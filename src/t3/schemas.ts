import * as z from 'zod';

/** The fields of `t3_environment_read` the gateway relies on. Extra fields are kept, not validated. */
export const environmentSchema = z.looseObject({
  environmentId: z.string(),
  serverVersion: z.string(),
  platform: z.looseObject({ os: z.string(), arch: z.string() }),
});
export type T3Environment = z.infer<typeof environmentSchema>;

export const projectSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  deletedAt: z.string().nullable().optional(),
  /** The model T3 uses for a launch that passes no `modelSelection`; without one, such a launch is refused. */
  defaultModelSelection: z.unknown().optional(),
});
export type T3Project = z.infer<typeof projectSchema>;

export const projectListSchema = z.looseObject({
  projects: z.array(projectSchema),
  nextCursor: z.number().int().nullable().optional(),
});

/**
 * Thread and run status values T3 documents. Outputs are parsed as plain strings so that a status
 * added by a newer T3 does not break watching; the job layer treats unrecognised values as active.
 */
export const THREAD_STATUSES = [
  'idle',
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting',
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** A run is still going (or about to) in these statuses. `waiting` means it is blocked on the user. */
export const ACTIVE_RUN_STATUSES: readonly string[] = ['preparing', 'queued', 'starting', 'running', 'waiting'];

export const RUNTIME_MODE_VALUES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;

/** Input of `t3_thread_launch` as the gateway sends it (a subset of what T3 accepts). */
export interface LaunchThreadInput {
  projectId: string;
  title: string;
  workspaceStrategy: { type: 'worktree'; baseRef: string; branch: string; startFromOrigin: boolean };
  runtimeMode: (typeof RUNTIME_MODE_VALUES)[number];
  modelSelection?: Record<string, unknown>;
  message: string;
}

export const launchResultSchema = z.looseObject({
  threadId: z.string().min(1),
  link: z.string(),
  projectId: z.string(),
  runId: z.string().nullable(),
  status: z.string().nullable(),
});
export type LaunchResult = z.infer<typeof launchResultSchema>;

export const threadSummarySchema = z.looseObject({
  threadId: z.string(),
  link: z.string(),
  title: z.string(),
  status: z.string(),
  latestRunId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadListSchema = z.looseObject({
  projectId: z.string(),
  threads: z.array(threadSummarySchema),
  nextCursor: z.number().int().nullable(),
  total: z.number().int(),
});
export type ThreadList = z.infer<typeof threadListSchema>;

export const threadSearchSchema = z.looseObject({
  matches: z.array(
    z.looseObject({
      threadId: z.string(),
      projectId: z.string(),
      source: z.string(),
      snippet: z.string(),
    }),
  ),
});
export type ThreadSearch = z.infer<typeof threadSearchSchema>;

export const threadItemSchema = z.looseObject({
  position: z.number().int(),
  itemId: z.string(),
  runId: z.string().nullable(),
  createdBy: z.string().nullable(),
  creationSource: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  text: z.string().nullable(),
  textTruncated: z.boolean(),
  updatedAt: z.string(),
  /** Set on some item types: a `subagent` item's title is the delegated task's title. */
  title: z.string().nullable().optional(),
});
export type ThreadItem = z.infer<typeof threadItemSchema>;

export const threadRunSchema = z.looseObject({
  runId: z.string(),
  ordinal: z.number().int(),
  status: z.string(),
  completedAt: z.string().nullable(),
});
export type ThreadRun = z.infer<typeof threadRunSchema>;

export const threadReadSchema = z.looseObject({
  thread: z.looseObject({
    threadId: z.string(),
    link: z.string(),
    projectId: z.string(),
    title: z.string(),
    status: z.string(),
    latestRunId: z.string().nullable(),
    activeRunId: z.string().nullable(),
    pendingRequestCount: z.number().int(),
    branch: z.string().nullable(),
    updatedAt: z.string(),
  }),
  recentRuns: z.array(threadRunSchema),
  items: z.array(threadItemSchema),
  nextPosition: z.number().int().nullable(),
  hasMore: z.boolean(),
});
export type ThreadRead = z.infer<typeof threadReadSchema>;

export const SEND_MODES = ['auto', 'queue', 'steer', 'restart'] as const;

export const sendResultSchema = z.looseObject({
  threadId: z.string(),
  messageId: z.string(),
  runId: z.string(),
  status: z.string(),
  delivery: z.string(),
});
export type SendResult = z.infer<typeof sendResultSchema>;

export const interruptResultSchema = z.looseObject({
  threadId: z.string(),
  runId: z.string().nullable(),
  status: z.string(),
});
export type InterruptResult = z.infer<typeof interruptResultSchema>;

export const pendingRequestListSchema = z.looseObject({ requestIds: z.array(z.string()) });

export const pendingRequestSchema = z.looseObject({
  requestId: z.string(),
  questions: z.array(
    z.looseObject({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      options: z.array(z.looseObject({ label: z.string(), description: z.string(), value: z.string().nullable().optional() })),
      multiSelect: z.boolean().nullable().optional(),
      allowCustomAnswer: z.boolean().nullable().optional(),
      required: z.boolean().nullable().optional(),
    }),
  ),
});
export type PendingRequest = z.infer<typeof pendingRequestSchema>;

export const respondResultSchema = z.looseObject({ sequence: z.number().int() });
