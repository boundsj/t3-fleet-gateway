import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex } from '../src/crypto.ts';
import { diagnoseClient } from '../src/oauth/diagnostics.ts';
import { NEVER_EXPIRES, REFRESH_GRACE } from '../src/oauth/tokens.ts';
import { DAY, HOUR, MINUTE, SECOND } from '../src/time.ts';
import { INITIALIZE, mcpPost, startTestGateway } from './helpers/gateway.ts';
import { startOAuthHarness, type OAuthHarness } from './helpers/oauthHarness.ts';
import { CALLBACK, pkcePair, signIn, tokenRequest } from './helpers/oauthFlow.ts';

function grant(h: OAuthHarness, clientId?: string) {
  const id = clientId ?? h.clients.register({ redirect_uris: [CALLBACK] }).id;
  const { verifier, challenge } = pkcePair();
  const code = h.tokens.issueAuthorizationCode({ clientId: id, redirectUri: CALLBACK, codeChallenge: challenge, scopes: ['fleet:read'] });
  const tokens = h.tokens.exchangeAuthorizationCode({ clientId: id, code, redirectUri: CALLBACK, codeVerifier: verifier, resource: h.resource });
  return { clientId: id, tokens };
}
const diagnose = (h: OAuthHarness, id: string) => {
  const result = diagnoseClient(h.db, h.clock, h.resource, id);
  assert.ok(result);
  return result;
};
const refresh = (h: OAuthHarness, id: string, token: string) => h.tokens.refresh({
  clientId: id, refreshToken: token, scope: undefined, resource: h.resource,
});

test('diagnostics distinguish pending, static bearer expiry and never-expiring bearer without revealing credentials', async (t) => {
  const h = await startOAuthHarness(t);
  assert.equal(diagnoseClient(h.db, h.clock, h.resource, 'missing'), undefined);
  const pending = h.clients.register({ redirect_uris: [CALLBACK] });
  assert.equal(diagnose(h, pending.id).state, 'pending');
  const finite = h.tokens.issueOperatorToken({ name: 'Synthetic finite', scopes: ['fleet:read'], expiresAt: h.clock() + HOUR });
  const never = h.tokens.issueOperatorToken({ name: 'Synthetic never', scopes: ['fleet:read'], expiresAt: NEVER_EXPIRES });
  assert.equal(diagnose(h, finite.clientId).state, 'active');
  h.clock.advance(HOUR);
  assert.equal(diagnose(h, finite.clientId).state, 'unusable', 'expiry is exclusive');
  assert.equal(diagnose(h, never.clientId).usableAccess, true);
  assert.equal(diagnose(h, never.clientId).usableRefresh, false);
  assert.deepEqual(diagnose(h, never.clientId).families[0]?.refresh, []);
  assert.equal(diagnose(h, never.clientId).families[0]?.access[0]?.latestExpiresAt, NEVER_EXPIRES);
  const serialized = JSON.stringify(diagnose(h, never.clientId));
  for (const value of [never.token, sha256Hex(never.token), 'token_hash', 'parent_hash']) assert.ok(!serialized.includes(value));
  h.clients.revoke(never.clientId);
  assert.equal(diagnose(h, never.clientId).state, 'revoked');
  assert.equal(diagnose(h, never.clientId).families[0]?.revocationReason, 'client_revoked');
});

