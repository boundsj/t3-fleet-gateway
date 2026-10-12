import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseConfig, type HostConfig } from '../src/config.ts';
import { checkMintExecutable, preflightCommand, PROBE_MAX_BYTES, resolveCommand } from '../src/hosts/commandPreflight.ts';
import { runCommand } from '../src/t3/pairing.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway } from './helpers/gateway.ts';
import { tempDir } from './helpers/tmp.ts';

function host(mint: string[], probe?: string[]): HostConfig {
  return parseConfig({ publicUrl: 'https://gateway.example', hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9',
    mintPairingCode: mint, ...(probe ? { mintPairingCodeProbe: probe } : {}) }] }).hosts[0]!;
}

function executable(t: TestContext, name: string, script = 'exit 0'): string {
  const path = join(tempDir(t), name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  return path;
}

const codes = (checks: { code: string }[]) => checks.map((check) => check.code);

test('resolution uses the supplied service PATH, respects search order, cwd and executable permissions', (t) => {
  const first = executable(t, 't3');
  const second = executable(t, 't3');
  chmodSync(first, 0o600);
  assert.equal(resolveCommand('t3', { PATH: dirname(first) }).check.code, 'executable_not_executable');
  assert.equal(resolveCommand('t3', { PATH: `${dirname(first)}:${dirname(second)}` }).path, second);
  chmodSync(first, 0o700);
  assert.equal(resolveCommand('t3', { PATH: `${dirname(first)}:${dirname(second)}` }).path, first);
  assert.equal(resolveCommand('t3', { PATH: '' }).check.code, 'executable_missing', 'does not borrow shell PATH');
  assert.equal(resolveCommand(first, { PATH: '' }).path, first);
  assert.equal(resolveCommand('./package.json', { PATH: '' }).check.code, 'executable_not_executable');
  assert.equal(resolveCommand(dirname(first), { PATH: '' }).check.code, 'executable_not_executable', 'directories cannot be commands');
  assert.equal(resolveCommand('sh', {}).check.level, 'ok', 'matches execFile default PATH when PATH is absent');
});

test('pinned argv and pinned PATH warn, while a stable symlink does not warn about its target', (t) => {
  const pinned = executable(t, 'runtime/versions/1.2.3/t3');
  assert.ok(codes(checkMintExecutable(host([pinned, 'secret-arg']), {})).includes('version_pinned_path'));
  assert.ok(codes(checkMintExecutable(host(['t3']), { PATH: dirname(pinned) })).includes('version_pinned_path'));
  const stable = join(tempDir(t), 't3');
  symlinkSync(pinned, stable);
  assert.deepEqual(codes(checkMintExecutable(host([stable]), {})), ['executable_resolved']);
  const missing = join(dirname(pinned), 'missing');
  assert.deepEqual(codes(checkMintExecutable(host([missing]), {})), ['executable_missing', 'version_pinned_path']);
});

test('unconfigured probes never execute mint, wrappers or SSH and never append guessed arguments', async (t) => {
  const marker = join(tempDir(t), 'executed');
  const command = executable(t, 'ssh-wrapper', `touch '${marker}'`);
  const argv = [command, 'synthetic-remote', 't3', 'auth', 'pairing', 'create', 'secret-token'];
  const checks = await preflightCommand(host(argv));
  assert.deepEqual(codes(checks), ['executable_resolved', 'probe_unverified']);
  assert.equal(existsSync(marker), false);
  assert.doesNotMatch(JSON.stringify(checks), /synthetic-remote|secret-token|ssh-wrapper/);
});

test('an explicit local version-only probe is safe, and version disagreement is warning only', async (t) => {
  const command = executable(t, 't3', 'if [ "$#" = 1 ] && [ "$1" = --version ]; then echo \'{"version":"1.2.3"}\'; else exit 9; fi');
  const config = host([command, 'auth', 'pairing', 'create'], [command, '--version']);
  const matches = await preflightCommand(config, { serverVersion: '1.2.3' });
  assert.deepEqual(codes(matches), ['executable_resolved', 'probe_succeeded', 'version_matches']);
  const differs = await preflightCommand(config, { serverVersion: '1.2.4' });
  assert.equal(differs.at(-1)?.code, 'version_disagreement');
  assert.equal(differs.at(-1)?.level, 'warn');
  assert.doesNotMatch(JSON.stringify(differs), /1\.2\.[34]/, 'parsed command output is not returned');
  const bare = await preflightCommand(config, { serverVersion: '1.2.3-test+build', runCommand: async () => '1.2.3-test+build\n' });
  assert.equal(bare.at(-1)?.code, 'version_matches');
});

test('custom probes run exactly configured argv with the same environment and bounded runner options', async (t) => {
  const command = executable(t, 'remote-probe');
  const probe = [command, 'configured-remote', 'inspect-version'];
  const env = { PATH: dirname(command), SYNTHETIC: 'sentinel' };
  let calls = 0;
  const checks = await preflightCommand(host([command, 'mint'], probe), { env, serverVersion: '1.0.0',
    runCommand: async (argv, options) => {
      calls++;
      assert.deepEqual(argv, probe, 'no appended --version');
      assert.equal(options?.env, env);
      assert.equal(options?.maxBuffer, PROBE_MAX_BYTES);
      assert.equal(options?.timeoutMs, 2000);
      assert.ok(options?.signal);
      return '{"version":"1.0.0"}';
    },
  });
  assert.equal(calls, 1);
  assert.ok(codes(checks).includes('version_matches'));
});

test('probe failures, missing executables, unreadable versions and oversized output yield fixed diagnostics', async (t) => {
  const fail = [process.execPath, '-e', 'console.log("secret-stdout"); console.error("secret-stderr"); process.exit(3)'];
  const failed = await preflightCommand(host([process.execPath, 'secret-argv'], fail));
  assert.equal(failed.at(-1)?.code, 'probe_failed');
  assert.equal(failed.at(-1)?.level, 'fail');
  const missing = await preflightCommand(host([process.execPath], [join(tempDir(t), 'missing'), 'secret-arg']));
  assert.equal(missing.at(-1)?.code, 'probe_executable_missing');
  const unverified = await preflightCommand(host([process.execPath], [process.execPath, '-e', 'console.log("secret-output")']));
  assert.equal(unverified.at(-1)?.code, 'version_unverified');
  const large = await preflightCommand(host([process.execPath], [process.execPath]), { runCommand: async () => 'x'.repeat(PROBE_MAX_BYTES + 1) });
  assert.equal(large.at(-1)?.code, 'probe_output_limit');
  const actualLarge = await preflightCommand(host([process.execPath], [process.execPath, '-e', 'console.log("x".repeat(5000))']));
  assert.equal(actualLarge.at(-1)?.level, 'fail', 'execFile enforces its buffer too');
  assert.doesNotMatch(JSON.stringify([failed, missing, unverified, large, actualLarge]), /secret-|console\.log|process\.exit/);
  await assert.rejects(runCommand(fail), (error: unknown) => {
    assert.doesNotMatch(JSON.stringify(error) + String(error), /secret-|console\.log|process\.exit/);
    return true;
  });
});

test('probes time out and kill the direct child; injected runners that ignore cancellation are still bounded', async (t) => {
  const marker = join(tempDir(t), 'alive');
  const config = host([process.execPath], [process.execPath, '-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 500);`]);
  const checks = await preflightCommand(config, { timeoutMs: 50 });
  assert.equal(checks.at(-1)?.code, 'probe_timeout');
  // A harmless second command runs long enough that an un-killed first child would write the marker.
  await runCommand([process.execPath, '-e', 'setTimeout(() => {}, 550)']);
  assert.equal(existsSync(marker), false);
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const ignored = await preflightCommand(host([process.execPath], [process.execPath]), {
      timeoutMs: 20, runCommand: async () => new Promise<string>(() => {}),
    });
    assert.equal(ignored.at(-1)?.code, 'probe_timeout');
  } finally { clearInterval(keepAlive); }
});

test('startup reports missing commands and shutdown aborts an in-flight configured probe without waiting', async (t) => {
  const missing = await startTestGateway(t, { config: { hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9',
    mintPairingCode: ['/missing/synthetic-secret-path', 'secret-arg'] }] } });
  // Let startup diagnostic microtasks settle; no timing sleep.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await missing.gateway.close();
  assert.ok(missing.logs.some((line) => line.includes('executable_missing')));
  assert.doesNotMatch(missing.logs.join('\n'), /synthetic-secret-path|secret-arg/);

  const probeStarted = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const gw = await startTestGateway(t, {
    config: { hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9', mintPairingCode: [process.execPath, 'do-not-mint'],
      mintPairingCodeProbe: [process.execPath, 'synthetic-safe-probe'] }] },
    runCommand: async (argv, options) => {
      assert.equal(argv[1], 'synthetic-safe-probe');
      signal = options?.signal;
      probeStarted.resolve();
      return new Promise<string>(() => {});
    },
  });
  await probeStarted.promise;
  const began = performance.now();
  await gw.gateway.close();
  assert.ok(performance.now() - began < 1000, 'shutdown did not wait for the two-second probe deadline');
  assert.equal(signal?.aborted, true);
  assert.ok(gw.logs.some((line) => line.includes('gateway.stopped')));
  assert.doesNotMatch(gw.logs.join('\n'), /do-not-mint|synthetic-safe-probe|probe_failed|probe_timeout/);
});

test('startup preflight completes before due renewal; shutdown during its probe never starts pairing', async (t) => {
  const fake = await startFakeT3({ tokenLifetimeSeconds: 3 * 86400 });
  t.after(() => fake.close());
  const first = await startTestGateway(t, { config: { hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand() }] } });
  await first.services.registry.enroll('main');
  await first.gateway.close();
  const registrations = fake.registeredClientNames.length;
  const started = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const second = await startTestGateway(t, {
    dataDir: first.dataDir, door: first.door,
    config: { hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand(),
      mintPairingCodeProbe: [process.execPath, 'synthetic-read-only-probe'] }] },
    runCommand: async (argv, options) => {
      assert.equal(argv[1], 'synthetic-read-only-probe', 'mint runner cannot run until preflight finishes');
      signal = options?.signal;
      started.resolve();
      return new Promise<string>(() => {});
    },
  });
  await started.promise;
  assert.equal(fake.registeredClientNames.length, registrations);
  await second.gateway.close();
  assert.equal(signal?.aborted, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.registeredClientNames.length, registrations, 'late probe completion did not start renewal');
});
