import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { MINUTE } from '../src/time.ts';
import { freePort } from './helpers/gateway.ts';
import { assertNotLogged, jobState, startJob, startJobHarness, type JobHarness } from './helpers/jobs.ts';
import { tempDir } from './helpers/tmp.ts';

interface Status {
  state: string;
  threadId: string | null;
  latestMessageExcerpt: string | null;
  latestActivityAt: string | null;
  hostUnreachableSince: string | null;
  pendingRequests: { requestId: string }[];
  waitingForApproval: boolean;
  lastError: { code: string; message: string } | null;
  recentEvents: { type: string; fromState: string | null; toState: string | null; reason: string | null }[];
}

describe('watcher', () => {
  test('a job runs, finishes its turn and goes idle with an excerpt of the final message', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent, 'Synthetic task: tidy the changelog');
    await tick();
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'running');
    const summary = 'Synthetic worker summary: changelog tidied, tests pass.';
    fake.finishTurn(fake.threadForJob(job.jobId).threadId, summary);
    await tick();
    const status = await agent.call<Status>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'idle');
    assert.equal(status.latestMessageExcerpt, summary);
    assert.ok(status.latestActivityAt);
    assert.deepEqual(status.recentEvents.at(-1), { ...status.recentEvents.at(-1), type: 'state_changed', fromState: 'running', toState: 'idle', reason: 'completed' });
    await tick();
    assert.equal(status.recentEvents.length, (await agent.call<Status>('work_status', { jobId: job.jobId })).recentEvents.length, 'no event without a change');
    assertNotLogged(gw, ['tidy the changelog', summary]);
  });

  test('bounds the excerpt and never skips a message that was still streaming when read', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    const { threadId } = fake.threadForJob(job.jobId);
    const item = fake.streamAssistant(threadId, 'Synthetic partial');
    await tick();
    assert.equal((await agent.call<Status>('work_status', { jobId: job.jobId })).latestMessageExcerpt, null, 'unsettled items are not taken');
    const full = `Synthetic final ${'x'.repeat(5000)}`;
    fake.settleItem(threadId, item.position, full);
    fake.endTurn(threadId);
    await tick();
    const status = await agent.call<Status>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'idle');
    assert.equal(status.latestMessageExcerpt, full.slice(0, 2000), 'the settled message is read again and bounded');
  });

  test('a question or an approval puts the job in needs_input; a failed run fails it', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const asking = await startJob(agent);
    const approving = await startJob(agent);
    await tick();
    const requestId = fake.askQuestion(fake.threadForJob(asking.jobId).threadId, [
      { id: 'q1', header: 'Choice', question: 'Synthetic question?', options: [{ label: 'Yes', description: 'go' }] },
    ]);
    fake.requestApproval(fake.threadForJob(approving.jobId).threadId);
    await tick();
    const asked = await agent.call<Status>('work_status', { jobId: asking.jobId });
    assert.equal(asked.state, 'needs_input');
    assert.deepEqual(asked.pendingRequests.map((request) => request.requestId), [requestId]);
    assert.equal(asked.waitingForApproval, false);
    const blocked = await agent.call<Status>('work_status', { jobId: approving.jobId });
    assert.equal(blocked.state, 'needs_input');
    assert.equal(blocked.waitingForApproval, true);
    assert.equal(blocked.recentEvents.at(-1)?.reason, 'approval');

    fake.grantApprovals(fake.threadForJob(approving.jobId).threadId);
    await tick();
    assert.equal(await jobState(agent, approving.jobId), 'running');
    fake.failRun(fake.threadForJob(approving.jobId).threadId);
    await tick();
    const failed = await agent.call<Status>('work_status', { jobId: approving.jobId });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.lastError?.code, 't3_run_failed');
  });

  test('records a turn finished from T3 itself while the job was idle', async (t) => {
    const { fake, agent, tick, tickAfter } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    const { threadId } = fake.threadForJob(job.jobId);
    fake.finishTurn(threadId, 'Synthetic first answer');
    await tick();
    // Someone continues the thread in T3 and it finishes between two idle polls.
    fake.userTurn(threadId, 'Synthetic follow-up typed in T3');
    fake.finishTurn(threadId, 'Synthetic second answer');
    await tick();
    assert.equal((await agent.call<Status>('work_status', { jobId: job.jobId })).latestMessageExcerpt, 'Synthetic first answer', 'idle jobs are polled less often');
    await tickAfter(2 * MINUTE);
    const status = await agent.call<Status>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'idle');
    assert.equal(status.latestMessageExcerpt, 'Synthetic second answer');
    assert.deepEqual(status.recentEvents.at(-1), { ...status.recentEvents.at(-1), type: 'turn_finished', fromState: 'idle', toState: 'idle' });
  });

  test('concurrency: a host runs at most maxConcurrentJobs; the next queued job starts when a slot frees', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t, { maxConcurrentJobs: 1 });
    const first = await startJob(agent, 'Synthetic first');
    const second = await startJob(agent, 'Synthetic second');
    await tick();
    assert.equal(await jobState(agent, first.jobId), 'running');
    assert.equal(await jobState(agent, second.jobId), 'queued');
    const fleet = await agent.call<{ hosts: { runningJobs: number; queuedJobs: number }[] }>('fleet_status');
    assert.deepEqual([fleet.hosts[0]?.runningJobs, fleet.hosts[0]?.queuedJobs], [1, 1]);
    await tick();
    assert.equal(fake.launches.length, 1, 'still one launch while the slot is held');

    fake.finishTurn(fake.threadForJob(first.jobId).threadId, 'Synthetic done');
    await tick();
    assert.equal(await jobState(agent, first.jobId), 'idle');
    assert.equal(await jobState(agent, second.jobId), 'running', 'idle frees the slot in the same tick');
    assert.equal(fake.launches[1]?.message?.toString().startsWith('Synthetic second'), true);
  });

  test('a host going away does not change job states; watching resumes when it is back', async (t) => {
    const { fake, agent, tick, tickAfter } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    const port = Number(new URL(fake.url).port);
    await fake.stop();
    await tick();
    await tickAfter(10 * MINUTE);
    const away = await agent.call<Status>('work_status', { jobId: job.jobId });
    assert.equal(away.state, 'running');
    assert.ok(away.hostUnreachableSince);
    const fleet = await agent.call<{ hosts: { reachable: boolean | null }[] }>('fleet_status');
    assert.equal(fleet.hosts[0]?.reachable, false);

    await fake.start(port);
    fake.finishTurn(fake.threadForJob(job.jobId).threadId, 'Synthetic result after the outage');
    await tickAfter(10 * MINUTE);
    const back = await agent.call<Status>('work_status', { jobId: job.jobId });
    assert.equal(back.state, 'idle');
    assert.equal(back.hostUnreachableSince, null);
  });
});

