import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { migrate, openDatabase, schemaVersion } from '../src/db/database.ts';
import { MAX_PENDING_PER_CLIENT } from '../src/oauth/browserApproval.ts';
import { MAX_ENROLLMENT_FAILURES_PER_HOUR, OWNER_SESSION_TTL } from '../src/owner/store.ts';
import { verifyAssertion, verifyRegistration, WebAuthnError } from '../src/owner/webauthn.ts';
import { MINUTE } from '../src/time.ts';
import { INITIALIZE, mcpPost, startTestGateway, type TestGateway } from './helpers/gateway.ts';
import {
  approveAsShown,
  authorizationResponse,
  authorizeUrl,
  CALLBACK,
  loadApprovalPage,
  pkcePair,
  registerClient,
  standardAuthorizeParams,
  tokenRequest,
} from './helpers/oauthFlow.ts';
import { browserLinkHandle, OWNER_BASE, OWNER_HOST, OWNER_ORIGIN, OwnerBrowser, rawRequest, SoftwarePasskey } from './helpers/passkey.ts';
import { tempDir } from './helpers/tmp.ts';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ClientStore } from '../src/oauth/clients.ts';

const HOSTS = [{ id: 'main', label: 'Main desk', t3Url: 'http://127.0.0.1:9' }, { id: 'studio', t3Url: 'http://127.0.0.1:9' }];
const DASHBOARD = {
  enabled: true,
  basePath: OWNER_BASE,
  allowedHosts: [OWNER_HOST],
  browserApproval: { enabled: true, origin: OWNER_ORIGIN },
};

async function start(t: TestContext, options: { dashboard?: Record<string, unknown>; dataDir?: string; door?: TestGateway['door']; clock?: TestGateway['clock'] } = {}) {
  const h = await startTestGateway(t, {
    config: { hosts: HOSTS, dashboard: options.dashboard ?? DASHBOARD },
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.door ? { door: options.door } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const port = h.gateway.dashboard?.port;
  assert.ok(port);
  return { ...h, port, browser: new OwnerBrowser(port) };
}

/** An enrolled, signed-in owner browser. */
async function enrolledOwner(h: Awaited<ReturnType<typeof start>>) {
  const passkey = new SoftwarePasskey();
  const enrolled = await h.browser.enroll(passkey, h.services.owner.mintEnrollmentCode().code, 'Test phone');
  assert.equal(enrolled.status, 200, enrolled.body);
  assert.ok(h.browser.cookie);
  return passkey;
}

/** A generic client's Connect: register, open the authorization URL, read the page. */
async function connect(h: TestGateway, extra: Record<string, string | undefined> = {}, metadata: Record<string, unknown> = {}) {
  const clientId = await registerClient(h.baseUrl, metadata);
  const { verifier, challenge } = pkcePair();
  const page = await loadApprovalPage(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, challenge, extra)));
  assert.equal(page.status, 200, page.html);
  return { clientId, verifier, page, handle: browserLinkHandle(page.html) };
}

function exchange(h: TestGateway, clientId: string, code: string, verifier: string) {
  return tokenRequest(h.baseUrl, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: verifier });
}

