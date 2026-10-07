import { configuredModel, type GatewayConfig, type HostConfig, type ProjectConfig, type RuntimeMode } from '../config.ts';
import { describeError, GatewayError } from '../errors.ts';
import type { HostRegistry } from '../hosts/registry.ts';
import { resolveProjectId } from '../hosts/projects.ts';
import type { Logger } from '../log.ts';
import { T3TransportError } from '../t3/client.ts';
import { T3ToolError } from '../t3/results.ts';
import type { LaunchResult, ThreadRead } from '../t3/schemas.ts';
import { MINUTE, SECOND, type Clock } from '../time.ts';
import { EXCERPT_CHARS, isActiveStatus, observe, threadLinkTarget } from './derive.ts';
import { deliverInterrupt } from './interrupt.ts';
import { jobMarker } from './service.ts';
import type { Job, JobChanges, JobStore } from './store.ts';

/** Launches can take a while: T3 prepares the worktree before answering. */
const LAUNCH_TIMEOUT_MS = 60 * SECOND;
const MAX_BACKOFF_MS = 5 * MINUTE;
/** Idle jobs are only checked for activity started from T3 itself, so less often. */
const IDLE_POLL_MS = MINUTE;
/** Pages of new timeline items read per job per tick. */
const MAX_READ_PAGES = 5;
const READ_PAGE_SIZE = 100;
const RECENT_RUNS = 5;

/** Error codes that mean the host as a whole cannot be used right now. */
const HOST_FAILURES = new Set(['host_unreachable', 't3_timeout', 't3_response_lost', 't3_unauthorized', 'host_not_enrolled']);

/**
 * T3 launch error codes that mean T3 refused before creating anything: the input was rejected (for
 * example no model selection where the project has no default), or the project or capability is
 * missing.
 */
const REFUSED_BEFORE_CREATION = new Set(['invalid_request', 'target_required', 'capability_denied', 'project_not_found']);

/** A job's thread as found or launched; `threadLink` is the app URL, when T3 gave a usable one. */
interface FoundThread {
  threadId: string;
  threadTitle: string;
  lastRunId: string | null;
  threadLink: string | null;
  /** The thread's T3 status, for a thread found by a lookup. */
  status?: string;
}

function foundThread(thread: { threadId: string; title: string; latestRunId: string | null; link: string; status: string }): FoundThread {
  const { threadId, title, latestRunId, link, status } = thread;
  return { threadId, threadTitle: title, lastRunId: latestRunId, threadLink: threadLinkTarget(link), status };
}

function isHostFailure(error: unknown): error is GatewayError {
  return error instanceof GatewayError && !(error instanceof T3ToolError) && HOST_FAILURES.has(error.code);
}

/** Appended to every task so the worker (and anyone reading the thread) knows where it came from. */
export function launchMessage(job: Job): string {
  return `${job.task}\n\n---\nStarted through t3-fleet-gateway as job ${job.id}, in a fresh worktree on branch ${job.branch}.`;
}

interface HostState {
  unreachableSince: number | null;
  failures: number;
  nextAttemptAt: number;
}

export interface JobEngineOptions {
  config: GatewayConfig;
  store: JobStore;
  registry: HostRegistry;
  clock: Clock;
  logger: Logger;
  /** Time between ticks. Defaults to `watcher.pollSeconds`. */
  intervalMs?: number;
  /** How long to wait for `t3_thread_launch`. Defaults to 60 seconds. */
  launchTimeoutMs?: number;
}

/**
 * The background half of the job layer. Each tick, per host: reconcile launches whose outcome is
 * unknown, watch jobs that have a thread, then dispatch queued jobs into free slots. Ticks never
 * overlap. Hosts that cannot be reached are backed off and their jobs keep their state. Nothing is
 * kept only in memory except backoff, the reconciliation clock and idle poll times, which restart
 * conservatively.
 */
export class JobEngine {
  readonly #options: JobEngineOptions;
  readonly #intervalMs: number;
  readonly #launchTimeoutMs: number;
  readonly #hosts = new Map<string, HostState>();
  readonly #projectIds = new Map<string, string>();
  /** Jobs this process is launching right now; any other `dispatching` job is stale. */
  readonly #inFlight = new Set<string>();
  /** When reconciliation first failed to find a job's thread while its host was reachable. */
  readonly #unconfirmedSince = new Map<string, { hostId: string; since: number }>();
  readonly #lastPolled = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  #current: Promise<void> = Promise.resolve();
  #next: Promise<void> | undefined;
  #stopped = false;

