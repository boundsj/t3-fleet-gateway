import assert from 'node:assert/strict';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { loadRoute } from '../src/webhooks/config.ts';
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
});
