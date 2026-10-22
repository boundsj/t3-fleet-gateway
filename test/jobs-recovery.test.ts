import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startJob, startJobHarness } from './helpers/jobs.ts';
import { buildSnapshot } from '../src/dashboard/snapshot.ts';
import { MINUTE } from '../src/time.ts';

for (const finishBeforePoll of [false, true]) {
  test(`a failed turn recovers from T3 activity (finished before poll: ${finishBeforePoll})`, async (t) => {
    const h = await startJobHarness(t);
    const job = await startJob(h.agent);
    await h.tick();
    const thread = h.fake.threadForJob(job.jobId);
    const snapshot = () => {
      const { config, db, clock, registry, jobs } = h.gw.services;
      return buildSnapshot({ config, db, clock, registry, store: jobs.store, engine: h.gw.gateway.engine,
        startedAt: clock(), mcpListen: 'test', lastChecks: () => null });
    };
    h.fake.failRun(thread.threadId);
    await h.tick();
    let status = await h.agent.call('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'idle');
    assert.equal((status.lastError as { code: string }).code, 't3_run_failed');
    assert.ok(snapshot().attention.some((a) => a.ref === job.jobId && /turn failed/.test(a.title)));
    await h.agent.call('work_settle', { jobId: job.jobId, requestId: 'settle-failure' });
    await h.tickAfter(2 * MINUTE);
    assert.equal(h.gw.services.jobs.store.settlementAcknowledged(job.jobId), true);
    h.fake.userTurn(thread.threadId, 'Synthetic recovery');
    if (finishBeforePoll) h.fake.finishTurn(thread.threadId, 'Synthetic recovered answer');
    await h.tickAfter(2 * MINUTE);
    status = await h.agent.call('work_status', { jobId: job.jobId });
    assert.equal(status.state, finishBeforePoll ? 'idle' : 'running');
    assert.equal(status.lastError, null);
    assert.equal(snapshot().attention.some((a) => a.ref === job.jobId), false);
    const listed = await h.agent.call<{ jobs: { jobId: string; state: string }[] }>('work_list', {});
    assert.equal(listed.jobs.find((j) => j.jobId === job.jobId)?.state, status.state);
    assert.equal(status.settled, false);
    assert.equal(h.gw.services.jobs.store.settlementAcknowledged(job.jobId), false);
    const count = () => h.gw.services.jobs.store.recentEvents(job.jobId, 100).filter((e) => e.type === 'job_recovered').length;
    assert.equal(count(), 1);
    await h.tickAfter(2 * MINUTE);
    assert.equal(count(), 1);
    const feed = await h.agent.call<{ events: { type: string }[] }>('work_feed', { cursor: '0' });
    assert.equal(feed.events.filter((e) => e.type === 'job_recovered').length, 1);
  });
}

test('work_continue resumes a failed worker turn with idle semantics', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  h.fake.failRun(h.fake.threadForJob(job.jobId).threadId);
  await h.tick();
  const result = await h.agent.call<{ job: { state: string } }>('work_continue', {
    jobId: job.jobId, requestId: 'retry-turn', message: 'Synthetic retry',
  });
  assert.equal(result.job.state, 'running');
  assert.equal(h.gw.services.jobs.store.require(job.jobId).lastErrorCode, null);
  assert.equal(h.gw.services.jobs.store.recentEvents(job.jobId, 100).filter((e) => e.type === 'job_recovered').length, 1);
});

for (const kind of ['cancelled', 'deleted'] as const) {
  test(`${kind} jobs remain terminal after T3 resumes`, async (t) => {
    const h = await startJobHarness(t);
    const job = await startJob(h.agent);
    await h.tick();
    const thread = h.fake.threadForJob(job.jobId);
    if (kind === 'cancelled') {
      await h.agent.call('work_cancel', { jobId: job.jobId });
      await h.tick();
    } else {
      h.fake.threads.delete(thread.threadId);
      await h.tick();
      h.fake.threads.set(thread.threadId, thread);
    }
    const before = h.gw.services.jobs.store.require(job.jobId);
    assert.equal(before.state, kind === 'cancelled' ? 'cancelled' : 'failed');
    h.fake.userTurn(thread.threadId, 'Synthetic external resume');
    await h.tickAfter(2 * MINUTE);
    assert.equal(h.gw.services.jobs.store.require(job.jobId).state, before.state);
    assert.equal((await h.agent.callError('work_continue', {
      jobId: job.jobId, requestId: 'terminal', message: 'Synthetic retry',
    })).code, 'job_state_conflict');
  });
}

test('a failed replacement turn stays idle without a false recovery; a later question recovers', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const thread = h.fake.threadForJob(job.jobId);
  h.fake.failRun(thread.threadId);
  await h.tick();
  h.fake.userTurn(thread.threadId, 'Synthetic unsuccessful retry');
  h.fake.failRun(thread.threadId);
  await h.tickAfter(2 * MINUTE);
  const events = () => h.gw.services.jobs.store.recentEvents(job.jobId, 100);
  assert.equal(events().some((e) => e.type === 'job_recovered'), false);
  assert.equal(h.gw.services.jobs.store.require(job.jobId).lastErrorCode, 't3_run_failed');
  h.fake.userTurn(thread.threadId, 'Synthetic successful retry');
  h.fake.askQuestion(thread.threadId, [{ id: 'q1', header: 'Synthetic', question: 'Synthetic choice?', options: [] }]);
  await h.tickAfter(2 * MINUTE);
  assert.equal(h.gw.services.jobs.store.require(job.jobId).state, 'needs_input');
  assert.equal(h.gw.services.jobs.store.require(job.jobId).lastErrorCode, null);
  assert.equal(events().filter((e) => e.type === 'job_recovered').length, 1);
});
