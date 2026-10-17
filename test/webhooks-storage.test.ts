import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { openDataDir } from '../src/dataDir.ts';
import { migrate, openDatabase, schemaVersion } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { JobStore } from '../src/jobs/store.ts';
import { silentLogger } from '../src/log.ts';
import { webhooksSchema } from '../src/webhooks/config.ts';
import { MAX_ATTEMPTS_PER_SUBSCRIPTION, MAX_PAYLOAD_BYTES, MAX_PENDING_PER_SUBSCRIPTION, WebhookStore } from '../src/webhooks/store.ts';
import { testClock } from './helpers/clock.ts';
import { tempDir } from './helpers/tmp.ts';

function fixture(t: TestContext) {
  const dir = join(tempDir(t), 'data');
  const data = openDataDir(dir);
  const db = openDatabase(data.databasePath);
  t.after(() => db.close());
  const clock = testClock();
  writeFileSync(join(dir, 'synthetic.key'), 'synthetic-private-header', { mode: 0o600 });
  const webhooks = new WebhookStore(db, clock);
  const config = webhooksSchema.parse({ subscriptions: [{ id: 'synthetic', enabled: true, url: 'https://routine.example.com/private',
    auth: { header: 'X-Synthetic-Key', secretFile: 'synthetic.key' } }] });
  webhooks.reconcile(config, dir);
  const jobs = new JobStore(db, clock, silentLogger);
  return { dir, db, clock, webhooks, config, jobs };
}

function createJob(jobs: JobStore, id = 'synthetic01') {
  return jobs.create({ id, clientId: 'synthetic-client', requestId: id, inputHash: id,
    projectAlias: 'pilot', hostId: 'main', task: 'Synthetic private task', title: 'Synthetic safe title', branch: `fleet/${id}`, runtimeMode: 'auto' }).job;
}