describe('reconciliation', () => {
  test('a lost launch response is reconciled to running by finding the marker, without relaunching', async (t) => {
    const { fake, agent, tick, tickAfter } = await startJobHarness(t);
    const job = await startJob(agent);
    fake.dropResponseOnce.add('t3_thread_launch');
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'unknown');
    await tickAfter(MINUTE);
    const status = await agent.call<Status>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'running');
    assert.equal(status.threadId, fake.threadForJob(job.jobId).threadId);
    assert.equal(status.lastError, null);
    assert.equal(status.recentEvents.at(-1)?.reason, 'reconciled');
    assert.equal(fake.launches.length, 1);
  });

  test('finds the thread by search when the title filter misses it', async (t) => {
    const { fake, agent, tick, tickAfter } = await startJobHarness(t);
    const job = await startJob(agent);
    fake.dropResponseOnce.add('t3_thread_launch');
    await tick();
    fake.failures.set('t3_thread_list', { code: 'unavailable', message: 'synthetic' });
    await tickAfter(MINUTE);
    assert.equal(await jobState(agent, job.jobId), 'unknown', 'a T3 tool failure during reconciliation changes nothing');
    fake.failures.delete('t3_thread_list');
    const thread = fake.threadForJob(job.jobId);
    thread.title = `Renamed by someone ${thread.title.slice(thread.title.indexOf('[job:'))}`;
    await tickAfter(MINUTE);
    assert.equal(await jobState(agent, job.jobId), 'running');
  });

  test('a launch that never happened fails with launch_not_confirmed after the window', async (t) => {
    const { fake, agent, tick, tickAfter } = await startJobHarness(t, { watcher: { reconcileWindowMinutes: 10 } });
    const job = await startJob(agent);
    fake.statusOnce.set('t3_thread_launch', 502);
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'unknown');
    await tickAfter(MINUTE);
    await tickAfter(9 * MINUTE);
    assert.equal(await jobState(agent, job.jobId), 'unknown', 'still inside the window');
    await tickAfter(MINUTE);
    const status = await agent.call<Status>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'failed');
    assert.equal(status.lastError?.code, 'launch_not_confirmed');
    assert.equal(fake.threads.size, 0, 'never relaunched');
  });

  test('time the host is unreachable does not count toward the window', async (t) => {
    const { fake, agent, tick, tickAfter } = await startJobHarness(t, { watcher: { reconcileWindowMinutes: 10 } });
    const job = await startJob(agent);
    fake.statusOnce.set('t3_thread_launch', 502);
    await tick();
    await tickAfter(MINUTE);
    const port = Number(new URL(fake.url).port);
    await fake.stop();
    await tickAfter(20 * MINUTE);
    await fake.start(port);
    await tickAfter(10 * MINUTE);
    assert.equal(await jobState(agent, job.jobId), 'unknown', 'the window restarted when the host came back');
    await tickAfter(11 * MINUTE);
    assert.equal(await jobState(agent, job.jobId), 'failed');
  });
});

