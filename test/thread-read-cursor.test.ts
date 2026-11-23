import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { startJob, startJobHarness } from './helpers/jobs.ts';

// T3 PR #41378: a t3_thread_read with neither cursor returns the newest page to every caller. Forward scans
// must say "from the start" (afterPosition -1, accepted since T3 v0.1.10); v0.1.9 and older refuse -1 and
// read a cursorless request from the start. The fake models all three (`threadReadCursor`).
const MODES = ['newest', 'forward', 'legacy'] as const;
type Mode = (typeof MODES)[number];

async function harness(t: TestContext, mode: Mode, budget = false) {
  const fake = await startFakeT3();
  t.after(() => fake.close());
  fake.threadReadCursor = mode;
  fake.budgetThreadReads = budget;
  return startJobHarness(t, { fake });
}

/** `count` finished exchanges, each with a long reply so a budgeted read returns fewer items than asked. */
function exchanges(fake: Awaited<ReturnType<typeof startFakeT3>>, threadId: string, count: number) {
  for (let i = 0; i < count; i++) {
    fake.userTurn(threadId, `Synthetic question ${i}`);
    fake.finishTurn(threadId, `Synthetic answer ${i} ${'x'.repeat(600)}`);
  }
}

for (const mode of MODES) {
  test(`${mode}: a read from the start returns the first items; state, item and forward reads are unchanged`, async (t) => {
    const { fake, gw, agent, tick } = await harness(t, mode);
    const job = await startJob(agent);
    await tick();
    const threadId = gw.services.jobs.store.require(job.jobId).threadId!;
    exchanges(fake, threadId, 80);
    const client = gw.services.registry.client('main');
    const before = fake.reads.length;

    const first = await client.readThread({ threadId, view: 'messages', afterPosition: null, limit: 100, maxCharsPerItem: 1 });
    assert.equal(first.items[0]?.position, 0);
    assert.equal(first.hasMore, true);
    const second = await client.readThread({ threadId, view: 'messages', afterPosition: first.nextPosition, limit: 100, maxCharsPerItem: 1 });
    assert.equal(second.items[0]?.position, first.nextPosition! + 1);
    const state = await client.readThread({ threadId, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 1 });
    const last = fake.threads.get(threadId)!.items.at(-1)!;
    // The premise of the fix: on current T3 a cursorless read is the newest page.
    assert.equal(state.items[0]?.position, mode === 'newest' ? last.position : 0);
    await client.readThread({ threadId, view: 'messages', itemId: last.itemId, textOffset: 1, maxCharsPerItem: 10 });

    assert.deepEqual(
      fake.reads.slice(before).map((read) => [read.afterPosition, read.itemId]),
      [[mode === 'legacy' ? undefined : -1, undefined], [first.nextPosition, undefined], [undefined, undefined], [undefined, last.itemId]],
    );
  });

  test(`${mode}: the watcher's first look pages forward through budgeted reads and finds an older still-running delegated task`, async (t) => {
    const { fake, gw, agent, tick, tickAfter } = await harness(t, mode, true);
    const job = await startJob(agent);
    await tick();
    const threadId = gw.services.jobs.store.require(job.jobId).threadId!;
    const stored = gw.services.jobs.store.require(job.jobId);
    assert.deepEqual([stored.readPosition, stored.activityPosition], [null, null], 'nothing observed yet');
    fake.delegate(threadId, 'Synthetic early task');
    fake.addActivity(threadId, 'reasoning', 150);
    exchanges(fake, threadId, 60);
    const before = fake.reads.length;
    await tick();
    const reads = fake.reads.slice(before);
    for (const view of ['messages', 'activity']) {
      assert.equal(reads.find((read) => read.view === view)?.afterPosition, mode === 'legacy' ? undefined : -1, `${view} starts at the first item`);
    }
    assert.ok(reads.filter((read) => read.view === 'messages').length > 1, 'budgeted messages pages');
    const status = await agent.call<{ waitingOnDelegatedWork: boolean; delegatedTasks: string[] }>('work_status', { jobId: job.jobId });
    assert.equal(status.waitingOnDelegatedWork, true);
    assert.deepEqual(status.delegatedTasks, ['Synthetic early task']);
    for (let i = 0; i < 5; i++) await tickAfter(60_001);
    const last = fake.threads.get(threadId)!.items.at(-1)!;
    assert.equal(gw.services.jobs.store.require(job.jobId).readPosition, last.position, 'messages caught up to the end');
    const latest = await agent.call<{ latestMessageExcerpt: string }>('work_status', { jobId: job.jobId });
    assert.match(latest.latestMessageExcerpt, /^Synthetic answer 59 /);
  });

  test(`${mode}: work_settle refuses a thread whose older delegated task is still running`, async (t) => {
    const { fake, gw, agent, tick } = await harness(t, mode);
    const job = await startJob(agent);
    await tick();
    const threadId = gw.services.jobs.store.require(job.jobId).threadId!;
    fake.finishTurn(threadId, 'Synthetic completion');
    await tick();
    // Out of the newest activity page; the watcher has not seen it.
    fake.delegate(threadId, 'Synthetic early task');
    fake.addActivity(threadId, 'reasoning', 150);
    const error = await agent.callError('work_settle', { jobId: job.jobId, requestId: 'settle-older-delegated' });
    assert.equal(error.code, 'job_state_conflict');
    assert.match(error.text, /delegated work/);
    assert.equal(fake.calls.includes('t3_thread_organize'), false);
  });
}
