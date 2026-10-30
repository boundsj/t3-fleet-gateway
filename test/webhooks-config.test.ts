import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import { parseConfig } from '../src/config.ts';
import { openDataDir } from '../src/dataDir.ts';
import { loadRoute, webhooksSchema } from '../src/webhooks/config.ts';
import { tempDir } from './helpers/tmp.ts';

function config(extra: Record<string, unknown> = {}) {
  return parseConfig({
    publicUrl: 'https://gateway.example.com', hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9' }],
    ...extra,
  });
}

function subscription(extra: Record<string, unknown> = {}) {
  return { id: 'synthetic', url: 'https://routine.example.com/private-synthetic-url',
    auth: { header: 'X-Routine-Sender-Key', secretFile: 'synthetic.key' }, ...extra };
}

describe('webhook configuration and private header files', () => {
  test('old config is off and defaults omit excerpts and running notifications', () => {
    assert.deepEqual(config().webhooks, { subscriptions: [] });
    const entry = config({ webhooks: { subscriptions: [subscription()] } }).webhooks.subscriptions[0]!;
    assert.equal(entry.enabled, false);
    assert.equal(entry.excerptChars, 0);
    assert.equal(entry.allowLoopbackHttp, false);
    assert.deepEqual(new Set(entry.events), new Set(['needs_input', 'idle', 'failed', 'cancelled', 'delegated_work_ended']));
  });

  test('HTTPS defaults reject credentials, fragments and HTTP; opt-in HTTP is literal loopback only', () => {
    for (const url of [
      'http://127.0.0.1/routine', 'https://user:synthetic-password@routine.example.com',
      'https://routine.example.com/#secret', 'https://routine.example.com/#', 'file:///synthetic', 'not-a-url',
    ]) assert.throws(() => config({ webhooks: { subscriptions: [subscription({ url })] } }), { code: 'config_invalid' });
    for (const url of ['http://127.0.0.1/routine', 'http://[::1]/routine']) {
      assert.doesNotThrow(() => config({ webhooks: { subscriptions: [subscription({ url, allowLoopbackHttp: true })] } }));
    }
    for (const url of ['http://localhost/routine', 'http://example.com/routine', 'http://192.0.2.1/routine']) {
      assert.throws(() => config({ webhooks: { subscriptions: [subscription({ url, allowLoopbackHttp: true })] } }), { code: 'config_invalid' });
    }
  });

  test('accepts arbitrary authentication names but refuses transport/control headers and invalid shapes', () => {
    for (const header of ['Authorization', 'X-Grok-Sender-Key', 'Api-Key', 'X_Custom!Key']) {
      assert.doesNotThrow(() => config({ webhooks: { subscriptions: [subscription({ auth: { header, secretFile: 'synthetic.key' } })] } }));
    }
    for (const header of ['Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Content-Type', 'Proxy-Authorization', 'Sec-Fetch-Site', 'X-Forwarded-For', 'Bad\r\nHeader']) {
      assert.throws(() => config({ webhooks: { subscriptions: [subscription({ auth: { header, secretFile: 'synthetic.key' } })] } }), { code: 'config_invalid' });
    }
    for (const secretFile of ['../outside.key', '/outside.key', 'nested/secret.key', '.', '..']) {
      assert.throws(() => config({ webhooks: { subscriptions: [subscription({ auth: { header: 'X-Key', secretFile } })] } }), { code: 'config_invalid' });
    }
    for (const extra of [{ excerptChars: 501 }, { excerptChars: -1 }, { events: ['invented'] }, { events: [] }, { projects: [] }, { hosts: [] }]) {
      assert.throws(() => config({ webhooks: { subscriptions: [subscription(extra)] } }), { code: 'config_invalid' });
    }
    assert.throws(() => config({ webhooks: { subscriptions: [subscription(), subscription()] } }), { code: 'config_invalid' });
  });

  test('private files are read exactly, missing/empty/multiline/insecure/symlink files fail with fixed sanitized errors', (t) => {
    const dir = tempDir(t);
    const entry = config({ webhooks: { subscriptions: [subscription()] } }).webhooks.subscriptions[0]!;
    const file = join(dir, entry.auth.secretFile);
    const assertPrivateFailure = () => assert.throws(() => loadRoute(entry, dir), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code: string }).code, 'config_invalid');
      for (const secret of [dir, entry.url, entry.auth.header, entry.auth.secretFile, 'synthetic-header-value']) {
        assert.equal(error.message.includes(secret), false);
      }
      return true;
    });
    assertPrivateFailure();
    for (const value of ['', '\n', ' \t\r\n', 'synthetic-header-value\r\nInjected: bad', 'x'.repeat(8193)]) {
      writeFileSync(file, value, { mode: 0o600 });
      assertPrivateFailure();
    }
    writeFileSync(file, 'synthetic-header-value\n', { mode: 0o600 });
    assert.deepEqual(loadRoute(entry, dir), { url: entry.url, header: 'x-routine-sender-key', value: 'synthetic-header-value' });
    chmodSync(file, 0o644);
    assertPrivateFailure();
    chmodSync(file, 0o600);
    const link = join(dir, 'linked.key');
    symlinkSync(file, link);
    assert.throws(() => loadRoute({ ...entry, auth: { ...entry.auth, secretFile: 'linked.key' } }, dir), { code: 'config_invalid' });
  });

  test('an owned 0600 FIFO fails promptly and privately for ping and startup instead of blocking at open', async (t) => {
    const dir = tempDir(t);
    const dataDir = join(dir, 'data');
    openDataDir(dataDir);
    const fifo = join(dataDir, 'synthetic.key');
    await promisify(execFile)('mkfifo', ['-m', '600', fifo]);
    assert.equal(statSync(fifo).isFIFO(), true);
    assert.equal(statSync(fifo).mode & 0o777, 0o600);
    if (process.getuid) assert.equal(statSync(fifo).uid, process.getuid());
    const configFile = join(dir, 'config.json');
    const configured = config({
      dashboard: { enabled: true }, webhooks: { subscriptions: [subscription({ enabled: true })] },
    });
    writeFileSync(configFile, JSON.stringify(configured), { mode: 0o600 });
    // Keep the blocking-open regression in a killable child; a timer cannot interrupt openSync in this test process.
    const script = `
      import { runCli } from ${JSON.stringify(new URL('../src/cli/main.ts', import.meta.url).href)};
      import { loadConfig } from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)};
      import { startGateway } from ${JSON.stringify(new URL('../src/gateway.ts', import.meta.url).href)};
      import { silentLogger } from ${JSON.stringify(new URL('../src/log.ts', import.meta.url).href)};
      const [configPath, dataDir, mode] = process.argv.slice(1);
      if (mode === 'ping') {
        process.exitCode = await runCli(['webhooks', 'ping', 'synthetic'], {
          env: { ...process.env, T3FG_CONFIG: configPath, T3FG_DATA_DIR: dataDir },
          out: (line) => process.stdout.write(line + '\\n'), err: (line) => process.stderr.write(line + '\\n'),
        });
      } else {
        try {
          const gateway = await startGateway({ config: loadConfig(configPath), dataDir, logger: silentLogger,
            port: 0, dashboardPort: 0, jobEngine: { autoStart: false }, webhookSender: { autoStart: false } });
          await gateway.close();
          process.exitCode = 2;
        } catch (error) {
          process.stderr.write(error.code + ': ' + error.message + '\\n');
          process.exitCode = 1;
        }
      }
    `;
    for (const mode of ['ping', 'startup']) {
      let failure: { code?: unknown; killed?: boolean; stdout?: string; stderr?: string } | undefined;
      try {
        await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, configFile, dataDir, mode],
          { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 20_000 });
      } catch (error) {
        failure = error as typeof failure;
      }
      assert.ok(failure, `${mode} must reject a FIFO`);
      assert.equal(failure.killed, false, `${mode} must return before the bounded child timeout`);
      assert.equal(failure.code, 1);
      const output = (failure.stdout ?? '') + (failure.stderr ?? '');
      assert.match(output, /config_invalid\)?: Webhook authentication or destination is invalid/);
      for (const sensitive of [dir, fifo, configured.webhooks.subscriptions[0]!.url, 'X-Routine-Sender-Key', 'synthetic.key']) {
        assert.equal(output.includes(sensitive), false);
      }
    }
  });
});

test('precise filters are bounded and bot-owned routes require an explicit host ceiling with excerpts off', () => {
  const base = { id: 'bot', enabled: true, url: 'https://receiver.example.com/events',
    auth: { header: 'Authorization', secretFile: 'synthetic.key' } };
  for (const extra of [{ jobs: [] }, { clients: [] }, { jobs: Array(101).fill('job') }, { clients: Array(101).fill('client') },
    { ownerClientId: 'client' }, { ownerClientId: 'client', hosts: ['main'], excerptChars: 1 }]) {
    assert.equal(webhooksSchema.safeParse({ subscriptions: [{ ...base, ...extra }] }).success, false);
  }
  assert.equal(webhooksSchema.safeParse({ subscriptions: [{ ...base, ownerClientId: 'client', hosts: ['main'], jobs: ['job-1'], clients: ['client'] }] }).success, true);
});
