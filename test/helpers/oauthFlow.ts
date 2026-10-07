import { pkceChallenge, randomToken } from '../../src/crypto.ts';

export const CALLBACK = 'https://agent.example.com/oauth/callback';

export async function register(baseUrl: string, metadata: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test agent', redirect_uris: [CALLBACK], ...metadata }),
  });
}

export async function registerClient(baseUrl: string, metadata: Record<string, unknown> = {}): Promise<string> {
  const response = await register(baseUrl, metadata);
  if (response.status !== 201) throw new Error(`registration failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { client_id: string }).client_id;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function authorizeUrl(baseUrl: string, params: Record<string, string | undefined>): string {
  const url = new URL(`${baseUrl}/oauth/authorize`);
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
  return url.href;
}

export function standardAuthorizeParams(clientId: string, challenge: string, extra: Record<string, string | undefined> = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    ...extra,
  };
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** Extract the approval form's hidden fields from the rendered page. */
export function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[match[1] as string] = (match[2] as string).replaceAll(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
  }
  return fields;
}

export async function loadApprovalPage(url: string): Promise<{ status: number; html: string; headers: Headers; fields: Record<string, string> }> {
  const response = await fetch(url, { redirect: 'manual' });
  const html = await response.text();
  return { status: response.status, html, headers: response.headers, fields: hiddenFields(html) };
}

export async function submitApproval(
  baseUrl: string,
  fields: Record<string, string>,
  form: { approval_code?: string; access?: string; decision?: string },
): Promise<Response> {
  return fetch(`${baseUrl}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, decision: 'approve', access: 'read', ...form } as Record<string, string>),
  });
}

export async function tokenRequest(baseUrl: string, params: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Register, approve with a freshly minted code and exchange the code: the whole agent sign-in. */
export async function signIn(
  baseUrl: string,
  mintCode: () => string,
  options: { access?: 'read' | 'operate'; clientId?: string } = {},
): Promise<{ clientId: string; tokens: IssuedTokens }> {
  const clientId = options.clientId ?? (await registerClient(baseUrl));
  const { verifier, challenge } = pkcePair();
  const page = await loadApprovalPage(authorizeUrl(baseUrl, standardAuthorizeParams(clientId, challenge)));
  const approval = await submitApproval(baseUrl, page.fields, { approval_code: mintCode(), access: options.access ?? 'read' });
  const location = approval.headers.get('location');
  if (approval.status !== 303 || !location) throw new Error(`approval failed: ${approval.status}`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error(`no code in redirect: ${location}`);
  const response = await tokenRequest(baseUrl, {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_verifier: verifier,
  });
  if (response.status !== 200) throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
  return { clientId, tokens: (await response.json()) as IssuedTokens };
}
