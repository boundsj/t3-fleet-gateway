import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MINUTE } from '../src/time.ts';
import { FAKE_ENVIRONMENT_ID } from './helpers/fakeT3.ts';
import { connectAgent, jobState, startJob, startJobHarness, type Agent } from './helpers/jobs.ts';

interface JobView {
  jobId: string;
  state: string;
}

interface Status extends JobView {
  link: string | null;
  pendingRequests: { requestId: string; questions: { id: string; question: string; options: { label: string }[] }[] | null }[];
  waitingForApproval: boolean;
  latestMessageExcerpt: string | null;
  recentEvents: { type: string; fromState: string | null; toState: string | null; reason: string | null }[];
}

interface FeedPage {
  events: { cursor: string; jobId: string; type: string; toState: string | null; project: string }[];
  nextCursor: string;
  hasMore: boolean;
  attention: (JobView & { why: string; startedByYou: boolean; link: string | null })[];
}

const status = (agent: Agent, jobId: string) => agent.call<Status>('work_status', { jobId });

describe('work_respond', () => {
  test('answers a pending question on the job, which then runs again', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    const other = await startJob(agent);
    await tick();
    const threadId = fake.threadForJob(job.jobId).threadId;
    const requestId = fake.askQuestion(threadId, [
      { id: 'q1', header: 'Scope', question: 'Synthetic: include tests?', options: [{ label: 'Yes', description: 'add tests', value: 'yes' }] },
    ]);
    const otherRequest = fake.askQuestion(fake.threadForJob(other.jobId).threadId, [{ id: 'q', header: 'h', question: 'Synthetic other?', options: [] }]);
    await tick();
    const blocked = await status(agent, job.jobId);
    assert.equal(blocked.state, 'needs_input');
    assert.equal(blocked.pendingRequests[0]?.requestId, requestId);
    assert.equal(blocked.pendingRequests[0]?.questions?.[0]?.question, 'Synthetic: include tests?', 'questions are read live from T3');

    const foreign = await agent.callError('work_respond', { jobId: job.jobId, requestId: otherRequest, answers: { q: 'x' } });
    assert.equal(foreign.code, 'not_found', "another job's request is refused");
    assert.match(foreign.text, new RegExp(`Pending on this job: ${requestId}`));

    const answered = await agent.call<{ job: JobView }>('work_respond', { jobId: job.jobId, requestId, answers: { q1: 'yes' } });
    assert.equal(answered.job.state, 'running');
    assert.deepEqual(fake.responses, [{ threadId, requestId, answers: { q1: 'yes' } }]);
    await tick();
    const after = await status(agent, job.jobId);
    assert.equal(after.state, 'running');
    assert.deepEqual(
      after.recentEvents.slice(-2).map((event) => [event.type, event.toState, event.reason]),
      [
        ['input_answered', 'needs_input', null],
        ['state_changed', 'running', 'input_answered'],
      ],
    );
    const again = await agent.callError('work_respond', { jobId: job.jobId, requestId, answers: { q1: 'yes' } });
    assert.equal(again.code, 'not_found');
  });

  test('explains that approvals can only be given in T3', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    fake.requestApproval(fake.threadForJob(job.jobId).threadId);
    await tick();
    assert.equal((await status(agent, job.jobId)).waitingForApproval, true);
    const refused = await agent.callError('work_respond', { jobId: job.jobId, requestId: 'anything', answers: {} });
    assert.equal(refused.code, 'not_found');
    assert.match(refused.text, /only the operator can give in T3/);
  });
});

