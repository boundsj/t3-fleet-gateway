import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestGateway } from './helpers/gateway.ts';
import { assertNotLogged, startJobHarness } from './helpers/jobs.ts';

test('launches prepend standing instructions, preserve caller titles, and leave follow-ups unchanged', async (t) => {
  const standingInstructions = 'Synthetic operator rule: keep review artifacts.\nUse concise commit messages.';
  const { fake, gw, agent, tick } = await startJobHarness(t, { standingInstructions });
  const task = 'Synthetic caller task';
  const input = { project: 'pilot', task, requestId: 'standing-start' };
  const first = await agent.call<{ job: { jobId: string; title: string; branch: string } }>('work_start', input);
  await tick();
  const job = first.job;
  assert.equal(fake.launches[0]?.message,
    `<operator-standing-instructions>\n${standingInstructions}\n</operator-standing-instructions>\n\n${task}\n\n---\n` +
    `Started through t3-fleet-gateway as job ${job.jobId}, in a fresh worktree on branch ${job.branch}.`);
  assert.equal(job.title, `${task} [job:${job.jobId}]`);
  const again = await agent.call<{ job: { jobId: string }; created: boolean }>('work_start', input);
  assert.equal(again.job.jobId, job.jobId);
  assert.equal(again.created, false);
  fake.finishTurn(fake.threadForJob(job.jobId).threadId, 'Synthetic reply');
  await tick();
  const message = 'Synthetic follow-up';
  await agent.call('work_continue', { jobId: job.jobId, message, requestId: 'standing-followup' });
  assert.equal(fake.sends[0]?.message, message);
  assertNotLogged(gw, [standingInstructions, task, message]);
});

test('changed configuration after restart preserves request-id replay and uses dispatch-time instructions', async (t) => {
  const first = await startJobHarness(t, { standingInstructions: 'Synthetic old rule.' });
  const input = { project: 'pilot', task: 'Synthetic queued task', requestId: 'standing-restart' };
  const original = await first.agent.call<{ job: { jobId: string } }>('work_start', input);
  await first.gw.gateway.close();
  const next = await startTestGateway(t, {
    dataDir: first.gw.dataDir, door: first.gw.door, clock: first.gw.clock,
    config: { ...first.gw.services.config, standingInstructions: 'Synthetic new rule.' },
    jobEngine: { autoStart: false },
  });
  // Replay as the original authorized caller without reusing a closed MCP transport.
  const replay = await next.services.jobs.start({ clientId: first.agent.clientId, scopes: ['fleet:read', 'fleet:operate'] }, input);
  assert.equal(replay.job.id, original.job.jobId);
  assert.equal(replay.created, false);
  await next.gateway.engine.tick();
  assert.equal(first.fake.launches.length, 1);
  assert.match(String(first.fake.launches[0]?.message), /^<operator-standing-instructions>\nSynthetic new rule\./);
  assert.equal(String(first.fake.launches[0]?.message).includes('Synthetic old rule.'), false);
});

test('maximum task and instructions fit T3 and adoption sends no instruction message', async (t) => {
  const { fake, gw, agent, tick } = await startJobHarness(t, { standingInstructions: 'x'.repeat(4000) });
  await agent.call('work_start', { project: 'pilot', task: 't'.repeat(20_000), requestId: 'standing-max' });
  await tick();
  assert.ok(String(fake.launches[0]?.message).length < 120_000);
  const { threadId } = fake.launchDirect({ projectId: 'project-1', title: 'Synthetic existing thread', message: 'Synthetic existing task' });
  fake.finishTurn(threadId, 'Synthetic existing reply');
  const adopted = await gw.services.jobs.adopt({ project: 'pilot', threadId });
  assert.equal(fake.sends.length, 0, 'adoption only reads the existing conversation');
  await agent.call('work_continue', { jobId: adopted.job.id, message: 'Synthetic adopted follow-up', requestId: 'standing-adopted' });
  assert.equal(fake.sends[0]?.message, 'Synthetic adopted follow-up');
});

test('standing instructions and native attachments reach the same initial turn', async (t) => {
  const { fake, agent, tick } = await startJobHarness(t, { standingInstructions: 'Synthetic shared rule.' });
  const bytes = Buffer.from('Synthetic attachment content');
  await agent.call('work_start', {
    project: 'pilot', task: 'Synthetic task with a file', requestId: 'standing-attachment',
    attachments: [{ name: 'notes.txt', mimeType: 'text/plain', data: bytes.toString('base64') }],
  });
  await tick();
  const launch = fake.launches[0]!;
  assert.match(String(launch.message), /^<operator-standing-instructions>\nSynthetic shared rule\.\n<\/operator-standing-instructions>\n\nSynthetic task with a file/);
  const sent = launch.attachments as { id: string; type: string }[];
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, 'file');
  assert.deepEqual(fake.uploads.get(sent[0]!.id)?.bytes, bytes);
  const replay = await agent.call<{ created: boolean }>('work_start', {
    project: 'pilot', task: 'Synthetic task with a file', requestId: 'standing-attachment',
    attachments: [{ name: 'notes.txt', mimeType: 'text/plain', data: bytes.toString('base64') }],
  });
  assert.equal(replay.created, false);
  assert.equal(fake.launches.length, 1);
});
