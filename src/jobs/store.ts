import { transaction, type Database } from '../db/database.ts';
import { GatewayError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { Clock } from '../time.ts';
import type { DelegatedTask } from './derive.ts';
import { isTerminal, RUNNING_STATES, TERMINAL_STATES, type JobState } from './states.ts';

export interface Job {
  id: string;
  clientId: string;
  requestId: string;
  projectAlias: string;
  hostId: string;
  t3ProjectId: string | null;
  state: JobState;
  task: string;
  title: string;
  branch: string;
  runtimeMode: string;
  threadId: string | null;
  threadTitle: string | null;
  /** URL that opens the thread in the T3 app, from the first thread read. Never logged. */
  threadLink: string | null;
  lastRunId: string | null;
  pendingRequestIds: string[];
  latestMessageExcerpt: string | null;
  latestActivityAt: number | null;
  /** The `afterPosition` for the next incremental `t3_thread_read` of the messages view; null reads from the start. */
  readPosition: number | null;
  /**
   * The `afterPosition` for the next incremental read of the activity view, where delegated work shows
   * (see activity.ts). Null reads from the start, except on a standing job, which is scanned as at adoption.
   */
  activityPosition: number | null;
  hostUnreachableSince: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: number;
  /** When any field last changed. Writes that change nothing (an unchanged thread polled again) leave it. */
  updatedAt: number;
  /** When the job entered its current state. */
  stateChangedAt: number;
  dispatchStartedAt: number | null;
  finishedAt: number | null;
  /**
   * An existing T3 thread the operator adopted (`jobs adopt`), not one the gateway launched. Never
   * launched or reconciled, holds no concurrency slot, and stays open until the operator releases it.
   */
  standing: boolean;
  /**
   * Work the thread delegated to other threads (T3 subagents) that is still running, from its timeline.
   * A coordinator is idle while it waits for such work, and T3 starts its next turn when the work is done.
   */
  delegatedWork: DelegatedTask[];
}

/** The client id recorded on standing jobs: the operator adopted them, no agent started them. Real client ids are longer. */
export const OPERATOR_CLIENT_ID = 'operator';

/** Why an event happened. Gateway-generated values only: never task text or worker content. */
export interface EventDetail {
  reason?: string;
  code?: string;
  requestId?: string;
}

export interface JobEvent {
  id: number;
  jobId: string;
  type: string;
  fromState: JobState | null;
  toState: JobState | null;
  detail: EventDetail;
  createdAt: number;
}

/** Fields a transition or update may change. */
export type JobChanges = Partial<
  Pick<
    Job,
    | 't3ProjectId'
    | 'threadId'
    | 'threadTitle'
    | 'threadLink'
    | 'lastRunId'
    | 'pendingRequestIds'
    | 'latestMessageExcerpt'
    | 'latestActivityAt'
    | 'readPosition'
    | 'activityPosition'
    | 'hostUnreachableSince'
    | 'lastErrorCode'
    | 'lastErrorMessage'
    | 'dispatchStartedAt'
    | 'delegatedWork'
  >
>;

const COLUMNS: Record<keyof JobChanges, string> = {
  t3ProjectId: 't3_project_id',
  threadId: 't3_thread_id',
  threadTitle: 't3_thread_title',
  threadLink: 't3_thread_link',
  lastRunId: 'last_run_id',
  pendingRequestIds: 'pending_request_ids',
  latestMessageExcerpt: 'latest_message_excerpt',
  latestActivityAt: 'latest_activity_at',
  readPosition: 'read_position',
  activityPosition: 'activity_position',
  hostUnreachableSince: 'host_unreachable_since',
  lastErrorCode: 'last_error_code',
  lastErrorMessage: 'last_error_message',
  dispatchStartedAt: 'dispatch_started_at',
  delegatedWork: 'delegated_work',
};

interface JobRow {
  id: string;
  client_id: string;
  request_id: string;
  project_alias: string;
  host_id: string;
  t3_project_id: string | null;
  state: JobState;
  task: string;
  title: string;
  branch: string;
  runtime_mode: string;
  t3_thread_id: string | null;
  t3_thread_title: string | null;
  t3_thread_link: string | null;
  last_run_id: string | null;
  pending_request_ids: string;
  latest_message_excerpt: string | null;
  latest_activity_at: number | null;
  read_position: number | null;
  activity_position: number | null;
  host_unreachable_since: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: number;
  updated_at: number;
  state_changed_at: number;
  dispatch_started_at: number | null;
  finished_at: number | null;
  standing: number;
  delegated_work: string;
}

interface EventRow {
  id: number;
  job_id: string;
  type: string;
  from_state: JobState | null;
  to_state: JobState | null;
  detail: string | null;
  created_at: number;
}

/** Placeholders for TERMINAL_STATES in `state NOT IN (…)`. */
const NOT_OPEN = TERMINAL_STATES.map(() => '?').join(', ');

function parseIds(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseDelegated(text: string): DelegatedTask[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (task): task is DelegatedTask =>
        typeof task === 'object' && task !== null && typeof task.itemId === 'string' && Number.isInteger(task.position) && typeof task.title === 'string',
    );
  } catch {
    return [];
  }
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    clientId: row.client_id,
    requestId: row.request_id,
    projectAlias: row.project_alias,
    hostId: row.host_id,
    t3ProjectId: row.t3_project_id,
    state: row.state,
    task: row.task,
    title: row.title,
    branch: row.branch,
    runtimeMode: row.runtime_mode,
    threadId: row.t3_thread_id,
    threadTitle: row.t3_thread_title,
    threadLink: row.t3_thread_link,
    lastRunId: row.last_run_id,
    pendingRequestIds: parseIds(row.pending_request_ids),
    latestMessageExcerpt: row.latest_message_excerpt,
    latestActivityAt: row.latest_activity_at,
    readPosition: row.read_position,
    activityPosition: row.activity_position,
    hostUnreachableSince: row.host_unreachable_since,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stateChangedAt: row.state_changed_at,
    dispatchStartedAt: row.dispatch_started_at,
    finishedAt: row.finished_at,
    standing: row.standing === 1,
    delegatedWork: parseDelegated(row.delegated_work),
  };
}

