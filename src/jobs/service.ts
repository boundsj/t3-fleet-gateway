import type { GatewayConfig, ProjectConfig } from '../config.ts';
import { sha256Hex } from '../crypto.ts';
import { describeError, GatewayError } from '../errors.ts';
import { resolveProjectId } from '../hosts/projects.ts';
import type { HostRegistry } from '../hosts/registry.ts';
import type { Logger } from '../log.ts';
import { T3TransportError, type T3Client } from '../t3/client.ts';
import { T3ToolError } from '../t3/results.ts';
import type { ThreadItem, ThreadRead } from '../t3/schemas.ts';
import { HOUR, SECOND, type Clock } from '../time.ts';
import { scanActivity } from './activity.ts';
import { EXCERPT_CHARS, holdsReadPosition, isActiveStatus, observe, threadLinkTarget, type ActivityRead } from './derive.ts';
import { newJobId } from './ids.ts';
import { cancelRequestId } from './interrupt.ts';
import { isTerminal, OPEN_STATES, type JobState } from './states.ts';
import type { FeedEvent, Job, JobEvent, JobStore } from './store.ts';

/** Bounds on agent-supplied text. T3 accepts up to 120,000 characters per message. */
export const MAX_TASK_CHARS = 20_000;
export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_ANSWERS_CHARS = 16_000;
/** Idle and failed jobs stay in the feed's attention list this long after their last change. */
export const ATTENTION_RECENT_MS = 24 * HOUR;
const MAX_ATTENTION = 50;
const MAX_QUESTION_READS = 5;
const QUESTION_READ_TIMEOUT_MS = 5 * SECOND;
export const MAX_TITLE_CHARS = 80;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const TITLE_FROM_TASK_CHARS = 60;
/** Pages of 100 messages read to find the end of a thread being adopted (messages view). */
const MAX_ADOPT_PAGES = 1000;

export interface Caller {
  clientId: string;
}

export interface StartInput {
  project: string;
  task: string;
  requestId: string;
  title?: string | undefined;
}

export interface ContinueInput {
  jobId: string;
  message: string;
  requestId: string;
}

export interface RespondInput {
  jobId: string;
  requestId: string;
  answers: Record<string, unknown>;
}

export interface ContinueResult {
  job: Job;
  /** How T3 took the message: started a new turn, steered or queued behind the active one. */
  delivery: string;
  /** True when this requestId had already been delivered and nothing was sent again. */
  replayed: boolean;
}

/**
 * `interrupt_requested` and `not_running` are for standing jobs, which work_cancel never closes: the
 * run is interrupted (the job becomes idle once T3 confirms) or nothing was running.
 */
export type CancelOutcome = 'cancelled' | 'cancel_requested' | 'already_finished' | 'interrupt_requested' | 'not_running';

export interface CancelResult {
  job: Job;
  outcome: CancelOutcome;
  /** T3 has the interrupt request (or no T3 call was needed). */
  delivered: boolean;
  /**
   * A standing job with nothing running whose thread T3 still lists questions for: interrupting does
   * not withdraw them, so they still need an answer (work_respond).
   */
  pendingQuestionIds?: string[];
}

export interface AdoptInput {
  project: string;
  threadId: string;
  /** Shown to agents instead of the thread's T3 title. */
  title?: string | undefined;
}

export interface Feed {
  events: FeedEvent[];
  nextCursor: number;
  hasMore: boolean;
  attention: Job[];
}

export interface JobServiceOptions {
  config: GatewayConfig;
  store: JobStore;
  registry: HostRegistry;
  clock: Clock;
  logger: Logger;
}

export interface PendingQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; value: string | null }[];
  multiSelect: boolean;
}

export interface JobDetail {
  job: Job;
  recentEvents: JobEvent[];
  /** Questions the worker waits on. `questions` is null when they could not be read from T3. */
  pendingRequests: { requestId: string; questions: PendingQuestion[] | null }[];
  /** Blocked with no answerable question: a permission approval only the operator can give in T3. */
  waitingForApproval: boolean;
}

/** A stable hash of a tool's meaningful input, for request-id idempotency. */
export function inputHash(tool: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  return sha256Hex(JSON.stringify([tool, keys.map((key) => [key, input[key] ?? null])]));
}

