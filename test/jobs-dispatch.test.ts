import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inputHash, threadTitle } from '../src/jobs/service.ts';
import { MINUTE } from '../src/time.ts';
import { assertNotLogged, connectAgent, jobState, startJob, startJobHarness } from './helpers/jobs.ts';

describe('work_start', () => {
  test('queues a job, then the dispatcher launches it in a fresh worktree and it runs', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t);
    const task = 'Synthetic task: rename the helper\nand update its callers.';
    const { job, created } = await agent.call<{ job: { jobId: string; state: string; branch: string; title: string; startedByYou: boolean }; created: boolean }>(
      'work_start',
      { project: 'pilot', task, requestId: 'req-1' },
    );
    assert.equal(created, true);
    assert.equal(job.state, 'queued');
    assert.match(job.jobId, /^[0-9a-hjkmnp-tv-z]{10}$/);
    assert.equal(job.branch, `fleet/${job.jobId}`);
    assert.equal(job.title, `Synthetic task: rename the helper [job:${job.jobId}]`);
    assert.equal(job.startedByYou, true);

    await tick();
    assert.equal(fake.launches.length, 1);
    assert.deepEqual(fake.launches[0], {
      projectId: 'project-1',
      title: job.title,
      workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: job.branch, startFromOrigin: false },
      runtimeMode: 'auto',
      message: `${task}\n\n---\nStarted through t3-fleet-gateway as job ${job.jobId}, in a fresh worktree on branch ${job.branch}.`,
    });
    const status = await agent.call<{ state: string; threadId: string; recentEvents: { type: string; fromState: string | null; toState: string; reason: string | null }[] }>(
      'work_status',
      { jobId: job.jobId },
    );
    assert.equal(status.state, 'running');
    assert.equal(status.threadId, fake.threadForJob(job.jobId).threadId);
    assert.deepEqual(
      status.recentEvents.map((event) => [event.type, event.fromState, event.toState, event.reason]),
      [
        ['created', null, 'queued', null],
        ['state_changed', 'queued', 'dispatching', null],
        ['state_changed', 'dispatching', 'running', 'launched'],
      ],
    );
    assertNotLogged(gw, [task, 'rename the helper']);
  });

  test('resolves projects by title and passes the project model selection and branch prefix', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const { job } = await agent.call<{ job: { jobId: string; title: string } }>('work_start', {
      project: 'docs',
      task: 'Synthetic docs task',
      requestId: 'req-docs',
      title: 'Short title',
    });
    assert.equal(job.title, `Short title [job:${job.jobId}]`);
    await tick();
    assert.deepEqual(fake.launches[0]?.workspaceStrategy, { type: 'worktree', baseRef: 'trunk', branch: `agents/${job.jobId}`, startFromOrigin: false });
    assert.equal(fake.launches[0]?.projectId, 'project-2');
    assert.equal(fake.launches[0]?.runtimeMode, 'approval-required');
    assert.deepEqual(fake.launches[0]?.modelSelection, { model: 'synthetic-large' });
  });

  test('is idempotent on requestId: same input returns the same job, different input is rejected', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t);
    const input = { project: 'pilot', task: 'Synthetic idempotent task', requestId: 'req-same' };
    const first = await agent.call<{ job: { jobId: string }; created: boolean }>('work_start', input);
    await tick();
    const again = await agent.call<{ job: { jobId: string; state: string }; created: boolean }>('work_start', input);
    assert.equal(again.created, false);
    assert.equal(again.job.jobId, first.job.jobId);
    assert.equal(again.job.state, 'running');
    const changed = await agent.callError('work_start', { ...input, task: 'A different synthetic task' });
    assert.equal(changed.code, 'request_id_conflict');
    await tick();
    assert.equal(fake.launches.length, 1, 'launched exactly once');
    assert.equal((await agent.call<{ jobs: unknown[] }>('work_list', {})).jobs.length, 1);

    // Request ids are scoped to the agent: another agent may use the same one.
    const other = await connectAgent(t, gw, 'operate');
    const theirs = await other.call<{ job: { jobId: string }; created: boolean }>('work_start', input);
    assert.equal(theirs.created, true);
    assert.notEqual(theirs.job.jobId, first.job.jobId);
  });

  test('rejects unknown projects and oversized input', async (t) => {
    const { agent } = await startJobHarness(t);
    const unknown = await agent.callError('work_start', { project: 'nope', task: 'x', requestId: 'r1' });
    assert.equal(unknown.code, 'not_found');
    assert.match(unknown.text, /Known projects: pilot, docs/);
    const huge = await agent.client.callTool({ name: 'work_start', arguments: { project: 'pilot', task: 'x'.repeat(20_001), requestId: 'r2' } });
    assert.equal(huge.isError, true);
    const badId = await agent.client.callTool({ name: 'work_start', arguments: { project: 'pilot', task: 'x', requestId: 'has spaces' } });
    assert.equal(badId.isError, true);
  });

  test('a Read agent can list and inspect jobs but cannot start one', async (t) => {
    const { gw, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    const reader = await connectAgent(t, gw, 'read');
    const denied = await reader.callError('work_start', { project: 'pilot', task: 'x', requestId: 'r' });
    assert.equal(denied.code, 'insufficient_scope');
    assert.match(denied.text, /fleet:operate/);
    const listed = await reader.call<{ jobs: { jobId: string; startedByYou: boolean }[] }>('work_list', {});
    assert.deepEqual(listed.jobs.map((item) => [item.jobId, item.startedByYou]), [[job.jobId, false]]);
    assert.equal(await jobState(reader, job.jobId), 'running');
  });
});

