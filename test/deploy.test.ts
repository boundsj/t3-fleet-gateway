import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { tempDir } from './helpers/tmp.ts';

const ROOT = join(import.meta.dirname, '..');
const INSTALL = join(ROOT, 'deploy', 'launchd', 'install.sh');
const run = promisify(execFile);

/**
 * Stand-ins for launchctl, plutil and uname that record their calls. `launchctl print` reports the
 * label as loaded for the first `loadedPrints` calls (bootout still in progress), and `bootstrap`
 * fails the way macOS does for the first `failingBootstraps` calls. The real launchctl is never run.
 */
function stubs(t: TestContext, options: { loadedPrints: number; failingBootstraps: number; printFailure?: number }) {
  const dir = tempDir(t);
  const log = join(dir, 'calls.log');
  const counter = (name: string) => `n=$(cat "${dir}/${name}" 2>/dev/null || echo 0); echo $((n + 1)) >"${dir}/${name}"`;
  const scripts = {
    launchctl: [
      `echo "$1" >>"${log}"`,
      'case "$1" in',
      `  print) ${counter('prints')}; (( n < ${options.loadedPrints} )) && exit 0; exit ${options.printFailure ?? 113} ;;`,
      `  bootstrap) ${counter('bootstraps')}; if (( n < ${options.failingBootstraps} )); then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi ;;`,
      'esac',
    ],
    plutil: [],
    uname: ['echo Darwin'],
  };
  for (const [name, lines] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), ['#!/usr/bin/env bash', ...lines, 'exit 0', ''].join('\n'));
    chmodSync(join(dir, name), 0o755);
  }
  const home = tempDir(t);
  const configPath = join(home, 'config.json');
  writeFileSync(configPath, '{}');
  const env = {
    PATH: `${dir}:${process.env.PATH}`,
    HOME: home,
    LABEL: 'test.t3-fleet-gateway',
    NODE_BIN: process.execPath,
    T3_BIN: '/usr/bin/true',
    CONFIG_PATH: configPath,
    DATA_DIR: join(home, 'data'),
    LOG_DIR: join(home, 'logs'),
    PLIST_DIR: join(home, 'agents'),
  };
  return {
    env,
    plist: join(env.PLIST_DIR, `${env.LABEL}.plist`),
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

async function install(env: Record<string, string>, ...args: string[]) {
  try {
    const { stdout, stderr } = await run('bash', [INSTALL, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe('launchd installer', () => {
  test('is valid bash', async () => {
    await run('bash', ['-n', INSTALL]);
  });

  test('waits until bootout has finished before bootstrapping', async (t) => {
    const stub = stubs(t, { loadedPrints: 2, failingBootstraps: 0 });
    const result = await install(stub.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(stub.calls(), ['bootout', 'print', 'print', 'print', 'bootstrap']);
    assert.match(readFileSync(stub.plist, 'utf8'), /<string>test\.t3-fleet-gateway<\/string>/);
  });

  test('retries a failed bootstrap once, and fails if the retry fails too', async (t) => {
    const once = stubs(t, { loadedPrints: 0, failingBootstraps: 1 });
    const retried = await install(once.env);
    assert.equal(retried.code, 0, retried.stderr);
    assert.match(retried.stderr, /bootstrap failed; waiting for launchd and retrying once/);
    assert.deepEqual(once.calls(), ['bootout', 'print', 'bootstrap', 'print', 'bootstrap']);

    const twice = stubs(t, { loadedPrints: 0, failingBootstraps: 2 });
    const failed = await install(twice.env);
    assert.notEqual(failed.code, 0);
    assert.deepEqual(twice.calls(), ['bootout', 'print', 'bootstrap', 'print', 'bootstrap']);
  });

  test('a launchctl print failure other than "service not found" is reported, not taken as unloaded', async (t) => {
    const stub = stubs(t, { loadedPrints: 1, failingBootstraps: 0 });
    assert.equal((await install(stub.env)).code, 0);
    const broken = stubs(t, { loadedPrints: 0, failingBootstraps: 0, printFailure: 5 });
    const removed = await install({ ...broken.env, PLIST_DIR: stub.env.PLIST_DIR }, '--uninstall');
    assert.notEqual(removed.code, 0);
    assert.match(removed.stderr, /launchctl print gui\/\d+\/test\.t3-fleet-gateway failed with exit 5 \(not 113, "service not found"\)/);
    assert.match(removed.stderr, /did not unload/);
    assert.equal(existsSync(stub.plist), true, 'the plist is kept');
  });

  test('--uninstall waits for the agent to unload before removing its plist', async (t) => {
    const stub = stubs(t, { loadedPrints: 1, failingBootstraps: 0 });
    assert.equal((await install(stub.env)).code, 0);
    assert.equal(existsSync(stub.plist), true);
    const removed = await install(stub.env, '--uninstall');
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(stub.calls().slice(-2), ['bootout', 'print']);
    assert.equal(existsSync(stub.plist), false);
  });
});
