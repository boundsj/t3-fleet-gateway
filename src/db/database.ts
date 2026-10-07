import { DatabaseSync } from 'node:sqlite';
import { GatewayError } from '../errors.ts';
import { MIGRATIONS, type Migration } from './migrations.ts';

export type Database = DatabaseSync;

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

function userVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/** Run `fn` inside an IMMEDIATE transaction so concurrent writers (CLI and server) serialize. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): void {
  const current = userVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new GatewayError(
      'database_error',
      `Database schema version ${current} is newer than this build supports (${latest}). Upgrade t3-fleet-gateway.`,
    );
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    transaction(db, () => {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
}

export function openDatabase(path: string): Database {
  let db: Database;
  try {
    db = new DatabaseSync(path);
  } catch (error) {
    throw new GatewayError('database_error', `Cannot open database ${path}`, { cause: error });
  }
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function schemaVersion(db: Database): number {
  return userVersion(db);
}
