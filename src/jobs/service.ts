import { configuredModel, type GatewayConfig, type HostConfig, type ProjectConfig } from '../config.ts';
import { sha256Hex } from '../crypto.ts';
import { describeError, GatewayError } from '../errors.ts';
import type { CatalogProject, CatalogService } from '../hosts/catalog.ts';
import { resolveProjectId } from '../hosts/projects.ts';
import type { HostRegistry } from '../hosts/registry.ts';
import type { Logger } from '../log.ts';
import { permits, permittedHosts, type AccessLevel, type Scope } from '../oauth/scopes.ts';
import { T3TransportError, type T3Client } from '../t3/client.ts';
import { T3ToolError } from '../t3/results.ts';
import type { ThreadItem, ThreadRead } from '../t3/schemas.ts';
import { HOUR, SECOND, type Clock } from '../time.ts';
import { scanActivity } from './activity.ts';
import { EXCERPT_CHARS, holdsReadPosition, isActiveStatus, observe, threadLinkTarget, type ActivityRead } from './derive.ts';
import { newJobId } from './ids.ts';
import { canonicalSelection, validateSelection, type LaunchSpec, type ModelSelection } from './launchSpec.ts';
import { readWorkerMessages, type MessagePage, type MessageQuery } from './messages.ts';
import { cancelRequestId } from './interrupt.ts';
import { isTerminal, OPEN_STATES, type JobState } from './states.ts';
import { jobNotFound, type FeedEvent, type Job, type JobEvent, type JobScope, type JobStore } from './store.ts';
import { launchPolicy, mapProjects, parseProjectRef, projectRef } from './targets.ts';

/** Bounds on agent-supplied text. T3 accepts up to 120,000 characters per message. */
export const MAX_TASK_CHARS = 20_000;
export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_ANSWERS_CHARS = 16_000;
/** Idle and failed jobs stay in the feed's attention list this long after their last change. */
export const ATTENTION_RECENT_MS = 24 * HOUR;
const MAX_ATTENTION = 50;
export const MAX_QUESTION_READS = 5;
export const MAX_QUESTIONS = 50;
export const MAX_QUESTION_OPTIONS = 100;
/** Whole requests only: never truncate an option or required question into an unsafe partial answer. */
export const MAX_QUESTION_CHARS = 64_000;
const QUESTION_READ_TIMEOUT_MS = 5 * SECOND;
export const MAX_TITLE_CHARS = 80;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const TITLE_FROM_TASK_CHARS = 60;
/** Pages of 100 messages read to find the end of a thread being adopted (messages view). */
const MAX_ADOPT_PAGES = 1000;

/**
 * The agent calling a work tool. Its scopes decide which hosts it may read and operate on (oauth/scopes.ts):
 * a project or job on a host it may not read is reported exactly as one that does not exist.
 */
export interface Caller {
  clientId: string;
  scopes: readonly Scope[];
}

export interface StartInput {
  project?: string | undefined;
  target?: { host: string; projectId?: string | undefined } | undefined;
  /** An explicit provider, model and options from fleet_models; without it the configured defaults apply. */
  modelSelection?: ModelSelection | undefined;
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
  catalog: CatalogService;
  clock: Clock;
  logger: Logger;
}

export interface PendingQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; value: string | null }[];
  multiSelect: boolean | null;
  allowCustomAnswer: boolean | null;
  required: boolean | null;
}

export interface QuestionRequest {
  requestId: string;
  questions: PendingQuestion[] | null;
  questionsUnavailable: 'temporarily_unreadable' | 'read_limit' | 'too_large' | null;
}

export interface JobDetail {
  job: Job;
  recentEvents: JobEvent[];
  /** Questions the worker waits on. `questions` is null when they could not be read from T3. */
  pendingRequests: QuestionRequest[];
  /** Blocked with no answerable question: a permission approval only the operator can give in T3. */
  waitingForApproval: boolean;
}

/** A stable hash of a tool's meaningful input, for request-id idempotency. */
export function inputHash(tool: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  return sha256Hex(JSON.stringify([tool, keys.map((key) => [key, input[key] ?? null])]));
}

