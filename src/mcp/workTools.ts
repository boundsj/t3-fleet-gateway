import * as z from 'zod';
import {
  ATTENTION_RECENT_MS,
  MAX_ANSWERS_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_TASK_CHARS,
  MAX_TITLE_CHARS,
  REQUEST_ID_PATTERN,
  type JobService,
} from '../jobs/service.ts';
import { JOB_STATES, STATE_MEANINGS } from '../jobs/states.ts';
import type { Job, JobEvent } from '../jobs/store.ts';
import { OPERATE_SCOPE, READ_SCOPE } from '../oauth/scopes.ts';
import { HOUR, isoTime } from '../time.ts';
import { defineTool, type GatewayTool, type ToolContext } from './tools.ts';

const MAX_LIST_LIMIT = 100;

const STATE_GUIDE = JOB_STATES.map((state) => `${state}: ${STATE_MEANINGS[state]}`).join(' ');

const time = z.string().describe('ISO 8601');
const nullableTime = time.nullable();

const MAX_FEED_LIMIT = 200;

const requestIdInput = z
  .string()
  .regex(REQUEST_ID_PATTERN, 'use 1-128 letters, digits, dots, underscores, colons or hyphens')
  .describe('Your unique id for this request, for safe retries (for example a UUID)');

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
      'rejected. Request ids are scoped to this tool: one you also use with work_continue does not collide. Write the task as a complete instruction for a coding agent that cannot ask you anything mid-way except ' +
      'through questions you answer with work_respond. Use fleet_status to learn the project aliases.',
    scope: OPERATE_SCOPE,
    readOnly: false,
    inputSchema: z.object({
      project: z.string().min(1).max(64).describe('Project alias from fleet_status'),
      task: z.string().min(1).max(MAX_TASK_CHARS).describe('What the worker should do, as a complete instruction'),
      requestId: requestIdInput,
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

  const workFeed = defineTool({
    name: 'work_feed',
    title: 'Job feed',
    description:
      'What changed since you last looked, plus the jobs that need you now. Designed for a scheduled routine: call it with ' +
      'the nextCursor from your previous call (omit cursor the first time), handle the events, store the new nextCursor, ' +
      'and call again with it while hasMore is true. The cursor is exclusive, so no event is returned twice. Events: ' +
      'created, state_changed (fromState to toState, with a reason), followup_sent, input_answered, turn_finished. ' +
      '"attention" lists jobs in needs_input (answer with work_respond, or the operator must approve in T3) or unknown ' +
      `(the gateway is confirming the launch) at any age, and jobs that went idle (turn finished: review with work_status, ` +
      `then work_continue or work_cancel) or failed within the last ${ATTENTION_RECENT_MS / HOUR} hours. ` +
      'An idle job is ready for review, not proof the task succeeded. Read-only.',
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: z.object({
      cursor: z
        .union([z.string().regex(/^\d{1,15}$/), z.int().min(0)])
        .optional()
        .describe('nextCursor from your previous work_feed call; omit to start from the beginning'),
      limit: z.int().min(1).max(MAX_FEED_LIMIT).optional().describe(`Events per page, default 50, at most ${MAX_FEED_LIMIT}`),
      mine: z.boolean().optional().describe('Only events and jobs from work this agent started'),
    }),
    outputSchema: z.object({
      events: z.array(eventSchema.extend({ project: z.string(), title: z.string() })),
      nextCursor: z.string().describe('Pass this as cursor next time'),
      hasMore: z.boolean().describe('More events are waiting: call again with nextCursor'),
      attention: z.array(jobSchema.extend({ why: z.string() })),
    }),
    async run(input, context) {
      const feed = jobs.feed({ cursor: Number(input.cursor ?? 0), limit: input.limit ?? 50, mine: input.mine ?? false }, context);
      const events = feed.events.map((event) => ({ ...eventView(event), project: event.projectAlias, title: event.title }));
      const attention = feed.attention.map((job) => ({ ...jobView(job, context), why: attentionReason(job.state, job.pendingRequestIds.length) }));
      const lines = [
        `${events.length} event(s)${feed.hasMore ? ', more waiting' : ''}; nextCursor ${feed.nextCursor}.`,
        ...events.map((event) => `#${event.cursor} ${event.jobId} ${event.type}${event.toState ? ` -> ${event.toState}` : ''}${event.reason ? ` (${event.reason})` : ''}`),
        attention.length === 0 ? 'Nothing needs attention.' : 'Needs attention:',
        ...attention.map((job) => `${job.jobId} [${job.state}] ${job.title}: ${job.why}`),
      ];
      return { structured: { events, nextCursor: String(feed.nextCursor), hasMore: feed.hasMore, attention }, summary: lines.join('\n') };
    },
  });

  const workContinue = defineTool({
    name: 'work_continue',
    title: 'Continue a job',
    description:
      "Send a follow-up instruction to a job's T3 thread: review feedback, the next step, or a correction. Use it when the " +
      'job is idle (its turn finished; this starts a new turn and the job goes back to running). On a running or needs_input ' +
      'job T3 steers the active turn or queues the message behind it. Idempotent: pass a unique requestId per message; ' +
      'repeating a requestId returns the first result without sending again, and if a call fails with an uncertain outcome, ' +
      'repeating it with the same requestId is safe. Request ids are scoped to this tool, separate from work_start. Not for answering a pending question: use work_respond.',
    scope: OPERATE_SCOPE,
    readOnly: false,
    inputSchema: z.object({
      jobId: jobIdInput,
      message: z.string().min(1).max(MAX_MESSAGE_CHARS).describe('The instruction for the worker'),
      requestId: requestIdInput,
    }),
    outputSchema: z.object({
      job: jobSchema,
      delivery: z.string().describe('started (new turn), steered (into the active turn) or queued (behind it)'),
      replayed: z.boolean().describe('true when this requestId was already delivered; nothing was sent again'),
    }),
    async run(input, context) {
      const result = await jobs.continue(context, input);
      const view = jobView(result.job, context);
      const summary = `${result.replayed ? 'Already sent (same requestId)' : 'Sent'}: ${result.delivery}. ${describeJob(view)}`;
      return { structured: { job: view, delivery: result.delivery, replayed: result.replayed }, summary };
    },
  });

  const workRespond = defineTool({
    name: 'work_respond',
    title: 'Answer a question',
    description:
      'Answer a question the worker asked: the job is needs_input and work_status lists it under pendingRequests with its ' +
      'questions. Pass that requestId and an answers object keyed by question id; each value is the chosen option ' +
      "(its value, or its label when it has no value), an array of them for multiSelect questions, or your own text when " +
      'custom answers are allowed. Only requests pending on this job are accepted. Permission approvals cannot be answered ' +
      'here: when work_status shows waitingForApproval, the operator must approve in T3.',
    scope: OPERATE_SCOPE,
    readOnly: false,
    inputSchema: z.object({
      jobId: jobIdInput,
      requestId: z.string().min(1).max(200).describe('A pendingRequests[].requestId from work_status'),
      answers: z
        .record(z.string().max(200), z.unknown())
        .refine((answers) => Object.keys(answers).length <= 50 && JSON.stringify(answers).length <= MAX_ANSWERS_CHARS, {
          message: `at most 50 answers and ${MAX_ANSWERS_CHARS} characters`,
        })
        .describe('Answers keyed by question id'),
    }),
    outputSchema: z.object({ job: jobSchema }),
    async run(input, context) {
      const job = await jobs.respond(input);
      const view = jobView(job, context);
      return { structured: { job: view }, summary: `Answered ${input.requestId}. ${describeJob(view)}` };
    },
  });

  const workCancel = defineTool({
    name: 'work_cancel',
    title: 'Cancel a job',
    description:
      "Stop a job. A queued job is cancelled at once without touching T3. Otherwise the gateway asks T3 to interrupt the " +
      'thread: outcome "cancelled" means it is confirmed stopped; "cancel_requested" means the interrupt is requested ' +
      '(delivered=true) or will be delivered when the host is reachable or the launch is confirmed (delivered=false), and ' +
      'the job moves to cancelled when the watcher sees the thread stop. Cancelled is terminal; the T3 thread and its ' +
      'worktree stay for the operator. Safe to repeat.',
    scope: OPERATE_SCOPE,
    readOnly: false,
    inputSchema: z.object({ jobId: jobIdInput }),
    outputSchema: z.object({
      job: jobSchema,
      outcome: z.enum(['cancelled', 'cancel_requested', 'already_finished']),
      confirmed: z.boolean().describe('The job is stopped'),
      delivered: z.boolean().describe('T3 has the interrupt request, or none was needed'),
    }),
    async run(input, context) {
      const result = await jobs.cancel(input);
      const view = jobView(result.job, context);
      const confirmed = view.state === 'cancelled' || view.state === 'failed';
      const summary =
        result.outcome === 'cancel_requested'
          ? `Cancel requested${result.delivered ? '' : ' (will be delivered when possible)'}; waiting for T3 to confirm. ${describeJob(view)}`
          : `${result.outcome === 'cancelled' ? 'Cancelled' : 'Already finished'}. ${describeJob(view)}`;
      return { structured: { job: view, outcome: result.outcome, confirmed, delivered: result.delivered }, summary };
    },
  });

  return [workStart, workContinue, workRespond, workCancel, workStatus, workList, workFeed];
}

function attentionReason(state: string, pendingQuestions: number): string {
  switch (state) {
    case 'needs_input':
      return pendingQuestions > 0
        ? 'The worker asked a question: read it with work_status and answer with work_respond.'
        : 'The worker waits for a permission approval that only the operator can give in T3.';
    case 'unknown':
      return 'The launch outcome is unconfirmed; the gateway is checking T3. Do not start a duplicate yet.';
    case 'idle':
      return 'Turn finished: review with work_status, then work_continue or work_cancel.';
    case 'failed':
      return 'Failed: see lastError in work_status. Start a new job to retry.';
    default:
      return STATE_MEANINGS[state as keyof typeof STATE_MEANINGS] ?? state;
  }
}
