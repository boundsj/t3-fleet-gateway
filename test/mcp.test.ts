import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod';
import { gatewayTools } from '../src/gateway.ts';
import { defineTool } from '../src/mcp/tools.ts';
import { OPERATE_SCOPE } from '../src/oauth/scopes.ts';
import { HOUR } from '../src/time.ts';
import { INITIALIZE, mcpPost, startTestGateway, type TestGateway } from './helpers/gateway.ts';
import { signIn } from './helpers/oauthFlow.ts';

const echoTool = defineTool({
  name: 'test_operate',
  title: 'Operate-scoped test tool',
  description: 'Echoes its input. Exists only in tests to exercise scope enforcement.',
  scope: OPERATE_SCOPE,
  readOnly: false,
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string(), clientId: z.string() }),
  async run(input, context) {
    return { structured: { value: input.value, clientId: context.clientId }, summary: `echo ${input.value}` };
  },
});

async function gatewayWithEcho(t: import('node:test').TestContext, config: Record<string, unknown> = {}): Promise<TestGateway> {
  return startTestGateway(t, { config, tools: (services) => [...gatewayTools(services), echoTool] });
}

async function connect(t: import('node:test').TestContext, gw: TestGateway, token: string, mode?: 'auto'): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '0' }, mode ? { versionNegotiation: { mode } } : {});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gw.baseUrl}/mcp`), { authProvider: { token: async () => token } }));
  t.after(() => client.close());
  return client;
}

describe('MCP endpoint authentication', () => {
  test('answers 401 with the protected resource metadata URL', async (t) => {
    const gw = await startTestGateway(t);
    const missing = await mcpPost(gw.baseUrl, undefined, INITIALIZE);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), `Bearer resource_metadata="${gw.baseUrl}/.well-known/oauth-protected-resource/mcp"`);
    const invalid = await mcpPost(gw.baseUrl, 'not-a-real-token', INITIALIZE);
    assert.equal(invalid.status, 401);
    assert.match(invalid.headers.get('www-authenticate') ?? '', /^Bearer error="invalid_token", resource_metadata="/);
  });

  test('rejects expired and revoked tokens', async (t) => {
    const gw = await startTestGateway(t);
    const { clientId, tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
    assert.equal((await mcpPost(gw.baseUrl, tokens.access_token, INITIALIZE)).status, 200);
    gw.clock.advance(13 * HOUR);
    assert.equal((await mcpPost(gw.baseUrl, tokens.access_token, INITIALIZE)).status, 401, 'expired after accessTtlSeconds');
    const second = await signIn(gw.baseUrl, gw.mintApprovalCode, { clientId });
    gw.services.clients.revoke(clientId);
    assert.equal((await mcpPost(gw.baseUrl, second.tokens.access_token, INITIALIZE)).status, 401);
  });

  test('validates Origin when present and allows clients that send none', async (t) => {
    const gw = await startTestGateway(t, { config: { allowedOrigins: ['https://agent.example.com'] } });
    const { tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
    assert.equal((await mcpPost(gw.baseUrl, tokens.access_token, INITIALIZE)).status, 200);
    assert.equal((await mcpPost(gw.baseUrl, tokens.access_token, INITIALIZE, { origin: gw.baseUrl })).status, 200);
    assert.equal((await mcpPost(gw.baseUrl, tokens.access_token, INITIALIZE, { origin: 'https://agent.example.com' })).status, 200);
    assert.equal((await mcpPost(gw.baseUrl, tokens.access_token, INITIALIZE, { origin: 'https://evil.example.com' })).status, 403);
  });

  test('has no sessions: GET and DELETE answer 405', async (t) => {
    const gw = await startTestGateway(t);
    const { tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${gw.baseUrl}/mcp`, { method, headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'text/event-stream' } });
      assert.equal(response.status, 405, method);
    }
  });
});

describe('MCP protocol handling', () => {
  test('serves 2025-era requests that omit MCP-Protocol-Version, with JSON responses (Grok Bot regression)', async (t) => {
    const gw = await startTestGateway(t);
    const { tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
    const init = await mcpPost(gw.baseUrl, tokens.access_token, INITIALIZE);
    assert.equal(init.status, 200);
    assert.match(init.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(init.headers.get('mcp-session-id'), null, 'stateless');
    assert.equal(((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18');
    assert.equal((await mcpPost(gw.baseUrl, tokens.access_token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const list = await mcpPost(gw.baseUrl, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(list.status, 200);
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    assert.deepEqual(tools, gatewayTools(gw.services).map((tool) => tool.name));
    assert.equal(tools[0], 'fleet_status');
    const call = await mcpPost(gw.baseUrl, tokens.access_token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'fleet_status', arguments: {} },
    });
    assert.equal(call.status, 200);
    const result = ((await call.json()) as { result: { isError?: boolean; structuredContent: { gateway: { name: string } } } }).result;
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.gateway.name, 't3-fleet-gateway');
    const withHeader = await mcpPost(gw.baseUrl, tokens.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
    assert.equal(withHeader.status, 200);
  });

  test('serves SDK clients in both protocol eras', async (t) => {
    const gw = await startTestGateway(t);
    const { tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
    for (const mode of [undefined, 'auto'] as const) {
      const client = await connect(t, gw, tokens.access_token, mode);
      assert.equal(client.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy');
      const result = await client.callTool({ name: 'fleet_status', arguments: {} });
      assert.notEqual(result.isError, true);
    }
  });

  test('serves clients whose Accept header lists only JSON, anything, or nothing', async (t) => {
    const gw = await startTestGateway(t);
    const { tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
    for (const accept of ['application/json', '*/*', '']) {
      const response = await mcpPost(gw.baseUrl, tokens.access_token, INITIALIZE, { accept });
      assert.equal(response.status, 200, `Accept: ${accept}`);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      const call = await mcpPost(gw.baseUrl, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fleet_status', arguments: {} } }, { accept });
      assert.equal(call.status, 200, `Accept: ${accept}`);
    }
  });

  test('bounds request bodies', async (t) => {
    const gw = await startTestGateway(t);
    const { tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
    const response = await mcpPost(gw.baseUrl, tokens.access_token, { ...INITIALIZE, padding: 'x'.repeat(1_100_000) });
    assert.equal(response.status, 413);
  });
});

describe('scope enforcement', () => {
  test('a Read grant can list but not run operate tools; the error names the scope', async (t) => {
    const gw = await gatewayWithEcho(t);
    const { tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode, { access: 'read' });
    for (const mode of [undefined, 'auto'] as const) {
      const client = await connect(t, gw, tokens.access_token, mode);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert.deepEqual(names.sort(), [...gatewayTools(gw.services).map((tool) => tool.name), 'test_operate'].sort());
      const result = await client.callTool({ name: 'test_operate', arguments: { value: 'x' } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /insufficient_scope: test_operate requires the fleet:operate scope/);
    }
  });

  test('an Operate grant runs operate tools and the tool sees the caller', async (t) => {
    const gw = await gatewayWithEcho(t);
    const { clientId, tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode, { access: 'operate' });
    const client = await connect(t, gw, tokens.access_token);
    const result = await client.callTool({ name: 'test_operate', arguments: { value: 'x' } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, { value: 'x', clientId });
  });

  test('tool inputs are validated against their schema', async (t) => {
    const gw = await gatewayWithEcho(t);
    const { tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode, { access: 'operate' });
    const client = await connect(t, gw, tokens.access_token);
    const result = await client.callTool({ name: 'test_operate', arguments: { value: 42 } });
    assert.equal(result.isError, true);
  });
});
