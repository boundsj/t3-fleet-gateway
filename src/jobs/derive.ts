import { ACTIVE_RUN_STATUSES, THREAD_STATUSES, type ThreadItem, type ThreadRead } from '../t3/schemas.ts';
import type { JobState } from './states.ts';
import type { Job } from './store.ts';

/** The worker message excerpt kept per job, in characters. Also passed to T3 as `maxCharsPerItem`. */
export const EXCERPT_CHARS = 2000;
const MAX_LINK_CHARS = 2048;
const LINK_SCHEMES = new Set(['t3-thread:', 'https:', 'http:']);

/** Timeline item statuses that mean the item may still change (for example a message being streamed). */
const UNSETTLED_ITEM_STATUSES = new Set(['pending', 'running', 'waiting']);
/** Statuses of a `subagent` item whose delegated work is still going. */
const DELEGATED_ACTIVE_STATUSES = new Set([...UNSETTLED_ITEM_STATUSES, ...ACTIVE_RUN_STATUSES]);

/** Delegated tasks followed per job, at most; and the characters of each title kept. */
export const MAX_DELEGATED_TASKS = 20;
const MAX_DELEGATED_TITLE_CHARS = 200;

export function isUnsettled(item: ThreadItem): boolean {
  return UNSETTLED_ITEM_STATUSES.has(item.status);
}

/**
 * Whether the read position must stop before this item: a worker message that may still change (being
 * streamed) is read again once settled, for the excerpt. Other unsettled items, such as a command still
 * running or delegated work (followed by item id instead, see trackDelegated), never hold it back, so a
 * long-lived one cannot hide the replies that come after it.
 */
export function holdsReadPosition(item: ThreadItem): boolean {
  return isUnsettled(item) && isWorkerMessage(item);
}

/**
 * A task the thread delegated to another thread (a T3 subagent), followed until it finishes. T3 shows
 * delegated work in the parent's timeline as one `subagent` item (no creator, title = the child's task
 * title, text = the child's final summary once it is done); the child's own messages never appear there.
 */
export interface DelegatedTask {
  itemId: string;
  position: number;
  title: string;
}

export function isDelegatedWork(item: ThreadItem): boolean {
  return /subagent/i.test(item.type);
}

/** A `subagent` item whose work is still going. */
export function isDelegatedWorkActive(item: ThreadItem): boolean {
  return isDelegatedWork(item) && DELEGATED_ACTIVE_STATUSES.has(item.status);
}

function delegatedTask(item: ThreadItem): DelegatedTask {
  const title = typeof item.title === 'string' ? item.title.replaceAll(/\s+/g, ' ').trim().slice(0, MAX_DELEGATED_TITLE_CHARS) : '';
  return { itemId: item.itemId, position: item.position, title: title || 'Untitled delegated task' };
}

/**
 * The delegated tasks still running after this read. `items` are the items read now; `refreshed` holds
 * the latest version of followed tasks that were not among them (null: T3 no longer has the item). A
 * followed task stays until T3 shows its item settled or gone; a task not read again is kept as it was.
 */
export function trackDelegated(
  previous: readonly DelegatedTask[],
  items: readonly ThreadItem[],
  refreshed: ReadonlyMap<string, ThreadItem | null> = new Map(),
): DelegatedTask[] {
  const latest = new Map<string, ThreadItem | null>(refreshed);
  for (const item of items) if (isDelegatedWork(item)) latest.set(item.itemId, item);
  const tasks = new Map<string, DelegatedTask>();
  for (const task of previous) {
    const item = latest.get(task.itemId);
    if (item === undefined) tasks.set(task.itemId, task);
    else if (item !== null && isDelegatedWorkActive(item)) tasks.set(task.itemId, delegatedTask(item));
    latest.delete(task.itemId);
  }
  for (const item of latest.values()) if (item !== null && isDelegatedWorkActive(item)) tasks.set(item.itemId, delegatedTask(item));
  return [...tasks.values()].sort((a, b) => a.position - b.position).slice(0, MAX_DELEGATED_TASKS);
}