describe('browser approval configuration', () => {
  const base = { publicUrl: 'https://mcp.example.test', hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9' }] };
  const invalid = (dashboard: Record<string, unknown>, pattern: RegExp, extra: Record<string, unknown> = {}) =>
    assert.throws(() => parseConfig({ ...base, ...extra, dashboard }), pattern);

  test('is off by default and fails closed when incomplete', () => {
    assert.deepEqual(parseConfig(base).dashboard.browserApproval, { enabled: false });
    invalid({ enabled: false, browserApproval: { enabled: true, origin: OWNER_ORIGIN } }, /browserApproval needs dashboard\.enabled/);
    invalid({ enabled: true, allowedHosts: [OWNER_HOST], browserApproval: { enabled: true } }, /browserApproval needs origin/);
    invalid({ enabled: true, browserApproval: { enabled: true, origin: OWNER_ORIGIN } }, /must be listed in dashboard\.allowedHosts/);
    invalid({ enabled: true, browserApproval: { enabled: true, origin: 'http://127.0.0.1:3791' } }, /passkeys do not accept IP addresses/);
    invalid({ enabled: true, browserApproval: { enabled: true, origin: 'http://gateway.example.test' } }, /must use https/);
    invalid({ enabled: true, allowedHosts: [OWNER_HOST], browserApproval: { enabled: true, origin: `${OWNER_ORIGIN}/x` } }, /must be an origin/);
    invalid({ enabled: true, browserApproval: { enabled: true, origin: OWNER_ORIGIN, extra: 1 } }, /Unrecognized key/);
  });

  test('never shares the MCP origin, and keeps the cookie off the MCP port on a shared host name', () => {
    invalid({ enabled: true, allowedHosts: ['mcp.example.test'], browserApproval: { enabled: true, origin: 'https://mcp.example.test' } }, /must differ from publicUrl/);
    invalid({ enabled: true, allowedHosts: [OWNER_HOST], browserApproval: { enabled: true, origin: OWNER_ORIGIN } }, /must differ from publicUrl and allowedOrigins/,
      { allowedOrigins: [OWNER_ORIGIN] });
    invalid({ enabled: true, allowedHosts: ['mcp.example.test:8443'], browserApproval: { enabled: true, origin: 'https://mcp.example.test:8443' } },
      /needs a dashboard\.basePath/);
    const ok = parseConfig({ ...base, dashboard: { enabled: true, basePath: '/fleet', allowedHosts: ['mcp.example.test:8443'],
      browserApproval: { enabled: true, origin: 'https://mcp.example.test:8443' } } });
    assert.equal(ok.dashboard.browserApproval.origin, 'https://mcp.example.test:8443');
    assert.equal(parseConfig({ ...base, dashboard: { enabled: true, browserApproval: { enabled: true, origin: 'http://localhost:3791' } } })
      .dashboard.browserApproval.origin, 'http://localhost:3791');
  });
});

describe('browser approval end to end', () => {
  test('a generic client connects: owner passkey, explicit Allow, callback, PKCE exchange, MCP', async (t) => {
    const h = await start(t);
    // Before any passkey exists the approval page offers only the code form.
    const before = await connect(h);
    assert.equal(before.handle, undefined);
    assert.equal((await h.browser.call('api/owner/status')).json.enrolled, false);
    await enrolledOwner(h);
    assert.match(h.browser.cookies[0]!, /^__Secure-t3fg-owner=[A-Za-z0-9_-]{43}; Path=\/fleet; Max-Age=43200; HttpOnly; SameSite=Strict; Secure$/);

    const { clientId, verifier, page, handle } = await connect(h, { scope: 'fleet:read fleet:operate', state: 'opaque-state-1' }, { client_name: 'Generic MCP Client' });
    assert.ok(handle, 'the approval page links to the dashboard once a passkey exists');
    assert.match(page.html, /approval_code/, 'the approval-code form is still offered');
    const view = await h.browser.call('api/authorizations/view', { handle });
    assert.equal(view.status, 200, view.body);
    assert.deepEqual(view.json.hosts, [
      { id: 'main', label: 'Main desk', allowed: true, selected: false },
      { id: 'studio', label: null, allowed: true, selected: false },
    ]);
    assert.equal(view.json.clientName, 'Generic MCP Client');
    assert.equal(view.json.returnOrigin, new URL(CALLBACK).origin);
    assert.equal(view.json.requested, 'fleet:read fleet:operate');
    assert.equal(view.json.access, 'operate');
    assert.equal(view.headers['cache-control'], 'no-store');

    const decided = await h.browser.call('api/authorizations/decide', { handle, decision: 'allow', access: 'operate', hostsMode: 'selected', hosts: ['studio'] });
    assert.equal(decided.status, 200, decided.body);
    assert.equal(decided.json.approved, true);
    const location = new URL(decided.json.responseUrl as string);
    assert.equal(`${location.origin}${location.pathname}`, CALLBACK);
    assert.equal(location.searchParams.get('state'), 'opaque-state-1');
    assert.equal(location.searchParams.get('iss'), h.baseUrl);
    const code = location.searchParams.get('code')!;

    // PKCE: the wrong verifier is refused, the right one gets exactly the selected grant.
    assert.equal((await exchange(h, clientId, code, pkcePair().verifier)).status, 400);
    const exchanged = await exchange(h, clientId, code, verifier);
    assert.equal(exchanged.status, 200);
    const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; scope: string };
    assert.equal(tokens.scope, 'host:studio:read host:studio:operate');
    assert.equal((await mcpPost(h.baseUrl, tokens.access_token, INITIALIZE)).status, 200);
    // Rotation still works for a browser-approved grant.
    const refreshed = await tokenRequest(h.baseUrl, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    assert.equal(refreshed.status, 200);
  });

  test('the code is bound to client, redirect, PKCE and resource, and works once', async (t) => {
    const h = await start(t);
    await enrolledOwner(h);
    const { clientId, verifier, handle } = await connect(h, { resource: `${h.baseUrl}/mcp` });
    const decided = await h.browser.call('api/authorizations/decide', { handle, decision: 'allow', access: 'read', hostsMode: 'all', hosts: [] });
    const code = new URL(decided.json.responseUrl as string).searchParams.get('code')!;
    const other = await registerClient(h.baseUrl);
    assert.equal((await exchange(h, other, code, verifier)).status, 400, 'another client cannot redeem it');
    const fresh = await connect(h);
    const decided2 = await h.browser.call('api/authorizations/decide', { handle: fresh.handle, decision: 'allow', access: 'read', hostsMode: 'all', hosts: [] });
    const code2 = new URL(decided2.json.responseUrl as string).searchParams.get('code')!;
    const wrongRedirect = await tokenRequest(h.baseUrl, { grant_type: 'authorization_code', code: code2, client_id: fresh.clientId, redirect_uri: 'https://agent.example.com/other', code_verifier: fresh.verifier });
    assert.equal(wrongRedirect.status, 400);
    const third = await connect(h);
    const decided3 = await h.browser.call('api/authorizations/decide', { handle: third.handle, decision: 'allow', access: 'read', hostsMode: 'all', hosts: [] });
    const code3 = new URL(decided3.json.responseUrl as string).searchParams.get('code')!;
    const ok = await exchange(h, third.clientId, code3, third.verifier);
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { scope: string }).scope, 'fleet:read');
    assert.equal((await exchange(h, third.clientId, code3, third.verifier)).status, 400, 'a code works once');
    assert.ok(clientId);
  });

  test('Deny returns access_denied with state, and the request cannot then be approved on the code form', async (t) => {
    const h = await start(t);
    await enrolledOwner(h);
    const { page, handle } = await connect(h, { state: 'deny-state' });
    const denied = await h.browser.call('api/authorizations/decide', { handle, decision: 'deny' });
    assert.equal(denied.status, 200);
    assert.equal(denied.json.approved, false);
    const location = new URL(denied.json.responseUrl as string);
    assert.equal(location.searchParams.get('error'), 'access_denied');
    assert.equal(location.searchParams.get('state'), 'deny-state');
    assert.equal(location.searchParams.get('code'), null);
    const late = await approveAsShown(h.baseUrl, page.html, h.mintApprovalCode());
    assert.match(await late.text(), /Already answered/);
    assert.equal((await h.browser.call('api/authorizations/decide', { handle, decision: 'allow', access: 'read', hostsMode: 'all' })).status, 404);
  });

  test('replays, concurrent answers and the code form answer a request once between them', async (t) => {
    const h = await start(t);
    await enrolledOwner(h);
    const first = await connect(h);
    const choice = { decision: 'allow', access: 'read', hostsMode: 'all', hosts: [] };
    const answers = await Promise.all([1, 2, 3].map(() => h.browser.call('api/authorizations/decide', { handle: first.handle, ...choice })));
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 404, 404]);
    const repeated = await approveAsShown(h.baseUrl, first.page.html, h.mintApprovalCode());
    assert.match(await repeated.text(), /Already approved/, 'the code form shows the same answer and spends no code');

    // Approved on the code form first: the dashboard handle is spent.
    const second = await connect(h);
    await authorizationResponse(await approveAsShown(h.baseUrl, second.page.html, h.mintApprovalCode()));
    assert.equal((await h.browser.call('api/authorizations/decide', { handle: second.handle, ...choice })).status, 404);
    assert.equal((await h.browser.call('api/authorizations/view', { handle: second.handle })).status, 404);
  });

  test('sibling handles share settlement and answered signatures cannot be offered again', async (t) => {
    const h = await start(t);
    await enrolledOwner(h);
    const clientId = await registerClient(h.baseUrl);
    for (const decision of ['allow', 'deny']) {
      const url = authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, pkcePair().challenge));
      // The injected clock does not advance: these pages have identical signed requests, but distinct handles.
      const first = await loadApprovalPage(url);
      const second = await loadApprovalPage(url);
      const handles = [browserLinkHandle(first.html)!, browserLinkHandle(second.html)!];
      assert.notEqual(handles[0], handles[1]);
      const choice = { access: 'read', hostsMode: 'all', hosts: [] };
      assert.equal((await h.browser.call('api/authorizations/decide', { handle: handles[0], decision, ...choice })).status, 200);
      assert.equal((await h.browser.call('api/authorizations/view', { handle: handles[1] })).status, 404);
      assert.equal((await h.browser.call('api/authorizations/decide', { handle: handles[1], decision: 'allow', ...choice })).status, 404);
      assert.equal(browserLinkHandle((await loadApprovalPage(url)).html), undefined);
    }
  });

  test('pending requests expire with the form, are bounded per client and are forgotten on restart', async (t) => {
    const h = await start(t);
    const passkey = await enrolledOwner(h);
    const { handle } = await connect(h);
    h.clock.advance(10 * MINUTE + 1);
    assert.equal((await h.browser.call('api/authorizations/view', { handle })).status, 404);

    const clientId = await registerClient(h.baseUrl);
    const handles: string[] = [];
    for (let i = 0; i <= MAX_PENDING_PER_CLIENT; i += 1) {
      const page = await loadApprovalPage(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, pkcePair().challenge)));
      handles.push(browserLinkHandle(page.html)!);
    }
    assert.equal((await h.browser.call('api/authorizations/view', { handle: handles[0] })).status, 404, 'a client’s oldest request gives way');
    assert.equal((await h.browser.call('api/authorizations/view', { handle: handles.at(-1) })).status, 200);

    // Restart on the same data: the passkey and session survive, the pending request does not.
    const dataDir = h.dataDir;
    const door = h.door;
    const cookie = h.browser.cookie;
    await h.gateway.close();
    const again = await start(t, { dataDir, door, clock: h.clock });
    again.browser.cookie = cookie;
    assert.deepEqual((await again.browser.call('api/owner/status')).json.signedIn, true);
    assert.equal((await again.browser.call('api/authorizations/view', { handle: handles.at(-1) })).status, 404);
    const fresh = await connect(again);
    assert.ok(fresh.handle);
    assert.equal((await again.browser.signIn(passkey)).status, 200);
  });

  test('a revoked client cannot be approved', async (t) => {
    const h = await start(t);
    await enrolledOwner(h);
    const { clientId, handle } = await connect(h);
    h.services.clients.revoke(clientId);
    assert.equal((await h.browser.call('api/authorizations/decide', { handle, decision: 'allow', access: 'read', hostsMode: 'all' })).status, 404);
  });
});

