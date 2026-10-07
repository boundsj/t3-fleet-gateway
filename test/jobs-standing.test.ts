import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { MINUTE } from '../src/time.ts';
import type { FakeT3 } from './helpers/fakeT3.ts';
import { assertNotLogged, jobState, startJob, startJobHarness, type Agent, type JobHarness } from './helpers/jobs.ts';
import { tempDir } from './helpers/tmp.ts';

interface JobView {
  jobId: string;
  state: string;
  standing: boolean;
  waitingOnDelegatedWork: boolean;
  delegatedTasks: string[];
  delegatedTasksUntracked: number;
  title: string;
  link: string | null;
  startedByYou: boolean;
}

interface Status extends JobView {
  latestMessageExcerpt: string | null;
  lastError: { code: string } | null;
  pendingRequests: { requestId: string }[];
  recentEvents: { type: string; fromState: string | null; toState: string | null; reason: string | null }[];
}

interface FeedPage {
  events: { jobId: string; type: string; fromState: string | null; toState: string | null; reason: string | null }[];
  nextCursor: string;
  attention: (JobView & { why: string })[];
}

const status = (agent: Agent, jobId: string) => agent.call<Status>('work_status', { jobId });

/**
 * A thread the operator started in T3 (not launched by the gateway), with two finished turns of
 * history; its items are at positions 0 to 3.
 */
function coordinatorThread(fake: FakeT3, projectId = 'project-1'): string {
  const { threadId } = fake.launchDirect({ projectId, title: 'Synthetic chief of staff', message: 'Synthetic: coordinate the project' });
  fake.finishTurn(threadId, 'Synthetic old reply 1');
  fake.userTurn(threadId, 'Synthetic: next step');
  fake.finishTurn(threadId, 'Synthetic old reply 2');
  return threadId;
}

async function adopt(harness: JobHarness, threadId: string, project = 'pilot', title?: string) {
  return harness.gw.services.jobs.adopt({ project, threadId, ...(title === undefined ? {} : { title }) });
}

describe('standing jobs: adopt', () => {
  test('checks the project, the thread and existing jobs; adopting again returns the same job', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const elsewhere = coordinatorThread(fake, 'project-2');

    await assert.rejects(adopt(harness, threadId, 'nosuchproject'), { code: 'not_found', message: /No project "nosuchproject"/ });
    await assert.rejects(adopt(harness, 'thread-404'), { code: 'not_found', message: /no T3 thread thread-404/ });
    await assert.rejects(adopt(harness, elsewhere), { code: 'invalid_argument', message: /belongs to T3 project project-2, not to project "pilot"/ });

    const launched = await startJob(agent);
    await tick();
    await assert.rejects(adopt(harness, fake.threadForJob(launched.jobId).threadId), {
      code: 'job_state_conflict',
      message: new RegExp(`job ${launched.jobId}, which the gateway launched`),
    });

    const first = await adopt(harness, threadId, 'pilot', 'Chief of Staff');
    assert.equal(first.created, true);
    assert.deepEqual([first.job.standing, first.job.state, first.job.title, first.job.threadTitle], [true, 'idle', 'Chief of Staff', 'Synthetic chief of staff']);
    const calls = fake.calls.length;
    const again = await adopt(harness, threadId, 'pilot', 'Another title');
    assert.deepEqual([again.created, again.job.id, again.job.title], [false, first.job.id, 'Chief of Staff']);
    assert.equal(fake.calls.length, calls, 'an existing standing job is returned without asking T3');
    await assert.rejects(adopt(harness, threadId, 'docs'), { code: 'invalid_argument' }, 'the T3 project decides, even for a standing job');

    gw.services.jobs.release(first.job.id);
    const readopted = await adopt(harness, threadId);
    assert.equal(readopted.created, true, 'a released thread can be adopted again');
    assert.notEqual(readopted.job.id, first.job.id);
  });

  test("derives the first state from the thread and starts reading at its end, so history is not replayed", async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    assert.deepEqual([job.readPosition, job.activityPosition], [3, 3], 'the last item when adopted, in both views');
    assert.equal(job.lastRunId, fake.threads.get(threadId)?.runs.at(-1)?.runId);

    const adopted = await status(agent, job.id);
    assert.deepEqual([adopted.state, adopted.standing, adopted.startedByYou], ['idle', true, false]);
    assert.equal(adopted.latestMessageExcerpt, 'Synthetic old reply 2', "the thread's latest reply, for context");
    assert.match(adopted.link ?? '', /^t3-thread:\/\/v1\/env-synthetic\//);
    const feed = await agent.call<FeedPage>('work_feed', {});
    assert.deepEqual(
      feed.events.map((event) => [event.jobId, event.type, event.toState, event.reason]),
      [[job.id, 'created', 'idle', 'adopted']],
    );

    gw.clock.advance(2 * MINUTE);
    await tick();
    const quiet = await agent.call<FeedPage>('work_feed', { cursor: feed.nextCursor });
    assert.deepEqual(quiet.events, [], 'watching the adopted thread replays nothing');

    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: plan the next milestone', requestId: 'cos-1' });
    fake.finishTurn(threadId, 'Synthetic new plan');
    await tick();
    const done = await status(agent, job.id);
    assert.deepEqual([done.state, done.latestMessageExcerpt], ['idle', 'Synthetic new plan']);
    const later = await agent.call<FeedPage>('work_feed', { cursor: feed.nextCursor });
    assert.deepEqual(
      later.events.map((event) => [event.type, event.toState, event.reason]),
      [
        ['state_changed', 'running', 'followup'],
        ['state_changed', 'idle', 'completed'],
      ],
    );
    assert.match(
      later.attention.find((entry) => entry.jobId === job.id)?.why ?? '',
      /read its reply with work_status\. Nothing it delegated is still running \(waitingOnDelegatedWork is false, which wins over the reply text\)/,
    );
  });

  test('a thread running or waiting on a question is adopted as running or needs_input', async (t) => {
    const harness = await startJobHarness(t);
    const { fake } = harness;
    const running = coordinatorThread(fake);
    fake.userTurn(running, 'Synthetic: long task');
    fake.streamAssistant(running, 'Synthetic partial');
    const adopted = await adopt(harness, running);
    assert.equal(adopted.job.state, 'running');
    assert.equal(adopted.job.readPosition, 4, 'stops before the message still being written');
    assert.equal(adopted.job.lastRunId, fake.threads.get(running)?.runs.at(-1)?.runId);

    const asking = coordinatorThread(fake);
    fake.userTurn(asking, 'Synthetic: decide');
    const requestId = fake.askQuestion(asking, [{ id: 'q', header: 'Pick', question: 'Synthetic: which?', options: [] }]);
    const blocked = await adopt(harness, asking);
    assert.deepEqual([blocked.job.state, blocked.job.pendingRequestIds], ['needs_input', [requestId]]);
  });

  test('a thread longer than one page is read to its end', async (t) => {
    const harness = await startJobHarness(t);
    const { fake } = harness;
    const threadId = coordinatorThread(fake);
    for (let i = 0; i < 250; i++) {
      fake.userTurn(threadId, `Synthetic question ${i}`);
      fake.finishTurn(threadId, `Synthetic answer ${i}`);
    }
    const { job } = await adopt(harness, threadId);
    assert.equal(job.readPosition, 503);
    assert.deepEqual([job.state, job.latestMessageExcerpt], ['idle', 'Synthetic answer 249']);
  });
});

