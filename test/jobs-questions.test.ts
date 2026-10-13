import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_QUESTION_CHARS, MAX_QUESTION_OPTIONS, MAX_QUESTIONS } from '../src/jobs/service.ts';
import type { JobDetailView } from '../src/mcp/workTools.ts';
import { assertNotLogged, startJob, startJobHarness } from './helpers/jobs.ts';

const textOf = (result: { content?: unknown }) => (result.content as { type: string; text: string }[])
  .filter((item) => item.type === 'text').map((item) => item.text).join('\n');

for (const targeted of [false, true]) {
  test(`a text-only client can answer a real-shaped Codex request ID${targeted ? ' after a targeted read' : ''}`, async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    const thread = fake.threadForJob(job.jobId);
    // Synthetic UUIDs, retaining the opaque ID shape observed during supervised live QA.
    const opaqueId = 'runtime-request:provider:codex:provider-turn:provider-turn%3Aprovider%3Acodex%3Anative-turn%3A' +
      '00000000-0000-4000-8000-000000000000:native-request:async%3Acall_00000000000000000000000000000000:' +
      '00000000-0000-4000-8000-000000000001';
    assert.ok(opaqueId.length > 200);
    const question = { id: '0', header: 'QA', question: 'Synthetic marker choice?', options: [{ label: 'Blue', description: 'Synthetic blue' }] };
    const shortId = fake.askQuestion(thread.threadId, [question]);
    thread.questions.set(opaqueId, thread.questions.get(shortId)!);
    thread.questions.delete(shortId);
    await tick();
    const first = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId } });
    const requestId = JSON.parse(textOf(first).match(/^Pending request: (.+)$/m)![1]!);
    assert.equal(requestId, opaqueId, 'text returns the complete upstream ID');
    if (targeted) {
      const selected = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId, pendingRequestId: requestId } });
      assert.notEqual(selected.isError, true, textOf(selected));
      assert.equal(JSON.parse(textOf(selected).match(/^Question: (.+)$/m)![1]!).question, question.question);
    }
    const answered = await agent.client.callTool({ name: 'work_respond', arguments: { jobId: job.jobId, requestId, answers: { '0': 'Blue' } } });
    assert.notEqual(answered.isError, true, textOf(answered));
    assert.deepEqual(fake.responses, [{ threadId: thread.threadId, requestId: opaqueId, answers: { '0': 'Blue' } }]);
    assert.equal((await agent.callError('work_respond', { jobId: job.jobId, requestId: `${opaqueId}-foreign`, answers: {} })).code,
      'not_found', 'a long ID still has to belong to this job');
    assertNotLogged(gw, [opaqueId, question.question, 'Synthetic blue']);
  });
}

test('a large foreign request ID returns a bounded public error without delivering or logging the answer', async (t) => {
  const { fake, gw, agent, tick } = await startJobHarness(t);
  const job = await startJob(agent);
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  const question = 'Synthetic-pending-question-93a1';
  const pendingId = fake.askQuestion(threadId, [{ id: 'q', header: 'QA', question, options: [] }]);
  await tick();
  const requestMarker = 'Synthetic-foreign-request-71bd';
  const foreignId = `${requestMarker}:${'x'.repeat(900_000)}`;
  const answer = 'Synthetic-rejected-answer-8b64';
  const result = await agent.client.callTool({
    name: 'work_respond', arguments: { jobId: job.jobId, requestId: foreignId, answers: { q: answer } },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^not_found:/);
  assert.deepEqual(fake.responses, [], 'a rejected ID must never deliver an answer to T3');
  assertNotLogged(gw, [requestMarker, answer, question]);
  assert.ok(JSON.stringify(result).length < 4000, 'a foreign ID near the MCP body limit must produce a bounded error');
  assert.equal(textOf(result).includes(requestMarker), false, 'the error must not echo caller-owned request content');
  assert.ok(textOf(result).includes(pendingId), 'the current T3-listed pending hint remains actionable');
  const status = await agent.call<JobDetailView>('work_status', { jobId: job.jobId });
  assert.equal(status.state, 'needs_input');
  assert.deepEqual(status.pendingRequests.map((request) => request.requestId), [pendingId]);
});

test('question flags preserve true, false, null and absence without inventing defaults', async (t) => {
  const { fake, agent, tick } = await startJobHarness(t);
  const job = await startJob(agent);
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  fake.askQuestion(threadId, [
    { id: 'yes', header: 'Required', question: 'Synthetic multiple?', options: [], multiSelect: true, allowCustomAnswer: true, required: true },
    { id: 'no', header: 'Optional', question: 'Synthetic one?', options: [{ label: 'A', description: 'A description' }],
      multiSelect: false, allowCustomAnswer: false, required: false },
    { id: 'null', header: 'Null', question: 'Synthetic unspecified?', options: [], multiSelect: null, allowCustomAnswer: null, required: null },
    { id: 'absent', header: 'Absent', question: 'Synthetic unspecified?', options: [] },
  ]);
  await tick();
  const result = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId } });
  const view = result.structuredContent as JobDetailView;
  assert.deepEqual(view.pendingRequests[0]?.questions?.map((q) => [q.multiSelect, q.allowCustomAnswer, q.required]),
    [[true, true, true], [false, false, false], [null, null, null], [null, null, null]]);
  assert.equal(view.pendingRequests[0]?.questions?.[1]?.options[0]?.value, null);
  const text = textOf(result);
  for (const rule of [/array of option values/, /single option value/, /Custom answers allowed/, /Custom answers forbidden/,
    /Answer required/, /Answer optional/, /Selection rule unspecified/, /Required: unspecified/]) assert.match(text, rule);
});