describe('browser approval owner boundary', () => {
  test('reaching the dashboard does not make anyone the owner', async (t) => {
    const h = await start(t);
    await enrolledOwner(h);
    const { handle } = await connect(h);
    const stranger = new OwnerBrowser(h.port);
    assert.equal((await stranger.call('api/authorizations/view', { handle })).status, 401);
    const decideWithoutSession = await stranger.call('api/authorizations/decide', { handle, decision: 'allow', access: 'operate', hostsMode: 'all', hosts: [] });
    assert.equal(decideWithoutSession.status, 401);
    // Forged or tossed cookies grant nothing; two cookies of the name count as none.
    stranger.cookie = `__Secure-t3fg-owner=${'A'.repeat(43)}`;
    assert.equal((await stranger.call('api/authorizations/view', { handle })).status, 401);
    stranger.cookie = `${h.browser.cookie}; __Secure-t3fg-owner=${'B'.repeat(43)}`;
    assert.equal((await stranger.call('api/authorizations/view', { handle })).status, 401);
    // Forwarded identity headers mean nothing.
    const forwarded = new OwnerBrowser(h.port);
    forwarded.headers = { 'x-forwarded-user': 'owner', 'tailscale-user-login': 'owner@example.com', 'x-forwarded-for': '127.0.0.1' };
    assert.equal((await forwarded.call('api/authorizations/view', { handle })).status, 401);
    // The pending request is untouched and the owner can still answer it.
    assert.equal((await h.browser.call('api/authorizations/view', { handle })).status, 200);
  });

  test('CSRF, foreign origins, rebinding hosts and Funnel traffic are refused before any owner action', async (t) => {
    const h = await start(t);
    await enrolledOwner(h);
    const { handle } = await connect(h);
    const body = { handle, decision: 'deny' };
    const refused = async (extra: Record<string, string>, status: number) => {
      const answer = await h.browser.call('api/authorizations/decide', body, extra);
      assert.equal(answer.status, status, `${JSON.stringify(extra)}: ${answer.body}`);
    };
    await refused({ origin: 'https://evil.example.com' }, 403);
    await refused({ origin: 'null' }, 403);
    await refused({ origin: `http://${OWNER_HOST}` }, 403);
    await refused({ origin: `http://127.0.0.1:${h.port}`, host: `127.0.0.1:${h.port}` }, 403);
    await refused({ 'sec-fetch-site': 'cross-site' }, 403);
    await refused({ 'sec-fetch-site': 'same-site' }, 403);
    await refused({ 'x-t3fg-dashboard': '0' }, 403);
    await refused({ host: 'rebound.example.com' }, 421);
    await refused({ 'tailscale-funnel-request': '?1' }, 403);
    await refused({ 'content-type': 'application/x-www-form-urlencoded' }, 415);
    // A body without Origin (a form post from a non-browser or an old browser) is refused too.
    const noOrigin = await rawRequest(h.port, { method: 'POST', path: `${OWNER_BASE}/api/authorizations/decide`,
      headers: { host: OWNER_HOST, 'x-t3fg-dashboard': '1', 'content-type': 'application/json', cookie: h.browser.cookie! }, body: JSON.stringify(body) });
    assert.equal(noOrigin.status, 403);
    assert.equal((await h.browser.call('api/authorizations/view', { handle })).status, 200, 'nothing was answered');
  });

  test('owner routes exist only on the dashboard listener, and only when configured', async (t) => {
    const h = await start(t);
    for (const path of ['/fleet/owner', '/fleet/api/owner/status', '/api/owner/status', '/owner', '/fleet/api/authorizations/view']) {
      assert.equal((await fetch(`${h.baseUrl}${path}`)).status, 404, `MCP listener ${path}`);
    }
    for (const path of ['/oauth/authorize', '/oauth/token', '/fleet/oauth/authorize', '/.well-known/oauth-authorization-server']) {
      assert.equal((await rawRequest(h.port, { path, headers: { host: OWNER_HOST } })).status, 404, `dashboard listener ${path}`);
    }
    const ownerPage = await rawRequest(h.port, { path: `${OWNER_BASE}/owner`, headers: { host: OWNER_HOST } });
    assert.equal(ownerPage.status, 200);
    assert.match(String(ownerPage.headers['content-security-policy']), /script-src 'self'.*frame-ancestors 'none'/);
    assert.equal(ownerPage.headers['x-frame-options'], 'DENY');
    assert.equal(ownerPage.headers['referrer-policy'], 'no-referrer');
    assert.equal(ownerPage.headers['access-control-allow-origin'], undefined);
    assert.match(String(ownerPage.headers['permissions-policy']), /publickey-credentials-get=\(self\)/);
    assert.doesNotMatch(ownerPage.body, /\bstyle\s*=/i);
    assert.equal(ownerPage.body.toLowerCase().split('<script').length - 1, 1);
    assert.ok(ownerPage.body.includes('<script type="module" src="assets/owner.js"></script>'));

    const off = await start(t, { dashboard: { enabled: true, basePath: OWNER_BASE, allowedHosts: [OWNER_HOST] } });
    assert.equal((await rawRequest(off.port, { path: `${OWNER_BASE}/owner`, headers: { host: OWNER_HOST } })).status, 404);
    assert.equal((await off.browser.call('api/owner/status')).status, 404);
    off.services.owner.mintEnrollmentCode();
    const page = await connect(off);
    assert.equal(page.handle, undefined, 'no dashboard link without browser approval');
  });

  test('sign-out, passkey revocation and CLI sign-out end sessions; a new sign-in replaces any presented cookie', async (t) => {
    const h = await start(t);
    const passkey = await enrolledOwner(h);
    const { handle } = await connect(h);
    const signedOut = await h.browser.call('api/owner/signout', {});
    assert.equal(signedOut.status, 200);
    assert.match(h.browser.cookies.at(-1)!, /Max-Age=0/);
    assert.equal(h.browser.cookie, undefined);

    const stale = h.browser.cookies[0]!.split(';')[0]!;
    const replay = new OwnerBrowser(h.port);
    replay.cookie = stale;
    assert.equal((await replay.call('api/authorizations/view', { handle })).status, 401, 'a signed-out cookie is dead');

    // Fixation: a sign-in that presents a cookie gets a new one and the old one stops working.
    assert.equal((await h.browser.signIn(passkey)).status, 200);
    const before = h.browser.cookie!;
    assert.equal((await h.browser.signIn(passkey)).status, 200);
    assert.notEqual(h.browser.cookie, before);
    const old = new OwnerBrowser(h.port);
    old.cookie = before;
    assert.equal((await old.call('api/owner/status')).json.signedIn, false);

    assert.equal(h.services.owner.revokeAllSessions(), 1);
    assert.equal((await h.browser.call('api/authorizations/view', { handle })).status, 401);
    assert.equal((await h.browser.signIn(passkey)).status, 200);
    const [record] = h.services.owner.passkeys();
    assert.ok(h.services.owner.revokePasskey(record!.id));
    assert.equal((await h.browser.call('api/authorizations/view', { handle })).status, 401, 'revoking the passkey ends its sessions');
    assert.equal((await h.browser.signIn(passkey)).status, 409, 'no passkey left: sign-in is not offered');
    assert.equal((await connect(h)).handle, undefined, 'and browser approval fails closed again');
  });

  test('sessions expire', async (t) => {
    const h = await start(t);
    await enrolledOwner(h);
    h.clock.advance(OWNER_SESSION_TTL + 1);
    assert.equal((await h.browser.call('api/owner/status')).json.signedIn, false);
  });

  test('passkey ceremonies: single-use challenges, exact origin, verification, counter', async (t) => {
    const h = await start(t);
    const passkey = await enrolledOwner(h);
    const attempt = async (overrides: Parameters<SoftwarePasskey['assert']>[2], origin?: string) => {
      const begin = await h.browser.call('api/owner/signin/begin', {});
      const challenge = (begin.json.publicKey as { challenge: string }).challenge;
      return h.browser.call('api/owner/signin/finish', { ceremonyId: begin.json.ceremonyId, credential: passkey.assert(challenge, origin, overrides) });
    };
    assert.equal((await attempt({}, 'https://evil.example.com')).status, 400);
    assert.equal((await attempt({ challenge: 'A'.repeat(43) })).status, 400);
    assert.equal((await attempt({ type: 'webauthn.create' })).status, 400);
    assert.equal((await attempt({ crossOrigin: true })).status, 400);
    passkey.flags = 0x01;
    assert.equal((await attempt({})).status, 400, 'user verification is required');
    passkey.flags = 0x05;
    passkey.rpId = 'other.example.test';
    assert.equal((await attempt({})).status, 400, 'the relying party id must match');
    passkey.rpId = OWNER_HOST;

    const begin = await h.browser.call('api/owner/signin/begin', {});
    const challenge = (begin.json.publicKey as { challenge: string }).challenge;
    const credential = passkey.assert(challenge);
    assert.equal((await h.browser.call('api/owner/signin/finish', { ceremonyId: begin.json.ceremonyId, credential })).status, 200);
    assert.equal((await h.browser.call('api/owner/signin/finish', { ceremonyId: begin.json.ceremonyId, credential })).status, 409, 'a ceremony is answered once');

    passkey.counter -= 2;
    assert.equal((await attempt({})).status, 400, 'a counter that goes backwards suggests a cloned authenticator');
    passkey.counter += 5;
    const stranger = new SoftwarePasskey();
    const begin2 = await h.browser.call('api/owner/signin/begin', {});
    assert.equal((await h.browser.call('api/owner/signin/finish', { ceremonyId: begin2.json.ceremonyId,
      credential: stranger.assert((begin2.json.publicKey as { challenge: string }).challenge) })).status, 400, 'an unknown passkey is refused');
    const expired = await h.browser.call('api/owner/signin/begin', {});
    h.clock.advance(2 * MINUTE + 1);
    assert.equal((await h.browser.call('api/owner/signin/finish', { ceremonyId: expired.json.ceremonyId,
      credential: passkey.assert((expired.json.publicKey as { challenge: string }).challenge) })).status, 409);
  });

  test('enrollment needs a one-time CLI code, is throttled, and a code adds one passkey', async (t) => {
    const h = await start(t);
    const browser = new OwnerBrowser(h.port);
    assert.equal((await browser.enroll(new SoftwarePasskey(), 'AAAAA-AAAAA')).status, 400);
    const { code } = h.services.owner.mintEnrollmentCode();
    assert.equal((await browser.enroll(new SoftwarePasskey(), code)).status, 200);
    assert.equal((await new OwnerBrowser(h.port).enroll(new SoftwarePasskey(), code)).status, 400, 'the code is spent');
    for (let i = 0; i < MAX_ENROLLMENT_FAILURES_PER_HOUR; i += 1) await browser.enroll(new SoftwarePasskey(), 'BBBBB-BBBBB');
    const fresh = h.services.owner.mintEnrollmentCode();
    // Minting clears the window; without that, even the right code would be throttled.
    assert.equal((await browser.enroll(new SoftwarePasskey(), fresh.code, 'Laptop')).status, 200);
    for (let i = 0; i < MAX_ENROLLMENT_FAILURES_PER_HOUR; i += 1) await browser.enroll(new SoftwarePasskey(), 'CCCCC-CCCCC');
    const throttled = await browser.call('api/owner/enroll/begin', { code: 'DDDDD-DDDDD' });
    assert.equal(throttled.status, 429);
    assert.deepEqual(h.services.owner.passkeys().map((passkey) => passkey.label).sort(), ['Laptop', 'Passkey']);
    // A crafted label or unknown fields are refused.
    const next = h.services.owner.mintEnrollmentCode().code;
    const begin = await browser.call('api/owner/enroll/begin', { code: next });
    const challenge = (begin.json.publicKey as { challenge: string }).challenge;
    assert.equal((await browser.call('api/owner/enroll/finish', { ceremonyId: begin.json.ceremonyId, label: '<img src=x>', credential: new SoftwarePasskey().register(challenge) })).status, 400);
    assert.equal((await browser.call('api/owner/enroll/begin', { code: next, extra: true })).status, 400);
  });

  test('a choice beyond the request or the configuration is refused and leaves the request pending', async (t) => {
    const h = await start(t);
    await enrolledOwner(h);
    const { handle } = await connect(h, { scope: 'host:main:read' }, { client_name: '<script>alert(1)</script>' });
    const view = await h.browser.call('api/authorizations/view', { handle });
    assert.equal(view.json.clientName, '<script>alert(1)</script>', 'returned as JSON text; the page renders text only');
    assert.equal(view.json.allowAll, false);
    assert.equal(view.json.allowOperate, false);
    assert.deepEqual(view.json.hosts, [
      { id: 'main', label: 'Main desk', allowed: true, selected: true },
      { id: 'studio', label: null, allowed: false, selected: false },
    ]);
    const decide = (choice: Record<string, unknown>) => h.browser.call('api/authorizations/decide', { handle, decision: 'allow', ...choice });
    for (const choice of [
      { access: 'read', hostsMode: 'all', hosts: [] },
      { access: 'operate', hostsMode: 'selected', hosts: ['main'] },
      { access: 'read', hostsMode: 'selected', hosts: ['studio'] },
      { access: 'read', hostsMode: 'selected', hosts: ['unknown'] },
      { access: 'read', hostsMode: 'selected', hosts: [] },
      { access: 'read', hostsMode: 'all', hosts: ['main'] },
      { access: 'admin', hostsMode: 'selected', hosts: ['main'] },
      { access: 'read', hostsMode: 'selected', hosts: 'main' },
      { access: 'read', hostsMode: ['all'], hosts: ['main'] },
    ]) {
      const refused = await decide(choice);
      assert.equal(refused.status, 400, JSON.stringify(choice));
    }
    assert.equal((await h.browser.call('api/authorizations/decide', { handle, decision: 'maybe' })).status, 400);
    assert.equal((await h.browser.call('api/authorizations/decide', { handle, decision: 'allow', scope: 'fleet:operate' })).status, 400);
    for (const bad of ['short', 'A'.repeat(44), `${'A'.repeat(42)}!`, 42, null]) {
      assert.equal((await h.browser.call('api/authorizations/view', { handle: bad })).status, 404);
    }
    const allowed = await decide({ access: 'read', hostsMode: 'selected', hosts: ['main'] });
    assert.equal(allowed.status, 200, allowed.body);
  });

  test('unregistered redirects never reach the owner', async (t) => {
    const h = await start(t);
    await enrolledOwner(h);
    const clientId = await registerClient(h.baseUrl);
    const page = await loadApprovalPage(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, pkcePair().challenge, { redirect_uri: 'https://evil.example.com/cb' })));
    assert.equal(page.status, 400);
    assert.equal(browserLinkHandle(page.html), undefined);
    const noPkce = await loadApprovalPage(authorizeUrl(h.baseUrl, { ...standardAuthorizeParams(clientId, pkcePair().challenge), code_challenge_method: 'plain' }));
    assert.equal(noPkce.status, 303);
    assert.equal(h.gateway.services.owner.enrolled(), true);
  });

  test('logs carry ids and fixed reasons only', async (t) => {
    const h = await start(t);
    const passkey = await enrolledOwner(h);
    const { handle } = await connect(h);
    await h.browser.call('api/authorizations/decide', { handle, decision: 'allow', access: 'read', hostsMode: 'all', hosts: [] });
    await h.browser.signIn(passkey);
    const logs = h.logs.join('\n');
    const session = h.browser.cookie!.split('=')[1]!;
    for (const secret of [handle!, session, passkey.id]) assert.ok(!logs.includes(secret), 'no handle, session or credential id in logs');
    for (const event of ['owner.passkey_enrolled', 'oauth.browser_approval_offered', 'oauth.browser_approval_granted', 'owner.signed_in']) assert.match(logs, new RegExp(event));
    assert.doesNotMatch(logs, /responseUrl|code=|challenge/);
  });
});

