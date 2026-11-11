import type { IncomingMessage, ServerResponse } from 'node:http';
import { readForm, readJson, sendHtml, sendJson, sendRedirect } from '../http/io.ts';
import type { Route } from '../http/server.ts';
import type { Logger } from '../log.ts';
import type { Clock } from '../time.ts';
import type { ApprovalCodes } from './approvalCodes.ts';
import {
  renderApprovalPage,
  renderErrorPage,
  renderNoticePage,
  renderReturnPage,
  type ApprovalChoice,
  type ApprovalHost,
} from './approvalPage.ts';
import { ApprovedRequests } from './approvedRequests.ts';
import { chooseGrant, type BrowserApprovals } from './browserApproval.ts';
import {
  authorizationRedirect,
  parseAuthorizationRequest,
  signAuthorizationRequest,
  verifyAuthorizationSignature,
  type AuthorizationParseResult,
  type AuthorizationRequest,
} from './authorizationRequest.ts';
import type { ClientStore } from './clients.ts';
import { OAuthError } from './errors.ts';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.ts';
import { formatScope } from './scopes.ts';
import { AUTHORIZATION_CODE_TTL, type TokenEvent, type TokenService } from './tokens.ts';

const OAUTH_BODY_LIMIT = 16 * 1024;
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };
const PUBLIC_DOCUMENT = { 'access-control-allow-origin': '*', 'cache-control': 'max-age=300' };

export interface OAuthDependencies {
  publicUrl: string;
  key: Buffer;
  clock: Clock;
  logger: Logger;
  clients: ClientStore;
  approvals: ApprovalCodes;
  tokens: TokenService;
  /** The configured hosts, offered on the approval page for a grant restricted to selected machines. */
  hosts: readonly ApprovalHost[];
  /** Browser approval by the signed-in owner on the dashboard listener, when configured. */
  browser?: BrowserApprovals | undefined;
}

/**
 * The choice a refused form showed, to show it again: a retry, even one that only corrects the approval code, must
 * not fall back to the request's defaults (All machines, or Operate), which may be more than the operator chose.
 * Only configured hosts are kept, and anything but exactly All machines shows Selected machines, so an empty, unknown
 * or malformed choice fails again on retry and never becomes all. A form without machine fields keeps the defaults.
 */
function submittedChoice(form: URLSearchParams, hosts: readonly ApprovalHost[]): ApprovalChoice {
  const access = form.get('access');
  const modes = form.getAll('hosts_mode');
  const picked = form.getAll('host');
  const choice: ApprovalChoice = { access: access === 'read' || access === 'operate' ? access : null };
  if (modes.length === 0 && picked.length === 0) return choice;
  const mode = modes.length === 1 && modes[0] === 'all' ? 'all' : 'selected';
  return { ...choice, machines: { mode, hosts: hosts.map((host) => host.id).filter((id) => picked.includes(id)) } };
}

export function logTokenEvent(logger: Logger): (event: TokenEvent) => void {
  return (event) => {
    if (event.type === 'issued') logger.info('oauth.token_issued', { clientId: event.clientId, familyId: event.familyId, grant: event.grant });
    else if (event.type === 'refresh_retry') logger.info('oauth.refresh_retry_accepted', { clientId: event.clientId, familyId: event.familyId });
    else logger.warn('oauth.token_family_revoked', { clientId: event.clientId, familyId: event.familyId, reason: event.reason });
  };
}