describe('standing jobs: driving them', () => {
  test('work_continue sends to the thread, idempotent on requestId', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, agent } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    const input = { jobId: job.id, message: 'Synthetic: review the open pull requests', requestId: 'cos-send-1' };
    const sent = await agent.call<{ job: JobView; delivery: string; replayed: boolean }>('work_continue', input);
    assert.deepEqual([sent.job.state, sent.job.standing, sent.delivery, sent.replayed], ['running', true, 'started', false]);
    const replay = await agent.call<{ replayed: boolean }>('work_continue', input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(
      fake.sends.map((send) => [send.threadId, send.message]),
      [[threadId, input.message]],
    );
    const steer = await agent.call<{ delivery: string }>('work_continue', { ...input, requestId: 'cos-send-2', message: 'Synthetic: also triage issues' });
    assert.equal(steer.delivery, 'steered');
  });

  test('work_cancel interrupts the current turn only: the job returns to idle and stays open', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: a long investigation', requestId: 'cos-long' });
    await tick();

    const result = await agent.call<{ outcome: string; confirmed: boolean; delivered: boolean; job: JobView }>('work_cancel', { jobId: job.id });
    assert.deepEqual([result.outcome, result.confirmed, result.delivered, result.job.state], ['interrupt_requested', false, true, 'running']);
    assert.equal(fake.threads.get(threadId)?.status, 'interrupted');
    await tick();
    const stopped = await status(agent, job.id);
    assert.equal(stopped.state, 'idle', 'never cancelled');
    assert.deepEqual(
      stopped.recentEvents.slice(-2).map((event) => [event.type, event.toState, event.reason]),
      [
        ['interrupt_requested', 'running', 'interrupt_requested'],
        ['state_changed', 'idle', 'interrupted'],
      ],
    );

    const idle = await agent.call<{ outcome: string; confirmed: boolean; job: JobView }>('work_cancel', { jobId: job.id });
    assert.deepEqual([idle.outcome, idle.confirmed, idle.job.state], ['not_running', true, 'idle']);
    const resumed = await agent.call<{ job: JobView }>('work_continue', { jobId: job.id, message: 'Synthetic: carry on', requestId: 'cos-resume' });
    assert.equal(resumed.job.state, 'running', 'the standing job still takes work');
  });

  test('interrupting a standing job that asked a question: a question T3 keeps still needs work_respond', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, agent, tick } = harness;
    fake.keepQuestionsOnInterrupt = true;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: pick a release date', requestId: 'cos-ask' });
    const question = [{ id: 'q', header: 'Date', question: 'Synthetic: which day?', options: [{ label: 'Monday', description: '' }] }];
    const requestId = fake.askQuestion(threadId, question);
    await tick();
    assert.equal(await jobState(agent, job.id), 'needs_input');

    type Cancel = { outcome: string; confirmed: boolean; pendingQuestions: string[]; job: JobView };
    const first = await agent.call<Cancel>('work_cancel', { jobId: job.id });
    assert.deepEqual([first.outcome, first.pendingQuestions], ['interrupt_requested', []]);
    await tick();
    assert.equal(fake.threads.get(threadId)?.status, 'interrupted');
    assert.equal(await jobState(agent, job.id), 'needs_input', 'T3 still lists the question');
    const result = await agent.client.callTool({ name: 'work_cancel', arguments: { jobId: job.id } });
    const again = result.structuredContent as Cancel;
    assert.deepEqual([again.outcome, again.confirmed, again.pendingQuestions, again.job.state], ['not_running', true, [requestId], 'needs_input']);
    assert.match(JSON.stringify(result.content), new RegExp(`question is still pending \\(${requestId}\\): answer it with work_respond`));

    // Once T3 lists no question for the stopped thread, the job is idle.
    fake.threads.get(threadId)?.questions.clear();
    await tick();
    assert.equal(await jobState(agent, job.id), 'idle');
    assert.deepEqual((await agent.call<Cancel>('work_cancel', { jobId: job.id })).pendingQuestions, []);
  });

  test('a failed run leaves a standing job idle with the error, cleared by the next turn', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: risky step', requestId: 'cos-risky' });
    fake.failRun(threadId);
    await tick();
    const failed = await status(agent, job.id);
    assert.deepEqual([failed.state, failed.lastError?.code], ['idle', 't3_run_failed']);
    assert.deepEqual(failed.recentEvents.at(-1) && [failed.recentEvents.at(-1)?.toState, failed.recentEvents.at(-1)?.reason], ['idle', 'run_failed']);
    const feed = await agent.call<FeedPage>('work_feed', {});
    assert.match(feed.attention.find((entry) => entry.jobId === job.id)?.why ?? '', /last run failed/);

    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: try again', requestId: 'cos-again' });
    assert.equal((await status(agent, job.id)).lastError, null);
  });

  test('follows a long turn whose activity grows past what one tick reads', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: a long investigation', requestId: 'cos-long' });
    // The activity grows past what one tick reads (10 pages of 100), with delegated work at its end, and
    // another thread in the project finishes meanwhile.
    const child = fake.launchDirect({ projectId: 'project-1', title: 'Synthetic other thread', message: 'Synthetic other task' });
    fake.addActivity(threadId, 'command_execution', 1200);
    fake.delegate(threadId, 'Synthetic late task');
    const thread = fake.threads.get(threadId);
    assert.ok(thread);
    await tick();
    const first = gw.services.jobs.store.require(job.id);
    assert.deepEqual([first.state, first.readPosition, first.activityPosition], ['running', 4, 1003], 'messages at once; activity 1000 items on');
    await tick();
    const caughtUp = gw.services.jobs.store.require(job.id);
    assert.deepEqual([caughtUp.activityPosition, caughtUp.delegatedWork.map((task) => task.title)], [thread.items.length - 1, ['Synthetic late task']]);
    fake.finishTurn(child.threadId, 'Synthetic other thread done');
    await tick();
    assert.equal(await jobState(agent, job.id), 'running', "another thread's finish is not the coordinator's");
    fake.finishTurn(threadId, 'Synthetic: delegated the last step');
    await tick();
    const done = await status(agent, job.id);
    assert.deepEqual([done.state, done.waitingOnDelegatedWork, done.latestMessageExcerpt], ['idle', true, 'Synthetic: delegated the last step']);
    assert.equal(gw.services.jobs.store.openJobForThread(child.threadId), undefined, 'other threads are not jobs');
  });
});