describe('work_continue', () => {
  test('continues an idle job: it runs again and its next turn ends idle with a new excerpt', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const TASK = 'Synthetic task: add a README section';
    const job = await startJob(agent, TASK, { requestId: 'start-1' });
    await tick();
    const { threadId } = fake.threadForJob(job.jobId);
    fake.finishTurn(threadId, 'Synthetic first result');
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'idle');

    const input = { jobId: job.jobId, message: 'Synthetic follow-up: also update the docs', requestId: 'follow-1' };
    const sent = await agent.call<{ job: JobView; delivery: string; replayed: boolean }>('work_continue', input);
    assert.deepEqual([sent.job.state, sent.delivery, sent.replayed], ['running', 'started', false]);
    assert.equal(fake.sends.length, 1);
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'running', 'the new run is followed, not the finished one');

    const replay = await agent.call<{ replayed: boolean; delivery: string }>('work_continue', input);
    assert.deepEqual([replay.replayed, replay.delivery], [true, 'started']);
    assert.equal(fake.sends.length, 1, 'a repeated requestId sends nothing');
    const conflict = await agent.callError('work_continue', { ...input, message: 'Something else' });
    assert.equal(conflict.code, 'request_id_conflict');

    // Request ids are scoped per tool: the work_start id of this job is free for work_continue.
    const reused = await agent.call<{ delivery: string; replayed: boolean }>('work_continue', { ...input, requestId: 'start-1', message: 'Synthetic steer' });
    assert.deepEqual([reused.delivery, reused.replayed], ['steered', false]);
    assert.equal(fake.sends.length, 2);
    const restarted = await agent.call<{ job: JobView; created: boolean }>('work_start', { project: 'pilot', task: TASK, requestId: 'start-1' });
    assert.deepEqual([restarted.created, restarted.job.jobId], [false, job.jobId], 'the work_start key is unaffected');

    const steer = await agent.call<{ delivery: string; job: JobView }>('work_continue', { ...input, requestId: 'follow-2', message: 'Synthetic steer' });
    assert.deepEqual([steer.delivery, steer.job.state], ['steered', 'running']);
    assert.equal((await status(agent, job.jobId)).recentEvents.at(-1)?.type, 'followup_sent');

    fake.finishTurn(threadId, 'Synthetic second result');
    await tick();
    const done = await status(agent, job.jobId);
    assert.equal(done.state, 'idle');
    assert.equal(done.latestMessageExcerpt, 'Synthetic second result');
  });

  test('a follow-up sent while the watcher is reading is not overwritten by that stale read', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    const { threadId } = fake.threadForJob(job.jobId);
    fake.finishTurn(threadId, 'Synthetic first');
    await tick();
    gw.clock.advance(2 * MINUTE);
    fake.toolDelayMs = 150;
    const ticking = tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await agent.call('work_continue', { jobId: job.jobId, message: 'Synthetic during a read', requestId: 'race-1' });
    await ticking;
    fake.toolDelayMs = 0;
    const stored = gw.services.jobs.store.require(job.jobId);
    assert.equal(stored.state, 'running');
    assert.equal(stored.lastRunId, fake.threads.get(threadId)?.runs.at(-1)?.runId, 'the new run is still the one followed');
  });

  test('refuses jobs without a thread or that are finished', async (t) => {
    const { agent } = await startJobHarness(t);
    const job = await startJob(agent);
    const refused = await agent.callError('work_continue', { jobId: job.jobId, message: 'x', requestId: 'c1' });
    assert.equal(refused.code, 'job_state_conflict');
    const missing = await agent.callError('work_continue', { jobId: 'nosuchjob00', message: 'x', requestId: 'c2' });
    assert.equal(missing.code, 'not_found');
  });

  test('an uncertain send can be retried with the same requestId; T3 deduplicates it', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    fake.finishTurn(fake.threadForJob(job.jobId).threadId, 'Synthetic');
    await tick();
    const input = { jobId: job.jobId, message: 'Synthetic retry me', requestId: 'uncertain-1' };
    fake.dropResponseOnce.add('t3_thread_send');
    const lost = await agent.callError('work_continue', input);
    assert.equal(lost.code, 't3_response_lost');
    assert.match(lost.text, /call work_continue again with the same requestId/);
    assert.equal(fake.sends.length, 1, 'the first attempt did reach T3');
    const retried = await agent.call<{ job: JobView; replayed: boolean }>('work_continue', input);
    assert.equal(retried.replayed, false);
    assert.equal(retried.job.state, 'running');
    assert.equal(fake.sends.length, 1, 'T3 deduplicated the retry by clientRequestId');
  });

  test('a send T3 never received releases the requestId for a retry', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    const input = { jobId: job.jobId, message: 'Synthetic', requestId: 'refused-1' };
    fake.statusOnce.set('t3_thread_send', 400);
    assert.equal((await agent.callError('work_continue', input)).code, 'host_unreachable');
    assert.equal(fake.sends.length, 0);
    await agent.call('work_continue', input);
    assert.equal(fake.sends.length, 1);
  });
});

