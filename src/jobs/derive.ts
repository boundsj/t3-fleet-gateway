import { ACTIVE_RUN_STATUSES, THREAD_STATUSES, type ThreadItem, type ThreadRead } from '../t3/schemas.ts';
import type { JobState } from './states.ts';
import type { Job } from './store.ts';

/** The worker message excerpt kept per job, in characters. Also passed to T3 as `maxCharsPerItem`. */
export const EXCERPT_CHARS = 2000;
const MAX_LINK_CHARS = 2048;
const LINK_SCHEMES = new Set(['t3-thread:', 'https:', 'http:']);

/** Timeline item statuses that mean the item may still change (for example a message being streamed). */
const UNSETTLED_ITEM_STATUSES = new Set(['pending', 'running', 'waiting']);

/** States the watcher can derive from a thread. */
export type ObservedState = Extract<JobState, 'running' | 'needs_input' | 'idle' | 'failed' | 'cancel_requested' | 'cancelled'>;

export interface Observation {
  state: ObservedState;
  /** Why, for the event: the T3 status that decided it. */
  reason: string;
  /** Set when the job moves to failed. */
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

function isActiveStatus(status: string): boolean {
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
 * 4. `failed` when the turn ended with the latest run (or the thread) `failed`.
 * 5. Otherwise `idle`: the turn is over (completed, interrupted, cancelled, rolled back, or a thread
 *    with no run) and the thread is waiting for its next instruction.
 */
export function observe(job: Job, read: ThreadRead, pendingQuestionIds: readonly string[]): Observation {
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
  } else if ((latest?.status ?? thread.status) === 'failed' || thread.status === 'failed') {
    state = 'failed';
    reason = 'run_failed';
    errorCode = 't3_run_failed';
  } else {
    state = 'idle';
    reason = latest?.status ?? thread.status;
  }

  const items = [...read.items].sort((a, b) => a.position - b.position);
  const unsettled = items.find((item) => UNSETTLED_ITEM_STATUSES.has(item.status));
  const settled = unsettled ? items.filter((item) => item.position < unsettled.position) : items;
  const message = settled.findLast((item) => isWorkerMessage(item) && item.text !== null && item.text.trim().length > 0);
  // Items come back with positions after the stored one, so stopping before an unsettled item never goes backwards.
  let readPosition: number | null;
  if (unsettled) readPosition = unsettled.position > 0 ? unsettled.position - 1 : null;
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
  };
}
