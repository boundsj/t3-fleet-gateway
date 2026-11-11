import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { startJob, startJobHarness, type JobHarnessOptions } from './helpers/jobs.ts';
import { HOUR, MINUTE } from '../src/time.ts';
import { buildSnapshot } from '../src/dashboard/snapshot.ts';
import { JobEngine } from '../src/jobs/engine.ts';

async function settledJob(t: TestContext, options: JobHarnessOptions = {}) {
  const h = await startJobHarness(t, options);
  const started = await startJob(h.agent);
  await h.tick();
  const thread = h.fake.threadForJob(started.jobId);
  h.fake.finishTurn(thread.threadId, 'Synthetic final reply');
  thread.settled = true; // Operator settlement in T3, with no gateway acknowledgement.
  await h.tick();
  const store = h.gw.services.jobs.store;
  const job = () => store.require(started.jobId);
  assert.notEqual(job().monitoringSettledAt, null);
  return { ...h, thread, job, store };
}

test('settled jobs keep their final reply and history, with summary scans instead of detailed reads', async (t) => {
  const h = await settledJob(t);
  assert.equal(h.job().latestMessageExcerpt, 'Synthetic final reply');
  const events = h.store.recentEvents(h.job().id, 100);
  const updatedAt = h.job().updatedAt;
  h.fake.calls.length = 0;
  h.fake.reads.length = 0;
  await h.tickAfter(MINUTE);
  await h.tickAfter(MINUTE);
  assert.equal(h.fake.reads.length, 0);
  assert.equal(h.fake.calls.filter((name) => name === 't3_thread_list').length, 2);
  assert.equal(h.fake.calls.includes('t3_pending_request'), false);
  assert.equal(h.job().updatedAt, updatedAt, 'freshness does not fabricate activity');
  assert.deepEqual(h.store.recentEvents(h.job().id, 100), events);
  const { config, db, clock, registry } = h.gw.services;
  const snap = buildSnapshot({ config, db, clock, registry, store: h.store, engine: h.gw.gateway.engine,
    startedAt: clock(), mcpListen: 'test', lastChecks: () => null });
  assert.equal(snap.jobs.openTotal, 0);
  assert.equal(snap.jobs.open.length, 0);
  assert.equal(snap.jobs.recent[0]?.id, h.job().id);
  assert.equal(snap.jobs.recent[0]?.settlementAcknowledged, true);
  assert.equal(snap.jobs.attention.length, 0);
  assert.equal(snap.hosts[0]?.capacity.open, 0);
  assert.equal(h.job().state, 'idle', 'execution state and continuation stay compatible');
});

for (const finishAndResettle of [false, true]) {
  test(`direct T3 reopening is observed, including a turn already re-settled: ${finishAndResettle}`, async (t) => {
    const h = await settledJob(t);
    await h.tickAfter(MINUTE);
    h.fake.userTurn(h.thread.threadId, 'Synthetic reopen');
    if (finishAndResettle) {
      h.fake.finishTurn(h.thread.threadId, 'Synthetic later reply');
      h.thread.settled = true;
    }
    await h.tickAfter(MINUTE);
    assert.equal(h.job().state, finishAndResettle ? 'idle' : 'running');
    if (finishAndResettle) {
      assert.equal(h.job().latestMessageExcerpt, 'Synthetic later reply');
      assert.notEqual(h.job().monitoringSettledAt, null);
      assert.equal(h.store.recentEvents(h.job().id, 100).filter((e) => e.type === 'turn_finished').length, 1);
    } else assert.equal(h.job().monitoringSettledAt, null);
  });
}

test('gateway continuation wakes monitoring before a held response, and old summaries cannot suspend it', async (t) => {
  const h = await settledJob(t);
  h.fake.holdResponses.add('t3_thread_list');
  const tick = h.tickAfter(MINUTE);
  await h.fake.whenHeld('t3_thread_list');
  h.fake.holdResponses.add('t3_thread_send');
  const send = h.agent.call('work_continue', { jobId: h.job().id, message: 'Synthetic follow-up', requestId: 'resume' });
  await h.fake.whenHeld('t3_thread_send');
  assert.equal(h.job().monitoringSettledAt, null);
  h.fake.releaseHeld('first');
  await tick;
  assert.equal(h.job().monitoringSettledAt, null);
  h.fake.releaseHeld('last');
  await send;
  assert.equal(h.job().state, 'running');
});