/**
 * The idempotency hash of a work_start request. An alias-only request without a model selection hashes
 * exactly as before this build, so earlier request ids replay. A request with a target or a selection
 * hashes its canonical target and selection (option keys sorted), so reordered options match and a
 * changed target or selection under the same request id conflicts.
 */
export function startInputHash(input: StartInput): string {
  if (input.target === undefined && input.modelSelection === undefined) {
    return inputHash('work_start', { project: input.project, task: input.task, title: input.title });
  }
  return inputHash('work_start', {
    project: input.project ?? null,
    target: input.target === undefined ? null : { host: input.target.host, ...(input.target.projectId === undefined ? {} : { projectId: input.target.projectId }) },
    modelSelection: input.modelSelection === undefined ? null : canonicalSelection(input.modelSelection),
    task: input.task,
    title: input.title,
  });
}

/** Why work_start is refused in a project, and where to send the work instead. */
export function startDisabledMessage(alias: string, standing: Job[]): string {
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
  readonly #catalog: CatalogService;
  readonly #clock: Clock;
  readonly #logger: Logger;
  /** Set by the running gateway so new work is dispatched without waiting for the next poll. */
  wake: () => void = () => {};

  constructor(options: JobServiceOptions) {
    this.store = options.store;
    this.#config = options.config;
    this.#registry = options.registry;
    this.#catalog = options.catalog;
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

  /**
   * A project as an agent may use it: one on a host its grant does not let it read is unknown, as in the
   * error for a missing project, whose list of known projects names only visible ones.
   */
  #projectFor(caller: Caller, alias: string, level: AccessLevel): ProjectConfig {
    const project = this.#config.projects.find((candidate) => candidate.alias === alias);
    if (project && permits(caller.scopes, level, project.host)) return project;
    if (project && permits(caller.scopes, 'read', project.host)) {
      throw new GatewayError(
        'insufficient_scope',
        `Project "${alias}" is on host ${project.host}, where this agent has read access only. Ask the operator for Operate access on that host.`,
      );
    }
    const known = this.#config.projects.filter((candidate) => permits(caller.scopes, 'read', candidate.host)).map((candidate) => candidate.alias);
    throw new GatewayError('not_found', `No project "${alias}". Known projects: ${known.join(', ') || '(none configured)'}. fleet_status lists them.`);
  }

  #jobFor(caller: Caller, jobId: string, level: AccessLevel): Job {
    const requestedHosts = permittedHosts(caller.scopes, level);
    const readableHosts = permittedHosts(caller.scopes, 'read');
    const scope = requestedHosts === 'all' || readableHosts === 'all'
      ? {} : { hostIds: [...new Set([...requestedHosts, ...readableHosts])] };
    const job = this.store.get(jobId, scope);
    if (job && permits(caller.scopes, level, job.hostId)) return job;
    if (job && permits(caller.scopes, 'read', job.hostId)) {
      throw new GatewayError(
        'insufficient_scope',
        `Job ${job.id} is on host ${job.hostId}, where this agent has read access only. Ask the operator for Operate access on that host.`,
      );
    }
    throw jobNotFound(jobId);
  }

  /** The rows of the ledger an agent may read: its grant's hosts, unless it covers all. */
  #visible(caller: Caller, mine = false): JobScope {
    const hosts = permittedHosts(caller.scopes, 'read');
    return { ...(mine ? { clientId: caller.clientId } : {}), ...(hosts === 'all' ? {} : { hostIds: hosts }) };
  }

  /**
   * A host as an agent may use it: one that is not configured, or that its grant does not let it read,
   * is unknown; one it may read but not operate is refused with insufficient_scope.
   */
  #hostFor(caller: Caller, hostId: string, level: AccessLevel): HostConfig {
    const host = this.#config.hosts.find((candidate) => candidate.id === hostId);
    if (host && permits(caller.scopes, level, host.id)) return host;
    if (host && permits(caller.scopes, 'read', host.id)) {
      throw new GatewayError('insufficient_scope', `This agent has read access only on host ${host.id}. Ask the operator for Operate access on that host.`);
    }
    throw new GatewayError('not_found', `No host "${hostId}". fleet_status lists the hosts you can use.`);
  }

  async start(caller: Caller, input: StartInput): Promise<{ job: Job; created: boolean }> {
    if ((input.project === undefined) === (input.target === undefined)) {
      throw new GatewayError('invalid_argument', 'Pass exactly one of project (a configured alias) or target ({ host } for no named project, or { host, projectId } from fleet_projects).');
    }
    const hash = startInputHash(input);
    const key = this.store.idempotencyKey(caller.clientId, 'work_start', input.requestId);
    // A retry returns the job of the first request, which the project config may since have moved to another host:
    // the agent must still be allowed to operate on the job's own host.
    const hosts = permittedHosts(caller.scopes, 'operate');
    const scope: JobScope = hosts === 'all' ? {} : { hostIds: hosts };
    const replayed = key && this.store.get(key.jobId, scope);
    if (key && !replayed) {
      throw new GatewayError(
        'insufficient_scope',
        `requestId "${input.requestId}" belongs to a job on a host this agent may not operate on. Use a new requestId for new work.`,
      );
    }
    if (key && replayed) {
      if (key.inputHash !== hash) {
        throw new GatewayError('request_id_conflict', `requestId "${input.requestId}" was already used for a different request. Use a new requestId for new work.`);
      }
      // A retry of a request made before the operator turned work_start off still gets its job back.
      return { job: replayed, created: false };
    }
    let project = input.project === undefined ? undefined : this.#projectFor(caller, input.project, 'operate');
    const host = project ? this.#hostFor(caller, project.host, 'operate') : this.#hostFor(caller, input.target!.host, 'operate');
    if (project?.workspaceMode === 'worktree' && input.target === undefined && input.modelSelection === undefined) {
      if (!project.allowWorkStart) throw this.#startDisabled(caller, project);
      const id = newJobId();
      const result = this.store.create({
        id,
        clientId: caller.clientId,
        requestId: input.requestId,
        inputHash: hash,
        projectAlias: project.alias,
        hostId: project.host,
        task: input.task,
        title: threadTitle(id, input.task, input.title),
        branch: `${project.branchPrefix}${id}`,
        runtimeMode: project.runtimeMode,
      }, scope);
      if (result.created) this.wake();
      return result;
    }
    const hostOnly = input.target !== undefined && input.target.projectId === undefined;
    if (!host.discovery.enabled && (input.target !== undefined || input.modelSelection !== undefined)) {
      throw new GatewayError(
        'discovery_disabled',
        `Host ${host.id} has discovery disabled: work_start there takes a configured project alias (fleet_status lists them) and no target or modelSelection.`,
      );
    }
    if (hostOnly) {
      if (host.defaultProject === undefined) {
        throw new GatewayError('not_found', `Host ${host.id} has no default scratch project. Ask the operator to configure defaultProject.`);
      }
      project = this.#projectFor(caller, host.defaultProject, 'operate');
      if (project.host !== host.id || project.workspaceMode !== 'scratch') {
        throw new GatewayError('invalid_argument', `Host ${host.id} defaultProject must be a scratch alias on that host.`);
      }
    }
    const { spec, branchPrefix } = await this.#resolveLaunch(caller, host, project, input);
    const id = newJobId();
    const result = this.store.create({
      id,
      clientId: caller.clientId,
      requestId: input.requestId,
      inputHash: hash,
      projectAlias: spec.alias ?? projectRef(host.id, spec.projectId),
      hostId: host.id,
      task: input.task,
      title: threadTitle(id, input.task, input.title),
      branch: spec.v === 2 && spec.workspace.kind === 'scratch' ? '' : `${branchPrefix}${id}`,
      runtimeMode: spec.runtimeMode,
      t3ProjectId: spec.projectId,
      launchSpec: spec,
    }, scope);
    if (result.created) this.wake();
    return result;
  }

  #startDisabled(caller: Caller, project: ProjectConfig): GatewayError {
    const standing = this.store.standingJobs(project.alias).filter((job) => permits(caller.scopes, 'read', job.hostId));
    return new GatewayError('start_disabled', startDisabledMessage(project.alias, standing));
  }

  /**
   * Resolve a target or a model selection against the host's catalogs (read-only; nothing is created
   * until this returns). A target that exactly one configured alias maps to is launched as that alias,
   * with all of its settings; several matching aliases or an ambiguous title mapping require the alias;
   * otherwise the host's discovery policy applies, and launches need `discovery.allowWorkStart`. An
   * explicit selection must match the host's fresh capabilities exactly; nothing is substituted.
   *
   * The project list is read from the host now, never from the browse cache: the policy follows the
   * projects' titles, and a project renamed since an agent browsed could otherwise be launched under
   * the wrong policy. A host that cannot answer fails the request (the error propagates); nothing is
   * resolved from an older snapshot. The dispatcher repeats this check right before the launch.
   */
  async #resolveLaunch(
    caller: Caller,
    host: HostConfig,
    project: ProjectConfig | undefined,
    input: StartInput,
  ): Promise<{ spec: LaunchSpec; branchPrefix: string }> {
    const projects = (await this.#catalog.projects(host.id, { refresh: true })).value;
    const mappings = mapProjects(this.#config, host.id, projects);
    let found: CatalogProject | undefined;
    let policy: ProjectConfig | HostConfig['discovery'];
    let alias: string | null;
    if (project) {
      found = project.t3ProjectId === undefined
        ? [...mappings.values()].find((mapping) => mapping.aliases.includes(project))?.project
        : projects.find((candidate) => candidate.id === project.t3ProjectId);
      if (!found) {
        const what = project.t3ProjectId === undefined ? `exactly one T3 project titled "${project.t3ProjectTitle}"` : `a T3 project with id ${project.t3ProjectId}`;
        throw new GatewayError('not_found', `Project "${project.alias}": host ${host.id} has no ${what}.`);
      }
      if (!project.allowWorkStart) throw this.#startDisabled(caller, project);
      policy = project;
      alias = project.alias;
    } else {
      const mapping = input.target?.projectId === undefined ? undefined : mappings.get(input.target.projectId);
      if (!mapping) {
        throw new GatewayError('not_found', `Host ${host.id} has no T3 project ${JSON.stringify(input.target!.projectId)}. fleet_projects lists them.`);
      }
      found = mapping.project;
      const resolved = launchPolicy(host, mapping);
      if (resolved.kind === 'ambiguous') {
        throw new GatewayError(
          'invalid_argument',
          `T3 project ${found.id} on host ${host.id} is configured under ${resolved.aliases.length === 1 ? 'alias' : 'aliases'} ${resolved.aliases.join(', ')}` +
            `${resolved.aliases.length === 1 ? ', whose title matches several T3 projects' : ''}. Start it with project set to the alias you mean, not with target.`,
        );
      }
      if (resolved.kind === 'alias') {
        if (!resolved.project.allowWorkStart) throw this.#startDisabled(caller, resolved.project);
        policy = resolved.project;
        alias = resolved.project.alias;
      } else {
        if (!host.discovery.allowWorkStart) {
          const aliases = this.#config.projects.filter((candidate) => candidate.host === host.id && candidate.allowWorkStart).map((candidate) => candidate.alias);
          throw new GatewayError(
            'start_disabled',
            `Host ${host.id} does not accept work_start into T3 projects without a configured alias (discovery.allowWorkStart is false). ` +
              `Projects that accept work there: ${aliases.join(', ') || '(none)'}. Ask the operator to configure the project or enable discovery launches.`,
          );
        }
        policy = host.discovery;
        alias = null;
      }
    }
    let model: LaunchSpec['model'];
    if (input.modelSelection) {
      const providers = (await this.#catalog.models(host.id, { refresh: true })).value;
      model = { source: 'explicit', selection: { ...validateSelection(host.id, providers, input.modelSelection) } };
    } else if (alias !== null) {
      const configured = configuredModel(this.#config, policy as ProjectConfig);
      model = configured ? { source: configured.source, selection: configured.selection } : { source: 't3_default', selection: null };
    } else if (host.defaultModelSelection) {
      model = { source: 'host', selection: host.defaultModelSelection };
    } else if (found.hasDefaultModel) {
      model = { source: 't3_default', selection: null };
    } else {
      throw new GatewayError(
        'invalid_argument',
        `T3 project ${found.id} on host ${host.id} has no default model and the host sets no defaultModelSelection: pass modelSelection ` +
          '({ instanceId, model, options? } from fleet_models).',
      );
    }
    const scratch = alias === null ? undefined : this.#config.projects.find((candidate) => candidate.alias === alias && candidate.workspaceMode === 'scratch');
    const common = {
      projectId: found.id,
      projectName: found.name,
      source: alias === null ? 'discovered' : 'alias',
      alias,
      runtimeMode: policy.runtimeMode,
      model,
    } satisfies Pick<LaunchSpec, 'projectId' | 'projectName' | 'source' | 'alias' | 'runtimeMode' | 'model'>;
    return {
      spec: scratch ? {
        v: 2,
        ...common,
        hostId: host.id,
        workspace: { kind: 'scratch' },
        defaultProject: input.target !== undefined && input.target.projectId === undefined ? scratch.alias : null,
      } : {
        v: 1,
        ...common,
        baseRef: policy.baseRef,
      },
      branchPrefix: policy.branchPrefix,
    };
  }

  list(
    filter: {
      project?: string | undefined;
      target?: { host: string; projectId: string } | undefined;
      states?: readonly JobState[] | undefined;
      mine?: boolean | undefined;
      limit: number;
    },
    caller: Caller,
  ): Job[] {
    // A configured alias, or the internal ref of a job targeted by T3 project id (@<host>/<projectId>): its host is
    // authorized like any host, and the ref is only a filter on the ledger.
    if (filter.project !== undefined) {
      const ref = parseProjectRef(filter.project);
      if (ref) this.#hostFor(caller, ref.hostId, 'read');
      else this.#projectFor(caller, filter.project, 'read');
    }
    if (filter.target !== undefined) this.#hostFor(caller, filter.target.host, 'read');
    return this.store.list({
      limit: filter.limit,
      ...(filter.project === undefined ? {} : { projectAlias: filter.project }),
      ...(filter.target === undefined ? {} : { target: { hostId: filter.target.host, projectId: filter.target.projectId } }),
      ...(filter.states === undefined ? {} : { states: filter.states }),
      ...this.#visible(caller, filter.mine ?? false),
    });
  }

  /** One job with its recent events and, read live from T3, the questions it waits on. */
  async status(caller: Caller, jobId: string, pendingRequestId?: string): Promise<JobDetail> {
    const job = this.#jobFor(caller, jobId, 'read');
    if (pendingRequestId !== undefined && !job.pendingRequestIds.includes(pendingRequestId)) {
      throw new GatewayError('not_found', 'That request is not pending on this job. Read work_status without pendingRequestId for the current list.');
    }
    const pendingRequests = await Promise.all(
      job.pendingRequestIds.map(async (requestId, index): Promise<QuestionRequest> => {
        if (pendingRequestId !== undefined ? requestId !== pendingRequestId : index >= MAX_QUESTION_READS) {
          return { requestId, questions: null, questionsUnavailable: 'read_limit' };
        }
        if (job.threadId === null) return { requestId, questions: null, questionsUnavailable: 'temporarily_unreadable' };
        return this.#questions(job.hostId, job.threadId, requestId);
      }),
    );
    return {
      job,
      recentEvents: this.store.recentEvents(jobId, 10),
      pendingRequests,
      waitingForApproval: job.state === 'needs_input' && job.pendingRequestIds.length === 0,
    };
  }

  /** A page of the job thread's worker messages, read live from T3 (see messages.ts). */
  async messages(caller: Caller, jobId: string, query: MessageQuery): Promise<{ job: Job; page: MessagePage }> {
    const job = this.#jobFor(caller, jobId, 'read');
    if (query.before !== undefined && query.after !== undefined) throw new GatewayError('invalid_argument', 'Pass before or after, not both.');
    if (job.threadId === null) throw new GatewayError('job_state_conflict', `Job ${jobId} has no T3 thread yet (${job.state}), so it has no messages.`);
    return { job, page: await readWorkerMessages(this.#registry.client(job.hostId), job.threadId, job.readPosition, query) };
  }

  async #questions(hostId: string, threadId: string, requestId: string): Promise<QuestionRequest> {
    try {
      const request = await this.#registry.client(hostId).readPendingRequest(threadId, requestId, { timeoutMs: QUESTION_READ_TIMEOUT_MS });
      if (request.questions === null) return { requestId, questions: null, questionsUnavailable: 'temporarily_unreadable' };
      const questions = request.questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        options: question.options.map((option) => ({ label: option.label, description: option.description, value: option.value ?? null })),
        multiSelect: question.multiSelect ?? null,
        allowCustomAnswer: question.allowCustomAnswer ?? null,
        required: question.required ?? null,
      }));
      if (questions.length > MAX_QUESTIONS || questions.some((question) => question.options.length > MAX_QUESTION_OPTIONS) ||
          JSON.stringify(questions).length > MAX_QUESTION_CHARS) {
        return { requestId, questions: null, questionsUnavailable: 'too_large' };
      }
      return { requestId, questions, questionsUnavailable: null };
    } catch (error) {
      this.#logger.debug('jobs.question_read_failed', { hostId, errorCode: describeError(error).code });
      return { requestId, questions: null, questionsUnavailable: 'temporarily_unreadable' };
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
      latestMessageTruncated: seen.excerptTruncated ?? false,
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
    // Before the request id is looked up, so a replay never returns a stored result for a job the agent may not operate.
    let job = this.#jobFor(caller, input.jobId, 'operate');
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
    this.store.recordSend(job.id, sent, caller.clientId, input.requestId);
    this.wake();
    return { job: this.store.require(job.id), delivery: sent.delivery, replayed: false };
  }

  /** Answer one of the job's pending questions. Only requests T3 lists for the job's own thread are accepted. */
  async respond(caller: Caller, input: RespondInput): Promise<Job> {
    const job = this.#jobFor(caller, input.jobId, 'operate');
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
      throw new GatewayError('not_found', `That request is not pending on job ${job.id}. ${hint}`);
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
  async cancel(caller: Caller, input: { jobId: string }): Promise<CancelResult> {
    const job = this.#jobFor(caller, input.jobId, 'operate');
    if (job.standing) return this.#interruptStanding(job);
    if (job.state === 'queued') {
      const cancelled = this.store.transition(job.id, { from: ['queued'], to: 'cancelled', detail: { reason: 'cancelled_before_launch' } });
      return cancelled ? { job: cancelled, outcome: 'cancelled', delivered: true } : this.cancel(caller, input);
    }
    if (isTerminal(job.state)) return { job, outcome: job.state === 'cancelled' ? 'cancelled' : 'already_finished', delivered: true };
    const request = { from: ['dispatching', 'unknown', 'running', 'needs_input', 'idle'] as JobState[], to: 'cancel_requested' as const, detail: { reason: 'cancel_requested' } };
    if (job.threadId === null) {
      // The launch is in flight or unconfirmed: the engine interrupts the thread if it turns up.
      const requested = job.state === 'cancel_requested' ? job : this.store.transition(job.id, request);
      return requested ? { job: requested, outcome: 'cancel_requested', delivered: false } : this.cancel(caller, input);
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

  /**
   * Events after `cursor` (exclusive) and the jobs needing attention. Cursors are global event ids; events of jobs
   * the agent may not see are filtered out before the limit, so they never take a place on its page.
   */
  feed(input: { cursor: number; limit: number; mine: boolean }, caller: Caller): Feed {
    const scope = this.#visible(caller, input.mine);
    const page = this.store.eventsAfter(input.cursor, input.limit + 1, scope);
    const events = page.slice(0, input.limit);
    return {
      events,
      nextCursor: events.at(-1)?.id ?? input.cursor,
      hasMore: page.length > input.limit,
      attention: this.store.attention(this.#clock(), ATTENTION_RECENT_MS, MAX_ATTENTION, scope),
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
