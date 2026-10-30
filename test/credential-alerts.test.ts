import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { runDoctor } from '../src/cli/doctor.ts';
import { parseConfig } from '../src/config.ts';
import { migrate } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { CredentialAlerts } from '../src/hosts/alerts.ts';
import { CredentialStore } from '../src/hosts/credentials.ts';
import { HostRegistry } from '../src/hosts/registry.ts';
import { JobStore } from '../src/jobs/store.ts';
import { silentLogger } from '../src/log.ts';
import { DAY } from '../src/time.ts';
import { webhooksSchema } from '../src/webhooks/config.ts';
import { WebhookStore } from '../src/webhooks/store.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway } from './helpers/gateway.ts';
import { testClock } from './helpers/clock.ts';
import { tempDir } from './helpers/tmp.ts';

async function fixture(t: TestContext, extra: Record<string, unknown> = {}) {
  const fake = await startFakeT3();
  t.after(() => fake.close());
  const gw = await startTestGateway(t, { config: {
    hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand() }],
    projects: [{ alias: 'pilot', host: 'main', t3ProjectId: 'project-1' }],
    dashboard: { enabled: true }, ...extra,
  }, jobEngine: { autoStart: false }, webhookSender: { autoStart: false } });
  const { services, clock } = gw;
  const credentials = new CredentialStore(services.db);
  const key = randomUUID();
  writeFileSync(join(gw.dataDir, 'synthetic.key'), key, { mode: 0o600 });
  const subscribe = (settings: Record<string, unknown> = {}) => {
    const config = webhooksSchema.parse({ subscriptions: [{ id: 'bot', enabled: true, url: 'https://receiver.example.com/event',
      auth: { header: 'Authorization', secretFile: 'synthetic.key' }, ...settings }] });
    services.webhooks.reconcile(config, gw.dataDir);
    return config;
  };
  subscribe();
  await services.registry.enroll('main');
  const old = credentials.get('main')!;
  const expiresIn = (days: number) => credentials.save({ ...old, expiresAt: clock() + days * DAY });
  const bodies = () => services.db.prepare('SELECT payload FROM credential_deliveries ORDER BY id').all()
    .map((row) => JSON.parse(String(row.payload)));
  return { ...gw, fake, credentials, old, expiresIn, bodies, subscribe, key };
}

test('renewal failure alerts once across repeated checks and registry restart; success resolves', async (t) => {
  const f = await fixture(t);
  f.expiresIn(4);
  f.fake.rejectDecisions = true;
  await f.services.registry.renewDue();
  assert.equal(f.bodies().filter((b) => b.reason === 'renewal_failed' && b.type === 'credential_alert').length, 1);
  const n = f.bodies().length;
  await f.services.registry.renewDue();
  const registry = new HostRegistry({ hosts: f.services.config.hosts, store: f.credentials, clock: f.clock, logger: silentLogger,
    renewWhenDaysLeft: 5, alerts: new CredentialAlerts(f.services.db, f.clock, f.services.config, f.services.webhooks) });
  await registry.renewDue();
  await registry.close();
  assert.equal(f.bodies().length, n);
  assert.equal(f.credentials.get('main')!.accessToken, f.old.accessToken);
  f.fake.rejectDecisions = false;
  await f.services.registry.renewDue();
  assert.ok(f.bodies().some((b) => b.type === 'credential_resolved' && b.reason === 'renewal_failed'));
  assert.ok(f.services.registry.credentialAlerts('main').every((a) => a.resolvedAt !== null));
});

