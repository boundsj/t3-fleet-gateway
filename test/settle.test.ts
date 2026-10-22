import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectAgent, startJob, startJobHarness } from './helpers/jobs.ts';

const ORGANIZE = 't3_thread_organize';

test('work_settle confirms T3 state, emits once, replays after continue without settling again', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
  h.fake.finishTurn(threadId, 'Synthetic completion');
  await h.tick();
  const input = { jobId: job.jobId, requestId: 'settle-1' };
  const result = await h.agent.call<{ job: { state: string }; settled: boolean; settledAt: string; replayed: boolean }>('work_settle', input);
  assert.equal(result.job.state, 'idle');
  assert.equal(result.settled, true);
  assert.ok(result.settledAt);
  assert.equal(result.replayed, false);
  const status = await h.agent.call('work_status', { jobId: job.jobId });
  assert.equal(status.settled, true);
  assert.equal(status.settledAt, result.settledAt);
  assert.equal(h.fake.calls.filter((name) => name === ORGANIZE).length, 1);
  const feed = await h.agent.call<{ events: { type: string }[] }>('work_feed', { cursor: '0' });
  assert.equal(feed.events.filter((event) => event.type === 'thread_settled').length, 1);
  await h.agent.call('work_continue', { jobId: job.jobId, requestId: 'continue-1', message: 'Synthetic follow-up' });
  assert.equal((await h.agent.call('work_status', { jobId: job.jobId })).settled, false);
  const replay = await h.agent.call('work_settle', input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.settled, true); // Original confirmation, not the current state.
  assert.equal(h.fake.threads.get(threadId)!.settled, false);
  assert.equal(h.fake.calls.filter((name) => name === ORGANIZE).length, 1);
  assert.equal(h.gw.services.jobs.store.recentEvents(job.jobId, 100).filter((event) => event.type === 'thread_settled').length, 1);
  const other = await startJob(h.agent);
  assert.equal((await h.agent.callError('work_settle', { ...input, jobId: other.jobId })).code, 'request_id_conflict');
});

test('work_settle refuses queued/running jobs and fresh T3 activity unseen by the watcher', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  const input = { jobId: job.jobId, requestId: 'busy' };
  assert.equal((await h.agent.callError('work_settle', input)).code, 'job_state_conflict');
  await h.tick();
  assert.equal((await h.agent.callError('work_settle', input)).code, 'job_state_conflict');
  const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
  h.fake.finishTurn(threadId, 'Synthetic completion');
  await h.tick();
  h.fake.userTurn(threadId, 'Synthetic new turn');
  assert.equal((await h.agent.callError('work_settle', input)).code, 'job_state_conflict');
  assert.equal(h.fake.calls.includes(ORGANIZE), false);
});

test('work_settle reads delegated work from fresh activity, including released jobs', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
  h.fake.finishTurn(threadId, 'Synthetic completion');
  await h.tick();
  h.fake.delegate(threadId, 'Synthetic child');
  const error = await h.agent.callError('work_settle', { jobId: job.jobId, requestId: 'delegated' });
  assert.equal(error.code, 'job_state_conflict');
  assert.match(error.text, /delegated work/);
  h.gw.services.jobs.store.transition(job.jobId, { from: ['idle'], to: 'released', detail: { reason: 'synthetic' } });
  assert.equal((await h.agent.callError('work_settle', { jobId: job.jobId, requestId: 'released-delegated' })).code, 'job_state_conflict');
  assert.equal(h.fake.calls.includes(ORGANIZE), false);
});

for (const state of ['cancelled', 'failed', 'released'] as const) {
  test(`work_settle accepts ${state} jobs with quiet threads`, async (t) => {
    const h = await startJobHarness(t);
    const job = await startJob(h.agent);
    await h.tick();
    const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
    h.fake.finishTurn(threadId, 'Synthetic completion');
    h.gw.services.jobs.store.transition(job.jobId, { from: ['running'], to: state, detail: { reason: 'synthetic' } });
    const result = await h.agent.call('work_settle', { jobId: job.jobId, requestId: 'terminal' });
    assert.equal(result.settled, true);
    assert.equal(h.gw.services.jobs.store.require(job.jobId).state, state);
    assert.equal((await h.agent.callError('work_continue', {
      jobId: job.jobId, requestId: 'terminal-continue', message: 'Synthetic follow-up',
    })).code, 'job_state_conflict');
  });
}

test('work_settle maps T3 final busy refusal and credential permissions to typed errors', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
  h.fake.finishTurn(threadId, 'Synthetic completion');
  await h.tick();
  const input = { jobId: job.jobId, requestId: 'retry-refusal' };
  for (const message of ['Thread is still running.', 'Thread has a queued message.', 'Thread is waiting on an approval or question.']) {
    h.fake.failures.set(ORGANIZE, { code: 'orchestration_error', message });
    assert.equal((await h.agent.callError('work_settle', input)).code, 'job_state_conflict');
  }
  for (const code of ['capability_denied', 'runtime_mode_escalation_denied', 'interaction_mode_escalation_denied']) {
    h.fake.failures.set(ORGANIZE, { code, message: 'Synthetic private failure detail' });
    const error = await h.agent.callError('work_settle', input);
    assert.equal(error.code, 't3_unauthorized');
    assert.match(error.text, /existing host credential/);
    assert.equal(error.text.includes('Synthetic private failure detail'), false);
  }
  h.fake.failures.delete(ORGANIZE);
  assert.equal((await h.agent.call('work_settle', input)).settled, true);
});