/** What `observe` needs to know about the job. */
export type ObservedJob = Pick<Job, 'state' | 'lastRunId' | 'readPosition' | 'threadLink' | 'latestActivityAt' | 'standing' | 'delegatedWork'>;

/** States the watcher can derive from a thread. */
export type ObservedState = Extract<JobState, 'running' | 'needs_input' | 'idle' | 'failed' | 'cancel_requested' | 'cancelled'>;

export interface Observation {
  state: ObservedState;
  /** Why, for the event: the T3 status that decided it. */
  reason: string;
  /** Set when the turn ended with a failed run: the job moves to failed (a standing job to idle). */
  errorCode?: string;
  pendingRequestIds: string[];
  /** The run the job now follows: the thread's latest run once the turn is over. */
  lastRunId: string | null;
  /** The newest settled worker message in this read, bounded; undefined when there is none. */
  excerpt?: string;
  activityAt: number | null;
  /** `afterPosition` for the next read: never past an item that may still change. */
  readPosition: number | null;
  /** The job was already idle and another turn has finished since (someone continued it in T3). */
  anotherTurnFinished: boolean;
  /** The thread's app link, when the job has none yet. */
  link?: string;
  /** Work the thread delegated to other threads that is still running. */
  delegatedWork: DelegatedTask[];
}

/**
 * The URL in a T3 thread link. T3 returns a markdown link, `[Title](t3-thread://v1/<environment>/<thread>)`,
 * meant to be pasted for a person; the target opens the thread in the T3 app. A bare URL is accepted
 * too. Returns null for anything else, including schemes other than t3-thread, https and http.
 */
export function threadLinkTarget(link: string): string | null {
  const text = link.trim();
  const target = /\]\(([^()\s]+)\)$/.exec(text)?.[1] ?? text;
  if (target.length > MAX_LINK_CHARS) return null;
  try {
    return LINK_SCHEMES.has(new URL(target).protocol) ? target : null;
  } catch {
    return null;
  }
}

/**
 * Whether a timeline item is the worker's own message. T3's messages view returns user messages,
 * assistant messages and proposed plans; the item `type` names the kind, and `creationSource` is
 * `provider` for model output. Messages the gateway or a person sent are never worker output: the
 * launch prompt and follow-ups are `user_message` items created by `agent` through `mcp`. Other
 * activity (command executions, checkpoints) is not a message even when the provider produced it.
 */
export function isWorkerMessage(item: ThreadItem): boolean {
  if (item.createdBy === 'user' || /user/i.test(item.type)) return false;
  return /assistant|plan/i.test(item.type) || (item.creationSource === 'provider' && /message/i.test(item.type));
}

/** Whether a thread or run status means work is going on (or about to). */
export function isActiveStatus(status: string): boolean {
  // A status this build does not know is treated as active: wait rather than declare the turn over.
  return ACTIVE_RUN_STATUSES.includes(status) || !(THREAD_STATUSES as readonly string[]).includes(status);
}

function parseTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Derive a job's state from one `t3_thread_read` (possibly several pages, items concatenated) and
 * the thread's pending question ids. The rules, in order:
 *
 * 1. `cancel_requested` becomes `cancelled` once nothing is active (below), else stays.
 * 2. `needs_input` when T3 lists pending questions, or the thread or the followed run is `waiting`
 *    (`pendingRequestCount` > 0 with nothing answerable means a permission approval).
 * 3. `running` while the thread has an `activeRunId`, its `status` is preparing, queued, starting,
 *    running or waiting, or the run the gateway started (`lastRunId` in `recentRuns`) is still in one
 *    of those statuses.
 * 4. `failed` when the turn ended with the latest run (or the thread) `failed`. A standing job is a
 *    long-lived thread that takes the next instruction after a failed run too, so it becomes `idle`
 *    instead, with the same error code.
 * 5. Otherwise `idle`: the turn is over (completed, interrupted, cancelled, rolled back, or a thread
 *    with no run) and the thread is waiting for its next instruction, or (reason
 *    `waiting_on_delegated_work`) for work it delegated, after which T3 starts its next turn by itself.
 *
 * An idle job that is running again was not continued by the gateway (that moves it to running
 * itself): the reason is `turn_started`. `refreshed` is passed to trackDelegated.
 */