test('7-day and 2-day expiry warnings escalate once, including equality and expired credentials', async (t) => {
  const f = await fixture(t);
  f.expiresIn(7);
  await f.services.registry.renewDue();
  assert.deepEqual(f.bodies().map((b) => b.thresholdDays), [7]);
  await f.services.registry.renewDue();
  assert.equal(f.bodies().length, 1);
  f.fake.rejectDecisions = true;
  f.clock.advance(5 * DAY);
  await f.services.registry.renewDue();
  assert.deepEqual(f.bodies().filter((b) => b.reason === 'expiry').map((b) => b.thresholdDays), [7, 2]);
  f.clock.advance(3 * DAY);
  const n = f.bodies().length;
  await f.services.registry.renewDue();
  assert.equal(f.bodies().length, n);
  assert.equal(f.services.registry.credentialStatus('main').state, 'expired');
});

test('threshold configuration is bounded and used independently of renewal timing', async (t) => {
  const f = await fixture(t, { renewal: { alertDaysLeft: [9, 3, 3] } });
  f.expiresIn(9);
  await f.services.registry.renewDue();
  assert.deepEqual(f.bodies().map((b) => b.thresholdDays), [9]);
  for (const days of [[], [0], [30], Array(9).fill(1)]) {
    assert.throws(() => parseConfig({ publicUrl: 'https://gateway.example.ts.net', renewal: { alertDaysLeft: days } }));
  }
});

test('preflight failure emits a redacted failure alert without pairing registration', async (t) => {
  const f = await fixture(t);
  f.expiresIn(3);
  f.services.registry.host('main').mintPairingCode.splice(0, 10, '/missing/synthetic-command');
  const before = f.fake.registeredClientNames.length;
  await f.services.registry.renewDue();
  assert.equal(f.fake.registeredClientNames.length, before);
  assert.ok(f.bodies().some((b) => b.reason === 'renewal_failed'));
  assert.doesNotMatch(JSON.stringify(f.bodies()) + f.logs.join(''), /synthetic-command/);
});

async function repairRequest(f: Awaited<ReturnType<typeof fixture>>, action: string, body: unknown, headers: Record<string, string> = {}) {
  const origin = `http://127.0.0.1:${f.gateway.dashboard!.port}`;
  return fetch(`${origin}/api/hosts/repair/${action}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-t3fg-dashboard': '1', origin, ...headers,
  }, body: JSON.stringify(body) });
}
async function confirmation(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await repairRequest(f, 'prepare', { host: 'main' });
  assert.equal(response.status, 200);
  return { host: 'main', confirmationId: (await response.json() as { confirmationId: string }).confirmationId };
}

test('confirmed dashboard re-pair verifies, installs and resolves; replay does not mint twice', async (t) => {
  const f = await fixture(t);
  f.expiresIn(3); f.fake.rejectDecisions = true;
  await f.services.registry.renewDue();
  f.fake.rejectDecisions = false;
  const body = await confirmation(f);
  const before = f.fake.registeredClientNames.length;
  const [a, b] = await Promise.all([repairRequest(f, 'confirm', body), repairRequest(f, 'confirm', body)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(f.fake.registeredClientNames.length, before + 1);
  assert.notEqual(f.credentials.get('main')!.accessToken, f.old.accessToken);
  assert.ok(f.services.registry.credentialAlerts('main').every((alert) => alert.resolvedAt !== null));
  const snapshot = (await a.json() as { snapshot: { hosts: { credential: { alerts: { resolvedAt: string | null }[] } }[] } }).snapshot;
  assert.ok(snapshot.hosts[0]!.credential.alerts.every((alert: { resolvedAt: string | null }) => alert.resolvedAt !== null));
});

test('dashboard verification failure preserves old credential and redacts all returned and logged text', async (t) => {
  const f = await fixture(t);
  const secret = randomUUID();
  f.fake.failures.set('t3_environment_read', { code: 'unavailable', message: secret });
  const response = await repairRequest(f, 'confirm', await confirmation(f));
  assert.equal(response.status, 409);
  assert.deepEqual(f.credentials.get('main'), f.old);
  const output = JSON.stringify(await response.json()) + f.logs.join('') + JSON.stringify(f.bodies()) +
    JSON.stringify(f.services.registry.credentialStatus('main'));
  for (const value of [secret, f.old.accessToken, f.old.t3ClientId, f.key]) assert.ok(!output.includes(value));
  for (const payload of f.bodies()) assert.deepEqual(Object.keys(payload).sort(),
    ['eventId', 'type', 'timestamp', 'feedSequence', 'feedCursor', 'host', 'reason', 'thresholdDays', 'expiresAt', 'alertId'].sort());
  const origin = `http://127.0.0.1:${f.gateway.dashboard!.port}`;
  assert.ok(!(await (await fetch(origin)).text()).includes(f.old.accessToken));
});

