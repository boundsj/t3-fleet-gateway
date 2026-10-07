/** OAuth error codes from RFC 6749, RFC 7591 and RFC 8707 that this server returns. */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'temporarily_unavailable';

export class OAuthError extends Error {
  readonly error: OAuthErrorCode;
  readonly status: number;

  constructor(error: OAuthErrorCode, description: string, status = 400) {
    super(description);
    this.name = 'OAuthError';
    this.error = error;
    this.status = status;
  }

  toJSON(): { error: OAuthErrorCode; error_description: string } {
    return { error: this.error, error_description: this.message };
  }
}
