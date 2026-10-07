import assert from 'node:assert/strict';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { checkDataDirPermissions, openDataDir } from '../src/dataDir.ts';
import { migrate, openDatabase, SCHEMA_VERSION, schemaVersion } from '../src/db/database.ts';
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

  test('job_events is append-only', (t) => {
    const db = openDatabase(join(tempDir(t), 'test.db'));
    t.after(() => db.close());
    db.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, created_at, updated_at)
       VALUES ('j1', 'c', 'r', 'p', 'h', 'queued', 't', 't', 'b', 'approval-required', 0, 0)`,
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