test('dashboard re-pair requires explicit fresh confirmation and existing mutation guards', async (t) => {
  const f = await fixture(t);
  const before = f.fake.registeredClientNames.length;
  assert.equal((await repairRequest(f, 'confirm', { host: 'main' })).status, 409);
  assert.equal((await repairRequest(f, 'prepare', { host: 'main' }, { origin: 'https://other.example' })).status, 403);
  assert.equal((await repairRequest(f, 'prepare', { host: 'main' }, { 'x-t3fg-dashboard': '' })).status, 403);
  assert.equal((await repairRequest(f, 'prepare', { host: 'main' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await repairRequest(f, 'prepare', { host: 'main', token: randomUUID() })).status, 400);
  const body = await confirmation(f);
  assert.equal(f.fake.registeredClientNames.length, before, 'preparation never mints');
  f.clock.advance(6 * 60_000);
  assert.equal((await repairRequest(f, 'confirm', body)).status, 409);
  assert.equal(f.fake.registeredClientNames.length, before);
});

test('credential delivery uses shared retry/health and disconnect cancels pending alerts', async (t) => {
  const f = await fixture(t);
  f.expiresIn(7); await f.services.registry.renewDue();
  const first = f.services.webhooks.claim(1, 30_000)[0]!;
  assert.equal(first.source, 'credential');
  f.services.webhooks.finish(first, { outcome: 'http_error', statusCode: 503 });
  assert.equal(f.services.webhooks.health()[0]!.health.failureStreak, 1);
  f.clock.advance(5000);
  const second = f.services.webhooks.claim(1, 30_000)[0]!;
  assert.equal(second.eventId, first.eventId);
  f.services.webhooks.finish(second, { outcome: 'delivered', statusCode: 200 });
  assert.equal(f.services.webhooks.health()[0]!.health.failureStreak, 0);
  assert.ok(f.services.webhooks.health()[0]!.health.lastSuccessAt);
  f.fake.rejectDecisions = true; f.clock.advance(5 * DAY);
  await f.services.registry.renewDue();
  f.services.webhooks.reconcile({ subscriptions: [] }, f.dataDir);
  assert.equal(f.services.webhooks.claim(4, 30_000).length, 0);
});

test('credential routes intersect host/project/job/client filters without borrowing another job identity', async (t) => {
  const f = await fixture(t);
  const jobs = new JobStore(f.services.db, f.clock, silentLogger);
  const create = (id: string, client: string) => jobs.create({ id, clientId: client, requestId: id, inputHash: id,
    projectAlias: 'pilot', hostId: 'main', t3ProjectId: 'project-1', task: 'Synthetic task', title: 'Synthetic title', branch: '', runtimeMode: 'auto' });
  create('job-a', 'client-a'); create('job-b', 'client-b');
  const status = f.services.registry.credentialStatus('main');
  const alerts = new CredentialAlerts(f.services.db, f.clock, f.services.config, f.services.webhooks);
  for (const filters of [{ hosts: ['other'] }, { projects: ['other'] }, { targets: [{ host: 'other', projectId: 'project-1' }] }, { targets: [{ host: 'main', projectId: 'unrelated-project' }] },
    { jobs: ['job-a'], clients: ['client-b'] }]) {
    f.subscribe(filters);
    alerts.update('main', { ...status, renewalError: { code: 'enrollment_failed', message: randomUUID(), at: f.clock() } });
    alerts.update('main', status);
  }
  assert.equal(f.bodies().length, 0);
  f.subscribe({ hosts: ['main'], projects: ['pilot'], targets: [{ host: 'main', projectId: 'project-1' }], jobs: ['job-a'], clients: ['client-a'] });
  alerts.update('main', { ...status, renewalError: { code: 'enrollment_failed', message: randomUUID(), at: f.clock() } });
  assert.equal(f.bodies().length, 1);
});

test('owner routes require matching bound jobs and permitted credential events', async (t) => {
  const f = await fixture(t);
  const jobs = new JobStore(f.services.db, f.clock, silentLogger);
  jobs.create({ id: 'owned-job', clientId: 'client-a', requestId: 'owned-job', inputHash: 'owned-job', projectAlias: 'pilot',
    hostId: 'main', t3ProjectId: 'project-1', task: 'Synthetic task', title: 'Synthetic title', branch: '', runtimeMode: 'auto' });
  f.subscribe({ ownerClientId: 'client-a', hosts: ['main'] });
  f.expiresIn(7); await f.services.registry.renewDue();
  assert.equal(f.bodies().length, 0);
  f.services.webhooks.subscribe({ clientId: 'client-a', scopes: ['host:main:operate'] }, 'bot', 'owned-job', ['credential_alert', 'credential_resolved']);
  f.clock.advance(5 * DAY); f.fake.rejectDecisions = true;
  await f.services.registry.renewDue();
  assert.equal(f.bodies().filter((b) => b.reason === 'expiry' && b.thresholdDays === 2).length, 1);
});

test('migration 19 preserves populated version 18 credentials, routes, jobs and queues', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, MIGRATIONS.slice(0, 18));
    const clock = testClock();
    new CredentialStore(db).save({ hostId: 'main', accessToken: randomUUID(), t3ClientId: randomUUID(), scope: '', access: 'auto',
      issuedAt: clock(), expiresAt: clock() + 30 * DAY, verifiedAt: clock() });
    new JobStore(db, clock, silentLogger).create({ id: 'migration-job', clientId: 'client-a', requestId: 'migration-job', inputHash: 'migration-job',
      projectAlias: 'pilot', hostId: 'main', t3ProjectId: 'project-1', task: 'Synthetic task', title: 'Synthetic title', branch: '', runtimeMode: 'auto' });
    const route = JSON.stringify({ url: 'https://receiver.example.com/event', header: 'authorization', value: randomUUID() });
    db.prepare(`INSERT INTO webhook_subscriptions (id, revision, identity, settings, route, source)
      VALUES ('legacy-bot', 'synthetic-revision', 'synthetic-identity', ?, ?, 'dashboard')`)
      .run(JSON.stringify({ projects: ['pilot'], hosts: ['main'], events: ['idle'], excerptChars: 0 }), route);
    const event = Number(db.prepare('SELECT MAX(id) AS n FROM job_events').get()!.n);
    db.prepare(`INSERT INTO webhook_deliveries (subscription_id, revision, event_id, feed_sequence, payload, created_at,
      expires_at, next_attempt_at, state) VALUES ('legacy-bot', 'synthetic-revision', 'synthetic-event', ?, '{}', ?, ?, ?, 'pending')`)
      .run(event, clock(), clock() + DAY, clock());
    db.prepare(`INSERT INTO webhook_attempts (subscription_id, delivery_id, event_id, attempted_at, outcome)
      VALUES ('legacy-bot', 1, 'synthetic-event', ?, 'http_error')`).run(clock());
    const tables = ['host_credentials', 'host_renewals', 'jobs', 'job_events', 'webhook_subscriptions', 'webhook_deliveries', 'webhook_attempts'];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    migrate(db);
    assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), before);
    assert.deepEqual(db.prepare('SELECT * FROM credential_alerts').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.throws(() => migrate(db, MIGRATIONS.slice(0, 18)), /newer than this build supports/);
  } finally { db.close(); }
});

