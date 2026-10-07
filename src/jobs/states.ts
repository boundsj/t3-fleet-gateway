/** Job states as stored in `jobs.state`. See docs/design.md, "Jobs". */
export const JOB_STATES = [
  'queued',
  'dispatching',
  'running',
  'needs_input',
  'idle',
  'cancel_requested',
  'cancelled',
  'failed',
  'unknown',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** States that occupy one of a host's `maxConcurrentJobs` slots. `unknown` counts: a launch may have happened. */
export const RUNNING_STATES: readonly JobState[] = ['dispatching', 'running', 'needs_input', 'cancel_requested', 'unknown'];

/** No further transitions happen from these states. */
export const TERMINAL_STATES: readonly JobState[] = ['cancelled', 'failed'];

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** What each state means to an agent. Shown by work_status and in tool descriptions. */
export const STATE_MEANINGS: Record<JobState, string> = {
  queued: 'Waiting for a free slot on its host; the T3 thread does not exist yet.',
  dispatching: 'The gateway is creating the T3 thread and worktree right now.',
  running: 'The worker is working on its turn.',
  needs_input:
    'The worker is blocked: it asked a question (answer with work_respond) or needs a permission approval that only the operator can give in T3 (projects with runtimeMode approval-required).',
  idle: 'The worker finished its turn and is waiting: ready for review or the next instruction (work_continue). Not proof the task succeeded.',
  cancel_requested: 'An interrupt was requested; waiting for T3 to confirm the thread stopped.',
  cancelled: 'Stopped by work_cancel. Terminal.',
  failed: 'The job could not start or its run failed. Terminal; see lastError. Start a new job to retry.',
  unknown:
    'The gateway cannot tell yet whether the launch happened (for example the response was lost). It is checking T3; do not start a duplicate yet.',
};
