import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { HOUR } from '../src/time.ts';
import { TestAgentProvider } from './helpers/agent.ts';
import { startTestGateway } from './helpers/gateway.ts';

test('an SDK agent discovers, registers, gets approved, calls tools and refreshes', async (t) => {
  const gw = await startTestGateway(t);
  const provider = new TestAgentProvider(gw.mintApprovalCode);
  const url = new URL(`${gw.baseUrl}/mcp`);

  const first = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await assert.rejects(new Client({ name: 'agent', version: '0' }).connect(first), UnauthorizedError);
  assert.ok(provider.clientInfo?.client_id, 'registered dynamically');
  assert.ok(provider.callbackParams?.get('code'), 'approval redirected back with a code');
  assert.equal(provider.callbackParams?.get('iss'), gw.baseUrl);
  await first.finishAuth(provider.callbackParams);
  assert.equal(provider.savedTokens?.scope, 'fleet:read');

  const client = new Client({ name: 'agent', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  t.after(() => client.close());
  const status = await client.callTool({ name: 'fleet_status', arguments: {} });
  assert.notEqual(status.isError, true);

  const firstAccess = provider.savedTokens?.access_token;
  gw.clock.advance(13 * HOUR);
  const later = await client.callTool({ name: 'fleet_status', arguments: {} });
  assert.notEqual(later.isError, true, 'the SDK refreshed after the access token expired');
  assert.notEqual(provider.savedTokens?.access_token, firstAccess);
  assert.ok(gw.logs.some((line) => line.includes('"event":"oauth.token_issued"') && line.includes('"grant":"refresh_token"')));
});