describe('standing jobs: a coordinator that delegates', () => {
  // Observed live: when a T3 coordinator delegates, its own run completes while the child thread works;
  // the child appears in the parent only as one subagent item; when the child finishes, T3 appends a
  // notification item and starts a new run on the parent by itself.
  test('goes idle while its delegated work runs, then resumes and finishes with no agent action', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    const start = await agent.call<FeedPage>('work_feed', {});
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: get the refactor done', requestId: 'cos-delegate' });
    const { childThreadId } = fake.delegate(threadId, 'Synthetic refactor task');
    fake.finishTurn(threadId, 'Synthetic: delegated the refactor; waiting for it');
    await tick();
    const waiting = await status(agent, job.id);
    assert.deepEqual(
      [waiting.state, waiting.waitingOnDelegatedWork, waiting.delegatedTasks, waiting.latestMessageExcerpt],
      ['idle', true, ['Synthetic refactor task'], 'Synthetic: delegated the refactor; waiting for it'],
    );
    const feed = await agent.call<FeedPage>('work_feed', { cursor: start.nextCursor });
    const entry = feed.attention.find((candidate) => candidate.jobId === job.id);
    assert.equal(entry?.waitingOnDelegatedWork, true);
    assert.match(entry?.why ?? '', /^Waiting on work it delegated \("Synthetic refactor task"\)\. It resumes by itself when that is done: do not send new instructions/);

    // A person asks for news in T3 while the child works: the reply comes after the pending subagent item.
    const thread = fake.threads.get(threadId);
    assert.ok(thread);
    fake.userTurn(threadId, 'Synthetic: any news?');
    fake.finishTurn(threadId, 'Synthetic: still waiting on the refactor');
    gw.clock.advance(2 * MINUTE);
    await tick();
    const asked = await status(agent, job.id);
    assert.deepEqual([asked.state, asked.waitingOnDelegatedWork, asked.latestMessageExcerpt], ['idle', true, 'Synthetic: still waiting on the refactor']);
    assert.equal(gw.services.jobs.store.require(job.id).readPosition, thread.items.length - 1, 'the pending subagent item does not hold the read position');

    fake.finishDelegated(childThreadId, 'Synthetic child summary: refactor merged');
    gw.clock.advance(2 * MINUTE);
    await tick();
    const resumed = await status(agent, job.id);
    assert.deepEqual(
      [resumed.state, resumed.waitingOnDelegatedWork, resumed.delegatedTasks, resumed.latestMessageExcerpt],
      ['running', false, [], 'Synthetic: still waiting on the refactor'],
      'neither the child summary nor the notification is the excerpt',
    );
    fake.finishTurn(threadId, 'Synthetic: the refactor is merged; ready for the next step');
    await tick();
    const done = await status(agent, job.id);
    assert.deepEqual([done.state, done.latestMessageExcerpt], ['idle', 'Synthetic: the refactor is merged; ready for the next step']);

    const events = (await agent.call<FeedPage>('work_feed', { cursor: start.nextCursor })).events;
    assert.deepEqual(
      events.map((event) => [event.type, event.fromState, event.toState, event.reason]),
      [
        ['state_changed', 'idle', 'running', 'followup'],
        ['state_changed', 'running', 'idle', 'waiting_on_delegated_work'],
        ['turn_finished', 'idle', 'idle', 'waiting_on_delegated_work'],
        ['state_changed', 'idle', 'running', 'turn_started'],
        ['state_changed', 'running', 'idle', 'completed'],
      ],
    );
    assert.equal(fake.sends.length, 1, 'the agent sent only the first instruction');
    assertNotLogged(gw, ['Synthetic refactor task', 'Synthetic child summary', 'still waiting on the refactor']);
  });

  test('a resumed turn that starts and ends between two checks is reported as turn_finished', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: publish the docs', requestId: 'cos-docs' });
    // A T3 that shows the subagent item completed at once: only the reply says the coordinator waits.
    const { childThreadId } = fake.delegate(threadId, 'Synthetic docs task', 'completed');
    fake.finishTurn(threadId, 'Synthetic: delegated the docs');
    await tick();
    const delegated = await status(agent, job.id);
    assert.deepEqual([delegated.state, delegated.waitingOnDelegatedWork], ['idle', false]);
    const before = await agent.call<FeedPage>('work_feed', {});
    assert.match(before.attention.find((entry) => entry.jobId === job.id)?.why ?? '', /Nothing it delegated is still running/);

    fake.finishDelegated(childThreadId, 'Synthetic docs summary');
    fake.finishTurn(threadId, 'Synthetic: the docs are published');
    gw.clock.advance(2 * MINUTE);
    await tick();
    const done = await status(agent, job.id);
    assert.deepEqual([done.state, done.latestMessageExcerpt], ['idle', 'Synthetic: the docs are published']);
    const after = await agent.call<FeedPage>('work_feed', { cursor: before.nextCursor });
    assert.deepEqual(
      after.events.map((event) => [event.type, event.fromState, event.toState, event.reason]),
      [['turn_finished', 'idle', 'idle', 'completed']],
    );
  });

  test('delegated work that fails without the coordinator resuming is reported (delegated_work_ended)', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: run the audit', requestId: 'cos-audit' });
    const { childThreadId } = fake.delegate(threadId, 'Synthetic audit task');
    fake.finishTurn(threadId, 'Synthetic: delegated the audit; waiting for it');
    await tick();
    assert.equal((await status(agent, job.id)).waitingOnDelegatedWork, true);
    const before = await agent.call<FeedPage>('work_feed', {});

    // The child fails: its subagent item settles, and T3 starts no run on the coordinator.
    fake.settleDelegated(childThreadId, 'failed');
    gw.clock.advance(2 * MINUTE);
    await tick();
    const ended = await status(agent, job.id);
    assert.deepEqual(
      [ended.state, ended.waitingOnDelegatedWork, ended.delegatedTasks, ended.latestMessageExcerpt],
      ['idle', false, [], 'Synthetic: delegated the audit; waiting for it'],
      'the flag, not the reply, says nothing is running',
    );
    const feed = await agent.call<FeedPage>('work_feed', { cursor: before.nextCursor });
    assert.deepEqual(
      feed.events.map((event) => [event.type, event.fromState, event.toState, event.reason]),
      [['delegated_work_ended', 'idle', 'idle', 'no_turn_started']],
    );
    assert.equal(
      feed.attention.find((entry) => entry.jobId === job.id)?.why,
      'Its delegated work has ended (finished, failed or cancelled) but it did not resume. Send work_continue asking it to check on that work.',
    );
    gw.clock.advance(2 * MINUTE);
    await tick();
    assert.deepEqual((await agent.call<FeedPage>('work_feed', { cursor: feed.nextCursor })).events, [], 'reported once');

    // The agent asks it to check: the mark goes with the new turn.
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: check on the audit', requestId: 'cos-audit-check' });
    fake.finishTurn(threadId, 'Synthetic: the audit failed; rerunning it later');
    await tick();
    const after = await agent.call<FeedPage>('work_feed', { cursor: feed.nextCursor });
    assert.match(after.attention.find((entry) => entry.jobId === job.id)?.why ?? '', /^Standing job's turn ended: read its reply/);
    assert.equal(gw.services.jobs.store.require(job.id).delegatedEndedAt, null);
  });

  test('follows the first 200 delegated tasks and counts the rest until the coordinator has run a new turn', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: fan out the batch', requestId: 'cos-batch' });
    const children = Array.from({ length: 205 }, (_, index) => fake.delegate(threadId, `Synthetic batch task ${index}`).childThreadId);
    fake.finishTurn(threadId, 'Synthetic: delegated the batch');
    await tick();
    const waiting = await status(agent, job.id);
    assert.deepEqual(
      [waiting.state, waiting.waitingOnDelegatedWork, waiting.delegatedTasks.length, waiting.delegatedTasks[0], waiting.delegatedTasksUntracked],
      ['idle', true, 200, 'Synthetic batch task 0', 5],
    );
    const feed = await agent.call<FeedPage>('work_feed', {});
    const entry = feed.attention.find((candidate) => candidate.jobId === job.id);
    assert.equal(entry?.delegatedTasksUntracked, 5);
    assert.match(entry?.why ?? '', /following 200 of 205 delegated tasks; ask the coordinator for status before sending more work/);

    // Every followed task ends without a new turn: the 5 not followed may still run, so it still waits.
    for (const child of children.slice(0, 200)) fake.settleDelegated(child, 'completed');
    for (let i = 0; i < 3; i++) {
      gw.clock.advance(2 * MINUTE);
      await tick();
    }
    const untracked = await status(agent, job.id);
    assert.deepEqual([untracked.state, untracked.waitingOnDelegatedWork, untracked.delegatedTasks, untracked.delegatedTasksUntracked], ['idle', true, [], 5]);
    assert.match((await agent.call<FeedPage>('work_feed', {})).attention.find((candidate) => candidate.jobId === job.id)?.why ?? '', /^Waiting on work it delegated \(following 0 of 5 delegated tasks/);

    // A new turn of the coordinator starts and finishes: the count is cleared.
    fake.userTurn(threadId, 'Synthetic: status of the batch?');
    fake.finishTurn(threadId, 'Synthetic: the batch is done');
    gw.clock.advance(2 * MINUTE);
    await tick();
    const done = await status(agent, job.id);
    assert.deepEqual([done.state, done.waitingOnDelegatedWork, done.delegatedTasksUntracked], ['idle', false, 0]);
    assert.ok(!done.recentEvents.some((event) => event.type === 'delegated_work_ended'), 'a turn ran, so nothing to report');
  });

  test('adopting a coordinator that waits on delegated work follows that work', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    fake.userTurn(threadId, 'Synthetic: start the migration');
    const { childThreadId } = fake.delegate(threadId, 'Synthetic migration task');
    fake.finishTurn(threadId, 'Synthetic: delegated the migration');
    for (let i = 0; i < 150; i++) {
      fake.userTurn(threadId, `Synthetic question ${i}`);
      fake.finishTurn(threadId, `Synthetic answer ${i}`);
    }
    const before = fake.reads.length;
    const { job } = await adopt(harness, threadId);
    assert.deepEqual([job.state, job.delegatedWork.map((task) => task.title)], ['idle', ['Synthetic migration task']], 'found on an earlier page');
    assert.equal(job.latestMessageExcerpt, 'Synthetic answer 149');
    const end = (fake.threads.get(threadId)?.items.length ?? 0) - 1;
    assert.deepEqual([job.readPosition, job.activityPosition], [end, end], 'both views start at the end');
    assert.deepEqual(
      fake.reads.slice(before).filter((read) => read.view === 'activity').map((read) => read.afterPosition ?? null),
      [end, end - 100, end - 200, end - 300, null],
      'the activity tail after the last message, then back 100 positions per read',
    );

    fake.finishDelegated(childThreadId, 'Synthetic migration summary');
    gw.clock.advance(2 * MINUTE);
    await tick();
    const resumed = await status(agent, job.id);
    assert.deepEqual([resumed.state, resumed.waitingOnDelegatedWork], ['running', false]);
  });

  test('adoption looks back from the last message even when the activity after it is longer than the scan', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, tick } = harness;
    const threadId = coordinatorThread(fake);
    fake.userTurn(threadId, 'Synthetic: start the rollout');
    fake.delegate(threadId, 'Synthetic rollout task');
    fake.finishTurn(threadId, 'Synthetic: delegated the rollout');
    // A person's next turn is busy: 2,100 activity items after its message, more than the whole scan reads.
    fake.userTurn(threadId, 'Synthetic: and the changelog?');
    const anchor = (fake.threads.get(threadId)?.items.length ?? 0) - 1;
    fake.addActivity(threadId, 'reasoning', 2100);
    const before = fake.reads.length;
    const { job } = await adopt(harness, threadId);
    assert.deepEqual([job.state, job.delegatedWork.map((task) => task.title)], ['running', ['Synthetic rollout task']], 'found just before the anchor');
    const activityReads = fake.reads.slice(before).filter((read) => read.view === 'activity');
    assert.deepEqual(
      [activityReads.filter((read) => (read.afterPosition ?? -1) >= anchor).length, activityReads.length],
      [15, 16],
      'the tail reads 15 pages, leaving pages to look back (one is enough here: the thread starts 100 positions back)',
    );
    assert.equal(job.activityPosition, anchor + 1500, 'short of the end');
    await tick();
    const end = (fake.threads.get(threadId)?.items.length ?? 0) - 1;
    assert.deepEqual([gw.services.jobs.store.require(job.id).activityPosition, gw.services.jobs.store.require(job.id).delegatedWork.length], [end, 1], 'the watcher catches up');
  });
});