test('CLI enrollment never echoes candidate verification errors or token material', async (t) => {
  const f = await fixture(t);
  const secret = randomUUID();
  f.fake.failures.set('t3_environment_read', { code: 'unavailable', message: secret });
  const configPath = join(tempDir(t), 'config.json');
  writeFileSync(configPath, JSON.stringify({ publicUrl: f.baseUrl,
    hosts: [{ id: 'main', t3Url: f.fake.url, mintPairingCode: f.fake.mintCommand() }] }));
  const lines: string[] = [];
  const code = await runCli(['hosts', 'enroll', 'main'], { env: { ...process.env, T3FG_CONFIG: configPath, T3FG_DATA_DIR: f.dataDir },
    out: (line) => lines.push(line), err: (line) => lines.push(line) });
  assert.equal(code, 1);
  for (const value of [secret, f.old.accessToken, f.old.t3ClientId]) assert.ok(!lines.join('').includes(value));
  assert.deepEqual(f.credentials.get('main'), f.old);
});

test('doctor shows the same persisted failure alert even when initial enrollment never succeeded', async (t) => {
  const f = await fixture(t);
  f.services.db.prepare("DELETE FROM host_credentials WHERE host_id = 'main'").run();
  f.fake.rejectDecisions = true;
  await assert.rejects(f.services.registry.enroll('main'));
  // Point every check at this synthetic gateway's actual listeners, never an operator listener.
  const services = { ...f.services, config: { ...f.services.config, dashboard: {
    ...f.services.config.dashboard, listen: { host: '127.0.0.1', port: f.gateway.dashboard!.port },
  } } };
  const checks = await runDoctor(services, f.dataDir);
  assert.ok(checks.some((check) => check.name === 'host main credential alert' && check.detail.includes('renewal_failed: active')));
});

