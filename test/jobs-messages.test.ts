import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertNotLogged, connectAgent, startJob, startJobHarness, type Agent } from './helpers/jobs.ts';

interface Message {
  position: number;
  type: string;
  status: string;
  text: string;
  textTruncated: boolean;
  length: number | null;
}

interface Page {
  job: { jobId: string; state: string };
  messages: Message[];
  earlier: number | null;
  later: number | null;
  hasMore: boolean;
}

interface Status {
  state: string;
  latestMessageExcerpt: string | null;
  excerptTruncated: boolean;
}

const messages = (agent: Agent, jobId: string, args: Record<string, unknown> = {}) => agent.call<Page>('work_messages', { jobId, ...args });

async function summaryText(agent: Agent, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await agent.client.callTool({ name, arguments: args });
  return (result.content as { text: string }[])[0]?.text ?? '';
}

describe('work_messages', () => {
  test('reads the latest reply in full when the excerpt is cut, and pages back through earlier replies', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t);
    const task = 'Synthetic-task-text-31c7: write the report';
    const followUp = 'Synthetic-follow-up-8e2a: shorten it';
    const job = await startJob(agent, task);
    await tick();
    const { threadId } = fake.threadForJob(job.jobId);
    const long = `Synthetic long reply ${'y'.repeat(6000)} end`;
    fake.finishTurn(threadId, long);
    await tick();

    const status = await agent.call<Status>('work_status', { jobId: job.jobId });
    assert.deepEqual([status.state, status.latestMessageExcerpt, status.excerptTruncated], ['idle', long.slice(0, 2000), true]);
    assert.match(await summaryText(agent, 'work_status', { jobId: job.jobId }), /cut short, read it in full with work_messages/);
    const latest = await messages(agent, job.jobId);
    assert.deepEqual(
      latest.messages.map((message) => [message.type, message.status, message.text, message.textTruncated, message.length]),
      [['assistant_message', 'completed', long, false, long.length]],
    );
    assert.deepEqual([latest.earlier, latest.hasMore], [null, false], 'the task is not a worker message, so nothing is older');
    assert.ok((await summaryText(agent, 'work_messages', { jobId: job.jobId })).includes(long), 'the text summary carries the message');

    await agent.call('work_continue', { jobId: job.jobId, message: followUp, requestId: 'more' });
    fake.finishTurn(threadId, 'Synthetic short reply');
    await tick();
    const shortStatus = await agent.call<Status>('work_status', { jobId: job.jobId });
    assert.deepEqual([shortStatus.latestMessageExcerpt, shortStatus.excerptTruncated], ['Synthetic short reply', false]);

    const newest = await messages(agent, job.jobId);
    assert.deepEqual(newest.messages.map((message) => message.text), ['Synthetic short reply']);
    assert.equal(newest.hasMore, true);
    assert.equal(newest.earlier, newest.messages[0]?.position);
    const older = await messages(agent, job.jobId, { before: newest.earlier });
    assert.deepEqual([older.messages.map((message) => message.text), older.earlier, older.hasMore], [[long], null, false]);
    const both = await messages(agent, job.jobId, { limit: 5 });
    assert.deepEqual(both.messages.map((message) => message.text), [long, 'Synthetic short reply'], 'oldest first, without the messages sent');

    const cut = await messages(agent, job.jobId, { before: newest.earlier, maxChars: 100 });
    assert.deepEqual(cut.messages.map((message) => [message.text, message.textTruncated, message.length]), [[long.slice(0, 100), true, null]]);
    assertNotLogged(gw, [task, followUp, long.slice(0, 40), 'Synthetic short reply']);
  });

  test('pages back across long stretches of activity, picking up where a bounded scan stopped', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    const { threadId } = fake.threadForJob(job.jobId);
    fake.finishTurn(threadId, 'Synthetic first reply');
    // Items the messages view leaves out still take positions: 2,500 of them span more than one scan.
    fake.addActivity(threadId, 'command_execution', 2500);
    fake.finishTurn(threadId, 'Synthetic second reply');
    for (let i = 0; i < 4; i++) await tick();

    const latest = await messages(agent, job.jobId);
    assert.deepEqual([latest.messages.map((message) => message.text), latest.hasMore], [['Synthetic second reply'], true]);
    const gap = await messages(agent, job.jobId, { before: latest.earlier });
    assert.deepEqual(gap.messages, [], 'one call scans 2,000 positions back');
    assert.equal(gap.hasMore, true);
    assert.ok(gap.earlier !== null && gap.earlier > 0 && gap.earlier < (latest.earlier ?? 0));
    const first = await messages(agent, job.jobId, { before: gap.earlier });
    assert.deepEqual([first.messages.map((message) => message.text), first.earlier, first.hasMore], [['Synthetic first reply'], null, false]);
  });

  test('reads on with after, stopping before a message still being written until it is finished', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t);
    const job = await startJob(agent);
    await tick();
    const { threadId } = fake.threadForJob(job.jobId);
    fake.finishTurn(threadId, 'Synthetic reply 1');
    await tick();
    const start = await messages(agent, job.jobId);
    assert.equal(start.later, start.messages[0]?.position);
    const quiet = await messages(agent, job.jobId, { after: start.later });
    assert.deepEqual([quiet.messages, quiet.later, quiet.hasMore], [[], start.later, false]);

    fake.userTurn(threadId, 'Synthetic-person-message: one more thing');
    const item = fake.streamAssistant(threadId, 'Synthetic partial');
    const writing = await messages(agent, job.jobId, { after: String(start.later) });
    assert.deepEqual(writing.messages.map((message) => [message.text, message.status]), [['Synthetic partial', 'running']]);
    assert.deepEqual([writing.later, writing.hasMore], [item.position - 1, true]);

    fake.settleItem(threadId, item.position, 'Synthetic reply 2, finished');
    fake.endTurn(threadId);
    const done = await messages(agent, job.jobId, { after: writing.later });
    assert.deepEqual(done.messages.map((message) => [message.text, message.status]), [['Synthetic reply 2, finished', 'completed']]);
    assert.deepEqual([done.later, done.hasMore], [item.position, false]);
  });

  test('Read access is enough; a job without a thread and a request for both directions are refused', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t, { maxConcurrentJobs: 1 });
    const running = await startJob(agent);
    const queued = await startJob(agent);
    await tick();
    const reader = await connectAgent(t, gw, 'read');
    assert.equal((await reader.callError('work_messages', { jobId: queued.jobId })).code, 'job_state_conflict');
    fake.finishTurn(fake.threadForJob(running.jobId).threadId, 'Synthetic reply');
    await tick();
    assert.deepEqual((await messages(reader, running.jobId)).messages.map((message) => message.text), ['Synthetic reply']);
    assert.equal((await reader.callError('work_messages', { jobId: running.jobId, before: 5, after: 1 })).code, 'invalid_argument');
    assert.equal((await reader.callError('work_messages', { jobId: 'nosuchjob00' })).code, 'not_found');
  });
});
