import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { runDoctor } from '../src/cli/doctor.ts';
import { openServices } from '../src/gateway.ts';
import { CredentialStore } from '../src/hosts/credentials.ts';
import { createLogger } from '../src/log.ts';
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

test('injected runners that ignore cancellation still have a bounded probe deadline', async () => {
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

test('unexpected preflight rejection still starts due renewal after all host checks settle', async (t) => {
  const fake = await startFakeT3({ tokenLifetimeSeconds: 3 * 86400 });
  t.after(() => fake.close());
  const first = await startTestGateway(t, { config: { hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand() }] } });
  await first.services.registry.enroll('main');
  await first.gateway.close();
  const registrations = fake.registeredClientNames.length;
  const probeStarted = Promise.withResolvers<void>();
  const finishProbe = Promise.withResolvers<string>();
  const renewed = Promise.withResolvers<void>();
  const gw = await startTestGateway(t, {
    dataDir: first.dataDir, door: first.door, jobEngine: { autoStart: false },
    config: { hosts: [
      { id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand() },
      { id: 'other', t3Url: fake.url, mintPairingCode: [process.execPath],
        mintPairingCodeProbe: [process.execPath, 'synthetic-non-mutating-probe'] },
    ] },
    tools: (services) => {
      const preflight = services.registry.preflight.bind(services.registry);
      // Inject an unexpected service-boundary rejection without making the logger sink throw.
      t.mock.method(services.registry, 'preflight', async (id: string, options?: Parameters<typeof preflight>[1]) => {
        if (id === 'main') throw new Error('Synthetic-preflight-secret-734a');
        return preflight(id, options);
      });
      const renewDue = services.registry.renewDue.bind(services.registry);
      t.mock.method(services.registry, 'renewDue', async () => { await renewDue(); renewed.resolve(); });
      return [];
    },
    runCommand: async (argv, options) => {
      if (argv[1] === 'synthetic-non-mutating-probe') {
        probeStarted.resolve();
        return finishProbe.promise;
      }
      return runCommand(argv, options);
    },
  });
  await probeStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.registeredClientNames.length, registrations, 'renewal waits for the other host preflight');
  finishProbe.resolve('1.2.3');
  assert.equal(await within(renewed.promise, 1000), true, 'unexpected preflight rejection must not disable automatic renewal');
  assert.equal(fake.registeredClientNames.length, registrations + 1, 'the due credential was actually renewed');
  assert.ok(gw.logs.some((line) => line.includes('host.pairing_preflight_failed')));
  assert.ok(gw.logs.some((line) => line.includes('probe_succeeded')), 'other host diagnostics are preserved');
  assert.doesNotMatch(gw.logs.join('\n'), /Synthetic-preflight-secret|synthetic-non-mutating-probe/);
});

// The child announces readiness only after installing its SIGTERM handler. A closed socket
// proves it exited; deadlines bound event waits, rather than sleeping and guessing readiness.
async function resistantProbe(t: TestContext): Promise<{ argv: string[]; ready: Promise<void>; closed: Promise<void> }> {
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let pid: number | undefined;
  let socket: Socket | undefined;
  let exited = false;
  const server = createServer((connection) => {
    socket = connection;
    let data = '';
    connection.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        pid = Number(data.trim());
        ready.resolve();
      }
    });
    connection.on('close', () => { exited = true; closed.resolve(); });
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (pid && !exited) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const script = String.raw`process.on('SIGTERM', () => {}); const s = require('net').connect(${address.port}, '127.0.0.1',
    () => s.write(process.pid + '\n'));`;
  return { argv: [process.execPath, '-e', script], ready: ready.promise, closed: closed.promise };
}