describe('standing jobs: delegated work in the activity view', () => {
  // T3's messages view never returns subagent items: they are in the activity view only, which a busy
  // coordinator fills with reasoning and tool calls.
  test('a busy coordinator: 600 activity items in one turn delay neither its reply nor its delegated work', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: get the release out', requestId: 'cos-busy' });
    fake.addActivity(threadId, 'reasoning', 300);
    fake.addActivity(threadId, 'dynamic_tool', 300);
    const { childThreadId, item } = fake.delegate(threadId, 'Synthetic release task');
    fake.addActivity(threadId, 'command_execution', 5);
    fake.finishTurn(threadId, 'Synthetic: delegated the release; waiting for it');
    const thread = fake.threads.get(threadId);
    assert.ok(thread);
    const end = thread.items.length - 1;

    let before = fake.reads.length;
    await tick();
    const waiting = await status(agent, job.id);
    assert.deepEqual(
      [waiting.state, waiting.waitingOnDelegatedWork, waiting.delegatedTasks, waiting.latestMessageExcerpt],
      ['idle', true, ['Synthetic release task'], 'Synthetic: delegated the release; waiting for it'],
    );
    const stored = gw.services.jobs.store.require(job.id);
    assert.deepEqual([stored.readPosition, stored.activityPosition], [end, end]);
    const pattern = () => fake.reads.slice(before).map((read) => [read.view, read.afterPosition ?? null, read.limit, read.maxCharsPerItem]);
    assert.deepEqual(
      pattern(),
      [
        ['messages', 3, 100, 2000],
        ...[3, 103, 203, 303, 403, 503, 603].map((after) => ['activity', after, 100, 1]),
      ],
      'one messages read for the reply; the activity in pages of 100 items of one character',
    );

    // A quiet check: one read of each view, and the followed item re-read by position.
    gw.clock.advance(2 * MINUTE);
    before = fake.reads.length;
    await tick();
    assert.deepEqual(pattern(), [
      ['messages', end, 100, 2000],
      ['activity', end, 100, 1],
      ['activity', item.position - 1, 100, 1],
    ]);
    assert.equal((await status(agent, job.id)).waitingOnDelegatedWork, true);

    fake.finishDelegated(childThreadId, 'Synthetic release summary');
    gw.clock.advance(2 * MINUTE);
    await tick();
    const resumed = await status(agent, job.id);
    assert.deepEqual(
      [resumed.state, resumed.waitingOnDelegatedWork, resumed.delegatedTasks, resumed.latestMessageExcerpt],
      ['running', false, [], 'Synthetic: delegated the release; waiting for it'],
      'neither the task prompt nor the summary is the excerpt',
    );
    fake.finishTurn(threadId, 'Synthetic: the release is out');
    await tick();
    const done = await status(agent, job.id);
    assert.deepEqual([done.state, done.latestMessageExcerpt], ['idle', 'Synthetic: the release is out']);
    assertNotLogged(gw, ['Synthetic release task', 'Synthetic delegated task prompt', 'Synthetic release summary']);
  });

  test('a standing job adopted before the activity position existed is scanned on its first check', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    fake.userTurn(threadId, 'Synthetic: start the audit');
    fake.addActivity(threadId, 'reasoning', 40);
    fake.delegate(threadId, 'Synthetic audit task');
    fake.finishTurn(threadId, 'Synthetic: delegated the audit');
    for (let i = 0; i < 20; i++) {
      fake.userTurn(threadId, `Synthetic question ${i}`);
      fake.addActivity(threadId, 'reasoning', 3);
      fake.finishTurn(threadId, `Synthetic answer ${i}`);
    }
    const { job } = await adopt(harness, threadId);
    // As a job adopted by an earlier build looks after migration 4: no activity position, nothing followed.
    gw.services.jobs.store.update(job.id, { activityPosition: null, delegatedWork: [] });
    gw.clock.advance(2 * MINUTE);
    await tick();
    const scanned = gw.services.jobs.store.require(job.id);
    const end = (fake.threads.get(threadId)?.items.length ?? 0) - 1;
    assert.deepEqual([scanned.activityPosition, scanned.delegatedWork.map((task) => task.title)], [end, ['Synthetic audit task']]);
    assert.equal((await status(agent, job.id)).waitingOnDelegatedWork, true);
  });
});

