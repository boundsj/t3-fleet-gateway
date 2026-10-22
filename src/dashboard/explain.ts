/**
 * Fixed operator-facing explanations for the codes the dashboard shows. The dashboard never shows an error's own
 * message (it can carry URLs, paths or text T3 returned); it shows the stable code and one of these sentences.
 */

/** A code as stored by the gateway or returned by T3, or null when it is not a short identifier (never shown raw then). */
export function safeCode(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : null;
}

const HOST_ERRORS: Record<string, string> = {
  host_unreachable: 'Nothing answered at the host\'s T3 URL, or it answered with an HTTP error. The gateway cannot tell which hop failed: a tunnel, the network or T3 itself.',
  t3_timeout: 'T3 did not answer within the check\'s deadline. The host may be overloaded, asleep or behind a stalled tunnel.',
  t3_response_lost: 'The connection closed or T3 answered with a server error before the check completed.',
  t3_unauthorized: 'T3 answered but refused the gateway\'s stored credential (revoked in T3, or replaced). Enroll the host again.',
  host_not_enrolled: 'The gateway has no T3 credential for this host yet, so it cannot ask it anything.',
  t3_invalid_response: 'T3 answered in a shape this gateway does not understand. Compare versions (npm run compat:check).',
  t3_tool_failed: 'T3 answered the check with a tool error.',
  internal_error: 'The check failed inside the gateway. See the service log for the error code.',
};

export function explainHostError(code: string | null): string {
  if (code === null) return 'The check failed.';
  return HOST_ERRORS[code] ?? 'The check failed with this code. See docs/operations.md or run doctor for details.';
}

const RENEWAL_ERRORS: Record<string, string> = {
  pairing_command_failed: 'The mint command failed or could not be found in the service environment. Run doctor with the service PATH.',
  enrollment_failed: 'T3 refused the pairing approval, or the new credential did not verify. The previous credential stays in use.',
  host_unreachable: 'T3 could not be reached during renewal. The previous credential stays in use; renewal retries on schedule.',
  t3_timeout: 'T3 did not answer during renewal. The previous credential stays in use; renewal retries on schedule.',
};

export function explainRenewalError(code: string | null): string {
  if (code === null) return 'The last renewal attempt failed.';
  return RENEWAL_ERRORS[code] ?? 'The last renewal attempt failed with this code; the previous credential stays in use. Run hosts status for details.';
}

const JOB_ERRORS: Record<string, string> = {
  t3_run_failed: 'The worker\'s run failed in T3.',
  thread_missing: 'T3 no longer has the job\'s thread.',
  launch_not_confirmed: 'The launch could not be confirmed in T3 within the reconciliation window; nothing was relaunched.',
  launch_not_started: 'T3 created the thread but no run ever started on it.',
  invalid_request: 'T3 refused the launch (often: no model selection and no project default).',
  model_selection_invalid: 'The model selection was no longer offered by the host when the job launched.',
  launch_policy_changed: 'The project\'s launch policy changed while the job was queued, so it was not launched.',
  project_not_configured: 'The job\'s project alias is no longer in the configuration.',
  project_not_found: 'The job\'s T3 project no longer exists.',
  database_error: 'The job\'s stored launch plan could not be read, so it was not launched. Start the work again.',
  host_unreachable: 'The host could not be reached while following this job; it keeps its state.',
  t3_invalid_response: 'T3 answered in an unexpected shape while following this job.',
};

export function explainJobError(code: string | null): string | null {
  if (code === null) return null;
  return JOB_ERRORS[code] ?? null;
}

const REVOCATIONS: Record<string, string> = {
  client_revoked: 'revoked by the operator',
  refresh_token_reuse: 'revoked: a rotated refresh token was presented again (possible token replay)',
  authorization_code_reuse: 'revoked: an authorization code was presented again (possible interception)',
};

export function explainRevocation(code: string | null): string {
  if (code === null) return 'revoked';
  return REVOCATIONS[code] ?? 'revoked';
}

/** Short past-tense phrases for event reasons, for the activity log. Unknown reasons are shown as their code. */
export const EVENT_REASONS: Record<string, string> = {
  launched: 'launched in T3',
  reconciled: 'found in T3 after an unconfirmed launch',
  completed: 'turn finished',
  question: 'asked a question',
  approval: 'waiting for approval in T3',
  followup: 'got a follow-up',
  input_answered: 'question answered',
  interrupted: 'interrupted',
  launch_rejected: 'launch refused by T3',
  launch_not_started: 'thread created without a run',
  launch_not_confirmed: 'launch not confirmed',
  run_failed: 'run failed',
  worker_resumed: 'recovered after a failed turn',
  released: 'released by the operator',
  turn_started: 'started a turn by itself',
  waiting_on_delegated_work: 'waiting on delegated work',
  adopted: 'adopted by the operator',
  dispatch_interrupted: 'dispatch interrupted by a restart',
  no_turn_started: 'delegated work ended without a new turn',
  cancel_requested: 'cancel requested',
  cancelled_before_launch: 'cancelled before launch',
  interrupt_requested: 'interrupt requested',
  host_unreachable: 'host unreachable during launch; queued again',
  launch_outcome_unknown: 'launch outcome unknown; reconciling',
  thread_missing: 'thread no longer in T3',
};

const EVENT_TYPES: Record<string, string> = {
  created: 'Created',
  job_recovered: 'Worker recovered',
  followup_sent: 'Follow-up delivered',
  input_answered: 'Question answered',
  turn_finished: 'Ran a turn by itself',
  delegated_work_ended: 'Delegated work ended',
  pull_request_opened: 'Pull request opened',
  pull_request_merged: 'Pull request merged',
  interrupt_requested: 'Interrupt requested',
};

/** One line for an event, from its type, states and codes only. */
export function describeEvent(type: string, from: string | null, to: string | null, reason: string | null): string {
  const why = reason === null ? null : EVENT_REASONS[reason] ?? reason;
  if (type === 'state_changed' && to !== null) return `${from ?? '—'} → ${to}${why ? ` (${why})` : ''}`;
  if (type === 'created') return `Created as ${to ?? 'queued'}${why ? ` (${why})` : ''}`;
  return `${EVENT_TYPES[type] ?? type}${why && type !== 'interrupt_requested' && type !== 'input_answered' ? ` (${why})` : ''}`;
}
