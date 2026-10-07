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
  let applied = current;
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    try {
      // PRAGMA foreign_keys cannot change inside a transaction, so it is switched around it.
      const enforced = foreignKeysEnforced(db);
      if (migration.rebuildsTables && enforced) db.exec('PRAGMA foreign_keys = OFF');
      try {
        transaction(db, () => {
          if (migration.run) migration.run(db);
          else db.exec(migration.sql ?? '');
          if (migration.rebuildsTables) {
            const violations = db.prepare('PRAGMA foreign_key_check').all();
            if (violations.length > 0) {
              throw new GatewayError('database_error', `Migration ${migration.version} would leave ${violations.length} broken foreign key reference(s)`);
            }
          }
          db.exec(`PRAGMA user_version = ${migration.version}`);
        });
      } finally {
        if (migration.rebuildsTables && enforced) db.exec('PRAGMA foreign_keys = ON');
      }
    } catch (error) {
      throw migrationFailed(migration, applied, error);
    }
    applied = migration.version;
  }
}

/** SQLite's result codes for a database another connection holds: SQLITE_BUSY and SQLITE_LOCKED. */
const BUSY_CODES = new Set([5, 6]);

/**
 * A failed migration as a `database_error` that names it. Its transaction was rolled back, so the
 * database is still at the version before it. Errors the migration raised itself are kept as they are.
 */
function migrationFailed(migration: Migration, applied: number, error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const { errcode, errstr, message } = error as { errcode?: unknown; errstr?: unknown; message?: unknown };
  const what = `Migration ${migration.version} (${migration.name})`;
  if (typeof errcode === 'number' && BUSY_CODES.has(errcode & 0xff)) {
    return new GatewayError(
      'database_error',
      `${what} could not run: another process is using the database (SQLITE_BUSY). Stop the gateway service and any other ` +
        `t3-fleet-gateway command using this data directory, then try again. The database is unchanged (schema version ${applied}).`,
      { cause: error },
    );
  }
  const detail = typeof message === 'string' ? message : typeof errstr === 'string' ? errstr : 'unknown error';
  return new GatewayError('database_error', `${what} failed: ${detail}. It was rolled back; the schema is still at version ${applied}.`, {
    cause: error,
  });
}

function foreignKeysEnforced(db: Database): boolean {
  return (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
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
