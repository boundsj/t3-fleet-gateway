import * as z from 'zod';
import { MAX_TASK_CHARS, MAX_TITLE_CHARS, REQUEST_ID_PATTERN, type JobService } from '../jobs/service.ts';
import { JOB_STATES, STATE_MEANINGS } from '../jobs/states.ts';
import type { Job, JobEvent } from '../jobs/store.ts';
import { OPERATE_SCOPE, READ_SCOPE } from '../oauth/scopes.ts';
import { isoTime } from '../time.ts';
import { defineTool, type GatewayTool, type ToolContext } from './tools.ts';

const MAX_LIST_LIMIT = 100;

const STATE_GUIDE = JOB_STATES.map((state) => `${state}: ${STATE_MEANINGS[state]}`).join(' ');

const time = z.string().describe('ISO 8601');
const nullableTime = time.nullable();

const jobIdInput = z.string().regex(/^[0-9a-z]{6,32}$/, 'a job id as returned by work_start').describe('The jobId returned by work_start');

const jobSchema = z.object({
  jobId: z.string(),
  state: z.enum(JOB_STATES),
  project: z.string(),
  host: z.string(),
  title: z.string().describe('The T3 thread title; it ends with the marker [job:<jobId>]'),
  branch: z.string().describe('The git branch of the job worktree'),
  threadId: z.string().nullable().describe('The T3 thread, once it exists'),
  createdAt: time,
  updatedAt: time,
  finishedAt: nullableTime,
  startedByYou: z.boolean(),
});

const eventSchema = z.object({
  cursor: z.string().describe('Feed position of this event'),
  jobId: z.string(),
  type: z.string().describe('created, state_changed, followup_sent, input_answered or turn_finished'),
  fromState: z.enum(JOB_STATES).nullable(),
  toState: z.enum(JOB_STATES).nullable(),
  reason: z.string().nullable(),
  code: z.string().nullable(),
  at: time,
});

const errorSchema = z.object({ code: z.string(), message: z.string() });

const questionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string(), value: z.string().nullable() })),
  multiSelect: z.boolean(),
});

const jobDetailSchema = jobSchema.extend({
  stateMeaning: z.string(),
  pendingRequests: z
    .array(z.object({ requestId: z.string(), questions: z.array(questionSchema).nullable().describe('null when T3 could not be asked just now') }))
    .describe('Questions the worker is waiting on; answer with work_respond'),
  waitingForApproval: z.boolean().describe('Blocked on a permission approval that only the operator can give in T3'),
  latestMessageExcerpt: z.string().nullable().describe("The start of the worker's latest message, bounded"),
  latestActivityAt: nullableTime,
  hostUnreachableSince: nullableTime.describe('Set while the gateway cannot reach the host; the job state is kept'),
  lastError: errorSchema.nullable(),
  recentEvents: z.array(eventSchema),
});

export type JobView = z.infer<typeof jobSchema>;
export type JobDetailView = z.infer<typeof jobDetailSchema>;

export function jobView(job: Job, context: ToolContext): JobView {
  return {
    jobId: job.id,
    state: job.state,
    project: job.projectAlias,
    host: job.hostId,
    title: job.title,
    branch: job.branch,
    threadId: job.threadId,
    createdAt: isoTime(job.createdAt),
    updatedAt: isoTime(job.updatedAt),
    finishedAt: job.finishedAt === null ? null : isoTime(job.finishedAt),
    startedByYou: job.clientId === context.clientId,
  };
}

export function eventView(event: JobEvent): z.infer<typeof eventSchema> {
  return {
    cursor: String(event.id),
    jobId: event.jobId,
    type: event.type,
    fromState: event.fromState,
    toState: event.toState,
    reason: event.detail.reason ?? null,
    code: event.detail.code ?? null,
    at: isoTime(event.createdAt),
  };
}

function describeJob(job: JobView): string {
  return `${job.jobId} [${job.state}] ${job.project}: ${job.title}`;
}