test('existing dashboard event filters stay deliberate and can explicitly enable credential alerts', async (t) => {
  const f = await fixture(t);
  f.services.webhooks.reconcile({ subscriptions: [] }, f.dataDir);
  const route = { url: 'https://receiver.example.com/event', header: 'authorization', value: randomUUID() };
  const ping = { eventId: randomUUID(), at: f.clock(), result: { outcome: 'delivered' as const, statusCode: 200 } };
  const connection = f.services.webhooks.connectDashboard('legacy-bot', 'pilot', 'main', route, ping, 'project-1',
    { events: ['needs_input', 'idle', 'failed', 'cancelled', 'delegated_work_ended'] });
  f.expiresIn(7); await f.services.registry.renewDue();
  assert.equal(f.bodies().length, 0);
  f.services.webhooks.replaceDashboard(connection.id, connection.revision, route, ping, [...connection.events, 'credential_alert', 'credential_resolved']);
  f.clock.advance(5 * DAY); f.fake.rejectDecisions = true;
  await f.services.registry.renewDue();
  assert.ok(f.bodies().some((b) => b.thresholdDays === 2));
});

test('failed success bookkeeping rolls back verified replacement and its resolution outbox', async (t) => {
  const f = await fixture(t);
  f.expiresIn(7); await f.services.registry.renewDue();
  const before = f.credentials.get('main');
  f.services.db.exec(`CREATE TRIGGER synthetic_resolution_failure BEFORE UPDATE ON credential_alerts
    WHEN NEW.resolved_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
  await assert.rejects(f.services.registry.enroll('main'));
  assert.deepEqual(f.credentials.get('main'), before);
  assert.equal(f.bodies().filter((b) => b.type === 'credential_resolved').length, 0);
  assert.equal(f.services.registry.credentialAlerts('main').find((a) => a.kind === 'expiry_7')!.resolvedAt, null);
});

test('abandoned credential leases recover once, expire as dead letters, and leave job replay untouched', async (t) => {
  const f = await fixture(t);
  f.expiresIn(7); await f.services.registry.renewDue();
  const first = f.services.webhooks.claim(1, 30_000)[0]!;
  f.clock.advance(31_000);
  const second = f.services.webhooks.claim(1, 30_000)[0]!;
  assert.equal(second.eventId, first.eventId);
  assert.equal(f.services.webhooks.active(first), false);
  assert.equal(f.services.webhooks.health()[0]!.health.failureStreak, 1);
  f.clock.advance(DAY);
  assert.equal(f.services.webhooks.claim(1, 30_000).length, 0);
  assert.equal(f.services.webhooks.health()[0]!.health.deadLettered, 1);
  f.services.webhooks.claim(1, 30_000);
  assert.equal(f.services.webhooks.health()[0]!.health.deadLettered, 1);
  assert.deepEqual(f.services.db.prepare('SELECT * FROM webhook_archive').all(), []);
});

test('unchanged file configuration with omitted events preserves legacy selections, revision, queue, bindings and health', async (t) => {
  const f = await fixture(t);
  const legacy = f.subscribe({ ownerClientId: 'client-a', hosts: ['main'], events: ['idle'] });
  const job = f.services.jobs.store.create({ id: 'upgrade-job', clientId: 'client-a', requestId: 'upgrade-job', inputHash: 'upgrade-job',
    projectAlias: 'pilot', hostId: 'main', t3ProjectId: 'project-1', task: 'Synthetic task', title: 'Synthetic title', branch: '', runtimeMode: 'auto' }).job;
  f.services.webhooks.subscribe({ clientId: 'client-a', scopes: ['host:main:operate'] }, 'bot', job.id, ['idle']);
  // A historical version-18 config whose events were defaulted to the original five.
  const oldEvents = ['needs_input', 'idle', 'failed', 'cancelled', 'delegated_work_ended'];
  const settings = { ...legacy.subscriptions[0]!, events: oldEvents };
  const route = f.services.webhooks.route('bot', f.services.webhooks.listConnections()[0]!.revision);
  const { createHash } = await import('node:crypto');
  f.services.db.prepare('UPDATE webhook_subscriptions SET settings = ?, identity = ? WHERE id = ?')
    .run(JSON.stringify(settings), createHash('sha256').update(JSON.stringify({ settings, route })).digest('hex'), 'bot');
  f.services.jobs.store.transition(job.id, { from: ['queued'], to: 'running' });
  f.services.jobs.store.transition(job.id, { from: ['running'], to: 'idle' });
  const first = f.services.webhooks.claim(1, 30_000)[0]!;
  f.services.webhooks.finish(first, { outcome: 'http_error', statusCode: 503 });
  const tables = ['webhook_subscriptions', 'webhook_deliveries', 'webhook_archive', 'webhook_job_bindings', 'webhook_health', 'webhook_attempts'];
  const before = tables.map((table) => f.services.db.prepare(`SELECT * FROM ${table}`).all());
  const { events: _events, ...withoutEvents } = legacy.subscriptions[0]!;
  const omitted = webhooksSchema.parse({ subscriptions: [withoutEvents] });
  f.services.webhooks.reconcile(omitted, f.dataDir);
  assert.deepEqual(tables.map((table) => f.services.db.prepare(`SELECT * FROM ${table}`).all()), before);
  const explicit = webhooksSchema.parse({ subscriptions: [{ ...withoutEvents, events: [...oldEvents, 'credential_alert', 'credential_resolved'] }] });
  f.services.webhooks.reconcile(explicit, f.dataDir);
  assert.ok(f.services.webhooks.listConnections()[0]!.events.includes('credential_alert'));
  assert.notEqual(f.services.webhooks.listConnections()[0]!.revision, before[0]![0]!.revision);
});