test('a detailed observation held across a send cannot put the job back to sleep', async (t) => {
  const h = await settledJob(t);
  h.store.wakeMonitoring(h.job().id);
  h.fake.holdResponses.add('t3_thread_read');
  const tick = h.tickAfter(MINUTE);
  await h.fake.whenHeld('t3_thread_read');
  await h.agent.call('work_continue', { jobId: h.job().id, message: 'Synthetic new turn', requestId: 'race' });
  h.fake.holdResponses.delete('t3_thread_read');
  h.fake.releaseHeld();
  await tick;
  assert.equal(h.job().state, 'running');
  assert.equal(h.job().monitoringSettledAt, null);
});

test('missing summaries are not settlement evidence and receive a bounded fallback read', async (t) => {
  const h = await settledJob(t);
  h.fake.threadListPages.set(0, { projectId: null, currentThreadId: null, threads: [], total: 0, nextCursor: null });
  h.fake.userTurn(h.thread.threadId, 'Synthetic hidden reopen');
  h.fake.reads.length = 0;
  await h.tickAfter(MINUTE);
  assert.equal(h.fake.reads.length, 0);
  await h.tickAfter(15 * MINUTE);
  assert.equal(h.job().state, 'running');
  assert.equal(h.job().monitoringSettledAt, null);
});

test('malformed shared scans leave open work monitored and settled work has a fallback', async (t) => {
  const h = await settledJob(t);
  h.fake.threadListPages.set(0, { malformed: true });
  const open = await startJob(h.agent);
  await h.tickAfter(MINUTE);
  h.fake.finishTurn(h.fake.threadForJob(open.jobId).threadId, 'Synthetic open reply');
  h.fake.userTurn(h.thread.threadId, 'Synthetic reopen');
  await h.tickAfter(15 * MINUTE);
  assert.equal(h.store.require(open.jobId).state, 'idle');
  assert.equal(h.store.require(open.jobId).monitoringSettledAt, null);
  assert.equal(h.job().state, 'running');
});

test('hosts without all-project listing use direct fallback without a capability warning or wrong-scope scan', async (t) => {
  const h = await settledJob(t);
  await h.gw.services.registry.client('main').close();
  h.fake.pendingRequestTools = 'combined';
  h.fake.toolsListPages.set('', { tools: [
    { name: 't3_thread_list', inputSchema: { type: 'object', properties: { projectId: { type: 'string' } } } },
    { name: 't3_pending_request', inputSchema: { type: 'object' } },
  ] });
  h.fake.userTurn(h.thread.threadId, 'Synthetic older host reopen');
  h.fake.calls.length = 0;
  await h.tickAfter(MINUTE);
  assert.equal(h.fake.calls.includes('t3_thread_list'), false, 'never silently lists the default project');
  assert.equal(h.gw.services.registry.signals('main').snapshot().some((s) => s.kind === 't3_thread_list' && s.problem), false);
  await h.tickAfter(15 * MINUTE);
  assert.equal(h.job().state, 'running');
});

test('restart retains settlement and uses summaries without re-reading every historical thread', async (t) => {
  const h = await settledJob(t);
  const { config, registry, clock, logger, catalog } = h.gw.services;
  const engine = new JobEngine({ config, registry, clock, logger, catalog, store: h.store });
  t.after(() => engine.stop());
  h.fake.reads.length = 0;
  h.gw.clock.advance(MINUTE);
  await engine.tick();
  assert.equal(h.fake.reads.length, 0);
  h.fake.userTurn(h.thread.threadId, 'Synthetic resumed after restart');
  h.gw.clock.advance(MINUTE);
  await engine.tick();
  assert.equal(h.job().state, 'running');
});

test('a settlement acknowledgement alone never disables detailed monitoring', async (t) => {
  const h = await settledJob(t);
  h.store.wakeMonitoring(h.job().id);
  h.thread.settled = false;
  h.store.appendEvent(h.job().id, 'thread_settled', 'idle', {});
  await h.tickAfter(MINUTE);
  assert.equal(h.job().monitoringSettledAt, null);
  h.fake.reads.length = 0;
  await h.tickAfter(MINUTE);
  assert.ok(h.fake.reads.length > 0);
});

