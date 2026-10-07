import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_REGISTRATIONS_PER_HOUR } from '../src/oauth/clients.ts';
import { DAY, HOUR } from '../src/time.ts';
import { startOAuthHarness } from './helpers/oauthHarness.ts';
import { register } from './helpers/oauthFlow.ts';

async function rejected(baseUrl: string, metadata: Record<string, unknown>, error: string): Promise<void> {
  const response = await register(baseUrl, metadata);
  assert.equal(response.status, 400, JSON.stringify(metadata));
  assert.equal(((await response.json()) as { error: string }).error, error, JSON.stringify(metadata));
}

describe('OAuth metadata', () => {
  test('publishes authorization server and protected resource metadata', async (t) => {
    const { baseUrl } = await startOAuthHarness(t);
    const as = (await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(as.issuer, baseUrl);
    assert.equal(as.authorization_endpoint, `${baseUrl}/oauth/authorize`);
    assert.equal(as.token_endpoint, `${baseUrl}/oauth/token`);
    assert.equal(as.registration_endpoint, `${baseUrl}/oauth/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(as.scopes_supported, ['fleet:read', 'fleet:operate']);
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const prm = (await (await fetch(baseUrl + path)).json()) as Record<string, unknown>;
      assert.equal(prm.resource, `${baseUrl}/mcp`);
      assert.deepEqual(prm.authorization_servers, [baseUrl]);
    }
  });
});

describe('dynamic client registration', () => {
  test('registers a public client with https and loopback redirect URIs', async (t) => {
    const { baseUrl, clients } = await startOAuthHarness(t);
    const uris = ['https://www.cursor.com/agents/mcp/oauth/callback', 'http://127.0.0.1:43123/callback', 'http://localhost/cb', 'http://[::1]:8080/cb'];
    const response = await register(baseUrl, { redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(typeof body.client_id, 'string');
    assert.deepEqual(body.redirect_uris, uris);
    assert.equal(body.token_endpoint_auth_method, 'none');
    assert.equal('client_secret' in body, false);
    assert.equal(clients.get(body.client_id as string)?.name, 'Test agent');
  });

  test('rejects unsafe or malformed redirect URIs', async (t) => {
    const { baseUrl } = await startOAuthHarness(t);
    for (const uri of [
      'https://agent.example.com/cb#fragment',
      'https://user:pass@agent.example.com/cb',
      'http://agent.example.com/cb',
      'javascript:alert(1)',
      'custom-app://callback',
      'not a url',
      `https://agent.example.com/${'a'.repeat(600)}`,
    ]) {
      await rejected(baseUrl, { redirect_uris: [uri] }, 'invalid_redirect_uri');
    }
    await rejected(baseUrl, { redirect_uris: [] }, 'invalid_redirect_uri');
    await rejected(baseUrl, { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://agent.example.com/${i}`) }, 'invalid_redirect_uri');
  });

  test('accepts only public clients with the supported grants', async (t) => {
    const { baseUrl } = await startOAuthHarness(t);
    await rejected(baseUrl, { token_endpoint_auth_method: 'client_secret_basic' }, 'invalid_client_metadata');
    await rejected(baseUrl, { grant_types: ['client_credentials'] }, 'invalid_client_metadata');
    await rejected(baseUrl, { grant_types: ['refresh_token'] }, 'invalid_client_metadata');
    await rejected(baseUrl, { response_types: ['token'] }, 'invalid_client_metadata');
    await rejected(baseUrl, { client_name: 'x'.repeat(81) }, 'invalid_client_metadata');
  });

  test('requires a bounded JSON body', async (t) => {
    const { baseUrl } = await startOAuthHarness(t);
    const form = await fetch(`${baseUrl}/oauth/register`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415);
    const huge = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://agent.example.com/cb'], padding: 'x'.repeat(20_000) }),
    });
    assert.equal(huge.status, 413);
  });

  test('rate-limits registrations and prunes clients that were never approved', async (t) => {
    const { baseUrl, clients, clock } = await startOAuthHarness(t);
    const first = ((await (await register(baseUrl)).json()) as { client_id: string }).client_id;
    for (let i = 1; i < MAX_REGISTRATIONS_PER_HOUR; i++) assert.equal((await register(baseUrl)).status, 201);
    const limited = await register(baseUrl);
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { error: string }).error, 'temporarily_unavailable');
    clock.advance(HOUR + 1);
    assert.equal((await register(baseUrl)).status, 201);
    assert.ok(clients.get(first));
    clock.advance(DAY);
    assert.equal((await register(baseUrl)).status, 201);
    assert.equal(clients.get(first), undefined, 'unapproved client older than a day was pruned');
  });
});