/** Why work_start is refused in a project, and where to send the work instead. */
function startDisabledMessage(alias: string, standing: Job[]): string {
  const where =
    standing.length === 0
      ? 'It has no standing job yet; ask the operator to adopt one (t3-fleet-gateway jobs adopt).'
      : `Send the work to its standing job with work_continue instead: ${standing.map((job) => `${job.id} ("${job.title}", ${job.state})`).join(', ')}. ` +
        'Follow it with work_feed and work_status.';
  return `Project "${alias}" does not accept work_start (allowWorkStart is false). ${where}`;
}

/** Anything shaped like a job marker, in any case or spacing. */
const MARKER_LIKE = /\[\s*job\s*:[^\]]*\]/gi;

/**
 * A one-line thread title: the agent's title, or the task's first line, then the job marker. Text
 * shaped like a marker is removed from the agent's part first, so a title cannot carry another job's
 * marker and be taken for that job's thread by reconciliation.
 */
export function threadTitle(jobId: string, task: string, title: string | undefined): string {
  const clean = (text: string) => text.replaceAll(MARKER_LIKE, ' ').replaceAll(/\s+/g, ' ').trim();
  const source = clean(title ?? '') || task.split('\n').map(clean).find((line) => line.length > 0) || 'Job';
  const short = source.length > TITLE_FROM_TASK_CHARS ? `${source.slice(0, TITLE_FROM_TASK_CHARS - 1).trimEnd()}…` : source;
  return `${short} ${jobMarker(jobId)}`;
}

/** The marker in every job thread's title; reconciliation finds launched threads by it. */
export function jobMarker(jobId: string): string {
  return `[job:${jobId}]`;
}

/**
 * The job operations behind the work_* tools. Starting a job only records it; the engine
 * (dispatcher and watcher) talks to T3. `wake` lets the engine react at once instead of at its next tick.
 */
export class JobService {
  readonly store: JobStore;
  readonly #config: GatewayConfig;
  readonly #registry: HostRegistry;
  readonly #clock: Clock;
  readonly #logger: Logger;
  /** Set by the running gateway so new work is dispatched without waiting for the next poll. */
  wake: () => void = () => {};

  constructor(options: JobServiceOptions) {
    this.store = options.store;
    this.#config = options.config;
    this.#registry = options.registry;
    this.#clock = options.clock;
    this.#logger = options.logger;
  }

  project(alias: string): ProjectConfig {
    const project = this.#config.projects.find((candidate) => candidate.alias === alias);
    if (!project) {
      const known = this.#config.projects.map((candidate) => candidate.alias).join(', ') || '(none configured)';
      throw new GatewayError('not_found', `No project "${alias}". Known projects: ${known}. fleet_status lists them.`);
    }
    return project;
  }

  start(caller: Caller, input: StartInput): { job: Job; created: boolean } {
    const project = this.project(input.project);
    // A retry of a request made before the operator turned work_start off still gets its job back.
    if (!project.allowWorkStart && !this.store.idempotencyKey(caller.clientId, 'work_start', input.requestId)) {
      throw new GatewayError('start_disabled', startDisabledMessage(project.alias, this.store.standingJobs(project.alias)));
    }
    const id = newJobId();
    const result = this.store.create({
      id,
      clientId: caller.clientId,
      requestId: input.requestId,
      inputHash: inputHash('work_start', { project: input.project, task: input.task, title: input.title }),
      projectAlias: project.alias,
      hostId: project.host,
      task: input.task,
      title: threadTitle(id, input.task, input.title),
      branch: `${project.branchPrefix}${id}`,
      runtimeMode: project.runtimeMode,
    });
    if (result.created) this.wake();
    return result;
  }

  list(filter: { project?: string | undefined; states?: readonly JobState[] | undefined; mine?: boolean | undefined; limit: number }, caller: Caller): Job[] {
    if (filter.project !== undefined) this.project(filter.project);
    return this.store.list({
      limit: filter.limit,
      ...(filter.project === undefined ? {} : { projectAlias: filter.project }),
      ...(filter.states === undefined ? {} : { states: filter.states }),
      ...(filter.mine ? { clientId: caller.clientId } : {}),
    });
  }