test('settlement waits for both message and activity backlogs and the final streamed reply', async (t) => {
  const h = await startJobHarness(t);
  const started = await startJob(h.agent);
  await h.tick();
  const thread = h.fake.threadForJob(started.jobId);
  const store = h.gw.services.jobs.store;
  const job = () => store.require(started.jobId);
  h.fake.addActivity(thread.threadId, 'assistant_message', 501);
  h.fake.addActivity(thread.threadId, 'reasoning', 1100);
  const final = h.fake.streamAssistant(thread.threadId, 'Synthetic final streaming reply');
  h.fake.endTurn(thread.threadId);
  thread.settled = true;
  await h.tick();
  assert.equal(job().monitoringSettledAt, null, 'bounded pages have more messages and activity');
  await h.tickAfter(MINUTE);
  assert.equal(job().monitoringSettledAt, null, 'a pending final message holds the message cursor');
  final.status = 'completed';
  await h.tickAfter(MINUTE);
  assert.equal(job().latestMessageExcerpt, 'Synthetic final streaming reply');
  assert.notEqual(job().monitoringSettledAt, null);
});

test('idle delegated work stays open and keeps detailed polling despite a settled flag', async (t) => {
  const h = await startJobHarness(t);
  const started = await startJob(h.agent);
  await h.tick();
  const thread = h.fake.threadForJob(started.jobId);
  h.fake.delegate(thread.threadId, 'Synthetic child');
  h.fake.finishTurn(thread.threadId, 'Synthetic waiting reply');
  thread.settled = true;
  await h.tick();
  const job = h.gw.services.jobs.store.require(started.jobId);
  assert.equal(job.state, 'idle');
  assert.equal(job.delegatedWork.length, 1);
  assert.equal(job.monitoringSettledAt, null);
  h.fake.reads.length = 0;
  await h.tickAfter(MINUTE);
  assert.ok(h.fake.reads.some((read) => read.threadId === thread.threadId && read.view === 'activity'));
});

test('unknown settlement metadata keeps the ordinary idle watcher', async (t) => {
  const h = await settledJob(t);
  h.store.wakeMonitoring(h.job().id);
  h.fake.threadDetailOverrides.set(h.thread.threadId, { settled: undefined });
  await h.tickAfter(MINUTE);
  assert.equal(h.job().monitoringSettledAt, null);
  h.fake.reads.length = 0;
  await h.tickAfter(MINUTE);
  assert.ok(h.fake.reads.length > 0);
});

test('a lost send response keeps monitoring until the same request is resolved', async (t) => {
  const h = await settledJob(t);
  h.fake.dropResponseOnce.add('t3_thread_send');
  const input = { jobId: h.job().id, message: 'Synthetic follow-up', requestId: 'uncertain' };
  await h.agent.callError('work_continue', input);
  h.fake.finishTurn(h.thread.threadId, 'Synthetic uncertain reply');
  h.thread.settled = true;
  await h.tickAfter(MINUTE);
  assert.equal(h.job().monitoringSettledAt, null);
  assert.equal(h.store.hasPendingSend(h.job().id), true);
  await h.agent.call('work_continue', input);
  await h.tickAfter(MINUTE);
  assert.equal(h.store.hasPendingSend(h.job().id), false);
  assert.notEqual(h.job().monitoringSettledAt, null);
});

test('shared pagination is bounded per tick, continues across ticks, and never adopts unrelated threads', async (t) => {
  const h = await settledJob(t);
  for (let i = 0; i < 410; i++) h.fake.launchDirect({ projectId: 'project-1', title: `Synthetic untracked ${i}`, message: 'Synthetic' });
  h.fake.userTurn(h.thread.threadId, 'Synthetic older-page reopen');
  h.fake.calls.length = 0;
  await h.tickAfter(MINUTE);
  assert.equal(h.fake.calls.filter((name) => name === 't3_thread_list').length, 4);
  assert.notEqual(h.job().monitoringSettledAt, null, 'the tracked thread is on the next page');
  await h.tickAfter(10_000);
  assert.equal(h.fake.calls.filter((name) => name === 't3_thread_list').length, 5);
  assert.equal(h.job().state, 'running');
  assert.equal(h.store.list({ limit: 100 }).length, 1, 'listing history never adopts threads');
});