function toEvent(row: EventRow): JobEvent {
  let detail: EventDetail = {};
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail) as EventDetail;
    } catch {
      detail = {};
    }
  }
  return { id: row.id, jobId: row.job_id, type: row.type, fromState: row.from_state, toState: row.to_state, detail, createdAt: row.created_at };
}

function columnValue(key: keyof JobChanges, value: JobChanges[keyof JobChanges]): string | number | null {
  if (key === 'pendingRequestIds' || key === 'delegatedWork') return JSON.stringify(value ?? []);
  // T3 positions are integers; the STRICT INTEGER column refuses anything else.
  return (value ?? null) as string | number | null;
}

export interface FeedEvent extends JobEvent {
  projectAlias: string;
  title: string;
}

/** Tools whose requestId makes a call idempotent. Keys are scoped per agent and per tool. */
export type IdempotentTool = 'work_start' | 'work_continue';

export interface IdempotencyKey {
  inputHash: string;
  jobId: string;
  /** The stored result, or null while the outcome of the first attempt is unknown. */
  response: string | null;
}

export interface NewJob {
  id: string;
  clientId: string;
  requestId: string;
  inputHash: string;
  projectAlias: string;
  hostId: string;
  task: string;
  title: string;
  branch: string;
  runtimeMode: string;
}

/** An existing T3 thread the operator adopts as a standing job, with its state from a first read. */
export interface NewStandingJob {
  id: string;
  projectAlias: string;
  hostId: string;
  t3ProjectId: string;
  state: JobState;
  title: string;
  branch: string;
  runtimeMode: string;
  threadId: string;
  threadTitle: string;
  threadLink: string | null;
  lastRunId: string | null;
  pendingRequestIds: string[];
  latestMessageExcerpt: string | null;
  latestActivityAt: number | null;
  readPosition: number | null;
  activityPosition: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  delegatedWork: DelegatedTask[];
}

export interface TransitionOptions {
  /** The transition happens only if the job is in one of these states. */
  from: readonly JobState[];
  to: JobState;
  changes?: JobChanges;
  detail?: EventDetail;
}

/**
 * The job ledger: jobs, their append-only event log (whose ids are the feed cursor) and request-id
 * idempotency. Every state change goes through `transition`, which updates the row only from an
 * expected state and appends the event in the same transaction.
 */
export class JobStore {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(db: Database, clock: Clock, logger: Logger) {
    this.#db = db;
    this.#clock = clock;
    this.#logger = logger;
  }

  get(id: string): Job | undefined {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row && toJob(row);
  }

  require(id: string): Job {
    const job = this.get(id);
    if (!job) throw new GatewayError('not_found', `No job ${id}. Use work_list to see jobs.`);
    return job;
  }

