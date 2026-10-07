import type { GatewayConfig, ProjectConfig } from '../config.ts';
import { sha256Hex } from '../crypto.ts';
import { GatewayError } from '../errors.ts';
import { newJobId } from './ids.ts';
import type { JobState } from './states.ts';
import type { Job, JobEvent, JobStore } from './store.ts';

/** Bounds on agent-supplied text. T3 accepts up to 120,000 characters per message. */
export const MAX_TASK_CHARS = 20_000;
export const MAX_TITLE_CHARS = 80;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const TITLE_FROM_TASK_CHARS = 60;

export interface Caller {
  clientId: string;
}

export interface StartInput {
  project: string;
  task: string;
  requestId: string;
  title?: string | undefined;
}

export interface JobServiceOptions {
  config: GatewayConfig;
  store: JobStore;
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

/** A one-line thread title: the agent's title, or the task's first line, then the job marker. */
export function threadTitle(jobId: string, task: string, title: string | undefined): string {
  const source = (title ?? task.split('\n').find((line) => line.trim().length > 0) ?? 'Job').replaceAll(/\s+/g, ' ').trim();
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
  /** Set by the running gateway so new work is dispatched without waiting for the next poll. */
  wake: () => void = () => {};

  constructor(options: JobServiceOptions) {
    this.store = options.store;
    this.#config = options.config;
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

  async status(jobId: string): Promise<JobDetail> {
    const job = this.store.require(jobId);
    return {
      job,
      recentEvents: this.store.recentEvents(jobId, 10),
      pendingRequests: job.pendingRequestIds.map((requestId) => ({ requestId, questions: null })),
      waitingForApproval: job.state === 'needs_input' && job.pendingRequestIds.length === 0,
    };
  }
}