describe('work_cancel', () => {
  test('cancels a queued job at once without contacting T3', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t, { maxConcurrentJobs: 1 });
    const running = await startJob(agent);
    const queued = await startJob(agent);
    await tick();
    const result = await agent.call<{ outcome: string; confirmed: boolean; job: JobView }>('work_cancel', { jobId: queued.jobId });
    assert.deepEqual([result.outcome, result.confirmed, result.job.state], ['cancelled', true, 'cancelled']);
    assert.equal(fake.calls.includes('t3_thread_interrupt'), false);
    await tick();
    assert.equal(fake.launches.length, 1, 'the cancelled job never launches');
    assert.equal(await jobState(agent, running.jobId), 'running');
    const repeat = await agent.call<{ outcome: string }>('work_cancel', { jobId: queued.jobId });
    assert.equal(repeat.outcome, 'cancelled');
  });

  test('interrupts a running job: requested first, confirmed when the watcher sees the thread stop', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    fake.deferInterrupts = true;
    const result = await agent.call<{ outcome: string; confirmed: boolean; delivered: boolean }>('work_cancel', { jobId: job.jobId });
    assert.deepEqual([result.outcome, result.confirmed, result.delivered], ['cancel_requested', false, true]);
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'cancel_requested', 'not confirmed while the thread still runs');
    fake.completeInterrupts();
    await tick();
    const done = await status(agent, job.jobId);
    assert.equal(done.state, 'cancelled');
    assert.equal(done.recentEvents.at(-1)?.reason, 'interrupted');
    assert.equal((await agent.callError('work_continue', { jobId: job.jobId, message: 'x', requestId: 'late' })).code, 'job_state_conflict');
  });

  test('a T3 refusal to interrupt is returned and the job keeps its state', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    fake.failures.set('t3_thread_interrupt', { code: 'permission_denied', message: 'Synthetic refusal.' });
    const refused = await agent.callError('work_cancel', { jobId: job.jobId });
    assert.equal(refused.code, 't3_tool_failed');
    assert.match(refused.text, /permission_denied/);
    assert.equal(await jobState(agent, job.jobId), 'running');
    fake.failures.delete('t3_thread_interrupt');
    assert.equal((await agent.call<{ outcome: string }>('work_cancel', { jobId: job.jobId })).outcome, 'cancel_requested');
  });

  test('an idle job is cancelled at once', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    fake.finishTurn(fake.threadForJob(job.jobId).threadId, 'Synthetic');
    await tick();
    const result = await agent.call<{ outcome: string; confirmed: boolean }>('work_cancel', { jobId: job.jobId });
    assert.deepEqual([result.outcome, result.confirmed], ['cancelled', true]);
  });

  test('a cancel the host cannot receive yet is kept and delivered when it is back', async (t) => {
    const { fake, agent, tick, tickAfter } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    const port = Number(new URL(fake.url).port);
    await fake.stop();
    const result = await agent.call<{ outcome: string; delivered: boolean }>('work_cancel', { jobId: job.jobId });
    assert.deepEqual([result.outcome, result.delivered], ['cancel_requested', false]);
    await fake.start(port);
    await tickAfter(MINUTE);
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'cancelled');
    assert.equal(fake.threadForJob(job.jobId).status, 'interrupted');
  });

  test('cancelling a job whose launch is unconfirmed interrupts the thread once reconciliation finds it', async (t) => {
    const { fake, agent, tick, tickAfter } = await startJobHarness(t);
    const job = await startJob(agent);
    fake.dropResponseOnce.add('t3_thread_launch');
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'unknown');
    const result = await agent.call<{ outcome: string; delivered: boolean }>('work_cancel', { jobId: job.jobId });
    assert.deepEqual([result.outcome, result.delivered], ['cancel_requested', false]);
    await tickAfter(MINUTE);
    assert.equal(fake.threadForJob(job.jobId).status, 'interrupted');
    assert.equal(await jobState(agent, job.jobId), 'cancelled');
  });
});

