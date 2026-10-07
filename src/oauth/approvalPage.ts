import { createHash } from 'node:crypto';
import { formatScope, OPERATE_SCOPE } from './scopes.ts';
import type { AuthorizationRequest } from './authorizationRequest.ts';

const STYLE = `
body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b1b1f;background:#fafafa}
h1{font-size:1.4rem}code{background:#eee;padding:0 .3em;border-radius:3px}
.card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:1rem 1.25rem;margin:1rem 0}
dt{font-weight:600}dd{margin:0 0 .6rem;word-break:break-all}
fieldset{border:0;padding:0;margin:1rem 0}label{display:block;margin:.3rem 0}
input[type=text]{font:inherit;font-family:ui-monospace,monospace;letter-spacing:.1em;padding:.4rem;width:12rem}
button{font:inherit;padding:.45rem 1rem;margin-right:.5rem;border-radius:6px;border:1px solid #888;background:#fff}
button[value=approve]{background:#1b1b1f;color:#fff;border-color:#1b1b1f}
.error{color:#a40000;font-weight:600}.muted{color:#555;font-size:.9rem}
`;
const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64');

export interface RenderedPage {
  html: string;
  headers: Record<string, string>;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Strict headers for the only HTML the gateway serves. form-action stays 'self': browsers apply it to every redirect that
 * follows a form submission, so the approval form never redirects to the client; it answers with `renderReturnPage`.
 */
function pageHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

function layout(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function renderErrorPage(message: string): RenderedPage {
  return renderNoticePage('Authorization failed', message);
}

/**
 * The page the approval form answers with when the browser should go back to the client: it navigates to
 * `responseUrl` (the authorization response or error, on the client's redirect URI) by meta refresh, with a
 * link as a fallback. With `navigate: false` it shows only the link (a repeated submission).
 */
export function renderReturnPage(options: { title: string; message: string; responseUrl: string; navigate?: boolean }): RenderedPage {
  const url = escapeHtml(options.responseUrl);
  const origin = escapeHtml(new URL(options.responseUrl).origin);
  const head = options.navigate === false ? '' : `<meta http-equiv="refresh" content="0;url=${url}">`;
  const body = `<h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(options.message)}</p><p><a href="${url}">Continue to ${origin}</a></p>`;
  return { html: layout(options.title, body, head), headers: pageHeaders() };
}

/** A page with a heading and a message and nothing to follow. */
export function renderNoticePage(title: string, message: string): RenderedPage {
  return { html: layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`), headers: pageHeaders() };
}

export function renderApprovalPage(options: {
  request: AuthorizationRequest;
  issuedAt: number;
  signature: string;
  error?: string;
}): RenderedPage {
  const { request } = options;
  const redirectOrigin = new URL(request.redirectUri).origin;
  const requested = request.requestedScopes.length > 0 ? formatScope(request.requestedScopes) : 'not specified';
  const preferOperate = request.requestedScopes.includes(OPERATE_SCOPE);
  const hidden: Record<string, string> = {
    response_type: 'code',
    client_id: request.client.id,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
    issued_at: String(options.issuedAt),
    signature: options.signature,
  };
  if (request.state !== null) hidden.state = request.state;
  if (request.requestedScopes.length > 0) hidden.scope = formatScope(request.requestedScopes);
  if (request.resource !== null) hidden.resource = request.resource;
  const hiddenInputs = Object.entries(hidden)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join('');
  const error = options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : '';
  const body = `
<h1>Connect an agent to your T3 fleet</h1>
<div class="card"><dl>
<dt>Client</dt><dd>${escapeHtml(request.client.name)}</dd>
<dt>Returns to</dt><dd><code>${escapeHtml(redirectOrigin)}</code></dd>
<dt>Requested access</dt><dd>${escapeHtml(requested)}</dd>
</dl></div>
<p class="muted">Approve only if you started this connection from your agent just now. Get a one-time code on the gateway machine with <code>t3-fleet-gateway pair</code>.</p>
${error}
<form method="post" action="/oauth/authorize">${hiddenInputs}
<label for="approval_code">Approval code</label>
<input id="approval_code" name="approval_code" type="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="32" required>
<fieldset><legend>Access to grant</legend>
<label><input type="radio" name="access" value="read"${preferOperate ? '' : ' checked'}> Read: see hosts, projects and job status</label>
<label><input type="radio" name="access" value="operate"${preferOperate ? ' checked' : ''}> Operate: also start, steer, answer and cancel jobs</label>
</fieldset>
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</form>`;
  return { html: layout('Approve agent access', body), headers: pageHeaders() };
}
