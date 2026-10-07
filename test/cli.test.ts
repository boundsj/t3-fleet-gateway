import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, test, type TestContext } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { openStorage } from '../src/gateway.ts';
import { ApprovalCodes, MAX_FAILURES_PER_HOUR } from '../src/oauth/approvalCodes.ts';
import { ClientStore, MAX_REGISTRATIONS_PER_HOUR } from '../src/oauth/clients.ts';
import { systemClock } from '../src/time.ts';
import { startFakeT3, type FakeT3 } from './helpers/fakeT3.ts';
import { freePort } from './helpers/gateway.ts';
import { tempDir } from './helpers/tmp.ts';

interface Env {
  dir: string;
  configPath: string;
  dataDir: string;
  port: number;
}

async function environment(t: TestContext, fake?: FakeT3, extra: Record<string, unknown> = {}): Promise<Env> {
  const dir = tempDir(t);
  const port = await freePort();
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      publicUrl: `http://127.0.0.1:${port}`,
      listen: { host: '127.0.0.1', port },
      hosts: [{ id: 'main', t3Url: fake?.url ?? 'http://127.0.0.1:9', mintPairingCode: fake?.mintCommand() ?? ['false'] }],
      ...extra,
    }),
  );
  return { dir, configPath, dataDir: join(dir, 'data'), port };
}