test('access expiry remains refreshable; refresh expiry, resource mismatch and legacy usage are honest', async (t) => {
  const h = await startOAuthHarness(t, { accessTtlSeconds: 3600, refreshIdleTtlDays: 1 });
  const { clientId, tokens } = grant(h);
  h.clients.touch(clientId);
  assert.deepEqual([diagnose(h, clientId).lastMcpSuccessAt, diagnose(h, clientId).lastRefreshSuccessAt], [null, null]);
  h.clock.advance(HOUR);
  assert.equal(diagnose(h, clientId).state, 'refreshable');
  assert.equal(diagnose(h, clientId).families[0]?.access[0]?.state, 'expired');
  h.clock.advance(DAY - HOUR);
  assert.equal(diagnose(h, clientId).state, 'unusable');
  assert.equal(diagnose(h, clientId).families[0]?.refresh[0]?.state, 'expired');
  assert.throws(() => refresh(h, clientId, tokens.refresh_token), /expired/);
  assert.equal(diagnose(h, clientId).lastRefreshSuccessAt, null);
  const fresh = grant(h);
  h.db.prepare('UPDATE token_families SET resource = ? WHERE client_id = ?').run('https://other.example.com/mcp', fresh.clientId);
  assert.equal(diagnose(h, fresh.clientId).state, 'unusable');
  assert.equal(diagnose(h, fresh.clientId).families[0]?.access[0]?.state, 'wrong_resource');
  assert.equal(diagnose(h, fresh.clientId).families[0]?.refresh[0]?.state, 'wrong_resource');
  assert.throws(() => refresh(h, fresh.clientId, fresh.tokens.refresh_token), /resource/);
  assert.equal(diagnose(h, fresh.clientId).lastRefreshSuccessAt, null);
  h.db.prepare('UPDATE token_families SET resource = ? WHERE client_id = ?').run(`${h.resource}/`, fresh.clientId);
  assert.equal(diagnose(h, fresh.clientId).state, 'active', 'one trailing slash matches enforcement');
});

test('rotation diagnostics include exact grace, siblings, supersession and child-rotation replay without mutating grants', async (t) => {
  const h = await startOAuthHarness(t);
  const { clientId, tokens } = grant(h);
  const first = refresh(h, clientId, tokens.refresh_token);
  const firstSuccess = h.clock();
  h.clock.advance(REFRESH_GRACE);
  let family = diagnose(h, clientId).families[0];
  assert.deepEqual(family?.refresh.map((item) => [item.state, item.count]), [['grace_retry', 1], ['usable', 1]]);
  const sibling = refresh(h, clientId, tokens.refresh_token);
  assert.equal(diagnose(h, clientId).lastRefreshSuccessAt, firstSuccess + REFRESH_GRACE, 'accepted grace retry counts');
  assert.equal(diagnose(h, clientId).families[0]?.refresh.find((item) => item.state === 'usable')?.count, 2);
  h.clock.advance(1);
  assert.equal(diagnose(h, clientId).families[0]?.refresh[0]?.state, 'replay', 'one millisecond outside grace');
  refresh(h, clientId, first.refresh_token);
  family = diagnose(h, clientId).families[0];
  assert.ok(family?.refresh.some((item) => item.state === 'superseded'));
  assert.equal(h.tokens.verifyAccessToken(sibling.access_token)?.clientId, clientId, 'superseded sibling access stays valid');
  const changes = h.db.prepare('SELECT total_changes() AS n').get();
  diagnose(h, clientId);
  assert.deepEqual(h.db.prepare('SELECT total_changes() AS n').get(), changes, 'diagnosis does not consume or revoke');
  const success = diagnose(h, clientId).lastRefreshSuccessAt;
  assert.throws(() => refresh(h, clientId, sibling.refresh_token), /already used/);
  assert.equal(diagnose(h, clientId).lastRefreshSuccessAt, success, 'rejection is not success');
  assert.equal(diagnose(h, clientId).families[0]?.revocationReason, 'refresh_token_reuse');
  assert.equal(diagnose(h, clientId).usableAccess, false);
  assert.equal(diagnose(h, clientId).usableRefresh, false);
});

test('child rotation blocks parent grace retry; a revoked family never masks another valid grant', async (t) => {
  const h = await startOAuthHarness(t);
  const { clientId, tokens } = grant(h);
  const child = refresh(h, clientId, tokens.refresh_token);
  refresh(h, clientId, child.refresh_token);
  assert.equal(diagnose(h, clientId).families[0]?.refresh[0]?.state, 'replay', 'child rotation ends parent grace immediately');
  assert.throws(() => refresh(h, clientId, tokens.refresh_token), /already used/);
  const fresh = grant(h, clientId);
  const result = diagnose(h, clientId);
  assert.equal(result.state, 'active');
  assert.equal(result.families.filter((family) => family.usableRefresh).length, 1);
  assert.equal(result.families.filter((family) => family.revocationReason === 'refresh_token_reuse').length, 1);
  assert.ok(h.tokens.verifyAccessToken(fresh.tokens.access_token));
  h.clock.advance(HOUR);
  assert.equal(diagnose(h, clientId).state, 'refreshable');
});