  /** One job with its recent events and, read live from T3, the questions it waits on. */
  async status(jobId: string): Promise<JobDetail> {
    const job = this.store.require(jobId);
    const pendingRequests = await Promise.all(
      job.pendingRequestIds.map(async (requestId, index) => ({
        requestId,
        questions: index < MAX_QUESTION_READS && job.threadId !== null ? await this.#questions(job.hostId, job.threadId, requestId) : null,
      })),
    );
    return {
      job,
      recentEvents: this.store.recentEvents(jobId, 10),
      pendingRequests,
      waitingForApproval: job.state === 'needs_input' && job.pendingRequestIds.length === 0,
    };
  }

  async #questions(hostId: string, threadId: string, requestId: string): Promise<PendingQuestion[] | null> {
    try {
      const request = await this.#registry.client(hostId).readPendingRequest(threadId, requestId, { timeoutMs: QUESTION_READ_TIMEOUT_MS });
      return request.questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        options: question.options.map((option) => ({ label: option.label, description: option.description, value: option.value ?? null })),
        multiSelect: question.multiSelect ?? false,
      }));
    } catch (error) {
      this.#logger.debug('jobs.question_read_failed', { hostId, errorCode: describeError(error).code });
      return null;
    }
  }

  /**
   * Adopt an existing T3 thread as a standing job (operator CLI only). The thread must belong to the
   * project's T3 project. Its state comes from a read now, and both read positions (messages and
   * activity view) start at the thread's current end, so the watcher follows only what happens from now
   * on; delegated work still running is found by a bounded scan back through the activity view
   * (scanActivity). Adopting a thread that is already a standing job of the project returns that job
   * (`created: false`).
   */
  async adopt(input: AdoptInput): Promise<{ job: Job; created: boolean }> {
    const project = this.project(input.project);
    const existing = this.store.openJobForThread(input.threadId);
    if (existing?.standing && existing.projectAlias === project.alias) return { job: existing, created: false };
    const client = this.#registry.client(project.host);
    const projectId = await resolveProjectId(this.#registry, project);
    let read: ThreadRead;
    let questions: string[];
    let activity: ActivityRead;
    try {
      read = await readToEnd(client, input.threadId);
      questions = await client.listPendingRequests(input.threadId);
      activity = await scanActivity(client, input.threadId, read.items.at(-1)?.position ?? read.nextPosition);
    } catch (error) {
      if (error instanceof T3ToolError && /not_found/.test(error.t3Code)) {
        throw new GatewayError('not_found', `Host ${project.host} has no T3 thread ${input.threadId} (${error.t3Code}).`);
      }
      throw error;
    }
    const { thread } = read;
    if (thread.projectId !== projectId) {
      throw new GatewayError(
        'invalid_argument',
        `Thread ${input.threadId} belongs to T3 project ${thread.projectId}, not to project "${project.alias}" (T3 project ${projectId}).`,
      );
    }
    const lastRunId = thread.activeRunId ?? thread.latestRunId;
    const seen = observe(
      {
        state: 'idle',
        lastRunId,
        readPosition: null,
        activityPosition: null,
        threadLink: null,
        latestActivityAt: null,
        standing: true,
        delegatedWork: [],
        delegatedUntracked: 0,
        delegatedUntrackedRunId: null,
      },
      read,
      questions,
      activity,
    );
    const runtimeMode = (thread as { runtimeMode?: unknown }).runtimeMode;
    return this.store.adopt({
      id: newJobId(),
      projectAlias: project.alias,
      hostId: project.host,
      t3ProjectId: projectId,
      state: seen.state,
      title: input.title ?? thread.title,
      branch: thread.branch ?? '',
      runtimeMode: typeof runtimeMode === 'string' ? runtimeMode : '',
      threadId: thread.threadId,
      threadTitle: thread.title,
      threadLink: threadLinkTarget(thread.link),
      lastRunId: seen.lastRunId,
      pendingRequestIds: seen.pendingRequestIds,
      latestMessageExcerpt: seen.excerpt ?? null,
      latestActivityAt: seen.activityAt,
      readPosition: seen.readPosition,
      activityPosition: seen.activityPosition,
      lastErrorCode: seen.errorCode ?? null,
      lastErrorMessage: seen.errorCode ? 'The latest T3 run failed. Open the thread in T3 for details.' : null,
      delegatedWork: seen.delegatedWork,
      delegatedUntracked: seen.delegatedUntracked,
      delegatedUntrackedRunId: seen.delegatedUntrackedRunId,
    });
  }

  /**
   * Stop following a standing job (operator CLI only): it becomes `released`. T3 is not contacted,
   * so the thread and any run on it carry on untouched. `released` is false when it was already finished.
   */
  release(jobId: string): { job: Job; released: boolean } {
    const job = this.store.require(jobId);
    if (!job.standing) {
      throw new GatewayError(
        'invalid_argument',
        `Job ${job.id} was started by an agent, not adopted; only standing jobs are released. Stop it with work_cancel instead.`,
      );
    }
    const released = this.store.transition(job.id, { from: OPEN_STATES, to: 'released', detail: { reason: 'released' } });
    return released ? { job: released, released: true } : { job: this.store.require(job.id), released: false };
  }

  /**
   * Send a follow-up instruction to the job's thread. Idempotent on requestId: a delivered request is
   * not sent again, and a request whose first attempt had an unknown outcome is re-sent with the same
   * T3 clientRequestId, which T3 deduplicates.
   */
  async continue(caller: Caller, input: ContinueInput): Promise<ContinueResult> {
    let job = this.store.require(input.jobId);
    const hash = inputHash('work_continue', { jobId: input.jobId, message: input.message });
    const key = this.store.idempotencyKey(caller.clientId, 'work_continue', input.requestId);
    if (key) {
      if (key.jobId !== input.jobId || key.inputHash !== hash) {
        throw new GatewayError('request_id_conflict', `requestId "${input.requestId}" was already used for a different request. Use a new requestId.`);
      }
      if (key.response !== null) {
        const stored = JSON.parse(key.response) as { delivery?: string };
        return { job, delivery: stored.delivery ?? 'unknown', replayed: true };
      }
    } else {
      if (!['idle', 'running', 'needs_input'].includes(job.state) || job.threadId === null) {
        throw new GatewayError('job_state_conflict', `Job ${job.id} is ${job.state}; work_continue needs a job that is idle, running or needs_input.`);
      }
      this.store.claimIdempotencyKey(caller.clientId, 'work_continue', input.requestId, { inputHash: hash, jobId: job.id });
    }
    const threadId = job.threadId;
    if (threadId === null) throw new GatewayError('job_state_conflict', `Job ${job.id} has no thread.`);
    let sent;
    try {
      sent = await this.#registry.client(job.hostId).sendToThread({
        threadId,
        message: input.message,
        mode: 'auto',
        clientRequestId: `t3fg-${job.id}-${sha256Hex(`${caller.clientId}\n${input.requestId}`).slice(0, 24)}`,
      });
    } catch (error) {
      if (error instanceof T3ToolError || (error instanceof T3TransportError && error.delivery === 'not_delivered')) {
        this.store.releaseIdempotencyKey(caller.clientId, 'work_continue', input.requestId);
        throw error;
      }
      const described = describeError(error);
      throw new GatewayError(
        described.code,
        `${described.message}. The message may or may not have reached T3: call work_continue again with the same requestId; T3 deduplicates it.`,
      );
    }
    this.store.completeIdempotencyKey(caller.clientId, 'work_continue', input.requestId, JSON.stringify({ runId: sent.runId, delivery: sent.delivery }));
    job = this.store.require(job.id);
    const moved = this.store.transition(job.id, {
      from: ['idle'],
      to: 'running',
      changes: { lastRunId: sent.runId, lastErrorCode: null, lastErrorMessage: null },
      detail: { reason: 'followup' },
    });
    if (!moved && !isTerminal(job.state)) {
      this.store.update(job.id, { lastRunId: sent.runId });
      this.store.appendEvent(job.id, 'followup_sent', job.state, { reason: sent.delivery });
    }
    this.wake();
    return { job: this.store.require(job.id), delivery: sent.delivery, replayed: false };
  }

  /** Answer one of the job's pending questions. Only requests T3 lists for the job's own thread are accepted. */
  async respond(input: RespondInput): Promise<Job> {
    const job = this.store.require(input.jobId);
    if (job.threadId === null || isTerminal(job.state)) {
      throw new GatewayError('job_state_conflict', `Job ${job.id} is ${job.state}; it has no question to answer.`);
    }
    const client = this.#registry.client(job.hostId);
    const pending = await client.listPendingRequests(job.threadId);
    if (!pending.includes(input.requestId)) {
      const hint =
        pending.length > 0
          ? `Pending on this job: ${pending.join(', ')}.`
          : job.state === 'needs_input'
            ? 'The job is waiting for a permission approval, which only the operator can give in T3.'
            : 'The job has no pending questions.';
      throw new GatewayError('not_found', `Request ${input.requestId} is not pending on job ${job.id}. ${hint}`);
    }
    await client.respondToPendingRequest(job.threadId, input.requestId, input.answers);
    const remaining = pending.filter((id) => id !== input.requestId);
    this.store.appendEvent(job.id, 'input_answered', job.state, { requestId: input.requestId });
    const moved =
      remaining.length === 0 &&
      this.store.transition(job.id, { from: ['needs_input'], to: 'running', changes: { pendingRequestIds: remaining }, detail: { reason: 'input_answered' } });
    if (!moved) this.store.update(job.id, { pendingRequestIds: remaining });
    this.wake();
    return this.store.require(job.id);
  }

  /**
   * Cancel a job. Queued jobs are cancelled without contacting T3. A job with a thread is
   * interrupted first and then recorded: cancelled at once if T3 reports nothing running, else
   * cancel_requested until the watcher sees the thread stop. If T3 cannot be reached, or the launch
   * is in flight or unconfirmed, the job becomes cancel_requested and the engine delivers the
   * interrupt later. A T3 refusal is returned and the job keeps its state.
   */
  async cancel(input: { jobId: string }): Promise<CancelResult> {
    const job = this.store.require(input.jobId);
    if (job.standing) return this.#interruptStanding(job);
    if (job.state === 'queued') {
      const cancelled = this.store.transition(job.id, { from: ['queued'], to: 'cancelled', detail: { reason: 'cancelled_before_launch' } });
      return cancelled ? { job: cancelled, outcome: 'cancelled', delivered: true } : this.cancel(input);
    }
    if (isTerminal(job.state)) return { job, outcome: job.state === 'cancelled' ? 'cancelled' : 'already_finished', delivered: true };
    const request = { from: ['dispatching', 'unknown', 'running', 'needs_input', 'idle'] as JobState[], to: 'cancel_requested' as const, detail: { reason: 'cancel_requested' } };
    if (job.threadId === null) {
      // The launch is in flight or unconfirmed: the engine interrupts the thread if it turns up.
      const requested = job.state === 'cancel_requested' ? job : this.store.transition(job.id, request);
      return requested ? { job: requested, outcome: 'cancel_requested', delivered: false } : this.cancel(input);
    }
    let status: string;
    try {
      const client = this.#registry.client(job.hostId);
      // The interrupt's retry key names the run it stops, so learn which run is active first.
      const { thread } = await client.readThread({ threadId: job.threadId, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 1 });
      const result = await client.interruptThread({
        threadId: job.threadId,
        clientRequestId: cancelRequestId(job.id, thread.activeRunId ?? thread.latestRunId),
        reason: 'Cancelled through t3-fleet-gateway',
      });
      status = result.status;
    } catch (error) {
      if (error instanceof T3ToolError) throw error;
      this.#logger.warn('jobs.interrupt_deferred', { jobId: job.id, errorCode: describeError(error).code });
      const requested = this.store.transition(job.id, request) ?? this.store.require(job.id);
      return { job: requested, outcome: requested.state === 'cancel_requested' ? 'cancel_requested' : 'already_finished', delivered: false };
    }
    const requested = this.store.transition(job.id, request) ?? this.store.require(job.id);
    if (requested.state !== 'cancel_requested') return { job: requested, outcome: requested.state === 'cancelled' ? 'cancelled' : 'already_finished', delivered: true };
    if (status !== 'interrupt_requested') {
      const cancelled = this.store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', detail: { reason: status } });
      return { job: cancelled ?? this.store.require(job.id), outcome: 'cancelled', delivered: true };
    }
    this.wake();
    return { job: requested, outcome: 'cancel_requested', delivered: true };
  }

  /**
   * work_cancel on a standing job: interrupt the run that is active now and leave the job open; the
   * watcher moves it to idle when T3 reports the run stopped. Nothing is deferred: if T3 cannot be
   * reached the agent is told to repeat the call, and a repeat for the same run reuses its T3
   * clientRequestId, which T3 deduplicates. When nothing is active no interrupt is sent: T3 would
   * answer a repeat for an already stopped run from its record of the first interrupt. The questions
   * T3 still lists for the thread are returned then: if T3 keeps a question after the interrupt, the job
   * stays needs_input (the watcher derives it from that list) until it is answered with work_respond;
   * once T3 lists none, the stopped thread is idle.
   */
  async #interruptStanding(job: Job): Promise<CancelResult> {
    if (isTerminal(job.state) || job.threadId === null) return { job, outcome: 'already_finished', delivered: true };
    const client = this.#registry.client(job.hostId);
    let status: string;
    try {
      const { thread } = await client.readThread({ threadId: job.threadId, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 1 });
      if (thread.activeRunId === null && !isActiveStatus(thread.status)) {
        // T3 may keep a question listed after its turn was interrupted; only an answer clears it.
        const pendingQuestionIds = await client.listPendingRequests(job.threadId);
        this.wake();
        return { job: this.store.require(job.id), outcome: 'not_running', delivered: true, pendingQuestionIds };
      }
      const result = await client.interruptThread({
        threadId: job.threadId,
        clientRequestId: cancelRequestId(job.id, thread.activeRunId ?? thread.latestRunId),
        reason: 'Interrupted through t3-fleet-gateway',
      });
      status = result.status;
    } catch (error) {
      if (error instanceof T3ToolError || !(error instanceof GatewayError)) throw error;
      throw new GatewayError(error.code, `${error.message}. The interrupt may not have reached T3: call work_cancel again; repeating it is safe.`);
    }
    if (status !== 'interrupt_requested') {
      this.wake();
      return { job: this.store.require(job.id), outcome: 'not_running', delivered: true };
    }
    const current = this.store.require(job.id);
    if (!isTerminal(current.state)) this.store.appendEvent(job.id, 'interrupt_requested', current.state, { reason: 'interrupt_requested' });
    this.wake();
    return { job: this.store.require(job.id), outcome: 'interrupt_requested', delivered: true };
  }

  /** Events after `cursor` (exclusive) and the jobs needing attention. */
  feed(input: { cursor: number; limit: number; mine: boolean }, caller: Caller): Feed {
    const clientId = input.mine ? caller.clientId : undefined;
    const page = this.store.eventsAfter(input.cursor, input.limit + 1, clientId);
    const events = page.slice(0, input.limit);
    return {
      events,
      nextCursor: events.at(-1)?.id ?? input.cursor,
      hasMore: page.length > input.limit,
      attention: this.store.attention(this.#clock(), ATTENTION_RECENT_MS, MAX_ATTENTION, clientId),
    };
  }
}

/**
 * Read a thread to the end of its messages view, for adoption: the last page (or everything from the
 * first message that may still change, so a message being streamed is read again once settled) with the
 * thread's state. Bounded by MAX_ADOPT_PAGES; a longer thread is caught up by the watcher.
 */
async function readToEnd(client: T3Client, threadId: string): Promise<ThreadRead> {
  let afterPosition: number | null = null;
  let read: ThreadRead | undefined;
  let kept: ThreadItem[] = [];
  for (let page = 0; page < MAX_ADOPT_PAGES; page++) {
    read = await client.readThread({ threadId, view: 'messages', afterPosition, limit: 100, runLimit: 5, maxCharsPerItem: EXCERPT_CHARS });
    kept = kept.some(holdsReadPosition) ? [...kept, ...read.items] : read.items;
    if (!read.hasMore || read.nextPosition === null || read.nextPosition === afterPosition) break;
    afterPosition = read.nextPosition;
  }
  if (!read) throw new GatewayError('internal_error', 'No thread read');
  return { ...read, items: kept, nextPosition: read.nextPosition ?? afterPosition };
}
