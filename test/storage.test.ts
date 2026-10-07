import assert from 'node:assert/strict';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { checkDataDirPermissions, openDataDir } from '../src/dataDir.ts';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openDatabase, SCHEMA_VERSION, schemaVersion } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { JobStore } from '../src/jobs/store.ts';
import { silentLogger } from '../src/log.ts';
import { tempDir } from './helpers/tmp.ts';

describe('data directory', () => {
  test('creates a private directory and key file', (t) => {
    const dir = join(tempDir(t), 'data');
    const data = openDataDir(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'gateway.key')).mode & 0o777, 0o600);
    assert.equal(data.key.length, 32);
    assert.deepEqual(openDataDir(dir).key, data.key, 'the key is stable across opens');
  });

  test('refuses a directory readable by others', (t) => {
    const dir = tempDir(t);
    chmodSync(dir, 0o755);
    assert.throws(() => openDataDir(dir), { code: 'data_dir_insecure' });
  });

  test('refuses a key or database file readable by others', (t) => {
    const dir = join(tempDir(t), 'data');
    const data = openDataDir(dir);
    openDatabase(data.databasePath).close();
    checkDataDirPermissions(dir);
    chmodSync(data.databasePath, 0o644);
    assert.throws(() => checkDataDirPermissions(dir), /chmod 600/);
    chmodSync(data.databasePath, 0o600);
    chmodSync(join(dir, 'gateway.key'), 0o640);
    assert.throws(() => openDataDir(dir), { code: 'data_dir_insecure' });
  });
});

describe('database', () => {
  test('opens in WAL mode with a busy timeout and private files', (t) => {
    const data = openDataDir(join(tempDir(t), 'data'));
    const db = openDatabase(data.databasePath);
    t.after(() => db.close());
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal(statSync(data.databasePath + suffix).mode & 0o077, 0, `gateway.db${suffix} is private`);
    }
  });

  test('creates every table the gateway and the job layer need', (t) => {
    const db = openDatabase(join(tempDir(t), 'test.db'));
    t.after(() => db.close());
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_'));
    assert.deepEqual(tables, [
      'access_tokens',
      'approval_codes',
      'approval_failures',
      'authorization_codes',
      'host_credentials',
      'host_renewals',
      'idempotency_keys',
      'job_events',
      'jobs',
      'oauth_clients',
      'refresh_tokens',
      'token_families',
    ]);
  });

  test('migrations are idempotent and refuse a newer schema', (t) => {
    const path = join(tempDir(t), 'test.db');
    openDatabase(path).close();
    const db = openDatabase(path);
    t.after(() => db.close());
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    assert.throws(() => migrate(db), { code: 'database_error' });
  });

  test('migration 2 keeps the jobs, events and request ids of a version 1 database', (t) => {
    const path = join(openDataDir(join(tempDir(t), 'data')).databasePath);
    const v1 = new DatabaseSync(path);
    v1.exec('PRAGMA foreign_keys = ON');
    migrate(v1, MIGRATIONS.slice(0, 1));
    assert.equal(schemaVersion(v1), 1);
    v1.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, t3_project_id, state, task, title, branch, runtime_mode,
         t3_thread_id, t3_thread_title, t3_thread_link, last_run_id, pending_request_ids, latest_message_excerpt, latest_activity_at,
         read_position, host_unreachable_since, last_error_code, last_error_message, created_at, updated_at, state_changed_at,
         dispatch_started_at, finished_at)
       VALUES ('jobfull0001', 'client-a', 'req-1', 'pilot', 'main', 'project-1', 'idle', 'synthetic task', 'Synthetic [job:jobfull0001]',
         'fleet/jobfull0001', 'auto', 'thread-1', 'Synthetic [job:jobfull0001]', 't3-thread://v1/env-synthetic/thread-1', 'thread-1-run-1',
         '["request-1"]', 'synthetic excerpt', 5, 7, NULL, 't3_run_failed', 'synthetic message', 1, 2, 3, 4, NULL)`,
    ).run();
    v1.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, created_at, updated_at, state_changed_at, finished_at)
       VALUES ('jobdone0002', 'client-b', 'req-2', 'docs', 'main', 'cancelled', 'synthetic', 't', 'b', 'approval-required', 10, 11, 12, 12)`,
    ).run();
    v1.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('jobfull0001', 'created', 'queued', 1)").run();
    v1.prepare("INSERT INTO job_events (job_id, type, from_state, to_state, detail, created_at) VALUES ('jobfull0001', 'state_changed', 'running', 'idle', '{\"reason\":\"completed\"}', 3)").run();
    v1.prepare("INSERT INTO idempotency_keys (client_id, request_id, tool, input_hash, job_id, response, created_at) VALUES ('client-a', 'req-1', 'work_start', 'h', 'jobfull0001', NULL, 1)").run();
    const before = v1.prepare('SELECT * FROM jobs ORDER BY rowid').all().map((row) => ({ ...row }));
    const eventsBefore = v1.prepare('SELECT * FROM job_events ORDER BY id').all();
    v1.close();

    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 2);
    const after = db.prepare('SELECT * FROM jobs ORDER BY rowid').all() as Record<string, unknown>[];
    assert.deepEqual(
      after.map(({ standing, ...rest }) => rest),
      before,
      'every row and column is copied as it was',
    );
    assert.deepEqual(after.map((row) => row.standing), [0, 0]);
    assert.deepEqual(db.prepare('SELECT * FROM job_events ORDER BY id').all(), eventsBefore);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get() as { n: number }).n, 1);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1, 'foreign keys are enforced again');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.throws(() => db.prepare("INSERT INTO job_events (job_id, type, created_at) VALUES ('nojob', 'x', 0)").run(), /FOREIGN KEY/);
    assert.throws(() => db.prepare('DELETE FROM job_events').run(), /append-only/, 'the job_events triggers survive');
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    assert.deepEqual(indexes, ['jobs_host_state', 'jobs_project_created', 'jobs_state', 'jobs_thread']);
    db.prepare("UPDATE jobs SET state = 'released', standing = 1 WHERE id = 'jobfull0001'").run();
    assert.throws(() => db.prepare("UPDATE jobs SET state = 'paused' WHERE id = 'jobfull0001'").run(), /CHECK/);
    assert.throws(() => db.prepare("UPDATE jobs SET standing = 2 WHERE id = 'jobfull0001'").run(), /CHECK/);

    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: typeof db) => target.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('jobs', 'job_events') ORDER BY name").all();
    assert.deepEqual(schema(db), schema(fresh), 'a migrated database has the schema of a new one');
  });

  test('a table rebuild that breaks a foreign key is rolled back', (t) => {
    const db = openDatabase(join(tempDir(t), 'test.db'));
    t.after(() => db.close());
    db.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, created_at, updated_at, state_changed_at)
       VALUES ('j1', 'c', 'r', 'p', 'h', 'queued', 't', 't', 'b', 'auto', 0, 0, 0)`,
    ).run();
    db.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('j1', 'created', 'queued', 0)").run();
    const broken = { version: SCHEMA_VERSION + 1, name: 'drops a job', rebuildsTables: true, sql: "DELETE FROM jobs WHERE id = 'j1';" };
    assert.throws(() => migrate(db, [...MIGRATIONS, broken]), { code: 'database_error', message: /broken foreign key/ });
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n, 1);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  });

  test('job_events is append-only', (t) => {
    const db = openDatabase(join(tempDir(t), 'test.db'));
    t.after(() => db.close());
    db.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, created_at, updated_at, state_changed_at)
       VALUES ('j1', 'c', 'r', 'p', 'h', 'queued', 't', 't', 'b', 'approval-required', 0, 0, 0)`,
    ).run();
    db.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('j1', 'state', 'queued', 0)").run();
    assert.throws(() => db.prepare("UPDATE job_events SET type = 'x'").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM job_events').run(), /append-only/);
  });

  test('the database file never contains the key file bytes', (t) => {
    const data = openDataDir(join(tempDir(t), 'data'));
    openDatabase(data.databasePath).close();
    assert.equal(readFileSync(data.databasePath).includes(data.key), false);
  });
});

