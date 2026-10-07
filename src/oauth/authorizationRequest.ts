import { hmacBase64Url, safeEqual } from '../crypto.ts';
import { MINUTE } from '../time.ts';
import type { ClientStore, OAuthClient } from './clients.ts';
import type { OAuthErrorCode } from './errors.ts';
import { formatScope, parseScope, type Scope } from './scopes.ts';

/** How long an approval page stays valid after it was rendered. */
export const APPROVAL_PAGE_TTL = 10 * MINUTE;
const MAX_STATE_LENGTH = 1024;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export interface AuthorizationRequest {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  /** Scopes the client asked for; empty when it did not say. */
  requestedScopes: Scope[];
  resource: string | null;
}

export type AuthorizationParseResult =
  | { kind: 'ok'; request: AuthorizationRequest }
  /** The client or redirect URI cannot be trusted: show an error page, never redirect. */
  | { kind: 'fatal'; message: string }
  /** The request is from a known client to a registered redirect URI: report the error there. */
  | { kind: 'redirect'; redirectUri: string; state: string | null; error: OAuthErrorCode; description: string };

const SINGLE_VALUED = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];

function sameResource(a: string, b: string): boolean {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

/** Validate an authorization request (RFC 6749 4.1.1 with OAuth 2.1 and RFC 8707 rules). */
export function parseAuthorizationRequest(params: URLSearchParams, clients: ClientStore, resource: string): AuthorizationParseResult {
  const clientId = params.get('client_id');
  if (!clientId || params.getAll('client_id').length > 1) return { kind: 'fatal', message: 'Missing or repeated client_id.' };
  const client = clients.getActive(clientId);
  if (!client) return { kind: 'fatal', message: 'Unknown or revoked client. Reconnect from your agent to register again.' };
  const redirectUri = params.get('redirect_uri');
  if (!redirectUri || params.getAll('redirect_uri').length > 1 || !client.redirectUris.includes(redirectUri)) {
    return { kind: 'fatal', message: 'The redirect URI does not match one registered for this client.' };
  }
  const state = params.get('state');
  const fail = (error: OAuthErrorCode, description: string): AuthorizationParseResult => ({
    kind: 'redirect',
    redirectUri,
    state: state !== null && state.length <= MAX_STATE_LENGTH ? state : null,
    error,
    description,
  });
  if (SINGLE_VALUED.some((name) => params.getAll(name).length > 1)) return fail('invalid_request', 'Parameters must not repeat');
  if (state !== null && state.length > MAX_STATE_LENGTH) return fail('invalid_request', 'state is too long');
  if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
  const codeChallenge = params.get('code_challenge');
  if (!codeChallenge || params.get('code_challenge_method') !== 'S256' || !PKCE_CHALLENGE.test(codeChallenge)) {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  const requestedResource = params.get('resource');
  if (requestedResource !== null && !sameResource(requestedResource, resource)) {
    return fail('invalid_target', `resource must be ${resource}`);
  }
  const requestedScopes = parseScope(params.get('scope'));
  if (!requestedScopes) return fail('invalid_scope', 'Unknown scope requested');
  return { kind: 'ok', request: { client, redirectUri, codeChallenge, state, requestedScopes, resource: requestedResource } };
}

function canonical(request: AuthorizationRequest, issuedAt: number): string {
  return JSON.stringify([
    request.client.id,
    request.redirectUri,
    request.codeChallenge,
    request.state,
    formatScope(request.requestedScopes),
    request.resource,
    issuedAt,
  ]);
}

/** HMAC binding the approval form to the exact request it was rendered for. */
export function signAuthorizationRequest(key: Buffer, request: AuthorizationRequest, issuedAt: number): string {
  return hmacBase64Url(key, `authorize:${canonical(request, issuedAt)}`);
}

export function verifyAuthorizationSignature(
  key: Buffer,
  request: AuthorizationRequest,
  issuedAt: number,
  signature: string,
  now: number,
): 'ok' | 'invalid' | 'expired' {
  if (!safeEqual(signAuthorizationRequest(key, request, issuedAt), signature)) return 'invalid';
  return now - issuedAt > APPROVAL_PAGE_TTL || issuedAt > now + MINUTE ? 'expired' : 'ok';
}

/** Where to send the user agent with an authorization response or error. */
export function authorizationRedirect(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) if (value !== null) url.searchParams.set(name, value);
  return url.href;
}
