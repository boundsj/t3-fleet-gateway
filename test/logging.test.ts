import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { HOUR } from '../src/time.ts';
import { TestAgentProvider } from './helpers/agent.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway } from './helpers/gateway.ts';
import { tokenRequest } from './helpers/oauthFlow.ts';

test('no secret value ever appears in the logs', async (t) => {
  const fake = await startFakeT3();
  t.after(() => fake.stop());
  const gw = await startTestGateway(t, {
    config: { hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand() }] },
  });
  await gw.services.registry.enroll('main');

  const approvalCodes: string[] = [];
  const provider = new TestAgentProvider(() => {
    const code = gw.mintApprovalCode();
    approvalCodes.push(code);
    return code;
  }, 'operate');
  const url = new URL(`${gw.baseUrl}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await new Client({ name: 'agent', version: '0' }).connect(transport).catch(() => {});
  const authorizationCode = provider.callbackParams?.get('code') ?? '';
  await transport.finishAuth(provider.callbackParams ?? new URLSearchParams());
  const issued = [provider.savedTokens?.access_token, provider.savedTokens?.refresh_token];

  const client = new Client({ name: 'agent', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  await client.callTool({ name: 'fleet_status', arguments: {} });
  gw.clock.advance(13 * HOUR);
  await client.callTool({ name: 'fleet_status', arguments: {} });
  issued.push(provider.savedTokens?.access_token, provider.savedTokens?.refresh_token);
  await client.close();
  // Failure paths log too: a bad approval code, a replayed code and a bogus bearer token.
  await tokenRequest(gw.baseUrl, { grant_type: 'authorization_code', code: authorizationCode, client_id: provider.clientInfo?.client_id ?? '' });
  await fetch(url, { method: 'POST', headers: { authorization: 'Bearer bogus-secret-token-value', 'content-type': 'application/json' }, body: '{}' });

  const secrets = [
    ...issued,
    authorizationCode,
    provider.codeVerifier(),
    ...approvalCodes,
    ...approvalCodes.map((code) => code.replace('-', '')),
    ...fake.issuedTokens,
    'bogus-secret-token-value',
  ].filter((value): value is string => typeof value === 'string' && value.length >= 8);
  assert.ok(secrets.length >= 9, `collected ${secrets.length} secrets`);
  assert.ok(gw.logs.length > 10);
  const log = gw.logs.join('\n');
  for (const secret of secrets) assert.equal(log.includes(secret), false, 'a secret leaked into the logs');
  assert.doesNotMatch(log, /"authorization"|bearer /i);
});
