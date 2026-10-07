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
    assert.equal(job.readPosition, 3, 'the last item when adopted');
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
      /read its reply with work_status\. If it says it delegated work or is waiting, send nothing: it resumes by itself/,
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

  test('follows a long turn whose timeline grows past what one tick reads', async (t) => {
    const harness = await startJobHarness(t);
    const { fake, gw, agent, tick } = harness;
    const threadId = coordinatorThread(fake);
    const { job } = await adopt(harness, threadId);
    await agent.call('work_continue', { jobId: job.id, message: 'Synthetic: a long investigation', requestId: 'cos-long' });
    // The timeline grows past what one tick reads (5 pages of 100), and another thread in the project finishes meanwhile.
    const child = fake.launchDirect({ projectId: 'project-1', title: 'Synthetic delegated child', message: 'Synthetic child task' });
    const thread = fake.threads.get(threadId);
    assert.ok(thread);
    const template = thread.items[0];
    assert.ok(template);
    for (let i = 0; i < 620; i++) {
      thread.items.push({ ...template, position: thread.items.length, itemId: `extra-${i}`, type: 'command_execution', creationSource: 'provider' });
    }
    for (let i = 0; i < 3; i++) {
      await tick();
      assert.equal(await jobState(agent, job.id), 'running');
    }
    assert.equal(gw.services.jobs.store.require(job.id).readPosition, thread.items.length - 1, 'caught up over several ticks');
    fake.finishTurn(child.threadId, 'Synthetic child done');
    await tick();
    assert.equal(await jobState(agent, job.id), 'running', "another thread's finish is not the coordinator's");
    fake.finishTurn(threadId, 'Synthetic: the refactor is merged');
    await tick();
    const done = await status(agent, job.id);
    assert.deepEqual([done.state, done.latestMessageExcerpt], ['idle', 'Synthetic: the refactor is merged']);
    assert.equal(gw.services.jobs.store.openJobForThread(child.threadId), undefined, 'child threads are not jobs');
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
    assert.match(before.attention.find((entry) => entry.jobId === job.id)?.why ?? '', /If it says it delegated work or is waiting, send nothing/);

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
    const { job } = await adopt(harness, threadId);
    assert.deepEqual([job.state, job.delegatedWork.map((task) => task.title)], ['idle', ['Synthetic migration task']], 'found on an earlier page');
    assert.equal(job.latestMessageExcerpt, 'Synthetic answer 149');

    fake.finishDelegated(childThreadId, 'Synthetic migration summary');
    gw.clock.advance(2 * MINUTE);
    await tick();
    const resumed = await status(agent, job.id);
    assert.deepEqual([resumed.state, resumed.waitingOnDelegatedWork], ['running', false]);
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
