import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { HOUR } from '../src/time.ts';
import { TestAgentProvider } from './helpers/agent.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway } from './helpers/gateway.ts';
import { assertNotLogged, startJobHarness } from './helpers/jobs.ts';
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

test('no task text, message, question, answer or worker output ever appears in the logs', async (t) => {
  const { fake, gw, agent, tick } = await startJobHarness(t);
  const content = {
    task: 'Synthetic-task-text-7d1f: refactor the parser',
    title: 'Synthetic-title-0b2e',
    followUp: 'Synthetic-follow-up-91ac: now add tests',
    question: 'Synthetic-question-55e0: which parser?',
    answer: 'Synthetic-answer-c3d9',
    excerpt: 'Synthetic-worker-output-a6f2: parser refactored',
  };
  const { job } = await agent.call<{ job: { jobId: string } }>('work_start', { project: 'pilot', task: content.task, title: content.title, requestId: 'log-1' });
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  const requestId = fake.askQuestion(threadId, [{ id: 'q', header: 'Which', question: content.question, options: [] }]);
  await tick();
  await agent.call('work_status', { jobId: job.jobId });
  await agent.call('work_respond', { jobId: job.jobId, requestId, answers: { q: content.answer } });
  fake.finishTurn(threadId, content.excerpt);
  await tick();
  await agent.call('work_continue', { jobId: job.jobId, message: content.followUp, requestId: 'log-2' });
  fake.failures.set('t3_thread_launch', { code: 'invalid_input', message: `Rejected: ${content.task}` });
  await agent.call('work_start', { project: 'pilot', task: `${content.task} again`, requestId: 'log-3' });
  await tick();
  await agent.call('work_feed', {});
  await agent.call('work_cancel', { jobId: job.jobId });

  assert.ok(gw.logs.some((line) => line.includes('"event":"job.state_changed"')));
  assertNotLogged(gw, [...Object.values(content), 'Synthetic-task-text', 'Synthetic-worker-output']);
});
