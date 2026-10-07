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