  /** Jobs newest first, optionally filtered. */
  list(filter: { projectAlias?: string; states?: readonly JobState[]; clientId?: string; limit: number }): Job[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectAlias !== undefined) {
      where.push('project_alias = ?');
      params.push(filter.projectAlias);
    }
    if (filter.states && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      params.push(...filter.states);
    }
    if (filter.clientId !== undefined) {
      where.push('client_id = ?');
      params.push(filter.clientId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM jobs ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, filter.limit) as unknown as JobRow[];
    return rows.map(toJob);
  }

  /** Jobs on a host in the given states, oldest first. */
  onHost(hostId: string, states: readonly JobState[]): Job[] {
    const rows = this.#db
      .prepare(`SELECT * FROM jobs WHERE host_id = ? AND state IN (${states.map(() => '?').join(', ')}) ORDER BY created_at, rowid`)
      .all(hostId, ...states) as unknown as JobRow[];
    return rows.map(toJob);
  }

  /** Queued jobs on a host in FIFO order. */
  queued(hostId: string, limit: number): Job[] {
    const rows = this.#db
      .prepare("SELECT * FROM jobs WHERE host_id = ? AND state = 'queued' ORDER BY created_at, rowid LIMIT ?")
      .all(hostId, limit) as unknown as JobRow[];
    return rows.map(toJob);
  }

