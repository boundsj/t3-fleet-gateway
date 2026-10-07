import type { GatewayConfig, HostConfig, ProjectConfig, RuntimeMode } from '../config.ts';
import { describeError, GatewayError } from '../errors.ts';
import type { HostRegistry } from '../hosts/registry.ts';
import { resolveProjectId } from '../hosts/projects.ts';
import type { Logger } from '../log.ts';
import { T3TransportError } from '../t3/client.ts';
import { T3ToolError } from '../t3/results.ts';
import { MINUTE, SECOND, type Clock } from '../time.ts';
import type { Job, JobStore } from './store.ts';

/** Launches can take a while: T3 prepares the worktree before answering. */
const LAUNCH_TIMEOUT_MS = 60 * SECOND;
const MAX_BACKOFF_MS = 5 * MINUTE;

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
 * The background half of the job layer. Each tick, per host: dispatch queued jobs into free slots.
 * Ticks never overlap. Hosts that cannot be reached are backed off and their jobs keep their state.
 */
export class JobEngine {
  readonly #options: JobEngineOptions;
  readonly #intervalMs: number;
  readonly #hosts = new Map<string, HostState>();
  readonly #projectIds = new Map<string, string>();
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
    try {
      const launched = await registry.client(job.hostId).launchThread(
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
      this.#attach(job.id, { threadId: launched.threadId, threadTitle: job.title, lastRunId: launched.runId }, 'launched');
    } catch (error) {
      if (error instanceof T3ToolError) {
        // T3 answered and refused: nothing was created.
        if (/project/.test(error.t3Code)) this.#projectIds.delete(project.alias);
        store.transition(job.id, {
          from: ['dispatching'],
          to: 'failed',
          changes: { lastErrorCode: error.t3Code, lastErrorMessage: error.message },
          detail: { reason: 'launch_rejected', code: error.t3Code },
        });
        return;
      }
      if (error instanceof T3TransportError && error.delivery === 'not_delivered') {
        store.transition(job.id, { from: ['dispatching'], to: 'queued', changes: { dispatchStartedAt: null }, detail: { reason: 'host_unreachable', code: error.code } });
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
    }
  }

  /** Record the job's thread and move it to running. */
  #attach(jobId: string, thread: { threadId: string; threadTitle: string; lastRunId: string | null }, via: 'launched' | 'reconciled'): void {
    this.#options.store.transition(jobId, {
      from: ['dispatching', 'unknown'],
      to: 'running',
      changes: { ...thread, lastErrorCode: null, lastErrorMessage: null },
      detail: { reason: via },
    });
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