describe('webauthn verification', () => {
  const rp = { id: OWNER_HOST, origin: OWNER_ORIGIN };
  test('registration and assertion round trip, and tampering fails', () => {
    const passkey = new SoftwarePasskey();
    const challenge = 'c'.repeat(43);
    const registration = verifyRegistration(rp, challenge, passkey.register(challenge));
    assert.equal(registration.credentialId, passkey.id);
    assert.equal(registration.algorithm, -7);
    const assertion = passkey.assert(challenge);
    assert.deepEqual(verifyAssertion(rp, challenge, registration, assertion), { signCount: 1 });
    const flipped = Buffer.from(assertion.signature, 'base64url');
    flipped[10] = flipped[10]! ^ 1;
    assert.throws(() => verifyAssertion(rp, challenge, registration, { ...assertion, signature: flipped.toString('base64url') }), WebAuthnError);
    assert.throws(() => verifyRegistration(rp, challenge, { ...passkey.register(challenge), attestationObject: 'AAAA' }), WebAuthnError);
    assert.throws(() => verifyRegistration(rp, challenge, { ...passkey.register(challenge), clientDataJSON: '!!' }), WebAuthnError);
    const truncated = Buffer.from(passkey.register(challenge).attestationObject, 'base64url').subarray(0, 60).toString('base64url');
    assert.throws(() => verifyRegistration(rp, challenge, { ...passkey.register(challenge), attestationObject: truncated }), WebAuthnError);
  });
});

describe('browser approval storage', () => {
  test('migration 22 adds empty owner tables to a populated version 21 ledger and keeps its data', (t) => {
    const path = join(tempDir(t), 'gateway.db');
    const old = new DatabaseSync(path);
    migrate(old as never, MIGRATIONS.slice(0, 21));
    const client = new ClientStore(old as never, () => 1_000).register({ client_name: 'Synthetic agent', redirect_uris: [CALLBACK] });
    const before = old.prepare('SELECT * FROM oauth_clients ORDER BY id').all();
    old.close();
    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), 22);
    assert.deepEqual(db.prepare('SELECT * FROM oauth_clients ORDER BY id').all(), before);
    assert.ok(client.id);
    for (const table of ['owner_passkeys', 'owner_sessions', 'owner_enrollment_codes', 'owner_enrollment_failures']) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    }
    assert.throws(() => migrate(db, MIGRATIONS.slice(0, 21)), /schema version 22 is newer than this build supports \(21\)/);
  });
});