export function oauthRoutes(deps: OAuthDependencies): Route[] {
  const { publicUrl, logger } = deps;
  const approved = deps.browser?.approved ?? new ApprovedRequests(deps.clock);
  const hostIds = deps.hosts.map((host) => host.id);

  /**
   * Answer the approval form with a page that navigates to the client's redirect URI, never with a redirect: browsers
   * apply the page's form-action to every redirect after a submission, and a callback that redirects on to another
   * origin would be blocked silently, leaving the operator on the approval page.
   */
  const returnToClient = (res: ServerResponse, responseUrl: string, title: string, message: string): void => {
    sendHtml(res, 200, renderReturnPage({ title, message, responseUrl }));
  };

  const respondToParseFailure = (res: ServerResponse, result: Exclude<AuthorizationParseResult, { kind: 'ok' }>, fromForm = false): void => {
    if (result.kind === 'fatal') {
      logger.warn('oauth.authorize_rejected', { reason: 'untrusted_client_or_redirect' });
      sendHtml(res, 400, renderErrorPage(result.message));
      return;
    }
    logger.info('oauth.authorize_error', { errorCode: result.error });
    const location = authorizationRedirect(result.redirectUri, {
      error: result.error,
      error_description: result.description,
      state: result.state,
      iss: publicUrl,
    });
    if (fromForm) returnToClient(res, location, 'Authorization failed', 'The request was not valid. Returning to the agent with an error.');
    else sendRedirect(res, location);
  };

  /** The approval page, new or, with `retry`, the same signed form shown again with an error and the operator's choice. */
  const showApprovalPage = (
    res: ServerResponse,
    request: AuthorizationRequest,
    status: number,
    retry?: { error: string; issuedAt: number; choice: ApprovalChoice },
  ): void => {
    const issuedAt = retry?.issuedAt ?? deps.clock();
    const signature = signAuthorizationRequest(deps.key, request, issuedAt);
    const shown = retry ? { error: retry.error, choice: retry.choice } : {};
    // A new page also offers the owner's browser approval, when it is set up; a retried form keeps to the code it was using.
    const browserLink = retry ? undefined : deps.browser?.offer(request, signature, issuedAt);
    sendHtml(res, status, renderApprovalPage({ request, hosts: deps.hosts, issuedAt, signature, ...shown, ...(browserLink ? { browserLink } : {}) }));
  };

  const authorizeGet = (_req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const result = parseAuthorizationRequest(url.searchParams, deps.clients, deps.tokens.resource, hostIds);
    if (result.kind !== 'ok') return respondToParseFailure(res, result);
    logger.info('oauth.approval_page_shown', { clientId: result.request.client.id });
    showApprovalPage(res, result.request, 200);
  };

  const authorizePost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const form = await readForm(req, OAUTH_BODY_LIMIT);
    const result = parseAuthorizationRequest(form, deps.clients, deps.tokens.resource, hostIds);
    if (result.kind !== 'ok') return respondToParseFailure(res, result, true);
    const { request } = result;
    const clientId = request.client.id;
    const issuedAt = Number(form.get('issued_at'));
    const signature = form.get('signature') ?? '';
    const now = deps.clock();
    const integrity = Number.isSafeInteger(issuedAt) ? verifyAuthorizationSignature(deps.key, request, issuedAt, signature, now) : 'invalid';
    if (integrity !== 'ok') {
      logger.warn('oauth.approval_rejected', { clientId, reason: integrity === 'expired' ? 'page_expired' : 'signature_invalid' });
      sendHtml(res, 400, renderErrorPage('This approval page expired or was altered. Start the connection again from your agent.'));
      return;
    }
    const repeated = approved.lookup(signature);
    if (repeated) {
      // The same form submitted again after it was approved: never a new code, and not a failed attempt.
      const resend = repeated.kind === 'resend' && deps.tokens.authorizationCodePending(repeated.code);
      logger.info('oauth.approval_repeated', { clientId, resent: resend });
      const page = repeated.kind === 'denied'
        ? renderNoticePage('Already answered', 'This request was denied. Start the connection again from your agent if that was a mistake.')
        : resend
        ? renderReturnPage({
            title: 'Already approved',
            message: `This request was already approved for ${request.client.name}.`,
            responseUrl: repeated.url,
            navigate: false,
          })
        : renderNoticePage('Already approved', 'This request was already approved. Return to your agent, and retry the connection there if it did not complete.');
      sendHtml(res, 200, page);
      return;
    }
    const decision = form.get('decision');
    if (decision === 'deny') {
      deps.browser?.settle(signature);
      approved.rememberDenied(signature);
      logger.info('oauth.approval_denied', { clientId });
      const location = authorizationRedirect(request.redirectUri, { error: 'access_denied', state: request.state, iss: publicUrl });
      returnToClient(res, location, 'Access denied', `Access was denied for ${request.client.name}. Returning to the agent.`);
      return;
    }
    // Every refusal below shows the form again with the operator's choice, never the defaults.
    const showAgain = (error: string): void =>
      showApprovalPage(res, request, 400, { error, issuedAt, choice: submittedChoice(form, deps.hosts) });
    if (decision !== 'approve') {
      showAgain('Choose Read or Operate, then approve.');
      return;
    }
    // Checked before the approval code is spent: a refused choice costs no code and counts as no failed attempt.
    const grant = chooseGrant(request, form.get('access'), form.getAll('hosts_mode'), form.getAll('host'), deps.hosts);
    if ('error' in grant) {
      showAgain(grant.error);
      return;
    }
    const { scopes } = grant;
    const throttle = deps.approvals.throttleState(signature);
    if (throttle !== 'ok') {
      logger.warn('oauth.approval_throttled', { clientId, limit: throttle === 'global_locked' ? 'global' : 'request' });
      const message =
        throttle === 'global_locked'
          ? 'Too many failed approval attempts. Approvals are paused for up to an hour, or until a new code is minted with t3-fleet-gateway pair.'
          : 'Too many failed attempts for this request. Start the connection again from your agent.';
      sendHtml(res, 429, renderErrorPage(message));
      return;
    }
    if (!deps.approvals.redeem(form.get('approval_code') ?? '', signature, clientId)) {
      logger.warn('oauth.approval_failed', { clientId, reason: 'code_not_accepted' });
      showAgain('That approval code was not accepted. Codes work once and expire; mint a new one with t3-fleet-gateway pair.');
      return;
    }
    const issuedCodeAt = deps.clock();
    const code = deps.tokens.issueAuthorizationCode({
      clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes,
    });
    const location = authorizationRedirect(request.redirectUri, { code, state: request.state, iss: publicUrl });
    approved.remember(signature, { url: location, code, expiresAt: issuedCodeAt + AUTHORIZATION_CODE_TTL });
    deps.browser?.settle(signature);
    logger.info('oauth.approval_granted', { clientId, scope: formatScope(scopes) });
    const origin = new URL(location).origin;
    returnToClient(res, location, 'Access approved', `Access was approved for ${request.client.name}. Returning you to ${origin}.`);
  };

  const register = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const client = deps.clients.register(await readJson(req, OAUTH_BODY_LIMIT));
      logger.info('oauth.client_registered', { clientId: client.id, redirectUris: client.redirectUris.length });
      sendJson(
        res,
        201,
        {
          client_id: client.id,
          client_id_issued_at: Math.floor(client.createdAt / 1000),
          client_name: client.name,
          redirect_uris: client.redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        NO_STORE,
      );
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      if (error.status === 429) logger.warn('oauth.registration_throttled');
      else logger.info('oauth.registration_rejected', { errorCode: error.error });
      sendJson(res, error.status, error.toJSON(), NO_STORE);
    }
  };

  const token = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const form = await readForm(req, OAUTH_BODY_LIMIT);
    const grantType = form.get('grant_type');
    try {
      const clientId = form.get('client_id');
      if (!clientId) throw new OAuthError('invalid_request', 'client_id is required');
      if (!deps.clients.getActive(clientId)) throw new OAuthError('invalid_client', 'Unknown or revoked client', 401);
      const optional = (name: string): string | undefined => form.get(name) ?? undefined;
      let response;
      if (grantType === 'authorization_code') {
        const code = form.get('code');
        if (!code) throw new OAuthError('invalid_request', 'code is required');
        response = deps.tokens.exchangeAuthorizationCode({
          code,
          clientId,
          redirectUri: optional('redirect_uri'),
          codeVerifier: optional('code_verifier'),
          resource: optional('resource'),
        });
      } else if (grantType === 'refresh_token') {
        const refreshToken = form.get('refresh_token');
        if (!refreshToken) throw new OAuthError('invalid_request', 'refresh_token is required');
        response = deps.tokens.refresh({ refreshToken, clientId, scope: optional('scope'), resource: optional('resource') });
      } else {
        throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
      }
      deps.clients.touch(clientId);
      sendJson(res, 200, response, NO_STORE);
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      logger.info('oauth.token_rejected', { grant: grantType ?? '(none)', errorCode: error.error });
      sendJson(res, error.status, error.toJSON(), NO_STORE);
    }
  };

  const serveDocument = (document: Record<string, unknown>) => (_req: IncomingMessage, res: ServerResponse) =>
    sendJson(res, 200, document, PUBLIC_DOCUMENT);
  const resourceDocument = serveDocument(protectedResourceMetadata(publicUrl));

  return [
    { path: '/.well-known/oauth-protected-resource', methods: { GET: resourceDocument } },
    { path: '/.well-known/oauth-protected-resource/mcp', methods: { GET: resourceDocument } },
    { path: '/.well-known/oauth-authorization-server', methods: { GET: serveDocument(authorizationServerMetadata(publicUrl)) } },
    { path: '/oauth/register', methods: { POST: register } },
    { path: '/oauth/authorize', methods: { GET: authorizeGet, POST: authorizePost } },
    { path: '/oauth/token', methods: { POST: token } },
  ];
}