describe('dispatcher', () => {
  test('keeps a job queued when the host cannot be reached, then launches it when the host is back', async (t) => {
    const { fake, gw, agent, tick, tickAfter } = await startJobHarness(t);
    await fake.stop();
    const job = await startJob(agent);
    await tick();
    const status = await agent.call<{ state: string; hostUnreachableSince: string | null }>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'queued');
    assert.ok(status.hostUnreachableSince, 'the observation is recorded on the job');
    assert.equal(fake.threads.size, 0);
    assert.ok(gw.logs.some((line) => line.includes('"event":"jobs.host_unreachable"')));

    await fake.start();
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'queued', 'backing off: no attempt before the backoff expires');
    await tickAfter(MINUTE);
    const after = await agent.call<{ state: string; hostUnreachableSince: string | null }>('work_status', { jobId: job.jobId });
    assert.equal(after.state, 'running');
    assert.equal(after.hostUnreachableSince, null);
  });

  test('a T3 launch error fails the job with the T3 code once a lookup finds no thread', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    fake.failures.set('t3_thread_launch', { code: 'invalid_workspace', message: 'Base ref not found.' });
    const job = await startJob(agent);
    await tick();
    const status = await agent.call<{ state: string; lastError: { code: string; message: string }; finishedAt: string | null }>('work_status', {
      jobId: job.jobId,
    });
    assert.equal(status.state, 'failed');
    assert.equal(status.lastError.code, 'invalid_workspace');
    assert.match(status.lastError.message, /Base ref not found/);
    assert.ok(status.finishedAt);
    assert.ok(fake.calls.includes('t3_thread_list'), 'looked for the marker first');
  });

  test('a T3 launch error after the thread was created continues the job on that thread', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    fake.failuresAfterEffect.set('t3_thread_launch', { code: 'internal_error', message: 'Synthetic failure after creating the thread.' });
    const job = await startJob(agent);
    await tick();
    const status = await agent.call<{ state: string; threadId: string; lastError: unknown; recentEvents: { reason: string | null }[] }>('work_status', {
      jobId: job.jobId,
    });
    assert.equal(status.state, 'running');
    assert.equal(status.threadId, fake.threadForJob(job.jobId).threadId);
    assert.equal(status.lastError, null);
    assert.equal(status.recentEvents.at(-1)?.reason, 'reconciled');
    assert.equal(fake.launches.length, 1);
  });

  test('a refusal T3 makes before creating anything fails the job at once, without a lookup', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    fake.failures.set('t3_thread_launch', {
      code: 'invalid_request',
      message: 'Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.',
    });
    const job = await startJob(agent);
    await tick();
    const status = await agent.call<{ state: string; lastError: { code: string; message: string } }>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'failed');
    assert.equal(status.lastError.code, 'invalid_request');
    assert.equal(fake.calls.includes('t3_thread_list'), false);
  });

  test('a lost launch response makes the job unknown and it is never relaunched automatically', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    fake.dropResponseOnce.add('t3_thread_launch');
    await tick();
    const status = await agent.call<{ state: string; lastError: { code: string } }>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'unknown');
    assert.equal(status.lastError.code, 't3_response_lost');
    assert.equal(fake.threads.size, 1, 'the launch did happen');
    await tick();
    assert.equal(fake.launches.length, 1, 'no second launch');
  });

  test('fails a job whose project does not resolve on the host', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    fake.projects.splice(1, 1);
    const { job } = await agent.call<{ job: { jobId: string } }>('work_start', { project: 'docs', task: 'Synthetic', requestId: 'r-docs' });
    await tick();
    const status = await agent.call<{ state: string; lastError: { code: string } }>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'failed');
    assert.equal(status.lastError.code, 'project_not_found');
  });
});

describe('job helpers', () => {
  test('thread titles use the first non-empty task line, bounded, plus the marker', () => {
    assert.equal(threadTitle('abc', '\n  Fix   the bug \nmore', undefined), 'Fix the bug [job:abc]');
    const long = threadTitle('abc', 'x'.repeat(200), undefined);
    assert.equal(long, `${'x'.repeat(59)}… [job:abc]`);
  });

  test('thread titles drop anything shaped like a job marker from the agent text', () => {
    assert.equal(threadTitle('abc', 'Task', 'Redo [job:other1] now'), 'Redo now [job:abc]');
    assert.equal(threadTitle('abc', 'Task', '[ JOB : other1 ]'), 'Task [job:abc]', 'an empty title falls back to the task');
    assert.equal(threadTitle('abc', '[job:other1]\nSecond line', undefined), 'Second line [job:abc]');
    assert.equal(threadTitle('abc', '[job:other1]', undefined), 'Job [job:abc]');
  });

  test('input hashes ignore key order and distinguish values', () => {
    assert.equal(inputHash('t', { a: 1, b: 2 }), inputHash('t', { b: 2, a: 1 }));
    assert.notEqual(inputHash('t', { a: 1 }), inputHash('t', { a: 2 }));
    assert.equal(inputHash('t', { a: undefined }), inputHash('t', { a: null }));
  });
});