/** Stop a harness's gateway as a restart would, letting pooled client sockets see the close. */
async function stopGateway(harness: JobHarness): Promise<void> {
  await harness.agent.client.close();
  await harness.gw.gateway.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('restart recovery', () => {
  test('a gateway restarted mid-job resumes watching the same job', async (t) => {
    const dataDir = join(tempDir(t), 'data');
    const port = await freePort();
    const first = await startJobHarness(t, { dataDir, port });
    const job = await startJob(first.agent, 'Synthetic restart task');
    await first.tick();
    assert.equal(await jobState(first.agent, job.jobId), 'running');
    await stopGateway(first);

    first.fake.finishTurn(first.fake.threadForJob(job.jobId).threadId, 'Synthetic result while the gateway was down');
    const second = await startJobHarness(t, { dataDir, port, fake: first.fake });
    await second.tick();
    const status = await second.agent.call<Status>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'idle');
    assert.equal(status.latestMessageExcerpt, 'Synthetic result while the gateway was down');
    assert.equal(first.fake.launches.length, 1);
  });

  test('a job left dispatching by a crash is reconciled at startup', async (t) => {
    const dataDir = join(tempDir(t), 'data');
    const port = await freePort();
    const first = await startJobHarness(t, { dataDir, port });
    const job = await startJob(first.agent);
    await stopGateway(first);
    // Simulate a crash after the launch reached T3 but before the gateway recorded the result.
    const { db } = (await import('../src/gateway.ts')).openStorage(dataDir);
    db.prepare("UPDATE jobs SET state = 'dispatching', t3_project_id = 'project-1', dispatch_started_at = 1 WHERE id = ?").run(job.jobId);
    db.close();
    first.fake.launchDirect({
      projectId: 'project-1',
      title: job.title,
      workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: job.branch, startFromOrigin: false },
      message: 'Synthetic',
    });

    const second = await startJobHarness(t, { dataDir, port, fake: first.fake });
    await second.tick();
    const status = await second.agent.call<Status>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'running');
    assert.deepEqual(
      status.recentEvents.slice(-2).map((event) => [event.fromState, event.toState, event.reason]),
      [
        ['dispatching', 'unknown', 'dispatch_interrupted'],
        ['unknown', 'running', 'reconciled'],
      ],
    );
    assert.equal(first.fake.launches.length, 1);
  });
});