test('five-request read limit is explicit and a text client can select and answer the sixth request', async (t) => {
  const { fake, agent, tick } = await startJobHarness(t);
  const job = await startJob(agent);
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  const ids = Array.from({ length: 6 }, (_, i) => fake.askQuestion(threadId, [
    { id: `q${i}`, header: 'Check', question: `Synthetic question ${i}`, options: [{ label: 'Yes', description: 'Do it', value: 'yes' }],
      multiSelect: false, allowCustomAnswer: false, required: true },
  ]));
  await tick();
  const first = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId } });
  const firstView = first.structuredContent as JobDetailView;
  assert.equal(firstView.pendingRequests[5]?.questions, null);
  assert.equal(firstView.pendingRequests[5]?.questionsUnavailable, 'read_limit');
  assert.match(textOf(first), /read limit.*pendingRequestId/);
  const requestId = JSON.parse(textOf(first).match(/^Pending request: (.+)$/gm)!.at(-1)!.replace('Pending request: ', ''));
  const selected = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId, pendingRequestId: requestId } });
  const question = JSON.parse(textOf(selected).match(/^Question: (.+)$/m)![1]!);
  assert.equal(question.question, 'Synthetic question 5');
  await agent.call('work_respond', { jobId: job.jobId, requestId, answers: { [question.id]: question.options[0].value } });
  assert.equal(fake.responses[0]?.requestId, ids[5]);
  assert.equal((await agent.callError('work_status', { jobId: job.jobId, pendingRequestId: 'foreign-request' })).code, 'not_found');
});

test('null and failed question reads remain explicitly temporarily unreadable', async (t) => {
  const { fake, agent, tick } = await startJobHarness(t);
  const job = await startJob(agent);
  await tick();
  const thread = fake.threadForJob(job.jobId);
  const id = fake.askQuestion(thread.threadId, []);
  thread.questions.set(id, null);
  await tick();
  for (const fails of [false, true]) {
    if (fails) fake.failures.set('t3_pending_request_read', { code: 'unavailable', message: 'Synthetic unavailable' });
    const result = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId } });
    assert.notEqual(result.isError, true);
    assert.deepEqual((result.structuredContent as JobDetailView).pendingRequests,
      [{ requestId: id, questions: null, questionsUnavailable: 'temporarily_unreadable' }]);
    assert.match(textOf(result), /temporarily unreadable.*Retry work_status/);
  }
});

test('oversize question sets are refused whole, with explicit limits and an operator path', async (t) => {
  const { fake, agent, tick } = await startJobHarness(t);
  const job = await startJob(agent);
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  const question = { id: 'q', header: 'Synthetic header', question: 'Synthetic important required question', options: [], required: true };
  const ids = [
    fake.askQuestion(threadId, Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({ ...question, id: `q${i}` }))),
    fake.askQuestion(threadId, [{ ...question, options: Array.from({ length: MAX_QUESTION_OPTIONS + 1 }, () => ({ label: 'x', description: 'y' })) }]),
    fake.askQuestion(threadId, [{ ...question, question: 'x'.repeat(MAX_QUESTION_CHARS + 1) }]),
  ];
  await tick();
  const result = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId } });
  assert.notEqual(result.isError, true);
  assert.deepEqual((result.structuredContent as JobDetailView).pendingRequests,
    ids.map((requestId) => ({ requestId, questions: null, questionsUnavailable: 'too_large' })));
  assert.match(textOf(result), /No partial questions returned.*operator.*T3/);
  assert.doesNotMatch(textOf(result), /Synthetic important required question/);
  assert.ok(textOf(result).length < 4000, 'bounded result without actionable fragments');
});

test('an accepted large request keeps every required question and option without clipping text', async (t) => {
  const { fake, agent, tick } = await startJobHarness(t);
  const job = await startJob(agent);
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  const questions = Array.from({ length: 50 }, (_, i) => ({
    id: `q${i}`, header: `Synthetic header ${i}`, question: `Synthetic required question ${i}?`, required: true,
    allowCustomAnswer: false, multiSelect: false,
    options: [{ label: `Option "${i}"`, description: `Synthetic description ${i}\nsecond line`, value: `value-${i}` }],
  }));
  fake.askQuestion(threadId, questions);
  await tick();
  const result = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId } });
  assert.notEqual(result.isError, true);
  const fromText = [...textOf(result).matchAll(/^Question: (.+)$/gm)].map((match) => JSON.parse(match[1]!));
  assert.deepEqual(fromText, questions, 'even the last required question and multiline options are complete in text');
  assert.deepEqual((result.structuredContent as JobDetailView).pendingRequests[0]?.questions, questions);
});