describe('standing jobs: release and slots', () => {
  test('release stops following the job without touching T3', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: keep going', requestId: 'cos-go' });
    await tick();

    const calls = fake.calls.length;
    const { job: released, released: changed } = gw.services.jobs.release(job.id);
    assert.deepEqual([changed, released.state], [true, 'released']);
    assert.equal(fake.calls.length, calls, 'release makes no T3 call');
    assert.equal(fake.threads.get(threadId)?.status, 'running', 'the thread keeps running');
    await tick();
    gw.clock.advance(5 * MINUTE);
    await tick();
    assert.equal(fake.calls.length, calls, 'a released job is no longer watched');

    const view = await status(agent, job.id);
    assert.equal(view.state, 'released');
    assert.equal(view.recentEvents.at(-1)?.reason, 'released');
    assert.equal((await agent.callError('work_continue', { jobId: job.id, message: 'x', requestId: 'cos-after' })).code, 'job_state_conflict');
    assert.equal((await agent.call<{ outcome: string }>('work_cancel', { jobId: job.id })).outcome, 'already_finished');
    assert.equal(gw.services.jobs.release(job.id).released, false);

    const launched = await startJob(agent);
    assert.throws(() => gw.services.jobs.release(launched.jobId), { code: 'invalid_argument', message: /work_cancel/ });
  });

  test('standing jobs never hold a concurrency slot', async (t) => {
    const harness = await startJobHarness(t, { maxConcurrentJobs: 1 });
    const { fake, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: busy', requestId: 'cos-busy' });
    await tick();
    assert.equal(await jobState(agent, job.id), 'running');

    const launched = await startJob(agent);
    await tick();
    assert.equal(await jobState(agent, launched.jobId), 'running', 'dispatched while the standing job runs');
    const fleet = await agent.call<{ hosts: { runningJobs: number; queuedJobs: number }[] }>('fleet_status');
    assert.deepEqual([fleet.hosts[0]?.runningJobs, fleet.hosts[0]?.queuedJobs], [1, 0]);
  });
});

