import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_FAILURES_PER_HOUR, MAX_FAILURES_PER_REQUEST } from '../src/oauth/approvalCodes.ts';
import { redirectUriMatches } from '../src/oauth/redirectUris.ts';
import { HOUR, MINUTE } from '../src/time.ts';
import { startOAuthHarness, type OAuthHarness } from './helpers/oauthHarness.ts';
import {
  authorizeUrl,
  CALLBACK,
  loadApprovalPage,
  pkcePair,
  registerClient,
  standardAuthorizeParams,
  submitApproval,
  tokenRequest,
} from './helpers/oauthFlow.ts';

async function openPage(h: OAuthHarness, clientId?: string, extra: Record<string, string | undefined> = {}) {
  const id = clientId ?? (await registerClient(h.baseUrl));
  const page = await loadApprovalPage(authorizeUrl(h.baseUrl, standardAuthorizeParams(id, pkcePair().challenge, extra)));
  return { clientId: id, page };
}

function redirectParams(response: Response): URLSearchParams {
  assert.equal(response.status, 303);
  const location = response.headers.get('location');
  assert.ok(location);
  assert.ok(location.startsWith(CALLBACK), location);
  return new URL(location).searchParams;
}

describe('authorization endpoint', () => {
  test('renders a self-contained approval page with strict headers', async (t) => {
    const h = await startOAuthHarness(t);
    const clientId = await registerClient(h.baseUrl, { client_name: '<script>alert(1)</script> Agent' });
    const { page } = await openPage(h, clientId, { scope: 'fleet:read fleet:operate' });
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /form-action 'self' https:\/\/agent\.example\.com/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(page.html, /<script/);
    assert.match(page.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Agent/);
    assert.match(page.html, /https:\/\/agent\.example\.com/);
    assert.match(page.html, /fleet:read fleet:operate/);
    assert.doesNotMatch(page.html, /\b(src|href)="http/i, 'no external assets');
    assert.ok(page.fields.signature);
  });

  test('loopback redirect URIs match with any port; everything else matches exactly', async (t) => {
    const registered = 'http://127.0.0.1/callback';
    assert.ok(redirectUriMatches(registered, 'http://127.0.0.1:54321/callback'));
    assert.ok(redirectUriMatches('http://127.0.0.1:8080/callback', 'http://127.0.0.1:9090/callback'));
    assert.ok(redirectUriMatches('http://[::1]/cb?x=1', 'http://[::1]:5000/cb?x=1'));
    for (const requested of [
      'http://localhost:54321/callback',
      'http://127.0.0.1:54321/other',
      'http://127.0.0.1:54321/callback?extra=1',
      'http://127.0.0.1:54321/callback#fragment',
      'http://user@127.0.0.1:54321/callback',
      'https://127.0.0.1:54321/callback',
    ]) {
      assert.equal(redirectUriMatches(registered, requested), false, requested);
    }
    assert.equal(redirectUriMatches('https://agent.example.com/cb', 'https://agent.example.com:8443/cb'), false, 'https stays exact');

    const h = await startOAuthHarness(t);
    const clientId = await registerClient(h.baseUrl, { redirect_uris: [registered] });
    const redirectUri = 'http://127.0.0.1:54321/callback';
    const { verifier, challenge } = pkcePair();
    const page = await loadApprovalPage(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, challenge, { redirect_uri: redirectUri })));
    assert.equal(page.status, 200);
    const approval = await submitApproval(h.baseUrl, page.fields, { approval_code: h.approvals.mint().code });
    const location = new URL(approval.headers.get('location') ?? '');
    assert.equal(`${location.origin}${location.pathname}`, redirectUri, 'redirects to the port the client asked for');
    const exchanged = await tokenRequest(h.baseUrl, {
      grant_type: 'authorization_code',
      code: location.searchParams.get('code') ?? '',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    assert.equal(exchanged.status, 200);
    const otherPath = await fetch(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, challenge, { redirect_uri: 'http://127.0.0.1:54321/elsewhere' })), {
      redirect: 'manual',
    });
    assert.equal(otherPath.status, 400);
  });

  test('never redirects for an unknown client or unregistered redirect URI', async (t) => {
    const h = await startOAuthHarness(t);
    const clientId = await registerClient(h.baseUrl);
    const { challenge } = pkcePair();
    for (const url of [
      authorizeUrl(h.baseUrl, standardAuthorizeParams('unknown-client', challenge)),
      authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, challenge, { redirect_uri: 'https://evil.example.com/cb' })),
      authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, challenge, { redirect_uri: undefined })),
    ]) {
      const response = await fetch(url, { redirect: 'manual' });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('location'), null);
    }
  });

  test('reports request errors to a registered redirect URI', async (t) => {
    const h = await startOAuthHarness(t);
    const clientId = await registerClient(h.baseUrl);
    const { challenge } = pkcePair();
    const cases: [Record<string, string | undefined>, string][] = [
      [{ code_challenge: undefined }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ resource: 'https://other.example.com/mcp' }, 'invalid_target'],
      [{ scope: 'fleet:admin' }, 'invalid_scope'],
    ];
    for (const [extra, error] of cases) {
      const response = await fetch(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, challenge, extra)), { redirect: 'manual' });
      const params = redirectParams(response);
      assert.equal(params.get('error'), error, JSON.stringify(extra));
      assert.equal(params.get('state'), 'state-123');
      assert.equal(params.get('iss'), h.baseUrl);
    }
    const ok = await fetch(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, challenge, { resource: h.resource })));
    assert.equal(ok.status, 200, 'our own resource is accepted');
  });

  test('approving with a valid code redirects with an authorization code; Read grants fleet:read', async (t) => {
    const h = await startOAuthHarness(t);
    const { page } = await openPage(h);
    const params = redirectParams(await submitApproval(h.baseUrl, page.fields, { approval_code: h.approvals.mint().code }));
    assert.ok(params.get('code'));
    assert.equal(params.get('state'), 'state-123');
    assert.equal(params.get('iss'), h.baseUrl);
    const row = h.db.prepare('SELECT scope FROM authorization_codes').get() as { scope: string };
    assert.equal(row.scope, 'fleet:read');
  });

  test('Operate grants both scopes, and codes are accepted in any case and spacing', async (t) => {
    const h = await startOAuthHarness(t);
    const { page } = await openPage(h);
    const code = h.approvals.mint().code.toLowerCase().replace('-', ' ');
    redirectParams(await submitApproval(h.baseUrl, page.fields, { approval_code: code, access: 'operate' }));
    const row = h.db.prepare('SELECT scope FROM authorization_codes').get() as { scope: string };
    assert.equal(row.scope, 'fleet:read fleet:operate');
  });

  test('deny redirects with access_denied', async (t) => {
    const h = await startOAuthHarness(t);
    const { page } = await openPage(h);
    const params = redirectParams(await submitApproval(h.baseUrl, page.fields, { decision: 'deny' }));
    assert.equal(params.get('error'), 'access_denied');
    assert.equal(params.get('code'), null);
  });

  test('approval codes are single use and expire', async (t) => {
    const h = await startOAuthHarness(t);
    const { code } = h.approvals.mint();
    const first = await openPage(h);
    redirectParams(await submitApproval(h.baseUrl, first.page.fields, { approval_code: code }));
    const second = await openPage(h);
    const reused = await submitApproval(h.baseUrl, second.page.fields, { approval_code: code });
    assert.equal(reused.status, 400);
    assert.match(await reused.text(), /not accepted/);
    const expiring = h.approvals.mint(MINUTE);
    h.clock.advance(MINUTE + 1);
    const third = await openPage(h);
    assert.equal((await submitApproval(h.baseUrl, third.page.fields, { approval_code: expiring.code })).status, 400);
  });

  test('rejects a tampered or expired approval form', async (t) => {
    const h = await startOAuthHarness(t);
    const clientId = await registerClient(h.baseUrl, { redirect_uris: [CALLBACK, 'https://agent.example.com/other'] });
    const { page } = await openPage(h, clientId);
    const { code } = h.approvals.mint();
    for (const tampered of [
      { ...page.fields, redirect_uri: 'https://agent.example.com/other' },
      { ...page.fields, code_challenge: pkcePair().challenge },
      { ...page.fields, state: 'other-state' },
      { ...page.fields, signature: 'forged' },
    ]) {
      const response = await submitApproval(h.baseUrl, tampered, { approval_code: code });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('location'), null);
    }
    h.clock.advance(11 * MINUTE);
    const expired = await submitApproval(h.baseUrl, page.fields, { approval_code: code });
    assert.equal(expired.status, 400);
    assert.match(await expired.text(), /expired or was altered/);
    assert.equal((h.db.prepare('SELECT used_at FROM approval_codes').get() as { used_at: number | null }).used_at, null, 'code not consumed');
  });

  test('locks one authorization request after repeated failures', async (t) => {
    const h = await startOAuthHarness(t);
    const { page } = await openPage(h);
    for (let i = 0; i < MAX_FAILURES_PER_REQUEST; i++) {
      assert.equal((await submitApproval(h.baseUrl, page.fields, { approval_code: 'WRONG-CODE0' })).status, 400);
    }
    const locked = await submitApproval(h.baseUrl, page.fields, { approval_code: h.approvals.mint().code });
    assert.equal(locked.status, 429, 'even a valid code is refused for a locked request');
    const fresh = await openPage(h);
    redirectParams(await submitApproval(h.baseUrl, fresh.page.fields, { approval_code: h.approvals.mint().code }));
    assert.ok(h.logs.some((line) => line.includes('"event":"oauth.approval_throttled"') && line.includes('"limit":"request"')));
  });

  async function exhaustGlobalLimit(h: OAuthHarness): Promise<void> {
    while (h.approvals.globalFailures() < MAX_FAILURES_PER_HOUR) {
      const { page } = await openPage(h);
      for (let i = 0; i < MAX_FAILURES_PER_REQUEST - 1 && h.approvals.globalFailures() < MAX_FAILURES_PER_HOUR; i++) {
        assert.equal((await submitApproval(h.baseUrl, page.fields, { approval_code: 'WRONG-CODE0' })).status, 400);
      }
    }
  }

  test('pauses all approvals after too many failures in an hour, then recovers', async (t) => {
    const h = await startOAuthHarness(t);
    const { code } = h.approvals.mint(2 * HOUR);
    await exhaustGlobalLimit(h);
    const blocked = await openPage(h);
    assert.equal((await submitApproval(h.baseUrl, blocked.page.fields, { approval_code: code })).status, 429);
    assert.ok(h.logs.some((line) => line.includes('"event":"oauth.approval_throttled"') && line.includes('"limit":"global"')));
    h.clock.advance(HOUR);
    const later = await openPage(h);
    redirectParams(await submitApproval(h.baseUrl, later.page.fields, { approval_code: code }));
  });

  test('minting a code lifts a global pause; locks on single requests stay until a throttle reset', async (t) => {
    const h = await startOAuthHarness(t);
    const locked = await openPage(h);
    for (let i = 0; i < MAX_FAILURES_PER_REQUEST; i++) {
      assert.equal((await submitApproval(h.baseUrl, locked.page.fields, { approval_code: 'WRONG-CODE0' })).status, 400);
    }
    await exhaustGlobalLimit(h);
    const blocked = await openPage(h);
    const paused = await submitApproval(h.baseUrl, blocked.page.fields, { approval_code: 'WRONG-CODE0' });
    assert.equal(paused.status, 429);
    assert.match(await paused.text(), /until a new code is minted/);

    const minted = h.approvals.mint();
    assert.equal(minted.clearedLock, true, 'pair reports that it lifted the pause');
    assert.equal(h.approvals.mint().clearedLock, false);
    redirectParams(await submitApproval(h.baseUrl, blocked.page.fields, { approval_code: minted.code }));
    const code = h.approvals.mint().code;
    assert.equal((await submitApproval(h.baseUrl, locked.page.fields, { approval_code: code })).status, 429, 'the locked request stays locked');

    h.approvals.resetThrottles();
    redirectParams(await submitApproval(h.baseUrl, locked.page.fields, { approval_code: code }));
  });

  test('a revoked client cannot complete an approval', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, page } = await openPage(h);
    h.clients.revoke(clientId);
    const response = await submitApproval(h.baseUrl, page.fields, { approval_code: h.approvals.mint().code });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
  });
});