test('a stuck page cursor falls back fairly with at most four direct observations per tick', async (t) => {
  const h = await settledJob(t);
  const jobs = [h.job().id];
  for (let i = 0; i < 5; i++) {
    const started = await startJob(h.agent);
    await h.tick();
    const thread = h.fake.threadForJob(started.jobId);
    h.fake.finishTurn(thread.threadId, 'Synthetic final reply');
    thread.settled = true;
    await h.tick();
    jobs.push(started.jobId);
  }
  h.fake.threadListPages.set(0, { projectId: null, threads: [], total: 6, nextCursor: 0 });
  h.fake.reads.length = 0;
  await h.tickAfter(16 * MINUTE);
  const first = new Set(h.fake.reads.map((read) => read.threadId));
  assert.equal(first.size, 4);
  await h.tickAfter(10_000);
  assert.equal(new Set(h.fake.reads.map((read) => read.threadId)).size, 6);
  assert.ok(jobs.every((id) => h.store.require(id).monitoringSettledAt !== null));
});

test('ordinary open work is observed before a slow shared history scan', async (t) => {
  const h = await settledJob(t);
  const started = await startJob(h.agent);
  await h.tick();
  const thread = h.fake.threadForJob(started.jobId);
  h.fake.finishTurn(thread.threadId, 'Synthetic open reply');
  h.fake.holdResponses.add('t3_thread_list');
  const tick = h.tickAfter(MINUTE);
  await h.fake.whenHeld('t3_thread_list');
  assert.equal(h.store.require(started.jobId).latestMessageExcerpt, 'Synthetic open reply');
  h.fake.releaseHeld();
  await tick;
});

test('a running engine lets a held gateway send record followup before observing the new run', async (t) => {
  const h = await settledJob(t, { intervalMs: HOUR });
  const service = h.gw.services.jobs;
  const wake = service.wake;
  let wakes = 0;
  service.wake = () => { wakes++; wake(); };
  const prior = Math.max(...h.store.recentEvents(h.job().id, 100).map((event) => event.id));
  h.fake.holdResponses.add('t3_thread_send');
  const send = h.agent.call('work_continue', { jobId: h.job().id, message: 'Synthetic held followup', requestId: 'held-followup' });
  await h.fake.whenHeld('t3_thread_send');
  assert.equal(wakes, 0, 'no tick is requested until the outcome is recorded');
  h.fake.reads.length = 0;
  await h.tickAfter(MINUTE); // Also cover an ordinary timer tick while the response is pending.
  assert.equal(h.fake.reads.length, 0);
  assert.equal(h.job().state, 'idle');
  h.fake.releaseHeld();
  await send;
  await h.tick();
  assert.equal(wakes, 1);
  assert.equal(h.store.monitoringResumeInFlight(h.job().id), false);
  const events = h.store.recentEvents(h.job().id, 100).filter((event) => event.id > prior && event.toState === 'running');
  assert.deepEqual(events.map((event) => [event.type, event.detail.reason]), [['state_changed', 'followup']]);
  const turn = h.gw.services.db.prepare('SELECT client_id FROM job_turns WHERE job_id = ? AND run_id = ?')
    .get(h.job().id, h.job().lastRunId);
  assert.equal(turn?.client_id, h.agent.clientId);
});

test('overlapping sends keep the watcher deferred until every response has been recorded', async (t) => {
  const h = await settledJob(t);
  h.fake.holdResponses.add('t3_thread_send');
  const first = h.agent.call('work_continue', { jobId: h.job().id, message: 'Synthetic first', requestId: 'first' });
  await h.fake.whenHeld('t3_thread_send');
  const second = h.agent.call('work_continue', { jobId: h.job().id, message: 'Synthetic second', requestId: 'second' });
  await h.fake.whenHeld('t3_thread_send', 2);
  h.fake.releaseHeld('first');
  await first;
  assert.equal(h.store.monitoringResumeInFlight(h.job().id), true);
  h.fake.reads.length = 0;
  await h.tickAfter(MINUTE);
  assert.equal(h.fake.reads.length, 0);
  h.fake.releaseHeld();
  await second;
  assert.equal(h.store.monitoringResumeInFlight(h.job().id), false);
});