describe('work_feed', () => {
  test('pages through events with an exclusive cursor and lists the jobs needing attention', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t);
    const first = await startJob(agent, 'Synthetic one');
    const second = await startJob(agent, 'Synthetic two');
    await tick();
    fake.finishTurn(fake.threadForJob(first.jobId).threadId, 'Synthetic done');
    fake.askQuestion(fake.threadForJob(second.jobId).threadId, [{ id: 'q', header: 'h', question: 'Synthetic?', options: [] }]);
    await tick();

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page: FeedPage = await agent.call<FeedPage>('work_feed', cursor === undefined ? { limit: 2 } : { cursor, limit: 2 });
      pages += 1;
      seen.push(...page.events.map((event) => event.cursor));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    const total = (gw.services.db.prepare('SELECT COUNT(*) AS n FROM job_events').get() as { n: number }).n;
    assert.equal(seen.length, total, 'every event once');
    assert.equal(new Set(seen).size, seen.length, 'no duplicates');
    assert.deepEqual([...seen].map(Number), [...seen].map(Number).sort((a, b) => a - b), 'in order');
    assert.ok(pages >= 4);

    const quiet = await agent.call<FeedPage>('work_feed', { cursor });
    assert.deepEqual([quiet.events.length, quiet.nextCursor, quiet.hasMore], [0, cursor, false]);
    assert.deepEqual(
      quiet.attention.map((job) => [job.jobId, job.state]).sort(),
      [
        [first.jobId, 'idle'],
        [second.jobId, 'needs_input'],
      ].sort(),
    );
    assert.match(quiet.attention.find((job) => job.state === 'needs_input')?.why ?? '', /work_respond/);

    await agent.call('work_continue', { jobId: first.jobId, message: 'Synthetic more', requestId: 'more' });
    const next = await agent.call<FeedPage>('work_feed', { cursor: Number(cursor) });
    assert.deepEqual(next.events.map((event) => [event.jobId, event.type, event.toState]), [[first.jobId, 'state_changed', 'running']]);

    const reader = await connectAgent(t, gw, 'read');
    assert.equal((await reader.call<FeedPage>('work_feed', { mine: true })).events.length, 0, 'mine filters to the caller');
    assert.ok((await reader.call<FeedPage>('work_feed', {})).events.length > 0);
  });

  test('read agents can follow work but not operate it', async (t) => {
    const { gw, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    const reader = await connectAgent(t, gw, 'read');
    for (const [tool, args] of [
      ['work_continue', { jobId: job.jobId, message: 'x', requestId: 'r' }],
      ['work_respond', { jobId: job.jobId, requestId: 'r', answers: {} }],
      ['work_cancel', { jobId: job.jobId }],
    ] as const) {
      const denied = await reader.callError(tool, args);
      assert.equal(denied.code, 'insufficient_scope', tool);
    }
    assert.equal(await jobState(reader, job.jobId), 'running');
  });
});

describe('job links', () => {
  test('work_status, work_list and the feed attention list carry the link that opens the thread in T3', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    assert.equal((await status(agent, job.jobId)).link, null, 'launched, but the watcher has not read the thread yet');
    await tick();
    const { threadId } = fake.threadForJob(job.jobId);
    const link = `t3-thread://v1/${FAKE_ENVIRONMENT_ID}/${threadId}`;
    assert.equal((await status(agent, job.jobId)).link, link);
    const summary = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId } });
    assert.match(JSON.stringify(summary.content), new RegExp(`Open in T3: ${link}`));
    const listed = await agent.call<{ jobs: (JobView & { link: string | null })[] }>('work_list', {});
    assert.equal(listed.jobs[0]?.link, link);
    fake.finishTurn(threadId, 'Synthetic result');
    await tick();
    const feed = await agent.call<FeedPage>('work_feed', {});
    assert.equal(feed.attention[0]?.state, 'idle');
    assert.equal(feed.attention[0]?.link, link);
    assert.equal(gw.logs.some((line) => line.includes('t3-thread://')), false, 'links are never logged');
  });
});