describe('standing jobs: CLI', () => {
  test('jobs adopt, list and release share the database with the running gateway', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const dir = tempDir(t);
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        publicUrl: gw.baseUrl,
        hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand() }],
        projects: [{ alias: 'pilot', host: 'main', t3ProjectId: 'project-1', runtimeMode: 'auto' }],
      }),
    );
    const cli = async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(args, { env: { T3FG_CONFIG: configPath, T3FG_DATA_DIR: gw.dataDir }, out: (text) => out.push(text), err: (text) => err.push(text) });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };

    assert.equal((await cli('jobs', 'adopt', 'pilot')).code, 2);
    assert.equal((await cli('jobs', 'adopt', 'pilot', threadId, 'extra')).code, 2);
    assert.equal((await cli('jobs', 'adopt', 'pilot', threadId, '--title', '')).code, 2);
    const missing = await cli('jobs', 'adopt', 'pilot', 'thread-404');
    assert.equal(missing.code, 1);
    assert.match(missing.err, /^error \(not_found\)/);

    const adopted = await cli('jobs', 'adopt', 'pilot', threadId, '--title', 'Synthetic Chief of Staff');
    assert.equal(adopted.code, 0, adopted.err);
    const jobId = /standing job ([0-9a-z]{10})\./.exec(adopted.out)?.[1] ?? '';
    assert.match(adopted.out, /^Adopted thread thread-\d+ as standing job [0-9a-z]{10}\.$/m);
    assert.match(adopted.out, new RegExp(`^${jobId}  pilot  idle  standing  Synthetic Chief of Staff  t3-thread://`, 'm'));
    const repeated = await cli('jobs', 'adopt', 'pilot', threadId);
    assert.equal(repeated.code, 0);
    assert.match(repeated.out, new RegExp(`is already standing job ${jobId}\\.`));

    const listed = await cli('jobs', 'list');
    assert.match(listed.out, /^ID +PROJECT +STATE +STANDING +TITLE +LINK$/m);
    assert.match(listed.out, new RegExp(`^${jobId} +pilot +idle +yes +Synthetic Chief of Staff +t3-thread://`, 'm'));

    // The running gateway follows the job the CLI adopted.
    await agent.call('work_continue', { jobId, message: 'Synthetic: status report', requestId: 'cli-1' });
    fake.finishTurn(threadId, 'Synthetic report');
    await tick();
    assert.equal(await jobState(agent, jobId), 'idle');

    const released = await cli('jobs', 'release', jobId);
    assert.equal(released.code, 0);
    assert.match(released.out, /The T3 thread was not touched\./);
    assert.match((await cli('jobs', 'release', jobId)).out, /is already released/);
    assert.match((await cli('jobs', 'list')).out, /^No open jobs/);
    assert.match((await cli('jobs', 'list', '--all')).out, new RegExp(`^${jobId} +pilot +released +yes`, 'm'));
    assert.equal((await cli('jobs', 'release')).code, 2);
    assert.equal((await cli('jobs', 'frobnicate')).code, 2);
    assertNotLogged(gw, ['Synthetic Chief of Staff', 'Synthetic chief of staff', 'Synthetic report']);
  });
});