describe('job store', () => {
  test('stores T3 read positions as integers and reads them back as numbers', (t) => {
    const db = openDatabase(openDataDir(join(tempDir(t), 'data')).databasePath);
    t.after(() => db.close());
    const store = new JobStore(db, () => 1_000, silentLogger);
    const job = { clientId: 'c', requestId: 'r', inputHash: 'h', projectAlias: 'pilot', hostId: 'main', task: 'synthetic', title: 't', branch: 'b', runtimeMode: 'auto' };
    store.create({ id: 'job1', ...job });
    assert.equal(store.require('job1').readPosition, null);
    store.update('job1', { readPosition: 42 });
    assert.equal(store.require('job1').readPosition, 42);
    assert.deepEqual({ ...(db.prepare('SELECT read_position AS p, typeof(read_position) AS type FROM jobs').get() as object) }, { p: 42, type: 'integer' });
    assert.throws(() => store.update('job1', { readPosition: 1.5 }), /INTEGER/);
    store.update('job1', { readPosition: null });
    assert.equal(store.require('job1').readPosition, null);
  });

  test('scopes request ids per agent and per tool', (t) => {
    const db = openDatabase(openDataDir(join(tempDir(t), 'data')).databasePath);
    t.after(() => db.close());
    const store = new JobStore(db, () => 1_000, silentLogger);
    const job = { clientId: 'c', requestId: 'shared', inputHash: 'h', projectAlias: 'pilot', hostId: 'main', task: 'synthetic', title: 't', branch: 'b', runtimeMode: 'auto' };
    assert.equal(store.create({ id: 'job1', ...job }).created, true);
    store.claimIdempotencyKey('c', 'work_continue', 'shared', { inputHash: 'other', jobId: 'job1' });
    assert.equal(store.idempotencyKey('c', 'work_start', 'shared')?.inputHash, 'h');
    assert.equal(store.idempotencyKey('c', 'work_continue', 'shared')?.inputHash, 'other');
    assert.deepEqual(store.create({ id: 'job2', ...job }), { job: store.require('job1'), created: false }, 'work_start replays unaffected');
  });
});
