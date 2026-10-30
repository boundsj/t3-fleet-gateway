import { SdkHttpError } from '@modelcontextprotocol/client';
import { GatewayError, type ErrorCode } from '../errors.ts';

const STAGES = ['registration', 'approval', 'token', 'mint', 'verification', 'preflight', 'enrollment'] as const;
type Stage = typeof STAGES[number];
const REASONS = ['http_error', 'request_failed', 'invalid_response', 'denied', 'command_failed', 'command_cancelled',
  'executable_missing', 'executable_not_executable', 'command_json_invalid', 'pairing_code_missing',
  't3_unauthorized', 't3_timeout', 't3_response_lost', 't3_tool_failed', 't3_invalid_response', 'host_unreachable', 'internal_error'] as const;
type Reason = typeof REASONS[number];
// A short identifier alone is not redaction: an arbitrary token can also look like an error code.
// Only recognized protocol/tool codes cross the local diagnostic boundary; unknown values remain unrecognized.
const UPSTREAM_CODES = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'invalid_scope', 'invalid_token',
  'unauthorized_client', 'unsupported_grant_type', 'unsupported_response_type', 'access_denied', 'server_error',
  'temporarily_unavailable', 'invalid_pairing_code', 'pairing_code_expired', 'pairing_code_invalid', 'unavailable',
  'unauthorized', 'forbidden', 'not_found', 'internal_error', 'timeout', 'AuthMcpApprovalError', 'unrecognized']);

export function enrollmentCode(value: unknown): string {
  return typeof value === 'string' && UPSTREAM_CODES.has(value) ? value : 'unrecognized';
}

/** Retain only typed numeric HTTP metadata through a bounded transport-cause chain. */
export function enrollmentHttpStatus(error: unknown): number | undefined {
  let current = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (current instanceof SdkHttpError) return current.status;
    current = current.cause;
  }
  return undefined;
}

/** Safe by construction. No raw response, command output or exception message becomes a diagnostic. */
export class EnrollmentError extends GatewayError {
  constructor(code: ErrorCode, stage: Stage, reason: Reason, options: { status?: number; upstream?: unknown; exit?: number; cause?: unknown } = {}) {
    const status = Number.isInteger(options.status) && options.status! >= 100 && options.status! <= 599 ? `; HTTP ${options.status}` : '';
    const upstream = options.upstream === undefined ? '' : `; T3 ${enrollmentCode(options.upstream)}`;
    const exit = Number.isInteger(options.exit) && options.exit! >= 0 && options.exit! <= 255 ? `; exit code ${options.exit}` : '';
    super(code, `Credential enrollment failed (${stage}: ${reason}${status}${upstream}${exit}).`, { cause: options.cause });
  }
}

/** Validate persisted diagnostics too: old builds could store a downstream error's arbitrary message. */
export function safeEnrollmentDetail(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length > 240) return null;
  const match = /^Credential enrollment failed \(([a-z_]+): ([a-z0-9_]+)(?:; HTTP ([1-5][0-9]{2}))?(?:; T3 ([A-Za-z_]+))?(?:; exit code ([0-9]{1,3}))?\)\.$/.exec(value);
  if (!match || !STAGES.includes(match[1] as Stage) || !REASONS.includes(match[2] as Reason) ||
      (match[4] !== undefined && !UPSTREAM_CODES.has(match[4])) || (match[5] !== undefined && Number(match[5]) > 255)) return null;
  return value;
}

export function enrollmentFailure(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof EnrollmentError) return { code: error.code, message: error.message };
  const code = error instanceof GatewayError ? error.code : 'internal_error';
  const reason = REASONS.includes(code as Reason) ? code as Reason : 'internal_error';
  return { code, message: new EnrollmentError(code, 'enrollment', reason).message };
}