describe('webhook migration and durable store boundaries', () => {
  test('migration 9 preserves a populated version 8 database and never invents historical events or attribution', (t) => {
    const path = openDataDir(join(tempDir(t), 'data')).databasePath;
    const old = new DatabaseSync(path);
    migrate(old, MIGRATIONS.slice(0, 8));
    assert.equal(schemaVersion(old), 8);
    old.exec(`
      INSERT INTO oauth_clients (id, name, redirect_uris, created_at, last_used_at, last_mcp_success_at)
        VALUES ('client-1', 'Synthetic agent', '[]', 1, 42, 50);
      INSERT INTO token_families (id, client_id, scope, resource, created_at)
        VALUES ('family-1', 'client-1', 'fleet:operate', 'https://gateway.example.com/mcp', 1);
      INSERT INTO refresh_tokens (token_hash, family_id, scope, created_at, expires_at)
        VALUES ('synthetic-refresh-hash', 'family-1', 'fleet:operate', 1, 9000);
      INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
        VALUES ('synthetic-access-hash', 'family-1', 'synthetic-refresh-hash', 'fleet:operate', 1, 1000);
      INSERT INTO host_credentials (host_id, t3_client_id, access_token, scope, access, issued_at, expires_at, verified_at)
        VALUES ('main', 'synthetic-t3-client', 'synthetic-t3-token', 'orchestration', 'full-access', 1, 9000, 1);
      INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, t3_project_id, state, task, title, branch, runtime_mode,
        created_at, updated_at, state_changed_at, last_run_id, latest_message_excerpt, latest_message_truncated, launch_spec)
        VALUES ('oldjob0001', 'client-1', 'request-1', 'pilot', 'main', 'project-1', 'idle', 'Synthetic private task',
          'Synthetic old job', 'fleet/oldjob0001', 'auto', 1, 2, 2, 'old-run', 'Synthetic old excerpt', 1, '{"v":1}');
      INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, t3_project_id, state, task, title, branch, runtime_mode,
        t3_thread_id, created_at, updated_at, state_changed_at, standing, activity_position, read_position)
        VALUES ('standing01', 'operator', 'adopted', 'pilot', 'main', 'project-1', 'idle', '', 'Synthetic coordinator', '', '',
          'thread-1', 1, 2, 3, 1, 20, 12);
      INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('oldjob0001', 'created', 'queued', 1);
      INSERT INTO job_events (job_id, type, from_state, to_state, detail, created_at)
        VALUES ('oldjob0001', 'state_changed', 'running', 'idle', '{"reason":"completed"}', 2);
      INSERT INTO job_events (job_id, type, to_state, detail, created_at)
        VALUES ('standing01', 'created', 'idle', '{"reason":"adopted"}', 1);
      INSERT INTO idempotency_keys (client_id, tool, request_id, input_hash, job_id, created_at)
        VALUES ('client-1', 'work_start', 'request-1', 'synthetic-request-hash', 'oldjob0001', 1);
    `);
    const tables = ['oauth_clients', 'token_families', 'refresh_tokens', 'access_tokens', 'host_credentials', 'jobs', 'job_events', 'idempotency_keys'];
    const before = tables.map((table) => old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    old.close();
    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), 9);
    assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
    for (const table of ['job_turns', 'webhook_subscriptions', 'webhook_deliveries', 'webhook_attempts']) {
      assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), [], `${table} begins empty`);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.throws(() => db.prepare('DELETE FROM job_events').run(), /append-only/);
    assert.throws(() => db.prepare("UPDATE job_events SET type = 'changed'").run(), /append-only/);
    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: typeof db) => target.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    assert.deepEqual(schema(db), schema(fresh));
  });

  test('separate connections claim exclusively, recover abandoned attempts, and reject stale completions', (t) => {
    const f = fixture(t);
    const job = createJob(f.jobs);
    f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled', detail: { reason: 'cancelled' } });
    const original = f.webhooks.claim(1, 1000)[0]!;
    assert.ok(original);
    const otherDb = openDatabase(join(f.dir, 'gateway.db'));
    t.after(() => otherDb.close());
    const other = new WebhookStore(otherDb, f.clock);
    assert.deepEqual(other.claim(1, 1000), [], 'a second writer cannot claim an active lease');
    f.clock.advance(1000);
    const resumed = other.claim(1, 1000)[0]!;
    assert.equal(resumed.eventId, original.eventId);
    assert.equal(resumed.payload, original.payload);
    assert.notEqual(resumed.lease, original.lease);
    f.webhooks.finish(original, { outcome: 'delivered', statusCode: 200 });
    assert.equal(other.active(resumed), true, 'late completion from an abandoned owner cannot finish the new attempt');
    other.finish(resumed, { outcome: 'delivered', statusCode: 204 });
    assert.deepEqual(other.claim(1, 1000), []);
    assert.deepEqual(other.diagnostics().attempts.map((row) => row.outcome), ['delivered', 'abandoned']);
    assert.equal(f.db.prepare('SELECT payload FROM webhook_deliveries').get()!.payload, null, 'settled history retains no payload');
  });

  test('auth rotation invalidates pending old deliveries and missing replacement credentials fail atomically', (t) => {
    const f = fixture(t);
    const job = createJob(f.jobs);
    f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled', detail: { reason: 'cancelled' } });
    const revision = f.db.prepare('SELECT revision FROM webhook_subscriptions').get()!.revision;
    writeFileSync(join(f.dir, 'synthetic.key'), '', { mode: 0o600 });
    assert.throws(() => f.webhooks.reconcile(f.config, f.dir), { code: 'config_invalid' });
    assert.equal(f.db.prepare('SELECT revision FROM webhook_subscriptions').get()!.revision, revision);
    assert.equal(f.db.prepare('SELECT state FROM webhook_deliveries').get()!.state, 'pending');
    writeFileSync(join(f.dir, 'synthetic.key'), 'synthetic-rotated-key', { mode: 0o600 });
    f.webhooks.reconcile(f.config, f.dir);
    assert.notEqual(f.db.prepare('SELECT revision FROM webhook_subscriptions').get()!.revision, revision);
    assert.deepEqual(f.webhooks.claim(1, 1000), []);
    assert.deepEqual({ ...f.db.prepare('SELECT state, payload FROM webhook_deliveries').get() }, { state: 'cancelled', payload: null });
  });

  test('queued and steered sends never establish a run initiator or replace its existing caller', (t) => {
    const f = fixture(t);
    const job = createJob(f.jobs);
    f.jobs.transition(job.id, { from: ['queued'], to: 'running', changes: { lastRunId: 'known-run' },
      gatewayTurn: { runId: 'known-run', clientId: 'original-caller' } });
    f.jobs.recordSend(job.id, { runId: 'known-run', delivery: 'queued' }, 'other-caller', 'queued-1');
    f.jobs.recordSend(job.id, { runId: 'known-run', delivery: 'steered' }, 'other-caller', 'steered-1');
    assert.deepEqual(f.db.prepare('SELECT * FROM job_turns').all().map((row) => ({ ...row })),
      [{ job_id: job.id, run_id: 'known-run', client_id: 'original-caller' }]);
    f.jobs.recordSend(job.id, { runId: 'unseen-run', delivery: 'queued' }, 'other-caller', 'queued-2');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM job_turns').get()!.n, 1);
    f.jobs.transition(job.id, { from: ['running'], to: 'idle', changes: { lastRunId: 'unseen-run' } });
    assert.deepEqual(JSON.parse(f.webhooks.claim(1, 1000)[0]!.payload).turnInitiator, { kind: 'unknown', clientId: null });
  });

  test('oversized upstream metadata is reported as payload overflow without truncating identifiers or blocking the job/feed', (t) => {
    const f = fixture(t);
    const job = f.jobs.create({ id: 'oversize01', clientId: 'synthetic-client', requestId: 'oversize', inputHash: 'oversize',
      projectAlias: 'pilot', hostId: 'main', task: 'Synthetic task', title: `Synthetic upstream title ${'x'.repeat(MAX_PAYLOAD_BYTES)}`,
      branch: 'fleet/oversize01', runtimeMode: 'auto' }).job;
    f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled' });
    assert.equal(f.jobs.require(job.id).state, 'cancelled');
    assert.equal(f.jobs.recentEvents(job.id, 10).at(-1)!.toState, 'cancelled');
    assert.deepEqual(f.webhooks.claim(1, 1000), []);
    const diagnostics = f.webhooks.diagnostics();
    assert.equal(diagnostics.subscriptions[0]!.overflow_count, 1);
    assert.equal(diagnostics.subscriptions[0]!.overflow_reason, 'payload_limit');
    assert.equal(diagnostics.subscriptions[0]!.overflow_sequence, f.jobs.recentEvents(job.id, 10).at(-1)!.id);
    assert.equal(JSON.stringify(diagnostics).includes('Synthetic upstream title'), false);
  });

  test('bounded attempts and terminal history preserve active backlog; overflow is explicit with a feed recovery sequence', (t) => {
    const f = fixture(t);
    const job = createJob(f.jobs);
    f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled', detail: { reason: 'cancelled' } });
    const row = f.db.prepare('SELECT * FROM webhook_deliveries').get()!;
    f.db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
      INSERT INTO webhook_deliveries (subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
      SELECT ?, ?, 'synthetic-backlog-' || n, ?, ?, ?, ?, ?, 'pending' FROM sequence`)
      .run(MAX_PENDING_PER_SUBSCRIPTION - 1, row.subscription_id!, row.revision!, row.feed_sequence!, row.payload!, row.created_at!, row.expires_at!, row.next_attempt_at!);
    const overflow = createJob(f.jobs, 'synthetic02');
    f.jobs.transition(overflow.id, { from: ['queued'], to: 'cancelled', detail: { reason: 'cancelled' } });
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE state = 'pending'").get()!.n, MAX_PENDING_PER_SUBSCRIPTION);
    const diagnostics = f.webhooks.diagnostics();
    assert.equal(diagnostics.subscriptions[0]!.overflow_count, 1);
    assert.equal(diagnostics.subscriptions[0]!.overflow_sequence, f.db.prepare('SELECT MAX(id) AS n FROM job_events').get()!.n);
    assert.equal(f.jobs.require(overflow.id).state, 'cancelled', 'bounded delivery backlog never blocks a job transition');

    f.db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < 1004)
      INSERT INTO webhook_deliveries (subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
      SELECT ?, ?, 'synthetic-terminal-' || n, ?, NULL, ?, ?, ?, 'delivered' FROM sequence`)
      .run(row.subscription_id!, row.revision!, row.feed_sequence!, row.created_at!, row.expires_at!, row.next_attempt_at!);

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_SUBSCRIPTION + 4; attempt++) {
      f.webhooks.recordPing('synthetic', `synthetic-ping-${attempt}`, f.clock(), { outcome: 'http_error', statusCode: 503 });
    }
    assert.equal(f.webhooks.diagnostics('synthetic', 9999).attempts.length, MAX_ATTEMPTS_PER_SUBSCRIPTION);
    assert.equal(f.webhooks.diagnostics('synthetic', 2).attempts.length, 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE state = 'delivered'").get()!.n, 1000);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE state = 'pending'").get()!.n, MAX_PENDING_PER_SUBSCRIPTION);
    assert.equal(JSON.stringify(f.webhooks.diagnostics()).includes('synthetic-private-header'), false);
    assert.equal(JSON.stringify(f.webhooks.diagnostics()).includes('Synthetic private task'), false);
  });
});
