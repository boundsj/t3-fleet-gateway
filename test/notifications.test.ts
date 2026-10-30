import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { openDataDir } from '../src/dataDir.ts';
import { openDatabase, migrate } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { JobStore } from '../src/jobs/store.ts';
import { silentLogger } from '../src/log.ts';
import { webhooksSchema } from '../src/webhooks/config.ts';
import { ARCHIVE_RETENTION_MS, MAX_ARCHIVE_EVENTS, MAX_JOB_BINDINGS, MAX_PENDING_PER_SUBSCRIPTION,
  RETRY_WINDOW_MS, WebhookStore, type NotificationCaller } from '../src/webhooks/store.ts';
import { testClock } from './helpers/clock.ts';
import { tempDir } from './helpers/tmp.ts';

const owner: NotificationCaller = { clientId: 'client-a', scopes: ['host:main:read', 'host:main:operate'] };
function fixture(t: TestContext, settings: Record<string, unknown> = {}) {
  const dir = join(tempDir(t), 'data');
  const data = openDataDir(dir);
  const db = openDatabase(data.databasePath);
  t.after(() => db.close());
  const clock = testClock();
  const store = new WebhookStore(db, clock);
  const jobs = new JobStore(db, clock, silentLogger);
  writeFileSync(join(dir, 'synthetic.key'), 'synthetic-key', { mode: 0o600 });
  const config = webhooksSchema.parse({ subscriptions: [{ id: 'bot', enabled: true, url: 'https://receiver.example.com/event',
    auth: { header: 'Authorization', secretFile: 'synthetic.key' }, events: ['idle', 'cancelled'], ...settings }] });
  store.reconcile(config, dir);
  const create = (id: string, extra: Record<string, string> = {}) => jobs.create({ id, clientId: owner.clientId, requestId: id, inputHash: id,
    projectAlias: 'pilot', hostId: 'main', t3ProjectId: 'project-1', task: 'Synthetic secret task', title: 'Synthetic title', branch: '', runtimeMode: 'auto', ...extra }).job;
  const cancel = (id: string) => jobs.transition(id, { from: ['queued'], to: 'cancelled' });
  return { dir, db, clock, store, jobs, config, create, cancel };
}

test('job, original-client, host, alias, paired target and event filters intersect', (t) => {
  const f = fixture(t, { jobs: ['match001', 'wrongclient', 'wronghost', 'wrongalias', 'wrongtarget', 'wrongevent'], clients: ['client-a'],
    hosts: ['main'], projects: ['pilot'], targets: [{ host: 'main', projectId: 'project-1' }] });
  const examples = [
    ['match001', {}], ['unlisted', {}], ['wrongclient', { clientId: 'client-b' }], ['wronghost', { hostId: 'other' }],
    ['wrongalias', { projectAlias: 'other' }], ['wrongtarget', { t3ProjectId: 'other' }],
  ] as const;
  for (const [id, extra] of examples) { f.create(id, extra); f.cancel(id); }
  f.create('wrongevent'); f.jobs.transition('wrongevent', { from: ['queued'], to: 'running' });
  const claim = f.store.claim(4, 30_000);
  assert.equal(claim.length, 1);
  assert.equal(JSON.parse(claim[0]!.payload).jobId, 'match001');
  assert.deepEqual(f.db.prepare('SELECT feed_sequence FROM webhook_archive').all().map((r) => r.feed_sequence),
    [JSON.parse(claim[0]!.payload).feedSequence]);
});