export function workTools(jobs: JobService): GatewayTool[] {
  const workStart = defineTool({
    name: 'work_start',
    title: 'Start work',
    description:
      'Start a coding job in a project: the gateway creates a fresh git worktree and branch on the project host, opens a T3 Code ' +
      'thread there and gives the worker your task. Returns at once with a jobId in state "queued"; the job moves to "running" ' +
      'when its host has a free slot. Follow it with work_feed (recommended: poll with the last cursor) or work_status. ' +
      'Idempotent: always pass a unique requestId per new piece of work; retrying with the same requestId and the same input ' +
      'returns the same job (created=false) instead of starting another, and reusing a requestId with different input is ' +
      'rejected. Write the task as a complete instruction for a coding agent that cannot ask you anything mid-way except ' +
      'through questions you answer with work_respond. Use fleet_status to learn the project aliases.',
    scope: OPERATE_SCOPE,
    readOnly: false,
    inputSchema: z.object({
      project: z.string().min(1).max(64).describe('Project alias from fleet_status'),
      task: z.string().min(1).max(MAX_TASK_CHARS).describe('What the worker should do, as a complete instruction'),
      requestId: z
        .string()
        .regex(REQUEST_ID_PATTERN, 'use 1-128 letters, digits, dots, underscores, colons or hyphens')
        .describe('Your unique id for this request, for safe retries (for example a UUID)'),
      title: z.string().min(1).max(MAX_TITLE_CHARS).optional().describe('Short thread title; defaults to the first line of the task'),
    }),
    outputSchema: z.object({ job: jobSchema, created: z.boolean().describe('false when this requestId was already used: the existing job') }),
    async run(input, context) {
      const { job, created } = jobs.start(context, input);
      const view = jobView(job, context);
      const prefix = created ? 'Started job' : 'Already started (same requestId):';
      return { structured: { job: view, created }, summary: `${prefix} ${describeJob(view)}. Poll work_feed or work_status for progress.` };
    },
  });

  const workList = defineTool({
    name: 'work_list',
    title: 'List jobs',
    description:
      'List jobs, newest first, optionally filtered by project, by state, or to the jobs you started. Use it to find a jobId ' +
      `or to see what is active. Read-only. States: ${STATE_GUIDE}`,
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: z.object({
      project: z.string().min(1).max(64).optional().describe('Only jobs in this project alias'),
      states: z.array(z.enum(JOB_STATES)).max(JOB_STATES.length).optional().describe('Only jobs in these states'),
      mine: z.boolean().optional().describe('Only jobs started by this agent'),
      limit: z.int().min(1).max(MAX_LIST_LIMIT).optional().describe(`Default 20, at most ${MAX_LIST_LIMIT}`),
    }),
    outputSchema: z.object({ jobs: z.array(jobSchema) }),
    async run(input, context) {
      const found = jobs.list({ project: input.project, states: input.states, mine: input.mine, limit: input.limit ?? 20 }, context);
      const views = found.map((job) => jobView(job, context));
      const summary = views.length === 0 ? 'No matching jobs.' : views.map(describeJob).join('\n');
      return { structured: { jobs: views }, summary };
    },
  });

  const workStatus = defineTool({
    name: 'work_status',
    title: 'Job status',
    description:
      "Show one job in detail: state and what it means, the T3 thread, branch, timestamps, the worker's pending questions, " +
      "whether it waits for an operator approval, an excerpt of the worker's latest message, host reachability, the last " +
      'error and recent events. Use it when work_feed reports a change on a job, before deciding to continue, respond or ' +
      `cancel. Read-only. States: ${STATE_GUIDE}`,
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: z.object({ jobId: jobIdInput }),
    outputSchema: jobDetailSchema,
    async run(input, context) {
      const detail = await jobs.status(input.jobId);
      const { job } = detail;
      const view: JobDetailView = {
        ...jobView(job, context),
        stateMeaning: STATE_MEANINGS[job.state],
        pendingRequests: detail.pendingRequests,
        waitingForApproval: detail.waitingForApproval,
        latestMessageExcerpt: job.latestMessageExcerpt,
        latestActivityAt: job.latestActivityAt === null ? null : isoTime(job.latestActivityAt),
        hostUnreachableSince: job.hostUnreachableSince === null ? null : isoTime(job.hostUnreachableSince),
        lastError: job.lastErrorCode === null ? null : { code: job.lastErrorCode, message: job.lastErrorMessage ?? '' },
        recentEvents: detail.recentEvents.map(eventView),
      };
      const lines = [describeJob(view), STATE_MEANINGS[job.state]];
      if (view.pendingRequests.length > 0) lines.push(`Pending questions: ${view.pendingRequests.map((request) => request.requestId).join(', ')}`);
      if (view.waitingForApproval) lines.push('Waiting for an approval the operator must give in T3.');
      if (view.hostUnreachableSince) lines.push(`Host unreachable since ${view.hostUnreachableSince}.`);
      if (view.lastError) lines.push(`Last error: ${view.lastError.code}`);
      if (view.latestMessageExcerpt) lines.push(`Latest worker message (excerpt):\n${view.latestMessageExcerpt}`);
      return { structured: view, summary: lines.join('\n') };
    },
  });

  return [workStart, workList, workStatus];
}