test('a held question answer records input_answered before the watcher sees its resumed run', async (t) => {
  const h = await settledJob(t);
  h.fake.userTurn(h.thread.threadId, 'Synthetic question turn');
  const requestId = h.fake.askQuestion(h.thread.threadId, [{ id: 'q', header: 'Choice', question: 'Pick?', options: [] }]);
  await h.tickAfter(MINUTE);
  assert.equal(h.job().state, 'needs_input');
  h.fake.holdResponses.add('t3_pending_request_respond');
  const answer = h.agent.call('work_respond', { jobId: h.job().id, requestId, answers: { q: 'Synthetic answer' } });
  await h.fake.whenHeld('t3_pending_request_respond');
  await h.tick();
  assert.equal(h.job().state, 'needs_input');
  h.fake.releaseHeld();
  await answer;
  const transition = h.store.recentEvents(h.job().id, 100).find((event) => event.type === 'state_changed' && event.fromState === 'needs_input');
  assert.equal(transition?.detail.reason, 'input_answered');
  assert.equal(h.store.monitoringResumeInFlight(h.job().id), false);
});

test('uncertain sends age out without removing retry evidence, and a retry restarts the grace period', async (t) => {
  const h = await settledJob(t);
  const input = { jobId: h.job().id, message: 'Synthetic uncertain followup', requestId: 'age-out' };
  h.fake.dropResponseOnce.add('t3_thread_send');
  await h.agent.callError('work_continue', input);
  h.fake.finishTurn(h.thread.threadId, 'Synthetic delivered result');
  h.thread.settled = true;
  await h.tickAfter(MINUTE);
  assert.equal(h.job().monitoringSettledAt, null);
  await h.tickAfter(10 * MINUTE);
  assert.notEqual(h.job().monitoringSettledAt, null);
  assert.notEqual(h.store.idempotencyKey(h.agent.clientId, 'work_continue', input.requestId)?.response, null);
  h.fake.dropResponseOnce.add('t3_thread_send');
  await h.agent.callError('work_continue', input);
  await h.tickAfter(MINUTE);
  assert.equal(h.store.hasPendingSend(h.job().id), true, 'latest attempt, not the original request creation time');
  assert.equal(h.job().monitoringSettledAt, null);
  await h.tickAfter(10 * MINUTE);
  assert.notEqual(h.job().monitoringSettledAt, null);
  h.fake.userTurn(h.thread.threadId, 'Synthetic later turn');
  await h.tickAfter(MINUTE);
  assert.equal(h.job().state, 'running');
});

test('a crashed unsent claim does not keep settled history open permanently', async (t) => {
  const h = await settledJob(t);
  h.store.claimIdempotencyKey(h.agent.clientId, 'work_continue', 'crashed-claim', { jobId: h.job().id, inputHash: 'synthetic' });
  h.store.wakeMonitoring(h.job().id);
  await h.tickAfter(MINUTE);
  assert.equal(h.job().monitoringSettledAt, null);
  await h.tickAfter(10 * MINUTE);
  assert.notEqual(h.job().monitoringSettledAt, null);
  assert.equal(h.store.idempotencyKey(h.agent.clientId, 'work_continue', 'crashed-claim')?.response, null);
});

test('an unsuccessful fallback preserves history instead of inventing reopened work', async (t) => {
  const h = await settledJob(t);
  h.thread.sideChat = true; // Omitted from list; direct reads still address the recorded thread.
  await h.fake.stop();
  await h.tickAfter(16 * MINUTE);
  assert.notEqual(h.job().monitoringSettledAt, null);
  assert.equal(h.store.list({ states: ['idle'], monitoring: 'open', limit: 100 }).length, 0);
  assert.equal(h.store.list({ monitoring: 'history', limit: 100 }).length, 1);
  await h.fake.start();
  h.fake.userTurn(h.thread.threadId, 'Synthetic recovered host turn');
  await h.tickAfter(16 * MINUTE);
  assert.equal(h.job().state, 'running');
});

test('an invalid summary row does not hide a valid changed thread or raise a host alarm', async (t) => {
  const h = await settledJob(t);
  h.fake.userTurn(h.thread.threadId, 'Synthetic reopened turn');
  h.fake.threadListPages.set(0, { projectId: null, total: 2, nextCursor: null, threads: [
    { threadId: 'unreadable-summary' },
    { threadId: h.thread.threadId, latestRunId: h.thread.runs.at(-1)!.runId, settled: false, status: 'running', updatedAt: h.thread.updatedAt },
  ] });
  await h.tickAfter(MINUTE);
  assert.equal(h.job().state, 'running');
  assert.equal(h.gw.services.registry.signals('main').snapshot().some((s) => s.kind === 't3_thread_list' && s.problem), false);
});