export function observe(
  job: ObservedJob,
  read: ThreadRead,
  pendingQuestionIds: readonly string[],
  refreshed?: ReadonlyMap<string, ThreadItem | null>,
): Observation {
  const { thread, recentRuns } = read;
  const followed = job.lastRunId === null ? undefined : recentRuns.find((run) => run.runId === job.lastRunId);
  const latest = recentRuns.find((run) => run.runId === thread.latestRunId) ?? recentRuns[0];
  const active = thread.activeRunId !== null || isActiveStatus(thread.status) || (followed !== undefined && isActiveStatus(followed.status));
  const blocked =
    pendingQuestionIds.length > 0 || thread.status === 'waiting' || followed?.status === 'waiting' || (active && thread.pendingRequestCount > 0);

  let state: ObservedState;
  let reason = thread.status;
  let errorCode: string | undefined;
  if (job.state === 'cancel_requested') {
    state = active ? 'cancel_requested' : 'cancelled';
    reason = active ? thread.status : 'interrupted';
  } else if (blocked) {
    state = 'needs_input';
    reason = pendingQuestionIds.length > 0 ? 'question' : 'approval';
  } else if (active) {
    state = 'running';
    if (job.state === 'idle') reason = 'turn_started';
  } else if ((latest?.status ?? thread.status) === 'failed' || thread.status === 'failed') {
    state = job.standing ? 'idle' : 'failed';
    reason = 'run_failed';
    errorCode = 't3_run_failed';
  } else {
    state = 'idle';
    reason = latest?.status ?? thread.status;
  }

  const items = [...read.items].sort((a, b) => a.position - b.position);
  const delegatedWork = trackDelegated(job.delegatedWork, items, refreshed);
  if (state === 'idle' && reason !== 'run_failed' && delegatedWork.length > 0) reason = 'waiting_on_delegated_work';
  const message = items.findLast((item) => isWorkerMessage(item) && !isUnsettled(item) && item.text !== null && item.text.trim().length > 0);
  // Items come back with positions after the stored one, so stopping before a held item never goes backwards.
  const held = items.find(holdsReadPosition);
  let readPosition: number | null;
  if (held) readPosition = held.position > 0 ? held.position - 1 : null;
  else readPosition = read.nextPosition ?? items.at(-1)?.position ?? job.readPosition;

  const times = [parseTime(thread.updatedAt), ...items.map((item) => parseTime(item.updatedAt))].filter((value): value is number => value !== null);
  const link = job.threadLink === null ? threadLinkTarget(thread.link) : null;
  const turnOver = state === 'idle' || state === 'failed' || state === 'cancelled';
  const lastRunId = turnOver ? (thread.latestRunId ?? job.lastRunId) : job.lastRunId;

  return {
    state,
    reason,
    ...(errorCode ? { errorCode } : {}),
    pendingRequestIds: [...pendingQuestionIds],
    lastRunId,
    ...(message?.text ? { excerpt: message.text.slice(0, EXCERPT_CHARS) } : {}),
    activityAt: times.length > 0 ? Math.max(...times) : job.latestActivityAt,
    readPosition,
    anotherTurnFinished: job.state === 'idle' && state === 'idle' && lastRunId !== job.lastRunId,
    ...(link ? { link } : {}),
    delegatedWork,
  };
}