describe('standing jobs: where agents send work', () => {
  test('allowWorkStart false refuses work_start and names the standing jobs to use instead', async (t) => {
    const harness = await startJobHarness(t, { pilot: { allowWorkStart: false } });
    const { fake, agent } = harness;
    const none = await agent.callError('work_start', { project: 'pilot', task: 'Synthetic task', requestId: 'off-1' });
    assert.equal(none.code, 'start_disabled');
    assert.match(none.text, /Project "pilot" does not accept work_start \(allowWorkStart is false\)\. It has no standing job yet/);

    const { job } = await adopt(harness, coordinatorThread(fake), 'pilot', 'Chief of Staff');
    const refused = await agent.callError('work_start', { project: 'pilot', task: 'Synthetic task', requestId: 'off-2' });
    assert.equal(refused.code, 'start_disabled');
    assert.match(refused.text, new RegExp(`Send the work to its standing job with work_continue instead: ${job.id} \\("Chief of Staff", idle\\)`));
    assert.equal(fake.launches.length, 1, 'only the synthetic coordinator thread exists');
    const elsewhere = await agent.call<{ created: boolean }>('work_start', { project: 'docs', task: 'Synthetic task', requestId: 'off-3' });
    assert.equal(elsewhere.created, true, 'other projects are unaffected');
  });

  test('a request made before work_start was turned off is still answered with its job', async (t) => {
    const harness = await startJobHarness(t);
    const { gw, agent } = harness;
    const first = await agent.call<{ job: JobView }>('work_start', { project: 'pilot', task: 'Synthetic task', requestId: 'before-1' });
    const pilot = gw.services.config.projects.find((project) => project.alias === 'pilot');
    assert.ok(pilot);
    pilot.allowWorkStart = false;
    const replay = await agent.call<{ job: JobView; created: boolean }>('work_start', { project: 'pilot', task: 'Synthetic task', requestId: 'before-1' });
    assert.deepEqual([replay.created, replay.job.jobId], [false, first.job.jobId]);
    assert.equal((await agent.callError('work_start', { project: 'pilot', task: 'Synthetic task', requestId: 'before-2' })).code, 'start_disabled');
  });

  test('fleet_status lists each project\'s allowWorkStart and open standing jobs', async (t) => {
    const harness = await startJobHarness(t, { pilot: { allowWorkStart: false } });
    const { fake, gw, agent } = harness;
    const { job } = await adopt(harness, coordinatorThread(fake), 'pilot', 'Chief of Staff');
    const old = await adopt(harness, coordinatorThread(fake), 'pilot', 'Retired coordinator');
    gw.services.jobs.release(old.job.id);
    const result = await agent.client.callTool({ name: 'fleet_status', arguments: {} });
    const { projects } = result.structuredContent as {
      projects: { alias: string; allowWorkStart: boolean; standingJobs: { jobId: string; title: string; state: string; link: string | null }[] }[];
    };
    assert.deepEqual(
      projects.map((project) => [project.alias, project.allowWorkStart, project.standingJobs]),
      [
        ['pilot', false, [{ jobId: job.id, title: 'Chief of Staff', state: 'idle', link: job.threadLink }]],
        ['docs', true, []],
      ],
    );
    assert.match(job.threadLink ?? '', /^t3-thread:/);
    const text = JSON.stringify(result.content);
    assert.match(text, /project pilot on main \(auto, T3's default model, work_start disabled\): Synthetic pilot project/);
    assert.match(text, new RegExp(`standing job ${job.id} \\[idle\\] Chief of Staff: send it work with work_continue; open: t3-thread://`));
    assert.doesNotMatch(text, /Retired coordinator/, 'released jobs are not listed');
  });
});
