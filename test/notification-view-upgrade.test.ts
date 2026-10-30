import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

const columns = ['id', 'subscription_id', 'revision', 'event_id', 'feed_sequence', 'payload', 'created_at', 'expires_at',
  'next_attempt_at', 'state', 'attempt_count', 'lease', 'lease_until'];

for (let version = 1; version <= 18; version++) {
  test(`notification view preserves column order and populated rows after upgrading migration ${version}`, () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db, MIGRATIONS.slice(0, version));
      db.prepare(`INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode,
        created_at, updated_at, state_changed_at) VALUES ('view-job', 'client-a', 'view-job', 'pilot', 'main', 'queued',
        'Synthetic task', 'Synthetic title', '', 'auto', 100, 101, 102)`).run();
      db.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('view-job', 'created', 'queued', 103)").run();
      const populate = () => {
        db.prepare(`INSERT INTO webhook_subscriptions (id, revision, identity, settings, route)
          VALUES ('view-route', 'view-revision', 'view-identity', '{}', '{}')`).run();
        db.prepare(`INSERT INTO webhook_deliveries (subscription_id, revision, event_id, feed_sequence, payload, created_at,
          expires_at, next_attempt_at, state, attempt_count, lease, lease_until)
          VALUES ('view-route', 'view-revision', 'job-event', 1, '{"kind":"job"}', 104, 205, 106, 'sending', 3, 'job-lease', 107)`).run();
      };
      if (version >= 9) populate();
      const before = version >= 9 ? db.prepare('SELECT * FROM webhook_deliveries').get() : undefined;
      // Verify every historical layout, rather than assuming later migrations leave the queue alone.
      if (version >= 9) assert.deepEqual(db.prepare('PRAGMA table_info(webhook_deliveries)').all().map((c) => c.name), columns);
      migrate(db);
      if (version < 9) populate();
      assert.equal(db.prepare("SELECT id FROM jobs WHERE id = 'view-job'").get()!.id, 'view-job');
      if (before) assert.deepEqual(db.prepare('SELECT * FROM webhook_deliveries').get(), before);
      for (const table of ['webhook_deliveries', 'credential_deliveries']) {
        assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name), columns);
      }
      db.prepare(`INSERT INTO credential_deliveries (subscription_id, revision, event_id, payload, created_at,
        expires_at, next_attempt_at, state, attempt_count, lease, lease_until)
        VALUES ('view-route', 'view-revision', 'credential-event', '{"kind":"credential"}', 108, 209, 110, 'pending', 5, NULL, NULL)`).run();
      const view = db.prepare('SELECT * FROM notification_deliveries ORDER BY source').all().map((row) => ({ ...row }));
      assert.deepEqual(view, [
        { ...db.prepare('SELECT * FROM credential_deliveries').get(), source: 'credential' },
        { ...db.prepare('SELECT * FROM webhook_deliveries').get(), source: 'job' },
      ]);
      assert.deepEqual(Object.keys(view[0]!), [...columns, 'source']);
      assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    } finally { db.close(); }
  });
}
