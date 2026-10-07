import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as z from 'zod';
import { T3Client } from '../src/t3/client.ts';
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
