import { describeError } from '../errors.ts';
import { explainHostError, explainJobError } from '../dashboard/explain.ts';
import type { Clock } from '../time.ts';

export const SIGNAL_LABELS = {
  models: 'Model catalog', projects: 'Project catalog', dispatch: 'Dispatch', start: 'Work start',
  t3_environment_read: 'Environment read', t3_project_list: 'Project list',
  t3_thread_read: 'Thread read', t3_thread_list: 'Thread list', t3_thread_search: 'Thread search',
  t3_thread_launch: 'Thread launch', t3_thread_send: 'Thread send', t3_thread_interrupt: 'Thread interrupt',
  t3_thread_organize: 'Thread settlement', t3_pending_request_list: 'Pending request list',
  t3_pending_request_read: 'Pending request read', t3_pending_request_respond: 'Pending request response',
} as const;
// Codes are contracts, never arbitrary strings supplied by upstream or thrown objects.
const SIGNAL_CODES = new Set(['host_unreachable', 'host_not_enrolled', 't3_unauthorized', 't3_timeout', 't3_response_lost',
  't3_invalid_response', 't3_tool_failed', 'catalog_limit', 'internal_error', 'database_error', 'invalid_argument',
  'not_found', 'project_not_configured', 'project_not_found', 'model_selection_invalid', 'launch_policy_changed',
  'workspace_probe_failed', 'workspace_probe_unavailable']);

const START_FAILURE_CODES = new Set(['host_unreachable', 'host_not_enrolled', 't3_unauthorized', 't3_timeout',
  't3_response_lost', 't3_invalid_response', 't3_tool_failed', 'catalog_limit', 'internal_error', 'database_error',
  'workspace_probe_failed', 'workspace_probe_unavailable']);
const CALL_FAILURE_CODES = new Set(['host_unreachable', 't3_unauthorized', 't3_timeout', 't3_response_lost', 't3_invalid_response']);

export function isCallSignal(kind: SignalKind): boolean { return kind.startsWith('t3_'); }

export type SignalKind = keyof typeof SIGNAL_LABELS;
export interface HostSignal {
  kind: SignalKind;
  code: string | null;
  message: string;
  checkedAt: number;
  problem: { firstSeen: number; lastSeen: number; count: number } | null;
}

/** A fixed number of slots per configured host. Only codes and fixed text survive the observation boundary. */
export class HostSignals {
  readonly #clock: Clock;
  readonly #values = new Map<SignalKind, HostSignal>();
  constructor(clock: Clock) { this.#clock = clock; }

  record(kind: SignalKind, error?: unknown): void {
    this.recordCode(kind, error === undefined ? null : describeError(error).code);
  }

  recordCode(kind: SignalKind, candidate: string | null): void {
    // Ignored application/caller errors leave the prior observation untouched, including its age and count.
    if (candidate !== null && ((kind === 'start' && !START_FAILURE_CODES.has(candidate))
      || (isCallSignal(kind) && !CALL_FAILURE_CODES.has(candidate)))) return;
    const now = this.#clock();
    const previous = this.#values.get(kind);
    const code = candidate === null ? null : SIGNAL_CODES.has(candidate) ? candidate : 'internal_error';
    this.#values.set(kind, {
      kind, code, checkedAt: now,
      message: code === null ? 'The last observed operation succeeded.' : ((kind === 'dispatch' ? explainJobError(code) : null) ?? explainHostError(code)).slice(0, 300),
      problem: code === null ? null : {
        firstSeen: previous?.problem?.firstSeen ?? now, lastSeen: now,
        count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.problem?.count ?? 0) + 1),
      },
    });
  }

  snapshot(): HostSignal[] {
    return [...this.#values.values()].map((value) => ({ ...value, problem: value.problem && { ...value.problem } }));
  }
}
