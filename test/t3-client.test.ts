import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as z from 'zod';
import { T3Client, T3TransportError } from '../src/t3/client.ts';
import { parseToolResult, T3ToolError } from '../src/t3/results.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';

async function setup(t: import('node:test').TestContext, options: Parameters<typeof startFakeT3>[0] = {}) {
  const fake = await startFakeT3(options);
  const token = fake.mintPairingCode() && 'token-for-tests';
  fake.validTokens.add(token);
  let current: string | undefined = token;
  const client = new T3Client({ hostId: 'main', t3Url: fake.url, token: () => current, timeoutMs: 2000 });
  t.after(async () => {
    await client.close();
    await fake.stop();
  });
  return { fake, client, setToken: (value: string | undefined) => (current = value) };
}

function rejectsWith(code: string) {
  return (error: unknown) => (error as { code?: string }).code === code;
}

function transportFailure(code: string, delivery: 'not_delivered' | 'unknown') {
  return (error: unknown) => error instanceof T3TransportError && error.code === code && error.delivery === delivery;
}

const LAUNCH = {
  projectId: 'project-1',
  title: 'Synthetic job [job:abc123]',
  workspaceStrategy: { type: 'worktree' as const, baseRef: 'main', branch: 'fleet/abc123', startFromOrigin: false },
  runtimeMode: 'auto' as const,
  message: 'Synthetic task text',
};

describe('T3 result parsing', () => {
  const schema = z.object({ value: z.number() });

  test('prefers structuredContent and falls back to the JSON text block', () => {
    assert.deepEqual(parseToolResult('t', { structuredContent: { value: 1 }, content: [] }, schema), { value: 1 });
    assert.deepEqual(parseToolResult('t', { content: [{ type: 'text', text: '{"value":2}' }] }, schema), { value: 2 });
  });

  test('turns T3 failures into T3ToolError with T3 code', () => {
    const failure = { _tag: 'OrchestratorMcpFailure', code: 'target_required', message: 'Pass projectId.' };
    assert.throws(
      () => parseToolResult('t3_thread_list', { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }] }, schema),
      (error: unknown) => error instanceof T3ToolError && error.code === 't3_tool_failed' && error.t3Code === 'target_required',
    );
    assert.throws(() => parseToolResult('t', { isError: true, content: [{ type: 'text', text: 'boom' }] }, schema), { t3Code: 'unknown' });
  });

  test('rejects results that do not match the expected shape', () => {
    assert.throws(() => parseToolResult('t', { structuredContent: { value: 'x' } }, schema), { code: 't3_invalid_response' });
    assert.throws(() => parseToolResult('t', { content: [{ type: 'text', text: 'not json' }] }, schema), { code: 't3_invalid_response' });
  });
});

describe('T3 client', () => {
  test('reads the environment and pages through projects', async (t) => {
    const { fake, client } = await setup(t, { projectCount: 130 });
    fake.projects[5]!.deletedAt = '2026-01-01T00:00:00.000Z';
    assert.equal((await client.environmentRead()).serverVersion, '0.0.0-test');
    const projects = await client.listProjects();
    assert.equal(projects.length, 129, 'deleted projects are dropped');
    assert.deepEqual(fake.calls.filter((call) => call === 't3_project_list').length, 2);
  });

  test('surfaces T3 tool failures with their code', async (t) => {
    const { fake, client } = await setup(t);
    fake.failures.set('t3_environment_read', { code: 'not_ready', message: 'Server is starting.' });
    await assert.rejects(client.environmentRead(), (error: unknown) => error instanceof T3ToolError && error.t3Code === 'not_ready');
  });

  test('reports a missing or rejected credential', async (t) => {
    const { fake, client, setToken } = await setup(t);
    setToken(undefined);
    await assert.rejects(client.environmentRead(), rejectsWith('host_not_enrolled'));
    setToken('not-a-valid-token');
    await assert.rejects(client.environmentRead(), rejectsWith('t3_unauthorized'));
    const fresh = fake.mintPairingCode();
    fake.validTokens.add(fresh);
    setToken(fresh);
    assert.ok(await client.environmentRead(), 'a new credential reconnects');
  });

  test('times out slow calls and recovers', async (t) => {
    const { fake, client } = await setup(t);
    fake.toolDelayMs = 500;
    await assert.rejects(client.environmentRead({ timeoutMs: 100 }), rejectsWith('t3_timeout'));
    fake.toolDelayMs = 0;
    assert.ok(await client.environmentRead());
  });

  test('reports an unreachable host and reconnects after T3 restarts', async (t) => {
    const { fake, client } = await setup(t);
    assert.ok(await client.environmentRead());
    await fake.stop();
    await assert.rejects(client.environmentRead(), rejectsWith('host_unreachable'));
    await fake.start(Number(new URL(fake.url).port));
    assert.ok(await client.environmentRead());
  });

  test('retries once when T3 has forgotten the session', async (t) => {
    const { fake, client } = await setup(t);
    assert.ok(await client.environmentRead());
    await fake.forgetSessions();
    assert.ok(await client.environmentRead());
  });
});