async function run(env: Env, args: string[], waitForShutdown?: () => Promise<void>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, {
    env: { T3FG_CONFIG: env.configPath, T3FG_DATA_DIR: env.dataDir },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...(waitForShutdown ? { waitForShutdown } : {}),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('cli', () => {
  test('help, version and usage errors', async (t) => {
    const env = await environment(t);
    assert.equal((await run(env, ['--help'])).code, 0);
    assert.match((await run(env, ['--version'])).out, /^\d+\.\d+\.\d+$/);
    assert.equal((await run(env, [])).code, 2);
    const unknown = await run(env, ['launch']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /Unknown command: launch/);
    assert.equal((await run(env, ['--nope'])).code, 2);
    assert.equal((await run(env, ['clients', 'list', 'x', 'y'])).code, 2);
  });

  test('reports a missing config with a stable code', async (t) => {
    const env = await environment(t);
    const result = await run({ ...env, configPath: join(env.dir, 'missing.json') }, ['hosts', 'status']);
    assert.equal(result.code, 1);
    assert.match(result.err, /config_not_found/);
  });

  test('pair mints a one-time code; --ttl is validated', async (t) => {
    const env = await environment(t);
    const result = await run(env, ['pair', '--ttl', '30m']);
    assert.equal(result.code, 0);
    assert.match(result.out, /^Approval code: [0-9A-Z]{5}-[0-9A-Z]{5}$/m);
    assert.match(result.out, /in 29m|in 30m/);
    assert.equal((await run(env, ['pair', '--ttl', '2d'])).code, 2);
    assert.equal((await run(env, ['pair', '--ttl', 'soon'])).code, 2);
  });

  test('throttle status and reset; pair reports a lifted approval pause', async (t) => {
    const env = await environment(t);
    const fail = (count: number) => {
      const storage = openStorage(env.dataDir);
      const approvals = new ApprovalCodes(storage.db, storage.key, systemClock);
      for (let i = 0; i < count; i++) approvals.redeem('WRONG-CODE0', `request-${i % 4}`, 'client');
      storage.db.close();
    };
    assert.match((await run(env, ['throttle', 'status'])).out, /approvals: +0\/20 .*\(ok\)\nregistrations: +0\/30 .*\(ok\)/);
    fail(MAX_FAILURES_PER_HOUR);
    assert.match((await run(env, ['throttle', 'status'])).out, /approvals: +20\/20 failed attempts in the last hour \(LIMIT REACHED\)/);
    const paired = await run(env, ['pair']);
    assert.match(paired.out, /^Approvals were paused after 20 failed attempts within an hour; minting this code lifted the pause\.$/m);
    assert.match((await run(env, ['throttle', 'status'])).out, /approvals: +0\/20/);
    assert.doesNotMatch((await run(env, ['pair'])).out, /paused/);

    fail(3);
    const storage = openStorage(env.dataDir);
    const store = new ClientStore(storage.db, systemClock);
    for (let i = 0; i < MAX_REGISTRATIONS_PER_HOUR; i++) store.register({ redirect_uris: ['https://agent.example.com/cb'] });
    storage.db.close();
    assert.match((await run(env, ['throttle', 'status'])).out, /registrations: +30\/30 counted in the last hour \(LIMIT REACHED\)/);
    const reset = await run(env, ['throttle', 'reset']);
    assert.equal(reset.code, 0);
    assert.match(reset.out, /^Cleared the failed approval attempts/);
    assert.match((await run(env, ['throttle', 'status'])).out, /approvals: +0\/20 .*\nregistrations: +0\/30/);
    assert.equal((await run(env, ['throttle'])).code, 2);
    assert.equal((await run(env, ['throttle', 'reset', 'extra'])).code, 2);
  });

  test('clients list and revoke', async (t) => {
    const env = await environment(t);
    assert.equal((await run(env, ['clients', 'list'])).out, 'No clients registered.');
    const storage = openStorage(env.dataDir);
    const client = new ClientStore(storage.db, systemClock).register({ client_name: 'Hosted agent', redirect_uris: ['https://agent.example.com/cb'] });
    storage.db.close();
    const listed = await run(env, ['clients', 'list']);
    assert.match(listed.out, new RegExp(`${client.id}\\s+Hosted agent\\s+-\\s+pending`));
    assert.match(listed.out, /https:\/\/agent\.example\.com/);
    const revoked = await run(env, ['clients', 'revoke', client.id]);
    assert.equal(revoked.code, 0);
    assert.match((await run(env, ['clients', 'list'])).out, /revoked/);
    const unknown = await run(env, ['clients', 'revoke', 'nope']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /not_found/);
    assert.equal((await run(env, ['clients', 'revoke'])).code, 2);
  });

  test('hosts enroll and hosts status, without printing credentials', async (t) => {
    const fake = await startFakeT3({ serverVersion: '9.9.9' });
    t.after(() => fake.stop());
    const env = await environment(t, fake);
    const before = await run(env, ['hosts', 'status']);
    assert.match(before.out, /credential: missing/);
    const enrolled = await run(env, ['hosts', 'enroll', 'main']);
    assert.equal(enrolled.code, 0, enrolled.err);
    assert.match(enrolled.out, /Enrolled main: T3 9\.9\.9, credential expires \S+ \(in (29|30)d\)/);
    const status = await run(env, ['hosts', 'status']);
    assert.match(status.out, /reachable:  yes, T3 9\.9\.9/);
    assert.match(status.out, /credential: active, expires/);
    for (const token of fake.issuedTokens) assert.equal(enrolled.out.includes(token) || status.out.includes(token), false);
    assert.equal((await run(env, ['hosts', 'enroll', 'other'])).code, 1);
  });

  test('a failing enrollment exits nonzero with the reason', async (t) => {
    const env = await environment(t);
    const result = await run(env, ['hosts', 'enroll', 'main']);
    assert.equal(result.code, 1);
    assert.match(result.err, /error \((host_unreachable|enrollment_failed)\)/);
  });

  test('doctor fails until the host is enrolled and the gateway is serving, then passes', async (t) => {
    const fake = await startFakeT3();
    t.after(() => fake.stop());
    const env = await environment(t, fake, {
      projects: [{ alias: 'pilot', host: 'main', t3ProjectTitle: 'Synthetic project 1', description: 'Scratch' }],
    });
    const failing = await run(env, ['doctor']);
    assert.equal(failing.code, 1);
    assert.match(failing.out, /FAIL  host main: not enrolled/);
    assert.match(failing.out, /FAIL  public URL/);
    assert.equal((await run(env, ['hosts', 'enroll', 'main'])).code, 0);

    let stop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => (ready = resolve));
    const serving = run(env, ['serve'], () => {
      ready();
      return stopped;
    });
    await started;
    const passing = await run(env, ['doctor']);
    stop();
    const served = await serving;
    assert.equal(passing.code, 0, passing.out);
    assert.match(passing.out, /OK    database: integrity ok/);
    assert.match(passing.out, /OK    project pilot: T3 project project-1 on main/);
    assert.match(passing.out, /OK    public URL/);
    assert.equal(served.code, 0);
    assert.match(served.out, /"event":"gateway.started"/);
    assert.match(served.out, /"event":"gateway.stopped"/);
  });

  test('the bin launcher runs the TypeScript entrypoint', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 't3-fleet-gateway.js'), '--version']);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});
