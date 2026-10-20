import type { DatabaseSync } from 'node:sqlite';

const V12_COLUMNS = ['workspace_kind', 'workspace_root_key', 'workspace_root_held_at', 'workspace_resume_tokens', 'probe_attempts', 'probe_retry_at'];

/** The rows of a table as they were before migration 12, which only added columns to jobs. */
export function rowsWithoutV12(db: DatabaseSync, table: string): Record<string, unknown>[] {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
  if (table !== 'jobs') return rows;
  return rows.map((row) => Object.assign(Object.create(null), Object.fromEntries(Object.entries(row).filter(([column]) => !V12_COLUMNS.includes(column)))));
}
