import type { GatewayConfig, HostConfig, ProjectConfig, RuntimeMode } from '../config.ts';
import { describeError, GatewayError } from '../errors.ts';
import type { HostRegistry } from '../hosts/registry.ts';
import { resolveProjectId } from '../hosts/projects.ts';
import type { Logger } from '../log.ts';
import { T3TransportError } from '../t3/client.ts';
import { T3ToolError } from '../t3/results.ts';
import type { LaunchResult, ThreadRead } from '../t3/schemas.ts';
import { MINUTE, SECOND, type Clock } from '../time.ts';
import { EXCERPT_CHARS, observe } from './derive.ts';
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
    });
    this.#next = next;
    this.#current = next.catch((error: unknown) => this.#options.logger.error('jobs.tick_failed', { errorCode: describeError(error).code }));
    return next;
  }

  async #tickHost(host: HostConfig): Promise<void> {
    const { store, clock, logger } = this.#options;
    const state = this.#hostState(host.id);
    if (state.nextAttemptAt > clock() || !store.hasOpenJobs(host.id)) return;
    const client = this.#options.registry.client(host.id);
    try {
      if (state.unreachableSince !== null) await client.environmentRead();
      await this.#reconcile(host);
      await this.#watch(host);
      await this.#dispatch(host);
      this.#markReachable(host.id);
    } catch (error) {
      if (isHostFailure(error)) this.#markUnreachable(host.id, error);
      else logger.error('jobs.host_tick_failed', { hostId: host.id, errorCode: describeError(error).code });
    }
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
      if (dispatching) await this.#launch(dispatching, project, projectId);
    }
  }

  async #launch(job: Job, project: ProjectConfig, projectId: string): Promise<void> {
    const { store, registry } = this.#options;
    this.#inFlight.add(job.id);
    let launched: LaunchResult;
    try {
      launched = await registry.client(job.hostId).launchThread(
        {
          projectId,
          title: job.title,
          workspaceStrategy: { type: 'worktree', baseRef: project.baseRef, branch: job.branch, startFromOrigin: false },
          runtimeMode: job.runtimeMode as RuntimeMode,
          ...(project.modelSelection ? { modelSelection: project.modelSelection } : {}),
          message: launchMessage(job),
        },
        { timeoutMs: LAUNCH_TIMEOUT_MS },
      );
    } catch (error) {
      this.#inFlight.delete(job.id);
      if (error instanceof T3ToolError) {
        // T3 answered and refused: nothing was created.
        if (/project/.test(error.t3Code)) this.#projectIds.delete(project.alias);
        const failure = { lastErrorCode: error.t3Code, lastErrorMessage: error.message };
        store.transition(job.id, { from: ['dispatching'], to: 'failed', changes: failure, detail: { reason: 'launch_rejected', code: error.t3Code } });
        store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', changes: failure, detail: { reason: 'launch_rejected', code: error.t3Code } });
        return;
      }
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
      if (isHostFailure(error)) throw error;
      return;
    }
    this.#inFlight.delete(job.id);
    await this.#attach(job.id, { threadId: launched.threadId, threadTitle: job.title, lastRunId: launched.runId }, 'launched');
  }

  /**
   * Resolve launches whose outcome is unknown, never by launching again: look for the job marker in
   * the project's threads. Found: attach the thread. Not found for `reconcileWindowMinutes` while
   * the host answers: the launch did not happen, so the job fails with `launch_not_confirmed`.
   */
  async #reconcile(host: HostConfig): Promise<void> {
    const { store, clock, config } = this.#options;
    for (const job of store.onHost(host.id, ['dispatching'])) {
      if (this.#inFlight.has(job.id)) continue;
      store.transition(job.id, { from: ['dispatching'], to: 'unknown', detail: { reason: 'dispatch_interrupted' } });
    }
    const windowMs = config.watcher.reconcileWindowMinutes * MINUTE;
    // cancel_requested jobs without a thread were cancelled while launching or unconfirmed.
    for (const job of store.onHost(host.id, ['unknown', 'cancel_requested'])) {
      if (job.threadId !== null || job.t3ProjectId === null || this.#inFlight.has(job.id)) continue;
      const found = await this.#findThread(job.hostId, job.t3ProjectId, job.id);
      if (found) {
        this.#unconfirmedSince.delete(job.id);
        await this.#attach(job.id, { threadId: found.threadId, threadTitle: found.title, lastRunId: found.latestRunId }, 'reconciled');
        continue;
      }
      const since = this.#unconfirmedSince.get(job.id)?.since ?? clock();
      this.#unconfirmedSince.set(job.id, { hostId: host.id, since });
      if (clock() - since < windowMs) continue;
      this.#unconfirmedSince.delete(job.id);
      const changes = {
        lastErrorCode: 'launch_not_confirmed',
        lastErrorMessage: `No T3 thread titled with ${jobMarker(job.id)} appeared within ${config.watcher.reconcileWindowMinutes} minutes, so the launch did not happen. Start a new job if the work is still needed.`,
      };
      const detail = { reason: 'launch_not_confirmed', code: 'launch_not_confirmed' };
      store.transition(job.id, { from: ['unknown'], to: 'failed', changes, detail });
      store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', changes, detail });
    }
  }

  /** The thread carrying the job's marker: by title in the project's thread list, then by search. */
  async #findThread(hostId: string, projectId: string, jobId: string): Promise<{ threadId: string; title: string; latestRunId: string | null } | undefined> {
    const client = this.#options.registry.client(hostId);
    const marker = jobMarker(jobId);
    const listed = await client.listThreads({ projectId, titleContains: marker, limit: 10 });
    const byTitle = listed.threads.filter((thread) => thread.title.includes(marker)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (byTitle) return { threadId: byTitle.threadId, title: byTitle.title, latestRunId: byTitle.latestRunId };
    const searched = await client.searchThreads({ projectId, query: jobId, limit: 20 });
    for (const threadId of new Set(searched.matches.map((match) => match.threadId))) {
      const read = await client.readThread({ threadId, limit: 1, runLimit: 1 });
      if (read.thread.title.includes(marker)) return { threadId, title: read.thread.title, latestRunId: read.thread.latestRunId };
    }
    return undefined;
  }

  /** Observe every job that has a thread and is not finished; idle jobs less often. */
  async #watch(host: HostConfig): Promise<void> {
    const { store, clock } = this.#options;
    for (const job of store.onHost(host.id, ['running', 'needs_input', 'cancel_requested', 'idle'])) {
      if (job.threadId === null) continue;
      if (job.state === 'idle' && clock() - (this.#lastPolled.get(job.id) ?? 0) < IDLE_POLL_MS) continue;
      await this.#observeJob(job, job.threadId);
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
      logger.warn('jobs.watch_failed', { jobId: job.id, hostId: job.hostId, t3Code: error.t3Code });
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
      ...(seen.errorCode ? { lastErrorCode: seen.errorCode, lastErrorMessage: 'The T3 run failed. Open the thread in T3 for details.' } : {}),
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
   * or unconfirmed keeps cancel_requested, and its thread is interrupted now.
   */
  async #attach(jobId: string, thread: { threadId: string; threadTitle: string; lastRunId: string | null }, via: 'launched' | 'reconciled'): Promise<void> {
    const { store, registry } = this.#options;
    const changes = { ...thread, lastErrorCode: null, lastErrorMessage: null };
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
      if (!(error instanceof T3ToolError)) throw error;
      this.#options.logger.warn('jobs.interrupt_failed', { jobId, hostId, t3Code: error.t3Code });
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
