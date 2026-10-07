import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/database.ts';
import { CredentialStore } from '../src/hosts/credentials.ts';
import { resolveProjectId } from '../src/hosts/projects.ts';
import { HostRegistry } from '../src/hosts/registry.ts';
import { startRenewalLoop } from '../src/hosts/renewal.ts';
import { silentLogger } from '../src/log.ts';
import { systemClock } from '../src/time.ts';
import { startFakeT3, type FakeT3 } from './helpers/fakeT3.ts';
import { tempDir } from './helpers/tmp.ts';

async function setup(t: TestContext, options: { tokenLifetimeSeconds?: number; access?: string; mint?: (fake: FakeT3) => string[] } = {}) {
  const fake = await startFakeT3(options.tokenLifetimeSeconds ? { tokenLifetimeSeconds: options.tokenLifetimeSeconds } : {});
  t.after(() => fake.stop());
  const access = options.access ?? 'auto';
  const config = parseConfig({
    publicUrl: 'https://gateway.example.ts.net',
    hosts: [{ id: 'main', t3Url: fake.url, access, mintPairingCode: (options.mint ?? ((f) => f.mintCommand()))(fake) }],
    // Read-only hosts cannot run jobs, so they carry no projects.
    projects:
      access === 'read-only'
        ? []
        : [
            { alias: 'by-title', host: 'main', t3ProjectTitle: 'Synthetic project 2' },
            { alias: 'by-id', host: 'main', t3ProjectId: 'project-3' },
            { alias: 'missing', host: 'main', t3ProjectTitle: 'No such project' },
          ],
  });
  const db = openDatabase(join(tempDir(t), 'test.db'));
  const store = new CredentialStore(db);
  const registry = new HostRegistry({ hosts: config.hosts, store, clock: systemClock, logger: silentLogger, renewWhenDaysLeft: 5 });
  t.after(async () => {
    await registry.close();
    db.close();
  });
  return { fake, config, store, registry };
}

describe('host enrollment', () => {
  test('obtains, verifies and stores a credential through the pairing-code flow', async (t) => {
    const { fake, store, registry } = await setup(t, { access: 'read-only' });
    assert.equal(registry.credentialStatus('main').state, 'missing');
    const result = await registry.enroll('main');
    assert.equal(result.t3Version, '0.0.0-test');
    const credential = store.get('main');
    assert.ok(credential);
    assert.ok(fake.validTokens.has(credential.accessToken));
    assert.equal(credential.access, 'read-only');
    assert.equal(credential.scope, 'orchestration:read');
    assert.deepEqual(fake.decisions, [{ access: 'read-only' }]);
    assert.deepEqual(fake.registeredClientNames, ['t3-fleet-gateway (main)']);
    const status = registry.credentialStatus('main');
    assert.equal(status.state, 'active');
    assert.equal(status.daysLeft, 29);
    assert.equal(status.renewalError, null);
    assert.equal((await registry.health('main')).reachable, true);
  });

  test('reports a failing or malformed pairing command and stores nothing', async (t) => {
    const failing = await setup(t, { mint: () => [process.execPath, '-e', 'process.exit(3)'] });
    await assert.rejects(failing.registry.enroll('main'), { code: 'pairing_command_failed', message: /exit code 3/ });
    assert.equal(failing.store.get('main'), undefined);
    assert.equal(failing.registry.credentialStatus('main').renewalError?.code, 'pairing_command_failed');
    const garbled = await setup(t, { mint: () => [process.execPath, '-e', 'console.log("Pairing code: ABC")'] });
    await assert.rejects(garbled.registry.enroll('main'), { code: 'pairing_command_failed', message: /--json/ });
  });

  test('a rejected pairing code fails enrollment', async (t) => {
    const { fake, store, registry } = await setup(t);
    fake.rejectDecisions = true;
    await assert.rejects(registry.enroll('main'), { code: 'enrollment_failed', message: /HTTP 400/ });
    assert.equal(store.get('main'), undefined);
  });
});

describe('credential renewal', () => {
  test('renews a credential inside the renewal window and switches to the new one', async (t) => {
    const { fake, store, registry } = await setup(t, { tokenLifetimeSeconds: 3 * 86400 });
    await registry.enroll('main');
    const first = store.get('main');
    assert.equal(registry.credentialStatus('main').state, 'renewal_due');
    await registry.renewDue();
    const second = store.get('main');
    assert.ok(first && second);
    assert.notEqual(second.accessToken, first.accessToken);
    fake.validTokens.delete(first.accessToken);
    assert.ok(await registry.client('main').environmentRead(), 'the client uses the renewed credential');
  });

  test('a failed renewal keeps the old credential working and records the error', async (t) => {
    const { fake, store, registry } = await setup(t, { tokenLifetimeSeconds: 3 * 86400 });
    await registry.enroll('main');
    const before = store.get('main');
    fake.rejectDecisions = true;
    await registry.renewDue();
    assert.deepEqual(store.get('main'), before);
    const status = registry.credentialStatus('main');
    assert.equal(status.state, 'renewal_due');
    assert.equal(status.renewalError?.code, 'enrollment_failed');
    assert.ok(await registry.client('main').environmentRead(), 'old credential still in use');
    fake.rejectDecisions = false;
    await registry.renewDue();
    assert.equal(registry.credentialStatus('main').renewalError, null, 'a later success clears the error');
  });

  test('a new credential that fails verification is not stored', async (t) => {
    const { fake, store, registry } = await setup(t, { tokenLifetimeSeconds: 3 * 86400 });
    await registry.enroll('main');
    const before = store.get('main');
    fake.failures.set('t3_environment_read', { code: 'unavailable', message: 'Try later.' });
    await assert.rejects(registry.enroll('main'), { code: 'enrollment_failed', message: /verification/ });
    assert.deepEqual(store.get('main'), before);
  });

  test('credentials outside the window are left alone', async (t) => {
    const { fake, registry } = await setup(t);
    await registry.enroll('main');
    await registry.renewDue();
    assert.equal(fake.decisions.length, 1);
  });

  test('the renewal loop checks at startup and stops cleanly', async (t) => {
    const { fake, registry } = await setup(t, { tokenLifetimeSeconds: 3 * 86400 });
    await registry.enroll('main');
    const loop = startRenewalLoop(registry, 60_000, silentLogger);
    await loop.stop();
    assert.equal(fake.decisions.length, 2);
  });
});

describe('host health and projects', () => {
  test('caches health, reports missing credentials and unreachable hosts', async (t) => {
    const { fake, registry } = await setup(t);
    const missing = await registry.health('main');
    assert.equal(missing.reachable, null);
    assert.equal(missing.error?.code, 'host_not_enrolled');
    await registry.enroll('main');
    const calls = () => fake.calls.filter((call) => call === 't3_environment_read').length;
    const before = calls();
    await registry.health('main');
    await registry.health('main');
    assert.equal(calls(), before + 1, 'second check is served from cache');
    await fake.stop();
    const down = await registry.health('main', { fresh: true });
    assert.equal(down.reachable, false);
    assert.equal(down.error?.code, 'host_unreachable');
    assert.throws(() => registry.host('other'), { code: 'host_not_found' });
  });

  test('resolves configured projects by title or id', async (t) => {
    const { config, registry } = await setup(t);
    await registry.enroll('main');
    const [byTitle, byId, missing] = config.projects;
    assert.equal(await resolveProjectId(registry, byTitle!), 'project-2');
    assert.equal(await resolveProjectId(registry, byId!), 'project-3');
    await assert.rejects(resolveProjectId(registry, missing!), { code: 'not_found' });
  });
});
