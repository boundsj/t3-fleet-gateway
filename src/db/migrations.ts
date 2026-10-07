export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * The migration rebuilds a table that others reference (SQLite cannot alter a CHECK constraint):
   * it runs with foreign key enforcement off and must leave no violations (SQLite's documented
   * procedure for schema changes ALTER TABLE cannot make).
   */
  rebuildsTables?: boolean;
}

/** Every column of `jobs` as created by migration 1, in order. */
const JOBS_V1_COLUMNS = `id, client_id, request_id, project_alias, host_id, t3_project_id, state, task, title, branch, runtime_mode,
  t3_thread_id, t3_thread_title, t3_thread_link, last_run_id, pending_request_ids, latest_message_excerpt, latest_activity_at,
  read_position, host_unreachable_since, last_error_code, last_error_message, created_at, updated_at, state_changed_at,
  dispatch_started_at, finished_at`;

/**
 * Append-only list. Never edit a migration once it is in a commit on main: databases in use have
 * applied it. Add a new one. Times are Unix milliseconds. The jobs, job_events and idempotency_keys
 * tables are used by the job layer.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  counts_toward_limit INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX oauth_clients_created ON oauth_clients(created_at);

CREATE TABLE approval_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_client_id TEXT
) STRICT;

CREATE TABLE approval_failures (
  id INTEGER PRIMARY KEY,
  request_key TEXT NOT NULL,
  failed_at INTEGER NOT NULL,
  counts_globally INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX approval_failures_request ON approval_failures(request_key);
CREATE INDEX approval_failures_time ON approval_failures(failed_at);

CREATE TABLE authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  family_id TEXT
) STRICT;

CREATE TABLE token_families (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT
) STRICT;
CREATE INDEX token_families_client ON token_families(client_id);

CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES token_families(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  parent_hash TEXT,
  rotated_at INTEGER,
  superseded_at INTEGER
) STRICT;
CREATE INDEX refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX refresh_tokens_parent ON refresh_tokens(parent_hash);

CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES token_families(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX access_tokens_family ON access_tokens(family_id);
CREATE INDEX access_tokens_refresh ON access_tokens(refresh_token_hash);

CREATE TABLE host_credentials (
  host_id TEXT PRIMARY KEY,
  t3_client_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  scope TEXT NOT NULL,
  access TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL
) STRICT;

CREATE TABLE host_renewals (
  host_id TEXT PRIMARY KEY,
  attempted_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  failed_at INTEGER,
  error_code TEXT,
  error_message TEXT
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  project_alias TEXT NOT NULL,
  host_id TEXT NOT NULL,
  t3_project_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'dispatching', 'running', 'needs_input', 'idle',
    'cancel_requested', 'cancelled', 'failed', 'unknown'
  )),
  task TEXT NOT NULL,
  title TEXT NOT NULL,
  branch TEXT NOT NULL,
  runtime_mode TEXT NOT NULL,
  t3_thread_id TEXT,
  t3_thread_title TEXT,
  t3_thread_link TEXT,
  last_run_id TEXT,
  pending_request_ids TEXT NOT NULL DEFAULT '[]',
  latest_message_excerpt TEXT,
  latest_activity_at INTEGER,
  read_position INTEGER,
  host_unreachable_since INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_changed_at INTEGER NOT NULL,
  dispatch_started_at INTEGER,
  finished_at INTEGER
) STRICT;
CREATE INDEX jobs_state ON jobs(state);
CREATE INDEX jobs_host_state ON jobs(host_id, state);
CREATE INDEX jobs_project_created ON jobs(project_alias, created_at DESC);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX job_events_job ON job_events(job_id, id);
CREATE TRIGGER job_events_append_only_update BEFORE UPDATE ON job_events
BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
CREATE TRIGGER job_events_append_only_delete BEFORE DELETE ON job_events
BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;

CREATE TABLE idempotency_keys (
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  response TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, tool, request_id)
) STRICT;
`,
  },
  {
    version: 2,
    name: 'standing jobs',
    rebuildsTables: true,
    // jobs gains `standing` (an existing T3 thread the operator adopted, rather than one the gateway
    // launched) and the terminal state `released` (the operator stopped tracking a standing job).
    // The state CHECK can only change by rebuilding the table; every row is copied as it is.
    sql: `
CREATE TABLE jobs_v2 (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  project_alias TEXT NOT NULL,
  host_id TEXT NOT NULL,
  t3_project_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'dispatching', 'running', 'needs_input', 'idle',
    'cancel_requested', 'cancelled', 'failed', 'unknown', 'released'
  )),
  task TEXT NOT NULL,
  title TEXT NOT NULL,
  branch TEXT NOT NULL,
  runtime_mode TEXT NOT NULL,
  t3_thread_id TEXT,
  t3_thread_title TEXT,
  t3_thread_link TEXT,
  last_run_id TEXT,
  pending_request_ids TEXT NOT NULL DEFAULT '[]',
  latest_message_excerpt TEXT,
  latest_activity_at INTEGER,
  read_position INTEGER,
  host_unreachable_since INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_changed_at INTEGER NOT NULL,
  dispatch_started_at INTEGER,
  finished_at INTEGER,
  standing INTEGER NOT NULL DEFAULT 0 CHECK (standing IN (0, 1))
) STRICT;
INSERT INTO jobs_v2 (${JOBS_V1_COLUMNS}) SELECT ${JOBS_V1_COLUMNS} FROM jobs ORDER BY rowid;
DROP TABLE jobs;
ALTER TABLE jobs_v2 RENAME TO jobs;
CREATE INDEX jobs_state ON jobs(state);
CREATE INDEX jobs_host_state ON jobs(host_id, state);
CREATE INDEX jobs_project_created ON jobs(project_alias, created_at DESC);
CREATE INDEX jobs_thread ON jobs(t3_thread_id);
`,
  },
];