  constructor(options: JobEngineOptions) {
    this.#options = options;
    this.#intervalMs = options.intervalMs ?? options.config.watcher.pollSeconds * SECOND;
    this.#launchTimeoutMs = options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
  }

  /** Tick now and then every interval. */
  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    void this.tick();
  }

  /** Ask for a tick soon (after a new job or an agent action). No-op unless started. */
  wake(): void {
    if (this.#timer && !this.#stopped) void this.tick();
  }

  /** Stop ticking and wait for the tick in progress. All job state is already in the database. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#current;
  }

  /** Run one tick, or join the one already queued. Ticks run one at a time; tests call this directly. */
  tick(): Promise<void> {
    if (this.#next) return this.#next;
    const next = this.#current.then(async () => {
      this.#next = undefined;
      if (this.#stopped) return;
      await Promise.all(this.#options.config.hosts.map((host) => this.#tickHost(host)));
      this.#forgetFinished();
    });
    this.#next = next;
    this.#current = next.catch((error: unknown) => this.#options.logger.error('jobs.tick_failed', { errorCode: describeError(error).code }));
    return next;
  }

  /** Drop the in-memory poll times and reconciliation windows of jobs that have finished. */
  #forgetFinished(): void {
    if (this.#lastPolled.size === 0 && this.#unconfirmedSince.size === 0) return;
    const open = this.#options.store.openJobIds();
    for (const jobId of this.#lastPolled.keys()) if (!open.has(jobId)) this.#lastPolled.delete(jobId);
    for (const jobId of this.#unconfirmedSince.keys()) if (!open.has(jobId)) this.#unconfirmedSince.delete(jobId);
  }

  async #tickHost(host: HostConfig): Promise<void> {
    const { store, clock, logger } = this.#options;
    const state = this.#hostState(host.id);
    if (state.nextAttemptAt > clock() || !store.hasOpenJobs(host.id)) return;
    const client = this.#options.registry.client(host.id);
    try {
      if (state.unreachableSince !== null) await client.environmentRead();
      // A failure that concerns one job is recorded on that job inside each step. Anything else that
      // escapes a step is logged and the next step still runs, so queued work is still dispatched.
      const steps = [
        ['reconcile', () => this.#reconcile(host)],
        ['watch', () => this.#watch(host)],
        ['dispatch', () => this.#dispatch(host)],
      ] as const;
      for (const [step, run] of steps) {
        try {
          await run();
        } catch (error) {
          if (isHostFailure(error)) throw error;
          logger.error('jobs.host_tick_failed', { hostId: host.id, step, errorCode: describeError(error).code });
        }
      }
      this.#markReachable(host.id);
    } catch (error) {
      if (isHostFailure(error)) this.#markUnreachable(host.id, error);
      else logger.error('jobs.host_tick_failed', { hostId: host.id, errorCode: describeError(error).code });
    }
  }

  /**
   * Record a failure that concerns one job only (a T3 tool error, an answer in an unexpected shape):
   * the job keeps its state, carries the error, and is tried again next tick. Host failures propagate.
   */
  #jobFailed(job: Job, error: unknown, event: string): void {
    if (isHostFailure(error)) throw error;
    const described = describeError(error);
    const code = error instanceof T3ToolError ? error.t3Code : described.code;
    this.#options.store.update(job.id, { lastErrorCode: code, lastErrorMessage: described.message });
    this.#options.logger.warn(event, { jobId: job.id, hostId: job.hostId, errorCode: code });
  }

  /** Fill free slots with queued jobs, oldest first. */
  async #dispatch(host: HostConfig): Promise<void> {
    const { store, clock } = this.#options;
    const free = host.maxConcurrentJobs - store.slotHolders(host.id);
    if (free <= 0) return;
    const queued = store.queued(host.id, free);
    if (queued.length === 0) return;
    // A cheap read first: a dead connection (for example after T3 restarted) fails here, where a
    // retry is safe, instead of making the launch itself ambiguous.
    await this.#options.registry.client(host.id).environmentRead();
    for (const job of queued) {
      const project = this.#options.config.projects.find((candidate) => candidate.alias === job.projectAlias);
      if (!project) {
        store.transition(job.id, {
          from: ['queued'],
          to: 'failed',
          changes: { lastErrorCode: 'project_not_configured', lastErrorMessage: `Project "${job.projectAlias}" is no longer configured.` },
          detail: { reason: 'project_not_configured', code: 'project_not_configured' },
        });
        continue;
      }
      let projectId: string;
      try {
        projectId = await this.#projectId(project);
      } catch (error) {
        if (isHostFailure(error)) throw error;
        const described = describeError(error);
        store.transition(job.id, {
          from: ['queued'],
          to: 'failed',
          changes: { lastErrorCode: 'project_not_found', lastErrorMessage: described.message },
          detail: { reason: 'project_not_found', code: 'project_not_found' },
        });
        continue;
      }
      const dispatching = store.transition(job.id, {
        from: ['queued'],
        to: 'dispatching',
        changes: { t3ProjectId: projectId, dispatchStartedAt: clock() },
      });
      if (dispatching && !(await this.#launch(dispatching, project, projectId))) return;
    }
  }

  /** Launch one job's thread. Returns false when no further job should be launched this tick. */
  async #launch(job: Job, project: ProjectConfig, projectId: string): Promise<boolean> {
    const { store, registry, config } = this.#options;
    const model = configuredModel(config, project);
    this.#inFlight.add(job.id);
    try {
      let launched: LaunchResult;
      try {
        launched = await registry.client(job.hostId).launchThread(
          {
            projectId,
            title: job.title,
            workspaceStrategy: { type: 'worktree', baseRef: project.baseRef, branch: job.branch, startFromOrigin: false },
            runtimeMode: job.runtimeMode as RuntimeMode,
            ...(model ? { modelSelection: model.selection } : {}),
            message: launchMessage(job),
          },
          { timeoutMs: this.#launchTimeoutMs },
        );
      } catch (error) {
        if (error instanceof T3ToolError) return await this.#launchRefused(job, project, projectId, error);
        if (error instanceof T3TransportError && error.delivery === 'not_delivered') {
          store.transition(job.id, { from: ['dispatching'], to: 'queued', changes: { dispatchStartedAt: null }, detail: { reason: 'host_unreachable', code: error.code } });
          store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', detail: { reason: 'cancelled_before_launch' } });
          throw error;
        }
        const described = describeError(error);
        store.transition(job.id, {
          from: ['dispatching'],
          to: 'unknown',
          changes: { lastErrorCode: described.code, lastErrorMessage: described.message },
          detail: { reason: 'launch_outcome_unknown', code: described.code },
        });
        // T3 prepares the worktree before answering, so a slow launch says nothing about the host (the
        // next tick's probe does). The job is reconciled like any unknown launch; launch no more now.
        if (error instanceof T3TransportError && error.code === 't3_timeout') return false;
        if (isHostFailure(error)) throw error;
        return true;
      }
      const thread = { threadId: launched.threadId, threadTitle: job.title, lastRunId: launched.runId, threadLink: threadLinkTarget(launched.link) };
      await this.#attach(job.id, thread, 'launched', null);
      return true;
    } finally {
      this.#inFlight.delete(job.id);
    }
  }

  /**
   * T3 answered the launch with an error. Some refusals happen before anything is created; after any
   * other, T3 may have created the thread (its own guidance is to look before retrying), so the
   * marker is looked up once: found, the job continues on that thread; not found, it fails with
   * T3's code. If the lookup fails in any way, the job is unknown and reconciliation takes over:
   * failing it would free the slot while a thread may exist.
   */
  async #launchRefused(job: Job, project: ProjectConfig, projectId: string, error: T3ToolError): Promise<boolean> {
    const { store, config } = this.#options;
    if (/project/.test(error.t3Code)) this.#projectIds.delete(project.alias);
    // T3 refuses a launch without a model when the project has no default (T3's message says so).
    const hint =
      error.t3Code === 'invalid_request' && !configuredModel(config, project)
        ? ` If T3 asks for a model: the operator sets modelSelection for project "${project.alias}" or defaultModelSelection for host "${project.host}" in the gateway config.`
        : '';
    const failure = { lastErrorCode: error.t3Code, lastErrorMessage: `${error.message}${hint}` };
    if (!REFUSED_BEFORE_CREATION.has(error.t3Code)) {
      let found: FoundThread | undefined;
      try {
        found = await this.#findThread(job.hostId, projectId, job.id);
      } catch (lookupError) {
        store.transition(job.id, { from: ['dispatching'], to: 'unknown', changes: failure, detail: { reason: 'launch_outcome_unknown', code: error.t3Code } });
        if (isHostFailure(lookupError)) throw lookupError;
        return true;
      }
      if (found) {
        await this.#attach(job.id, found, 'reconciled', error.t3Code);
        return true;
      }
    }
    store.transition(job.id, { from: ['dispatching'], to: 'failed', changes: failure, detail: { reason: 'launch_rejected', code: error.t3Code } });
    store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', changes: failure, detail: { reason: 'launch_rejected', code: error.t3Code } });
    return true;
  }


  /**
   * Resolve launches whose outcome is unknown, never by launching again: look for the job marker in
   * the project's threads. Found: attach the thread. Not found for `reconcileWindowMinutes` while
   * the host answers: the launch did not happen, so the job fails with `launch_not_confirmed`.
   */
  async #reconcile(host: HostConfig): Promise<void> {
    const { store, config } = this.#options;
    for (const job of store.onHost(host.id, ['dispatching'])) {
      if (this.#inFlight.has(job.id)) continue;
      store.transition(job.id, { from: ['dispatching'], to: 'unknown', detail: { reason: 'dispatch_interrupted' } });
    }
    const windowMs = config.watcher.reconcileWindowMinutes * MINUTE;
    // cancel_requested jobs without a thread were cancelled while launching or unconfirmed.
    for (const job of store.onHost(host.id, ['unknown', 'cancel_requested'])) {
      if (job.threadId !== null || job.t3ProjectId === null || this.#inFlight.has(job.id)) continue;
      try {
        await this.#reconcileJob(job, job.t3ProjectId, windowMs);
      } catch (error) {
        // A lookup that failed is not a miss: the window neither starts nor advances.
        this.#jobFailed(job, error, 'jobs.reconcile_failed');
      }
    }
  }

  async #reconcileJob(job: Job, projectId: string, windowMs: number): Promise<void> {
    const { store, clock, config } = this.#options;
    const found = await this.#findThread(job.hostId, projectId, job.id);
    if (found) {
      this.#unconfirmedSince.delete(job.id);
      // The launch's own error; lastError may since hold a failed lookup's.
      const launchEvent = store.recentEvents(job.id, 20).findLast((event) => event.detail.reason === 'launch_outcome_unknown');
      const launchCode = launchEvent?.detail.code ?? null;
      await this.#attach(job.id, found, 'reconciled', launchCode);
      return;
    }
    const since = this.#unconfirmedSince.get(job.id)?.since ?? clock();
    this.#unconfirmedSince.set(job.id, { hostId: job.hostId, since });
    if (clock() - since < windowMs) return;
    this.#unconfirmedSince.delete(job.id);
    const changes = {
      lastErrorCode: 'launch_not_confirmed',
      lastErrorMessage: `No T3 thread titled with ${jobMarker(job.id)} appeared within ${config.watcher.reconcileWindowMinutes} minutes, so the launch did not happen. Start a new job if the work is still needed.`,
    };
    const detail = { reason: 'launch_not_confirmed', code: 'launch_not_confirmed' };
    store.transition(job.id, { from: ['unknown'], to: 'failed', changes, detail });
    store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', changes, detail });
  }

  /**
   * The thread carrying the job's marker: by title in the project's unsettled, then settled threads,
   * then by search. A search match T3 refuses to read is skipped: one unreadable thread must not stall
   * reconciliation, and the job's own thread is found by title.
   */
  async #findThread(hostId: string, projectId: string, jobId: string): Promise<FoundThread | undefined> {
    const client = this.#options.registry.client(hostId);
    const marker = jobMarker(jobId);
    // The marker ends the title; one merely mentioned elsewhere in a title is someone else's thread.
    const carriesMarker = (title: string) => title.trim().endsWith(marker);
    // T3 lists unsettled threads unless asked for settled ones, and a job's thread may be settled already.
    for (const settled of [false, true]) {
      const listed = await client.listThreads({ projectId, titleContains: marker, limit: 10, ...(settled ? { settled } : {}) });
      const byTitle = listed.threads.filter((thread) => carriesMarker(thread.title)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (byTitle) return foundThread(byTitle);
    }
    const searched = await client.searchThreads({ projectId, query: jobId, limit: 20 });
    for (const threadId of new Set(searched.matches.map((match) => match.threadId))) {
      let thread: ThreadRead['thread'];
      try {
        ({ thread } = await client.readThread({ threadId, limit: 1, runLimit: 1 }));
      } catch (error) {
        if (error instanceof T3ToolError) continue;
        throw error;
      }
      if (carriesMarker(thread.title)) return foundThread(thread);
    }
    return undefined;
  }


  /** Observe every job that has a thread and is not finished; idle jobs less often. */
  async #watch(host: HostConfig): Promise<void> {
    const { store, clock } = this.#options;
    for (const job of store.onHost(host.id, ['running', 'needs_input', 'cancel_requested', 'idle'])) {
      if (job.threadId === null) continue;
      if (job.state === 'idle' && clock() - (this.#lastPolled.get(job.id) ?? 0) < IDLE_POLL_MS) continue;
      try {
        await this.#observeJob(job, job.threadId);
      } catch (error) {
        this.#jobFailed(job, error, 'jobs.watch_failed');
      }
      this.#lastPolled.set(job.id, clock());
    }
  }

  async #observeJob(job: Job, threadId: string): Promise<void> {
    const { store, registry, logger } = this.#options;
    const client = registry.client(job.hostId);
    let read: ThreadRead;
    let questions: string[];
    try {
      read = await this.#readNew(job, threadId);
      questions = await client.listPendingRequests(threadId);
    } catch (error) {
      if (!(error instanceof T3ToolError)) throw error;
      logger.warn('jobs.watch_failed', { jobId: job.id, hostId: job.hostId, errorCode: error.t3Code });
      if (/not_found/.test(error.t3Code)) {
        store.transition(job.id, {
          from: [job.state],
          to: job.state === 'cancel_requested' ? 'cancelled' : 'failed',
          changes: { lastErrorCode: 'thread_missing', lastErrorMessage: `T3 no longer has the job's thread (${error.t3Code}).` },
          detail: { reason: 'thread_missing', code: error.t3Code },
        });
      } else {
        store.update(job.id, { lastErrorCode: error.t3Code, lastErrorMessage: error.message });
      }
      return;
    }
    const seen = observe(job, read, questions);
    const changes: JobChanges = {
      pendingRequestIds: seen.pendingRequestIds,
      readPosition: seen.readPosition,
      latestActivityAt: seen.activityAt,
      lastRunId: seen.lastRunId,
      ...(seen.excerpt === undefined ? {} : { latestMessageExcerpt: seen.excerpt }),
      ...(seen.link === undefined ? {} : { threadLink: seen.link }),
      ...(seen.errorCode
        ? { lastErrorCode: seen.errorCode, lastErrorMessage: 'The T3 run failed. Open the thread in T3 for details.' }
        : // A standing job outlives a failed run: the error clears once a new turn runs.
          seen.state === 'running' && job.lastErrorCode === 't3_run_failed'
          ? { lastErrorCode: null, lastErrorMessage: null }
          : {}),
    };
    // Both writes are guarded by the state the observation started from: an agent action that
    // landed while T3 was being read (a follow-up, an answer, a cancel) wins over this observation.
    if (seen.state === job.state) {
      if (!store.transition(job.id, { from: [job.state], to: job.state, changes })) return;
      if (seen.anotherTurnFinished) store.appendEvent(job.id, 'turn_finished', 'idle', { reason: seen.reason });
      // Still running after a cancel: the interrupt may never have arrived, or a new run started
      // since (a queued follow-up, or someone in T3). Interrupt the run that is active now.
      if (job.state === 'cancel_requested') {
        await this.#interrupt(job.id, job.hostId, { threadId, runId: read.thread.activeRunId ?? read.thread.latestRunId }, registry);
      }
      return;
    }
    store.transition(job.id, {
      from: [job.state],
      to: seen.state,
      changes,
      detail: { reason: seen.reason, ...(seen.errorCode ? { code: seen.errorCode } : {}) },
    });
  }

  /** Read the thread's state and every timeline item after the job's read position (bounded). */
  async #readNew(job: Job, threadId: string): Promise<ThreadRead> {
    const client = this.#options.registry.client(job.hostId);
    let afterPosition = job.readPosition;
    let read: ThreadRead | undefined;
    const items: ThreadRead['items'] = [];
    for (let page = 0; page < MAX_READ_PAGES; page++) {
      read = await client.readThread({ threadId, afterPosition, limit: READ_PAGE_SIZE, runLimit: RECENT_RUNS, maxCharsPerItem: EXCERPT_CHARS });
      items.push(...read.items);
      if (!read.hasMore || read.nextPosition === null) break;
      afterPosition = read.nextPosition;
    }
    if (!read) throw new GatewayError('internal_error', 'No thread read');
    return { ...read, items, nextPosition: read.nextPosition ?? afterPosition };
  }

  /**
   * Record the job's thread and move it to running. A job cancelled while its launch was in flight
   * or unconfirmed keeps cancel_requested, and its thread is interrupted now. A found thread on
   * which no run ever started never received the task: the job fails with `launch_not_started`
   * (`launchCode` is the launch's own error, if any), keeping the thread so it can be inspected.
   */
  async #attach(jobId: string, thread: FoundThread, via: 'launched' | 'reconciled', launchCode: string | null): Promise<void> {
    const { store, registry } = this.#options;
    const { threadLink, status, ...rest } = thread;
    if (status !== undefined && thread.lastRunId === null && !isActiveStatus(status)) {
      const changes = {
        ...rest,
        ...(threadLink ? { threadLink } : {}),
        lastErrorCode: 'launch_not_started',
        lastErrorMessage:
          `T3 created the job's thread but started no run on it${launchCode ? ` (the launch answered ${launchCode})` : ''}, ` +
          'so the task was never delivered. The thread is kept for inspection; start a new job if the work is still needed.',
      };
      const detail = { reason: 'launch_not_started', code: 'launch_not_started' };
      store.transition(jobId, { from: ['dispatching', 'unknown'], to: 'failed', changes, detail });
      store.transition(jobId, { from: ['cancel_requested'], to: 'cancelled', changes, detail });
      return;
    }
    const changes = { ...rest, ...(threadLink ? { threadLink } : {}), lastErrorCode: null, lastErrorMessage: null };
    if (store.transition(jobId, { from: ['dispatching', 'unknown'], to: 'running', changes, detail: { reason: via } })) return;
    const job = store.get(jobId);
    if (job?.state !== 'cancel_requested') return;
    store.update(jobId, changes);
    await this.#interrupt(jobId, job.hostId, { threadId: thread.threadId, runId: thread.lastRunId }, registry);
  }

  /** Deliver (or re-deliver) a cancel_requested job's interrupt for one run. T3 deduplicates repeats per run. */
  async #interrupt(jobId: string, hostId: string, thread: { threadId: string; runId: string | null }, registry: HostRegistry): Promise<void> {
    try {
      await deliverInterrupt(this.#options.store, registry.client(hostId), jobId, thread);
    } catch (error) {
      // Tried again on the next tick while the job is still cancel_requested and its thread active.
      if (isHostFailure(error)) throw error;
      this.#options.logger.warn('jobs.interrupt_failed', { jobId, hostId, errorCode: error instanceof T3ToolError ? error.t3Code : describeError(error).code });
    }
  }

  async #projectId(project: ProjectConfig): Promise<string> {
    const cached = this.#projectIds.get(project.alias);
    if (cached) return cached;
    const id = await resolveProjectId(this.#options.registry, project);
    this.#projectIds.set(project.alias, id);
    return id;
  }

  #hostState(hostId: string): HostState {
    let state = this.#hosts.get(hostId);
    if (!state) {
      state = { unreachableSince: null, failures: 0, nextAttemptAt: 0 };
      this.#hosts.set(hostId, state);
    }
    return state;
  }

  #markUnreachable(hostId: string, error: GatewayError): void {
    const { clock, store, logger } = this.#options;
    const state = this.#hostState(hostId);
    const now = clock();
    if (state.unreachableSince === null) {
      state.unreachableSince = now;
      logger.warn('jobs.host_unreachable', { hostId, errorCode: error.code });
    }
    state.failures += 1;
    state.nextAttemptAt = now + Math.min(MAX_BACKOFF_MS, this.#intervalMs * 2 ** (state.failures - 1));
    store.markHostUnreachable(hostId, state.unreachableSince);
    // The not-found window only counts time the host was answering.
    for (const [jobId, entry] of this.#unconfirmedSince) if (entry.hostId === hostId) this.#unconfirmedSince.delete(jobId);
  }

  #markReachable(hostId: string): void {
    const state = this.#hostState(hostId);
    if (state.unreachableSince === null) return;
    this.#options.logger.info('jobs.host_reachable', { hostId, unreachableForMs: this.#options.clock() - state.unreachableSince });
    state.unreachableSince = null;
    state.failures = 0;
    state.nextAttemptAt = 0;
    this.#options.store.clearHostUnreachable(hostId);
  }
}
