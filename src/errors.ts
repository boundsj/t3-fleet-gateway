/** Stable error codes. Callers and agents may branch on these; never rename one. */
export type ErrorCode =
  | 'config_not_found'
  | 'config_invalid'
  | 'data_dir_insecure'
  | 'database_error'
  | 'invalid_argument'
  | 'not_found'
  | 'host_not_found'
  | 'host_not_enrolled'
  | 'host_unreachable'
  | 't3_unauthorized'
  | 't3_timeout'
  | 't3_response_lost'
  | 't3_tool_failed'
  | 't3_invalid_response'
  | 'pairing_command_failed'
  | 'enrollment_failed'
  | 'insufficient_scope'
  | 'job_state_conflict'
  | 'request_id_conflict'
  | 'internal_error';

export class GatewayError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GatewayError';
    this.code = code;
  }
}

export function isGatewayError(error: unknown): error is GatewayError {
  return error instanceof GatewayError;
}

/** Reduce any thrown value to a code and a message that is safe to log or show. */
export function describeError(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof GatewayError) return { code: error.code, message: error.message };
  return { code: 'internal_error', message: error instanceof Error ? error.name : 'Unknown error' };
}