async function within(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

test('real SIGTERM-resistant probe exits after its timeout', async (t) => {
  const child = await resistantProbe(t);
  const pending = preflightCommand(host([process.execPath], child.argv), { timeoutMs: 1000 });
  assert.equal(await within(child.ready, 800), true, 'child installed its signal handler before the deadline');
  const checks = await pending;
  assert.equal(checks.at(-1)?.code, 'probe_timeout');
  assert.equal(await within(child.closed, 1000), true, 'timeout must kill the direct child even when it ignores SIGTERM');
});

test('real SIGTERM-resistant startup probe exits after shutdown cancellation', async (t) => {
  const child = await resistantProbe(t);
  const gw = await startTestGateway(t, { jobEngine: { autoStart: false }, config: { hosts: [{
    id: 'main', t3Url: 'http://127.0.0.1:9', mintPairingCode: [process.execPath], mintPairingCodeProbe: child.argv,
  }] } });
  assert.equal(await within(child.ready, 1000), true, 'child installed its signal handler before shutdown');
  await gw.gateway.close();
  assert.equal(await within(child.closed, 1000), true, 'shutdown must kill the direct child even when it ignores SIGTERM');
});

test('startup preflight does not delay shutdown on stalled MCP initialization', async (t) => {
  const initialized = Promise.withResolvers<void>();
  let requests = 0;
  const server = createHttpServer((request) => {
    requests++;
    request.resume();
    initialized.resolve(); // Accept the request but never answer MCP initialization.
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const config = { hosts: [{ id: 'main', t3Url: `http://127.0.0.1:${address.port}`, mintPairingCode: [process.execPath],
    mintPairingCodeProbe: [process.execPath, 'synthetic-safe-probe'] }], projects: [] };
  const dataDir = join(tempDir(t), 'data');
  const seed = openServices({ config: parseConfig({ publicUrl: 'https://gateway.example', ...config }), dataDir,
    logger: createLogger({ sink: () => {} }) });
  new CredentialStore(seed.db).save({ hostId: 'main', accessToken: 'synthetic-token', t3ClientId: 'synthetic-client',
    scope: '', access: 'auto', issuedAt: Date.now(), expiresAt: Date.now() + 30 * 86400000, verifiedAt: Date.now() });
  await seed.close();
  const probeStarted = Promise.withResolvers<void>();
  const gw = await startTestGateway(t, { dataDir, config, jobEngine: { autoStart: false }, runCommand: async () => {
    probeStarted.resolve();
    return new Promise<string>(() => {});
  } });
  assert.equal(await within(Promise.race([initialized.promise, probeStarted.promise]), 1000), true);
  const began = performance.now();
  await gw.gateway.close();
  assert.ok(performance.now() - began < 1000, 'preflight must not create a health connection that delays shutdown');
  assert.equal(requests, 0, 'preflight uses completed cached health only; no initialization request is sent');
});

test('exact native T3 version prefix matches or warns without exposing output', async () => {
  const config = host([process.execPath], [process.execPath, '--version']);
  const version = '0.0.46-nightly.20261007.2774';
  const matched = await preflightCommand(config, { serverVersion: version, runCommand: async () => `t3 v${version}\n` });
  assert.equal(matched.at(-1)?.code, 'version_matches');
  const differed = await preflightCommand(config, { serverVersion: '0.0.47', runCommand: async () => `t3 v${version}\n` });
  assert.equal(differed.at(-1)?.code, 'version_disagreement');
  assert.equal(differed.at(-1)?.level, 'warn');
  for (const output of [`secret prefix t3 v${version}`, `t3 v${version}\nsecret suffix`, `t3 v${version} secret`]) {
    const unverified = await preflightCommand(config, { serverVersion: version, runCommand: async () => output });
    assert.equal(unverified.at(-1)?.code, 'version_unverified', 'never search arbitrary output for embedded versions');
    assert.doesNotMatch(JSON.stringify(unverified), /secret|nightly|2774/);
  }
  assert.doesNotMatch(JSON.stringify([matched, differed]), /nightly|2774|0\.0\.47/);
});


test('preflight uses only completed unexpired health while doctor compares fresh health', async (t) => {
  const fake = await startFakeT3({ serverVersion: '0.0.46-nightly.20261007.2774' });
  t.after(() => fake.close());
  const gw = await startTestGateway(t, { jobEngine: { autoStart: false }, config: { hosts: [{
    id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand(), mintPairingCodeProbe: [process.execPath, '--version'],
  }] }, runCommand: (argv, options) => argv[1] === '--version' ? Promise.resolve(`t3 v${fake.serverVersion}\n`) : runCommand(argv, options) });
  const registry = gw.services.registry;
  await registry.enroll('main');
  await registry.health('main');
  const calls = () => fake.calls.filter((name) => name === 't3_environment_read').length;
  const before = calls();
  assert.equal((await registry.preflight('main')).at(-1)?.code, 'version_matches');
  assert.equal(calls(), before, 'preflight does not refresh completed health');
  gw.clock.advance(31_000);
  assert.equal((await registry.preflight('main')).at(-1)?.code, 'version_unverified', 'expired cache is not used');
  assert.equal(calls(), before, 'preflight does not refresh expired health');

  fake.holdResponses.add('t3_environment_read');
  const pending = registry.health('main', { fresh: true });
  await fake.whenHeld('t3_environment_read');
  try {
    const preflight = registry.preflight('main');
    assert.equal(await within(preflight, 1000), true, 'preflight does not await an in-flight health read');
    assert.equal((await preflight).at(-1)?.code, 'version_unverified');
    assert.equal(calls(), before + 1, 'preflight does not create another health request');
  } finally {
    fake.holdResponses.delete('t3_environment_read');
    fake.releaseHeld();
    await pending;
  }
  const checks = await runDoctor(gw.services, gw.dataDir);
  assert.equal(calls(), before + 2, 'doctor reads fresh health even with a completed cache');
  assert.ok(checks.some((check) => check.name === 'host main pairing command' && check.detail.startsWith('version_matches:')));
});