describe('T3 session sharing', () => {
  async function until(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(condition(), 'condition reached');
  }

  test('a timeout on one call leaves the other calls on the session running', async (t) => {
    const { fake, client } = await setup(t);
    await client.environmentRead();
    fake.toolDelays.set('t3_thread_launch', 300);
    fake.toolDelays.set('t3_environment_read', 600);
    const launch = client.launchThread(LAUNCH);
    // A health probe that times out while the launch is in flight.
    await assert.rejects(client.environmentRead({ timeoutMs: 100 }), rejectsWith('t3_timeout'));
    const launched = await launch;
    assert.equal(launched.threadId, [...fake.threads.keys()][0], 'the launch response arrives');
    fake.toolDelays.clear();
    assert.ok(await client.environmentRead(), 'the session is still usable');
  });

  test('a failure on an old connection never closes the newer one', async (t) => {
    const { fake, client, setToken } = await setup(t);
    await client.environmentRead();
    fake.toolDelays.set('t3_thread_launch', 300);
    const first = client.launchThread(LAUNCH);
    await until(() => fake.calls.includes('t3_thread_launch'));
    // A renewed credential replaces the connection while the first launch is still in flight on the old one.
    const renewed = fake.mintPairingCode();
    fake.validTokens.add(renewed);
    setToken(renewed);
    const second = client.launchThread({ ...LAUNCH, title: 'Second synthetic job [job:def456]' });
    await assert.rejects(first, (error: unknown) => error instanceof T3TransportError && error.delivery === 'unknown');
    const launched = await second;
    assert.equal(fake.threads.get(launched.threadId)?.title, 'Second synthetic job [job:def456]');
  });
});