test('work_settle authorizes before replay or T3 reads', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
  h.fake.finishTurn(threadId, 'Synthetic completion');
  await h.tick();
  const input = { jobId: job.jobId, requestId: 'auth' };
  await h.agent.call('work_settle', input);
  const reader = await connectAgent(t, h.gw, 'read');
  assert.equal((await reader.callError('work_settle', input)).code, 'insufficient_scope');
  const calls = h.fake.calls.length;
  await assert.rejects(h.gw.services.jobs.settle({ clientId: h.agent.clientId, scopes: ['host:other:operate'] }, input), { code: 'not_found' });
  await assert.rejects(h.gw.services.jobs.settle({ clientId: h.agent.clientId, scopes: ['host:main:read'] }, input), { code: 'insufficient_scope' });
  assert.equal(h.fake.calls.length, calls);
});

test('lost settle response is reconciled without a second organize call', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
  h.fake.finishTurn(threadId, 'Synthetic completion');
  await h.tick();
  h.fake.dropResponseOnce.add(ORGANIZE);
  const input = { jobId: job.jobId, requestId: 'lost' };
  assert.equal((await h.agent.call('work_settle', input)).settled, true);
  assert.equal((await h.agent.call('work_settle', input)).replayed, true);
  assert.equal(h.fake.calls.filter((name) => name === ORGANIZE).length, 1);
});

test('an unknown outcome never sends settle again after the thread resumes', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
  h.fake.finishTurn(threadId, 'Synthetic completion');
  await h.tick();
  h.fake.failures.set(ORGANIZE, { code: 'orchestration_error', message: 'The operation could not be completed.' });
  const input = { jobId: job.jobId, requestId: 'unknown' };
  assert.equal((await h.agent.callError('work_settle', input)).code, 't3_response_lost');
  h.fake.failures.delete(ORGANIZE);
  h.fake.userTurn(threadId, 'Synthetic intervening turn');
  h.fake.finishTurn(threadId, 'Synthetic intervening completion');
  assert.equal((await h.agent.callError('work_settle', input)).code, 't3_response_lost');
  assert.equal(h.fake.calls.filter((name) => name === ORGANIZE).length, 1);
});

test('work_status keeps settlement unknown when live state is unavailable', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  assert.equal((await h.agent.call('work_status', { jobId: job.jobId })).settled, null);
  await h.tick();
  const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
  h.fake.readFailures.set(threadId, { code: 'orchestration_error', message: 'Synthetic failure' });
  const status = await h.agent.call('work_status', { jobId: job.jobId });
  assert.equal(status.settled, null);
  assert.equal(status.settledAt, null);
});

test('settlement refuses an incomplete delegated scan', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
  h.fake.finishTurn(threadId, 'Synthetic completion');
  await h.tick();
  h.fake.addActivity(threadId, 'reasoning', 2001);
  h.fake.delegate(threadId, 'Synthetic child beyond scan');
  assert.equal((await h.agent.callError('work_settle', { jobId: job.jobId, requestId: 'bounded' })).code, 'job_state_conflict');
  assert.equal(h.fake.calls.includes(ORGANIZE), false);
});


test('concurrent settlement requests organize once and record one confirmation', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
  h.fake.finishTurn(threadId, 'Synthetic completion');
  await h.tick();
  const caller = { clientId: h.agent.clientId, scopes: ['host:main:operate'] as const };
  const input = { jobId: job.jobId, requestId: 'concurrent' };
  const results = await Promise.allSettled([h.gw.services.jobs.settle(caller, input), h.gw.services.jobs.settle(caller, input)]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  for (const result of results) {
    if (result.status === 'rejected') assert.equal(result.reason.code, 't3_response_lost');
  }
  assert.equal(h.fake.calls.filter((name) => name === ORGANIZE).length, 1);
  assert.equal(h.gw.services.jobs.store.recentEvents(job.jobId, 100).filter((event) => event.type === 'thread_settled').length, 1);
});


test('a tool error after side effects is reconciled rather than re-sent', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const threadId = h.gw.services.jobs.store.require(job.jobId).threadId!;
  h.fake.finishTurn(threadId, 'Synthetic completion');
  await h.tick();
  h.fake.failuresAfterEffect.set(ORGANIZE, { code: 'orchestration_error', message: 'The operation could not be completed.' });
  const input = { jobId: job.jobId, requestId: 'after-effect' };
  assert.equal((await h.agent.call('work_settle', input)).settled, true);
  assert.equal((await h.agent.call('work_settle', input)).replayed, true);
  assert.equal(h.fake.calls.filter((name) => name === ORGANIZE).length, 1);
});