test('owner connections require explicit job opt-in, owner and all-host grants; retry/removal and limits are durable', (t) => {
  const f = fixture(t, { ownerClientId: owner.clientId, hosts: ['main'] });
  f.create('mine0001'); f.create('other001', { clientId: 'client-b' }); f.create('hidden01', { hostId: 'hidden' });
  const bad: NotificationCaller[] = [{ ...owner, clientId: 'other' }, { ...owner, scopes: ['host:main:read'] }, { ...owner, scopes: ['host:other:operate'] }];
  for (const caller of bad) {
    assert.throws(() => f.store.subscribe(caller, 'bot', 'mine0001'), { code: 'not_found' });
    assert.throws(() => f.store.replayOwned(caller, 'bot', { afterCursor: '0' }), { code: 'not_found' });
  }
  for (const id of ['other001', 'hidden01', 'unknown']) assert.throws(() => f.store.subscribe(owner, 'bot', id), { code: 'not_found' });
  assert.deepEqual(f.store.ownedConnections({ ...owner, clientId: 'other' }), []);
  assert.deepEqual(f.store.ownedConnections({ ...owner, scopes: ['host:other:read'] }), []);
  assert.throws(() => f.store.subscribe(owner, 'bot', 'mine0001', ['running']), { code: 'invalid_argument' });
  f.store.subscribe(owner, 'bot', 'mine0001', ['cancelled']);
  f.store.subscribe(owner, 'bot', 'mine0001', ['cancelled']);
  assert.equal(f.store.ownedConnections(owner)[0]!.subscriptions.length, 1);
  const otherDb = openDatabase(join(f.dir, 'gateway.db')); t.after(() => otherDb.close());
  const restarted = new WebhookStore(otherDb, f.clock);
  assert.equal(restarted.ownedConnections(owner)[0]!.subscriptions.length, 1);
  f.cancel('mine0001');
  assert.equal(f.store.claim(4, 30_000).length, 1);
  f.store.subscribe(owner, 'bot', 'mine0001', undefined, true);
  f.jobs.transition('mine0001', { from: ['cancelled'], to: 'running' });
  f.jobs.transition('mine0001', { from: ['running'], to: 'idle' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM webhook_archive').get()!.n, 1);
  for (let i = 0; i < MAX_JOB_BINDINGS; i++) {
    const job = f.create(`limit${String(i).padStart(4, '0')}`);
    f.store.subscribe(owner, 'bot', job.id);
  }
  f.create('limitlast');
  assert.throws(() => f.store.subscribe(owner, 'bot', 'limitlast'), { code: 'invalid_argument' });
  f.store.subscribe(owner, 'bot', 'limit0000'); // Repeated existing binding at the limit is safe.
  f.create('unbound1'); f.cancel('unbound1');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM webhook_archive').get()!.n, 1);
});

test('an owner cannot subscribe or read health through a narrowed multi-host ceiling or a legacy operator connection', (t) => {
  const f = fixture(t, { ownerClientId: owner.clientId, hosts: ['main', 'other'] });
  f.create('mine0001');
  assert.throws(() => f.store.subscribe(owner, 'bot', 'mine0001'), { code: 'not_found' });
  assert.deepEqual(f.store.ownedConnections(owner), []);
  const fleet: NotificationCaller = { ...owner, scopes: ['fleet:read', 'fleet:operate'] };
  f.store.subscribe(fleet, 'bot', 'mine0001');
  assert.equal(f.store.ownedConnections(fleet).length, 1);
  f.store.reconcile({ subscriptions: [{ ...f.config.subscriptions[0]!, ownerClientId: undefined }] }, f.dir);
  assert.throws(() => f.store.subscribe(fleet, 'bot', 'mine0001'), { code: 'not_found' });
  assert.deepEqual(f.store.ownedConnections(fleet), []);
});

test('delivery health counts failures, abandoned leases, expiry and recovery independently of pruned attempts or pings', (t) => {
  const f = fixture(t);
  f.create('health01'); f.cancel('health01');
  const original = f.store.claim(1, 30_000)[0]!;
  f.store.finish(original, { outcome: 'http_error', statusCode: 503 });
  assert.equal(f.store.health()[0]!.health.failureStreak, 1);
  assert.deepEqual(f.store.claim(1, 30_000), []);
  f.clock.advance(5000);
  const abandoned = f.store.claim(1, 30_000)[0]!;
  f.clock.advance(30_000);
  const recovered = f.store.claim(1, 30_000)[0]!;
  assert.equal(f.store.health()[0]!.health.failureStreak, 2);
  f.store.finish(abandoned, { outcome: 'delivered', statusCode: 204 });
  assert.equal(f.store.health()[0]!.health.lastSuccessAt, null, 'late lease completion cannot mask failure');
  f.store.finish(recovered, { outcome: 'delivered', statusCode: 204 });
  const successful = f.store.health()[0]!.health;
  assert.equal(successful.failureStreak, 0);
  assert.equal(successful.lastSuccessAt, new Date(f.clock()).toISOString());
  f.create('health02'); f.cancel('health02');
  const expiring = f.store.claim(1, 30_000)[0]!;
  f.clock.advance(RETRY_WINDOW_MS);
  f.store.finish(expiring, { outcome: 'timeout', statusCode: null });
  f.create('health03'); f.cancel('health03');
  f.clock.advance(RETRY_WINDOW_MS);
  f.store.claim(1, 30_000);
  for (let i = 0; i < 105; i++) f.store.recordPing('bot', `ping-${i}`, f.clock(), { outcome: 'delivered', statusCode: 204 });
  const h = f.store.health()[0]!.health;
  assert.equal(h.deadLettered, 2);
  assert.equal(h.failureStreak, 1);
  assert.equal(h.lastSuccessAt, successful.lastSuccessAt);
  assert.equal(f.store.diagnostics().attempts.length, 20);
  assert.ok(!JSON.stringify(f.store.diagnostics()).includes('synthetic-key'));
});

test('cursor/time replay preserves event bytes and ID, skips active duplicates and pages across pruned delivery history', (t) => {
  const f = fixture(t);
  f.create('replay01'); f.cancel('replay01');
  const first = f.store.claim(1, 30_000)[0]!;
  f.store.finish(first, { outcome: 'delivered', statusCode: 204 });
  f.clock.advance(1);
  const since = new Date(f.clock()).toISOString();
  f.create('replay02'); f.cancel('replay02');
  const second = f.store.claim(1, 30_000)[0]!;
  f.store.finish(second, { outcome: 'delivered', statusCode: 204 });
  f.db.prepare("DELETE FROM webhook_deliveries WHERE state = 'delivered'").run();
  const reopened = openDatabase(join(f.dir, 'gateway.db')); t.after(() => reopened.close());
  const restarted = new WebhookStore(reopened, f.clock);
  const page = restarted.replay('bot', { afterCursor: '0', limit: 1 });
  assert.equal(page.queued, 1); assert.equal(page.hasMore, true);
  assert.equal(restarted.replay('bot', { afterCursor: '0', limit: 1 }).skipped, 1);
  const replayed = restarted.claim(1, 30_000)[0]!;
  assert.equal(replayed.payload, first.payload); assert.equal(replayed.eventId, first.eventId);
  restarted.finish(replayed, { outcome: 'delivered', statusCode: 200 });
  const next = restarted.replay('bot', { afterCursor: page.nextCursor, limit: 1 });
  assert.equal(next.queued, 1); assert.equal(next.hasMore, false);
  const active = restarted.claim(1, 30_000)[0]!;
  assert.equal(active.payload, second.payload);
  restarted.finish(active, { outcome: 'delivered', statusCode: 200 });
  assert.equal(restarted.replay('bot', { since }).queued, 1, 'time is inclusive and excludes the earlier event');
  f.clock.advance(RETRY_WINDOW_MS);
  restarted.claim(1, 30_000);
  assert.equal(restarted.replay('bot', { afterCursor: page.nextCursor }).queued, 1, 'expired event gets a fresh window');
  assert.ok(restarted.claim(1, 30_000)[0]!.expiresAt > f.clock());
});

test('archive retention reports gaps; replacement/removal invalidates old history and bindings', (t) => {
  const f = fixture(t, { ownerClientId: owner.clientId, hosts: ['main'] });
  f.create('archive1'); f.store.subscribe(owner, 'bot', 'archive1'); f.cancel('archive1');
  f.clock.advance(ARCHIVE_RETENTION_MS);
  const gap = f.store.replayOwned(owner, 'bot', { afterCursor: '0' });
  assert.equal(gap.retentionGap, true); assert.equal(gap.queued, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM webhook_archive').get()!.n, 0);
  f.create('archive2'); f.store.subscribe(owner, 'bot', 'archive2'); f.cancel('archive2');
  f.store.reconcile({ subscriptions: [{ ...f.config.subscriptions[0]!, url: 'https://new.example.com/events' }] }, f.dir);
  assert.equal(f.store.replayOwned(owner, 'bot', { afterCursor: '0' }).queued, 0);
  assert.equal(f.store.ownedConnections(owner)[0]!.subscriptions.length, 0);
  f.store.reconcile({ subscriptions: [] }, f.dir);
  assert.throws(() => f.store.replayOwned(owner, 'bot', { afterCursor: '0' }), { code: 'not_found' });
});

test('full queues still archive missed events; replay never exceeds the queue bound or advances past blocked events', (t) => {
  const f = fixture(t);
  f.create('queue001'); f.cancel('queue001');
  const row = f.db.prepare('SELECT * FROM webhook_deliveries').get()!;
  f.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO webhook_deliveries (subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
    SELECT 'bot', ?, 'backlog-' || x, ?, '{}', ?, ?, ?, 'pending' FROM n`)
    .run(MAX_PENDING_PER_SUBSCRIPTION - 1, row.revision!, row.feed_sequence!, f.clock(), f.clock() + RETRY_WINDOW_MS, f.clock());
  f.create('queue002'); f.cancel('queue002');
  const firstCursor = String(row.feed_sequence);
  const blocked = f.store.replay('bot', { afterCursor: firstCursor });
  assert.equal(blocked.queued, 0); assert.equal(blocked.hasMore, true); assert.equal(blocked.nextCursor, firstCursor);
  assert.equal(f.store.health()[0]!.health.overflowCount, 1);
  f.db.prepare("DELETE FROM webhook_deliveries WHERE event_id = 'backlog-1'").run();
  assert.equal(f.store.replay('bot', { afterCursor: blocked.nextCursor }).queued, 1);
  assert.equal(f.store.health()[0]!.health.pending, MAX_PENDING_PER_SUBSCRIPTION);
});

test('bounded archive advances its retention floor without discarding the pending outbox', (t) => {
  const f = fixture(t);
  f.create('bounded1'); f.cancel('bounded1');
  const row = f.db.prepare('SELECT * FROM webhook_archive').get()!;
  // Populate real source events cheaply, then synthetic immutable snapshots for the capacity boundary.
  f.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO job_events (job_id, type, created_at) SELECT 'bounded1', 'synthetic', ? FROM n`).run(MAX_ARCHIVE_EVENTS, f.clock());
  f.db.prepare(`INSERT INTO webhook_archive (subscription_id, revision, feed_sequence, event_id, payload, created_at)
    SELECT 'bot', ?, id, 'archive-' || id, '{}', ? FROM job_events WHERE id > ?`).run(row.revision!, f.clock(), row.feed_sequence!);
  assert.equal(f.store.replay('bot', { afterCursor: '0', limit: 1 }).retentionGap, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM webhook_archive').get()!.n, MAX_ARCHIVE_EVENTS);
  assert.equal(f.store.health()[0]!.health.pending, 2, 'original pending event and first replay remain queued');
});

test('replay rejects malformed selectors before changing the outbox', (t) => {
  const f = fixture(t);
  for (const input of [{}, { afterCursor: '-1' }, { afterCursor: '9999999999999999' }, { since: 'bad' },
    { afterCursor: '0', since: new Date(f.clock()).toISOString() }, { afterCursor: '0', limit: 201 }]) {
    assert.throws(() => f.store.replay('bot', input), { code: 'invalid_argument' });
  }
});

test('migration 18 preserves populated v17 routes, revisions, queued payloads and attempts; rollback fails closed', (t) => {
  const path = join(tempDir(t), 'previous.db');
  const db = new DatabaseSync(path); t.after(() => db.close());
  migrate(db, MIGRATIONS.slice(0, 17));
  const clock = testClock();
  db.prepare(`INSERT INTO webhook_subscriptions (id, revision, identity, settings, route, source)
    VALUES ('existing', 'revision', 'identity', ?, ?, 'dashboard')`).run(JSON.stringify({ events: ['idle'], excerptChars: 0 }),
      JSON.stringify({ url: 'https://receiver.example.com/events', header: 'Authorization', value: 'synthetic-key' }));
  const jobs = new JobStore(db, clock, silentLogger);
  const job = jobs.create({ id: 'upgrade1', clientId: 'client-a', requestId: 'upgrade', inputHash: 'upgrade',
    projectAlias: 'pilot', hostId: 'main', task: 'Synthetic task', title: 'Synthetic title', branch: '', runtimeMode: 'auto' }).job;
  const event = db.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES (?, 'state_changed', 'idle', ?)").run(job.id, clock());
  db.prepare(`INSERT INTO webhook_deliveries (subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
    VALUES ('existing', 'revision', 'old-event', ?, '{}', ?, ?, ?, 'pending')`).run(Number(event.lastInsertRowid), clock(), clock() + RETRY_WINDOW_MS, clock());
  db.prepare("INSERT INTO webhook_attempts (subscription_id, event_id, attempted_at, outcome) VALUES ('existing', 'old-event', ?, 'http_error')").run(clock());
  const tables = ['jobs', 'job_events', 'webhook_subscriptions', 'webhook_deliveries', 'webhook_attempts'];
  const before = tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  migrate(db);
  assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
  const store = new WebhookStore(db, clock);
  assert.equal(store.health()[0]!.health.lastSuccessAt, null);
  assert.equal(store.health()[0]!.health.failureStreak, 0);
  assert.equal(store.replay('existing', { afterCursor: '0' }).retentionGap, true);
  assert.equal(store.claim(1, 30_000)[0]!.payload, '{}');
  assert.throws(() => migrate(db, MIGRATIONS.slice(0, 17)), /newer than this build supports/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