test('successful MCP exchanges and refresh pair issuance have separate times; rejection and malformed HTTP do not count', async (t) => {
  const gw = await startTestGateway(t);
  const { clientId, tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
  const read = () => diagnoseClient(gw.services.db, gw.clock, `${gw.baseUrl}/mcp`, clientId)!;
  assert.deepEqual([read().lastMcpSuccessAt, read().lastRefreshSuccessAt], [null, null], 'code exchange is not refresh');
  const post = async (token: string | undefined, message: unknown, headers: Record<string, string> = {}) => {
    const response = await mcpPost(gw.baseUrl, token, message, headers);
    await response.text();
    return response.status;
  };
  assert.equal(await post(undefined, INITIALIZE), 401);
  assert.equal(await post(tokens.access_token, INITIALIZE, { origin: 'https://untrusted.example.com' }), 403);
  const malformed = await fetch(`${gw.baseUrl}/mcp`, { method: 'POST',
    headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  await malformed.text();
  const unsupported = await fetch(`${gw.baseUrl}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(unsupported.status, 405);
  await unsupported.text();
  assert.equal(read().lastMcpSuccessAt, null);
  assert.equal(await post(tokens.access_token, INITIALIZE), 200);
  const initial = gw.clock();
  assert.equal(read().lastMcpSuccessAt, initial);
  gw.clock.advance(SECOND);
  assert.equal(await post(tokens.access_token, { jsonrpc: '2.0', method: 'notifications/initialized' }), 202);
  assert.equal(read().lastMcpSuccessAt, initial, 'MCP writes are bounded to once per minute');
  gw.clock.advance(MINUTE - SECOND);
  // A scope/tool error still proves an authorized successful exchange.
  assert.equal(await post(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'work_start', arguments: { project: 'missing', task: 'Synthetic forbidden task', requestId: 'no-scope-1' } },
  }), 200);
  assert.equal(read().lastMcpSuccessAt, gw.clock(), 'inclusive one-minute sampling boundary');
  gw.clock.advance(SECOND);
  const response = await tokenRequest(gw.baseUrl, { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(read().lastRefreshSuccessAt, gw.clock());
  const mcpTime = read().lastMcpSuccessAt;
  gw.clock.advance(13 * HOUR);
  assert.equal(await post(tokens.access_token, INITIALIZE), 401);
  assert.equal(read().lastMcpSuccessAt, mcpTime);
  assert.equal(read().lastRefreshSuccessAt, initial + MINUTE + SECOND);
  const serialized = JSON.stringify(read()) + gw.logs.join('\n');
  for (const value of [tokens.access_token, tokens.refresh_token, sha256Hex(tokens.access_token), sha256Hex(tokens.refresh_token)]) {
    assert.ok(!serialized.includes(value), 'diagnostics and logs keep credentials/hashes private');
  }
});

test('MCP success bookkeeping failure does not change a completed response or grant security', async (t) => {
  const gw = await startTestGateway(t);
  const { clientId, tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
  gw.services.db.exec(`CREATE TRIGGER synthetic_success_failure BEFORE UPDATE OF last_mcp_success_at ON oauth_clients
    BEGIN SELECT RAISE(ABORT, 'synthetic bookkeeping failure'); END`);
  const response = await mcpPost(gw.baseUrl, tokens.access_token, INITIALIZE);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(gw.services.tokens.verifyAccessToken(tokens.access_token)?.clientId, clientId);
  assert.equal(diagnoseClient(gw.services.db, gw.clock, `${gw.baseUrl}/mcp`, clientId)?.lastMcpSuccessAt, null);
  assert.ok(gw.logs.some((line) => line.includes('"event":"mcp.success_record_failed"')));
  assert.ok(gw.logs.every((line) => !line.includes('synthetic bookkeeping failure')));
});