  /** Jobs holding one of the host's concurrency slots. Standing jobs never do. */
  slotHolders(hostId: string): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE host_id = ? AND standing = 0 AND state IN (${RUNNING_STATES.map(() => '?').join(', ')})`)
      .get(hostId, ...RUNNING_STATES) as { n: number };
    return row.n;
  }

  /** Ids of every job that is not finished. */
  openJobIds(): Set<string> {
    const rows = this.#db.prepare(`SELECT id FROM jobs WHERE state NOT IN (${NOT_OPEN})`).all(...TERMINAL_STATES) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  hasOpenJobs(hostId: string): boolean {
    const row = this.#db.prepare(`SELECT 1 AS present FROM jobs WHERE host_id = ? AND state NOT IN (${NOT_OPEN}) LIMIT 1`).get(hostId, ...TERMINAL_STATES);
    return row !== undefined;
  }

  /** The open job following a T3 thread, if any. */
  openJobForThread(threadId: string): Job | undefined {
    const row = this.#db
      .prepare(`SELECT * FROM jobs WHERE t3_thread_id = ? AND state NOT IN (${NOT_OPEN}) ORDER BY created_at, rowid LIMIT 1`)
      .get(threadId, ...TERMINAL_STATES) as JobRow | undefined;
    return row && toJob(row);
  }

  /** Open standing jobs, oldest first; all of them, or one project's. */
  standingJobs(projectAlias?: string): Job[] {
    const project = projectAlias === undefined ? '' : 'AND project_alias = ?';
    const rows = this.#db
      .prepare(`SELECT * FROM jobs WHERE standing = 1 AND state NOT IN (${NOT_OPEN}) ${project} ORDER BY created_at, rowid`)
      .all(...TERMINAL_STATES, ...(projectAlias === undefined ? [] : [projectAlias])) as unknown as JobRow[];
    return rows.map(toJob);
  }

  /**
   * Insert a queued job with its first event, or return the existing job for a repeated request.
   * The same (client, requestId) for work_start with a different input is rejected.
   */
  create(job: NewJob): { job: Job; created: boolean } {
    return transaction(this.#db, () => {
      const existing = this.idempotencyKey(job.clientId, 'work_start', job.requestId);
      if (existing) {
        if (existing.inputHash !== job.inputHash) {
          throw new GatewayError(
            'request_id_conflict',
            `requestId "${job.requestId}" was already used for a different request. Use a new requestId for new work.`,
          );
        }
        return { job: this.require(existing.jobId), created: false };
      }
      const now = this.#clock();
      this.#db
        .prepare(
          `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, created_at, updated_at, state_changed_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(job.id, job.clientId, job.requestId, job.projectAlias, job.hostId, job.task, job.title, job.branch, job.runtimeMode, now, now, now);
      this.#insertEvent(job.id, 'created', null, 'queued', {}, now);
      this.#db
        .prepare('INSERT INTO idempotency_keys (client_id, request_id, tool, input_hash, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(job.clientId, job.requestId, 'work_start', job.inputHash, job.id, now);
      this.#logger.info('job.created', { jobId: job.id, project: job.projectAlias, hostId: job.hostId, clientId: job.clientId });
      return { job: this.require(job.id), created: true };
    });
  }

  /**
   * Record an adopted T3 thread as a standing job, with a `created` event (reason `adopted`) in its
   * first state. Adopting a thread that an open standing job of the same project already follows
   * returns that job; a thread followed by any other open job is refused.
   */
  adopt(job: NewStandingJob): { job: Job; created: boolean } {
    return transaction(this.#db, () => {
      const existing = this.openJobForThread(job.threadId);
      if (existing) {
        if (existing.standing && existing.projectAlias === job.projectAlias) return { job: existing, created: false };
        const what = existing.standing ? `standing job ${existing.id} in project "${existing.projectAlias}"` : `job ${existing.id}, which the gateway launched`;
        throw new GatewayError('job_state_conflict', `Thread ${job.threadId} is already followed by ${what} (${existing.state}).`);
      }
      const now = this.#clock();
      this.#db
        .prepare(
          `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, t3_project_id, state, task, title, branch, runtime_mode,
             t3_thread_id, t3_thread_title, t3_thread_link, last_run_id, pending_request_ids, latest_message_excerpt, latest_activity_at,
             read_position, last_error_code, last_error_message, created_at, updated_at, state_changed_at, finished_at, standing, delegated_work,
             activity_position)
           VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          job.id,
          OPERATOR_CLIENT_ID,
          'adopted',
          job.projectAlias,
          job.hostId,
          job.t3ProjectId,
          job.state,
          job.title,
          job.branch,
          job.runtimeMode,
          job.threadId,
          job.threadTitle,
          job.threadLink,
          job.lastRunId,
          JSON.stringify(job.pendingRequestIds),
          job.latestMessageExcerpt,
          job.latestActivityAt,
          job.readPosition,
          job.lastErrorCode,
          job.lastErrorMessage,
          now,
          now,
          now,
          isTerminal(job.state) ? now : null,
          JSON.stringify(job.delegatedWork),
          job.activityPosition,
        );
      this.#insertEvent(job.id, 'created', null, job.state, { reason: 'adopted' }, now);
      this.#logger.info('job.adopted', { jobId: job.id, project: job.projectAlias, hostId: job.hostId, state: job.state });
      return { job: this.require(job.id), created: true };
    });
  }

  /**
   * Move a job to `to` if it is currently in one of `from`, applying `changes` and appending a
   * `state_changed` event. Returns the updated job, or undefined when the job was in another state.
   * `to` may equal the current state: then only the changes are applied, guarded by that state.
   */
  transition(id: string, options: TransitionOptions): Job | undefined {
    return transaction(this.#db, () => {
      const current = this.get(id);
      if (!current || !options.from.includes(current.state)) return undefined;
      const now = this.#clock();
      if (!this.#write(current, options.changes ?? {}, now, options.to)) return current;
      if (current.state !== options.to) {
        this.#insertEvent(id, 'state_changed', current.state, options.to, options.detail ?? {}, now);
        this.#logger.info('job.state_changed', {
          jobId: id,
          from: current.state,
          to: options.to,
          reason: options.detail?.reason,
          errorCode: options.detail?.code,
        });
      }
      return this.get(id);
    });
  }

  /** Change fields without changing state and without an event. */
  update(id: string, changes: JobChanges): void {
    const current = this.get(id);
    if (current) this.#write(current, changes, this.#clock());
  }

  /** Record an event that is not a state change (for example a follow-up sent to a running job). */
  appendEvent(id: string, type: string, state: JobState, detail: EventDetail = {}): void {
    this.#insertEvent(id, type, state, state, detail, this.#clock());
  }

  /** Mark every open job on a host as unreachable since `since`, keeping an earlier mark. A change bumps `updatedAt`. */
  markHostUnreachable(hostId: string, since: number): void {
    this.#db
      .prepare(
        'UPDATE jobs SET host_unreachable_since = ?, updated_at = ? ' +
          `WHERE host_id = ? AND host_unreachable_since IS NULL AND state NOT IN (${NOT_OPEN})`,
      )
      .run(since, this.#clock(), hostId, ...TERMINAL_STATES);
  }

  clearHostUnreachable(hostId: string): void {
    this.#db
      .prepare('UPDATE jobs SET host_unreachable_since = NULL, updated_at = ? WHERE host_id = ? AND host_unreachable_since IS NOT NULL')
      .run(this.#clock(), hostId);
  }

  /** The latest events of one job, oldest first. */
  recentEvents(jobId: string, limit: number): JobEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM (SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(jobId, limit) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /** Events after `cursor` (exclusive), oldest first, with their job's project and title. */
  eventsAfter(cursor: number, limit: number, clientId?: string): FeedEvent[] {
    const mine = clientId === undefined ? '' : 'AND jobs.client_id = ?';
    const rows = this.#db
      .prepare(
        `SELECT job_events.*, jobs.project_alias, jobs.title FROM job_events JOIN jobs ON jobs.id = job_events.job_id
          WHERE job_events.id > ? ${mine} ORDER BY job_events.id LIMIT ?`,
      )
      .all(...(clientId === undefined ? [cursor, limit] : [cursor, clientId, limit])) as unknown as (EventRow & { project_alias: string; title: string })[];
    return rows.map((row) => ({ ...toEvent(row), projectAlias: row.project_alias, title: row.title }));
  }

  /**
   * Jobs that want the agent's attention, most recent state change first: blocked or unconfirmed
   * jobs at any age, and jobs that went idle or failed within `recentMs`.
   */
  attention(now: number, recentMs: number, limit: number, clientId?: string): Job[] {
    const mine = clientId === undefined ? '' : 'AND client_id = ?';
    const rows = this.#db
      .prepare(
        `SELECT * FROM jobs
          WHERE (state IN ('needs_input', 'unknown') OR (state IN ('idle', 'failed') AND state_changed_at >= ?)) ${mine}
          ORDER BY state_changed_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...(clientId === undefined ? [now - recentMs, limit] : [now - recentMs, clientId, limit])) as unknown as JobRow[];
    return rows.map(toJob);
  }

  idempotencyKey(clientId: string, tool: IdempotentTool, requestId: string): IdempotencyKey | undefined {
    const row = this.#db
      .prepare('SELECT input_hash, job_id, response FROM idempotency_keys WHERE client_id = ? AND tool = ? AND request_id = ?')
      .get(clientId, tool, requestId) as { input_hash: string; job_id: string; response: string | null } | undefined;
    return row && { inputHash: row.input_hash, jobId: row.job_id, response: row.response };
  }

  /** Claim a request id for a tool before calling T3, so a retry can tell an earlier attempt happened. */
  claimIdempotencyKey(clientId: string, tool: IdempotentTool, requestId: string, key: Omit<IdempotencyKey, 'response'>): void {
    this.#db
      .prepare('INSERT INTO idempotency_keys (client_id, request_id, tool, input_hash, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(clientId, requestId, tool, key.inputHash, key.jobId, this.#clock());
  }

  completeIdempotencyKey(clientId: string, tool: IdempotentTool, requestId: string, response: string): void {
    this.#db
      .prepare('UPDATE idempotency_keys SET response = ? WHERE client_id = ? AND tool = ? AND request_id = ?')
      .run(response, clientId, tool, requestId);
  }

  /** Release a request id whose call definitely did not happen, so the agent may retry with it. */
  releaseIdempotencyKey(clientId: string, tool: IdempotentTool, requestId: string): void {
    this.#db
      .prepare('DELETE FROM idempotency_keys WHERE client_id = ? AND tool = ? AND request_id = ? AND response IS NULL')
      .run(clientId, tool, requestId);
  }

  /** Write what differs from `current`. Returns false, writing nothing, when nothing differs. */
  #write(current: Job, changes: JobChanges, now: number, state?: JobState): boolean {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (state !== undefined && state !== current.state) {
      sets.push('state = ?', 'state_changed_at = ?', 'finished_at = ?');
      params.push(state, now, isTerminal(state) ? now : null);
    }
    for (const [key, value] of Object.entries(changes) as [keyof JobChanges, JobChanges[keyof JobChanges]][]) {
      if (value === undefined) continue;
      const next = columnValue(key, value);
      if (next === columnValue(key, current[key])) continue;
      sets.push(`${COLUMNS[key]} = ?`);
      params.push(next);
    }
    if (sets.length === 0) return false;
    sets.push('updated_at = ?');
    params.push(now);
    this.#db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params, current.id);
    return true;
  }

  #insertEvent(jobId: string, type: string, from: JobState | null, to: JobState | null, detail: EventDetail, now: number): void {
    const json = Object.keys(detail).length > 0 ? JSON.stringify(detail) : null;
    this.#db
      .prepare('INSERT INTO job_events (job_id, type, from_state, to_state, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jobId, type, from, to, json, now);
  }
}