describe('T3 thread tools', () => {
  test('launch, read incrementally, list by marker, search, send and interrupt', async (t) => {
    const { fake, client } = await setup(t);
    const launched = await client.launchThread(LAUNCH);
    assert.equal(launched.status, 'running');
    assert.deepEqual(fake.launches[0]?.workspaceStrategy, LAUNCH.workspaceStrategy);

    const first = await client.readThread({ threadId: launched.threadId, limit: 100, maxCharsPerItem: 10 });
    assert.equal(first.thread.status, 'running');
    assert.equal(first.thread.activeRunId, launched.runId);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]?.text, 'Synthetic ');
    assert.equal(first.items[0]?.textTruncated, true);
    fake.finishTurn(launched.threadId, 'All done.');
    const next = await client.readThread({ threadId: launched.threadId, afterPosition: first.nextPosition });
    assert.deepEqual(next.items.map((item) => item.text), ['All done.'], 'only items after the position');
    assert.equal(next.recentRuns[0]?.status, 'completed');

    const listed = await client.listThreads({ projectId: 'project-1', titleContains: '[job:abc123]' });
    assert.deepEqual(listed.threads.map((thread) => thread.threadId), [launched.threadId]);
    assert.equal((await client.listThreads({ projectId: 'project-1', titleContains: '[job:other]' })).threads.length, 0);
    assert.equal((await client.searchThreads({ projectId: 'project-1', query: 'abc123' })).matches[0]?.threadId, launched.threadId);

    const sent = await client.sendToThread({ threadId: launched.threadId, message: 'Next step', clientRequestId: 'r1' });
    const again = await client.sendToThread({ threadId: launched.threadId, message: 'Next step', clientRequestId: 'r1' });
    assert.equal(sent.delivery, 'started');
    assert.deepEqual(again, sent, 'T3 deduplicates by clientRequestId');
    assert.equal(fake.sends.length, 1);
    assert.equal((await client.interruptThread({ threadId: launched.threadId, clientRequestId: 'c1' })).status, 'interrupt_requested');
    assert.equal((await client.interruptThread({ threadId: launched.threadId, clientRequestId: 'c2' })).status, 'no_active_run');
  });

  test('lists, reads and answers pending questions', async (t) => {
    const { fake, client } = await setup(t);
    const { threadId } = await client.launchThread(LAUNCH);
    const requestId = fake.askQuestion(threadId, [{ id: 'q1', header: 'Choice', question: 'Which one?', options: [{ label: 'A', description: 'first' }] }]);
    assert.deepEqual(await client.listPendingRequests(threadId), [requestId]);
    assert.equal((await client.readPendingRequest(threadId, requestId)).questions[0]?.id, 'q1');
    assert.equal(typeof (await client.respondToPendingRequest(threadId, requestId, { q1: 'A' })), 'number');
    assert.deepEqual(await client.listPendingRequests(threadId), []);
    await assert.rejects(client.respondToPendingRequest(threadId, requestId, { q1: 'A' }), { t3Code: 'not_found' });
  });

  test('T3 refuses thread listing without a project, like a client outside a T3 thread', async (t) => {
    const { client } = await setup(t);
    await assert.rejects(
      client.callTool('t3_thread_list', {}, z.object({}).loose(), { readOnly: true }),
      (error: unknown) => error instanceof T3ToolError && error.t3Code === 'target_required',
    );
  });
});

describe('T3 delivery classification', () => {
  test('a host that refuses connections means the call was not delivered', async (t) => {
    const { fake, client } = await setup(t);
    await fake.stop();
    await assert.rejects(client.launchThread(LAUNCH), transportFailure('host_unreachable', 'not_delivered'));
    assert.equal(fake.threads.size, 0);
  });

  test('after a read finds the host gone, a launch is known not to be delivered', async (t) => {
    const { fake, client } = await setup(t);
    await client.environmentRead();
    await fake.stop();
    // A write on the stale keep-alive socket would fail with a reset, which is ambiguous; the dispatcher
    // therefore probes with a read-only call first, which also drops the dead connection.
    await assert.rejects(client.environmentRead(), transportFailure('host_unreachable', 'not_delivered'));
    await assert.rejects(client.launchThread(LAUNCH), transportFailure('host_unreachable', 'not_delivered'));
  });

  test('a response lost after T3 ran the call is unknown and is not retried', async (t) => {
    const { fake, client } = await setup(t);
    await client.environmentRead();
    fake.dropResponseOnce.add('t3_thread_launch');
    await assert.rejects(client.launchThread(LAUNCH), transportFailure('t3_response_lost', 'unknown'));
    assert.equal(fake.threads.size, 1, 'the launch happened exactly once');
  });

  test('a timeout after sending is unknown', async (t) => {
    const { fake, client } = await setup(t);
    await client.environmentRead();
    fake.toolDelayMs = 300;
    await assert.rejects(client.launchThread(LAUNCH, { timeoutMs: 100 }), transportFailure('t3_timeout', 'unknown'));
  });

  test('a bare 5xx is unknown; a 4xx was refused before handling', async (t) => {
    const { fake, client } = await setup(t);
    await client.environmentRead();
    fake.statusOnce.set('t3_thread_launch', 502);
    await assert.rejects(client.launchThread(LAUNCH), transportFailure('t3_response_lost', 'unknown'));
    fake.statusOnce.set('t3_thread_launch', 400);
    await assert.rejects(client.launchThread(LAUNCH), transportFailure('host_unreachable', 'not_delivered'));
  });

  test('read-only calls retry once after a lost response', async (t) => {
    const { fake, client } = await setup(t);
    const { threadId } = await client.launchThread(LAUNCH);
    fake.dropResponseOnce.add('t3_thread_read');
    assert.equal((await client.readThread({ threadId })).thread.threadId, threadId);
  });
});

