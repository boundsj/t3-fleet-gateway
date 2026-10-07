import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { HOUR } from '../src/time.ts';
import { TestAgentProvider } from './helpers/agent.ts';
import { startTestGateway } from './helpers/gateway.ts';
import { startJobHarness } from './helpers/jobs.ts';

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

test('an SDK agent with an Operate grant starts work and follows it through work_feed until it is idle', async (t) => {
  const { fake, gw } = await startJobHarness(t, { intervalMs: 50 });
  const provider = new TestAgentProvider(gw.mintApprovalCode, 'operate');
  const url = new URL(`${gw.baseUrl}/mcp`);
  const first = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await assert.rejects(new Client({ name: 'agent', version: '0' }).connect(first), UnauthorizedError);
  await first.finishAuth(provider.callbackParams ?? new URLSearchParams());
  assert.equal(provider.savedTokens?.scope, 'fleet:read fleet:operate');
  const client = new Client({ name: 'agent', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  t.after(() => client.close());
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return result.structuredContent as T;
  };

  const started = await call<{ job: { jobId: string } }>('work_start', { project: 'pilot', task: 'Synthetic agent-path task', requestId: 'agent-path-1' });
  const { jobId } = started.job;
  type Feed = { events: { jobId: string; toState: string | null }[]; nextCursor: string; attention: { jobId: string; state: string }[] };
  let cursor: string | undefined;
  const states: string[] = [];
  const pollUntil = async (state: string) => {
    for (let attempt = 0; attempt < 100 && !states.includes(state); attempt++) {
      const feed: Feed = await call<Feed>('work_feed', cursor === undefined ? {} : { cursor });
      cursor = feed.nextCursor;
      states.push(...feed.events.filter((event) => event.jobId === jobId && event.toState).map((event) => event.toState as string));
      if (!states.includes(state)) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(states.includes(state), `saw ${states.join(', ')} but not ${state}`);
  };
  await pollUntil('running');
  fake.finishTurn(fake.threadForJob(jobId).threadId, 'Synthetic agent-path result');
  await pollUntil('idle');
  assert.deepEqual(states, ['queued', 'dispatching', 'running', 'idle']);
  const feed = await call<Feed>('work_feed', { cursor });
  assert.deepEqual(feed.attention.map((job) => [job.jobId, job.state]), [[jobId, 'idle']]);
  const status = await call<{ latestMessageExcerpt: string }>('work_status', { jobId });
  assert.equal(status.latestMessageExcerpt, 'Synthetic agent-path result');
});
