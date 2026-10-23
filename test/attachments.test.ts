import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, validateAttachments } from '../src/jobs/attachments.ts';
import { startInputHash } from '../src/jobs/service.ts';
import { assertNotLogged, connectAgent, startJob, startJobHarness } from './helpers/jobs.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway } from './helpers/gateway.ts';

const PNG = { name: 'picture.png', mimeType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
const FILE = { name: 'notes.txt', mimeType: 'text/plain' as const, data: Buffer.from('SYNTHETIC_ATTACHMENT_CONTENT').toString('base64') };
const attachments = [PNG, FILE];

describe('attachment validation and hashes', () => {
  test('rejects malformed base64, mismatched images, paths, URLs, MIME types and bounds with safe errors', () => {
    for (const items of [
      [{ ...FILE, data: '' }], [{ ...FILE, data: 'a===' }], [{ ...FILE, data: 'Zh==' }],
      [{ ...FILE, data: 'data:text/plain;base64,YQ==' }], [{ ...FILE, data: 'YQ==\n' }],
      [{ ...PNG, data: FILE.data }], [{ ...FILE, name: '../file' }], [{ ...FILE, name: 'a\nb' }],
      [{ ...FILE, mimeType: 'image/svg+xml' }], [{ ...FILE, url: 'https://example.test/file' }],
      Array.from({ length: 9 }, () => FILE), [{ ...FILE, data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }],
      [FILE, ...Array.from({ length: 2 }, () => ({ ...FILE, data: Buffer.alloc(MAX_TOTAL_ATTACHMENT_BYTES / 2).toString('base64') }))],
    ]) {
      assert.throws(() => validateAttachments(items as typeof attachments), (error: unknown) => {
        const e = error as { code: string; message: string };
        assert.equal(e.code, 'invalid_argument');
        assert.equal(e.message.includes(FILE.data), false);
        return true;
      });
    }
    assert.equal(validateAttachments([{ mimeType: 'text/plain', data: 'YQ==' }])[0]?.name, 'attachment-1.txt');
    assert.equal(validateAttachments([{ ...FILE, data: Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64') }]).length, 1);
  });

  test('preserves legacy text hashes, and includes ordered names, MIME types and content hashes', () => {
    const input = { project: 'pilot', task: 'Synthetic task', requestId: 'r' };
    assert.equal(startInputHash(input), startInputHash({ ...input, attachments: [] }));
    const hash = startInputHash({ ...input, attachments });
    for (const changed of [attachments.toReversed(), [PNG], [PNG, { ...FILE, name: 'other.txt' }],
      [PNG, { ...FILE, data: 'YQ==' }], [PNG, { ...FILE, mimeType: 'text/markdown' as const }]]) {
      assert.notEqual(startInputHash({ ...input, attachments: changed }), hash);
    }
  });
});

test('MCP start delivers native images and files in the initial turn; replays never upload or launch twice', async (t) => {
  const h = await startJobHarness(t);
  const first = await startJob(h.agent, 'Inspect attached files', { attachments, requestId: 'start-files' });
  assert.equal(h.fake.calls.includes('t3_attachment_prepare_upload'), false, 'acceptance stays downstream-free');
  const row = () => h.gw.services.db.prepare('SELECT payload FROM job_launch_attachments WHERE job_id = ?').get(first.jobId);
  assert.ok(row()?.payload);
  await h.tick();
  const thread = h.fake.threadForJob(first.jobId);
  const sent = thread.launch.attachments as { id: string; type: string }[];
  assert.deepEqual(sent.map((a) => a.type), ['image', 'file']);
  for (const [i, item] of sent.entries()) assert.deepEqual(h.fake.uploads.get(item.id)?.bytes, Buffer.from(attachments[i]!.data, 'base64'));
  assert.equal(row(), undefined);
  assert.equal(thread.items.filter((item) => item.type === 'user_message').length, 1, 'files ride the initial message');
  const calls = h.fake.calls.length;
  const replay = await startJob(h.agent, 'Inspect attached files', { attachments, requestId: 'start-files' });
  assert.equal(replay.jobId, first.jobId);
  assert.equal(h.fake.calls.length, calls);
  assert.equal((await h.agent.callError('work_start', { project: 'pilot', task: 'Inspect attached files', attachments: [PNG], requestId: 'start-files' })).code, 'request_id_conflict');
  const views = [await h.agent.call('work_status', { jobId: first.jobId }), await h.agent.call('work_list'), await h.agent.call('work_feed')];
  for (const value of views) assert.equal(JSON.stringify(value).includes(FILE.data), false);
  const records = JSON.stringify(h.gw.services.db.prepare('SELECT * FROM idempotency_keys').all());
  assert.equal(records.includes(FILE.data), false);
  assertNotLogged(h.gw, [FILE.name, FILE.data, 'SYNTHETIC_ATTACHMENT_CONTENT', PNG.data, ...sent.map((a) => a.id)]);
});

test('a queued attachment start survives a gateway restart; cancellation erases pending bytes', async (t) => {
  const first = await startJobHarness(t);
  const job = await startJob(first.agent, 'Synthetic restart', { attachments });
  await first.agent.client.close();
  await first.gw.gateway.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await startJobHarness(t, { fake: first.fake, dataDir: first.gw.dataDir, door: first.gw.door });
  await second.tick();
  assert.equal(second.fake.threadForJob(job.jobId).launch.attachments instanceof Array, true);
  const cancelled = await startJob(second.agent, 'Synthetic cancel', { attachments });
  await second.agent.call('work_cancel', { jobId: cancelled.jobId });
  assert.equal(second.gw.services.db.prepare('SELECT payload FROM job_launch_attachments WHERE job_id = ?').get(cancelled.jobId), undefined);
});

test('attachment follow-ups use the native API, preserve attribution and replay successful responses', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const turnsBefore = h.gw.services.db.prepare('SELECT * FROM job_turns').all();
  const args = { jobId: job.jobId, message: 'Review these files', attachments, requestId: 'follow-files' };
  const sent = await h.agent.call<{ delivery: string; replayed: boolean }>('work_continue', args);
  assert.equal(sent.delivery, 'accepted');
  assert.equal(sent.replayed, false);
  assert.equal(h.fake.attachmentSends.length, 1);
  assert.deepEqual(h.gw.services.db.prepare('SELECT * FROM job_turns').all(), turnsBefore, 'no guessed new-turn attribution');
  const replay = await h.agent.call<{ replayed: boolean }>('work_continue', args);
  assert.equal(replay.replayed, true);
  assert.equal(h.fake.attachmentSends.length, 1);
  assert.equal((await h.agent.callError('work_continue', { ...args, attachments: [PNG] })).code, 'request_id_conflict');
  assertNotLogged(h.gw, [FILE.name, FILE.data, PNG.data]);
});

test('an attachment send with a lost response never resends, including after a gateway restart', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const args = { jobId: job.jobId, message: 'Review attached', attachments, requestId: 'lost-files' };
  h.fake.dropResponseOnce.add('t3_thread_send_attachments');
  assert.equal((await h.agent.callError('work_continue', args)).code, 't3_response_lost');
  assert.equal(h.fake.attachmentSends.length, 1);
  assert.equal((await h.agent.callError('work_continue', args)).code, 't3_response_lost');
  await h.agent.client.close();
  await h.gw.gateway.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await startJobHarness(t, { fake: h.fake, dataDir: h.gw.dataDir, door: h.gw.door });
  // Reuse the original caller identity: request ids are scoped to a client.
  const caller = { clientId: h.agent.clientId, scopes: ['fleet:operate' as const] };
  await assert.rejects(second.gw.services.jobs.continue(caller, args), { code: 't3_response_lost' });
  assert.equal(h.fake.attachmentSends.length, 1);
});

test('upload failure sends no turn and allows the same follow-up request to retry safely', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const args = { jobId: job.jobId, message: 'Review attached', attachments, requestId: 'upload-failure' };
  h.fake.uploadStatus = 500;
  assert.equal((await h.agent.callError('work_continue', args)).code, 'host_unreachable');
  assert.equal(h.fake.attachmentSends.length, 0);
  h.fake.uploadStatus = 200;
  await h.agent.call('work_continue', args);
  assert.equal(h.fake.attachmentSends.length, 1);
});

test('host-supplied upload URLs cannot redirect bytes elsewhere', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  for (const url of ['https://example.test/api/attachments/upload/x', '//example.test/api/attachments/upload/x', '/api/attachments/upload/../../../mcp']) {
    h.fake.uploadRelativeUrl = url;
    const error = await h.agent.callError('work_continue', { jobId: job.jobId, message: 'Review attached', attachments, requestId: 'unsafe-url' });
    // Normalized paths must remain inside the attachment route too.
    assert.equal(error.code, 't3_invalid_response');
  }
  assert.equal(h.fake.attachmentSends.length, 0);
});

test('each host receives its own bytes over HTTP, with authorization before uploading', async (t) => {
  const local = await startFakeT3();
  const remote = await startFakeT3();
  t.after(() => local.close());
  t.after(() => remote.close());
  const gw = await startTestGateway(t, { config: {
    hosts: [{ id: 'main', t3Url: local.url, mintPairingCode: local.mintCommand() }, { id: 'host-a', t3Url: remote.url, mintPairingCode: remote.mintCommand() }],
    projects: [{ alias: 'local', host: 'main', t3ProjectId: 'project-1', runtimeMode: 'auto' },
      { alias: 'remote', host: 'host-a', t3ProjectId: 'project-1', runtimeMode: 'auto' }],
  }, jobEngine: { autoStart: false } });
  await gw.services.registry.enroll('main');
  await gw.services.registry.enroll('host-a');
  const agent = await connectAgent(t, gw);
  for (const [project, fake] of [['local', local], ['remote', remote]] as const) {
    const job = await startJob(agent, 'Inspect', { project, attachments });
    await gw.gateway.engine.tick();
    await agent.call('work_continue', { jobId: job.jobId, message: 'Again', attachments: [FILE], requestId: project });
    assert.equal(fake.uploads.size, 3);
    assert.equal(fake.attachmentSends.length, 1);
    const calls = fake.calls.length;
    await assert.rejects(gw.services.jobs.continue({ clientId: 'restricted', scopes: ['fleet:read'] },
      { jobId: job.jobId, message: 'Forbidden', attachments, requestId: 'no' }), { code: 'insufficient_scope' });
    assert.equal(fake.calls.length, calls);
  }
});

test('MCP accepts payloads beyond the former 1 MiB body limit and validates decoded size', async (t) => {
  const h = await startJobHarness(t);
  const large = { ...FILE, data: Buffer.alloc(1024 * 1024, 65).toString('base64') };
  const job = await startJob(h.agent, 'Inspect large file', { attachments: [large] });
  await h.tick();
  const id = (h.fake.threadForJob(job.jobId).launch.attachments as { id: string }[])[0]!.id;
  assert.equal(h.fake.uploads.get(id)?.bytes?.length, 1024 * 1024);
});

test('semantic attachment errors are invalid_argument over MCP without downstream calls', async (t) => {
  const h = await startJobHarness(t);
  const before = h.fake.calls.length;
  for (const items of [[{ ...FILE, data: 'Zh==' }], Array.from({ length: 9 }, () => FILE),
    [{ ...FILE, name: '../no' }], [{ ...FILE, mimeType: 'text/html' }], [{ ...FILE, url: 'https://example.test/file' }]]) {
    const result = await h.agent.callError('work_start', { project: 'pilot', task: 'Inspect', requestId: 'bad', attachments: items });
    assert.equal(result.code, 'invalid_argument');
    assert.equal(result.text.includes(FILE.data), false);
  }
  assert.equal(h.fake.calls.length, before);
});

for (const payload of ['not-json', '']) test(`unreadable queued attachment bytes (${JSON.stringify(payload)}) fail only their job before any upload`, async (t) => {
  const h = await startJobHarness(t);
  const bad = await startJob(h.agent, 'Corrupt payload', { attachments });
  h.gw.services.db.prepare('UPDATE job_launch_attachments SET payload = ? WHERE job_id = ?').run(payload, bad.jobId);
  const good = await startJob(h.agent, 'Healthy payload', { attachments });
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(bad.jobId).state, 'failed');
  assert.equal(h.gw.services.jobs.store.require(bad.jobId).lastErrorCode, 'database_error');
  assert.equal(h.fake.threads.size, 1);
  assert.ok(h.fake.threadForJob(good.jobId));
  assert.equal(h.fake.uploads.size, 2);
});

test('lost launch responses reconcile the initial attachments without relaunching', async (t) => {
  const h = await startJobHarness(t);
  h.fake.dropResponseOnce.add('t3_thread_launch');
  const job = await startJob(h.agent, 'Inspect attached', { attachments });
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(job.jobId).state, 'unknown');
  await h.tickAfter(60_000);
  assert.equal(h.gw.services.jobs.store.require(job.jobId).state, 'running');
  assert.equal(h.fake.threads.size, 1);
  assert.equal(h.fake.uploads.size, 2);
});

test('scratch launches deliver native attachments without a project or workspace strategy', async (t) => {
  const h = await startJobHarness(t, { host: { defaultProject: 'pilot' }, pilot: { workspaceMode: 'scratch' } });
  h.fake.scratchProjectId = 'project-1';
  const result = await h.agent.call<{ job: { jobId: string } }>('work_start', { target: { host: 'main' }, task: 'Inspect', attachments, requestId: 'scratch-files' });
  await h.tick();
  const launch = h.fake.threadForJob(result.job.jobId).launch;
  assert.equal(launch.scratch, true);
  assert.equal(launch.projectId, undefined);
  assert.equal(launch.workspaceStrategy, undefined);
  assert.equal((launch.attachments as unknown[]).length, 2);
});

test('concurrent attachment follow-ups with the same requestId send only once', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const args = { jobId: job.jobId, message: 'Inspect', attachments, requestId: 'concurrent-files' };
  h.fake.holdResponses.add('t3_attachment_prepare_upload');
  const first = h.agent.call('work_continue', args);
  await h.fake.whenHeld('t3_attachment_prepare_upload');
  const second = await h.agent.callError('work_continue', args);
  assert.equal(second.code, 'job_state_conflict');
  h.fake.holdResponses.clear();
  h.fake.releaseHeld();
  await first;
  await h.agent.call('work_continue', args);
  assert.equal(h.fake.attachmentSends.length, 1);
});

test('cancelling a start while its upload is pending never launches a worker', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent, 'Inspect', { attachments });
  h.fake.holdResponses.add('t3_attachment_prepare_upload');
  const tick = h.tick();
  await h.fake.whenHeld('t3_attachment_prepare_upload');
  await h.agent.call('work_cancel', { jobId: job.jobId });
  h.fake.holdResponses.clear();
  h.fake.releaseHeld();
  await tick;
  assert.equal(h.fake.threads.size, 0);
  assert.equal(h.gw.services.jobs.store.require(job.jobId).state, 'cancelled');
});

test('cancelling a job while a follow-up uploads prevents the send', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  h.fake.holdResponses.add('t3_attachment_prepare_upload');
  const followup = h.agent.callError('work_continue', { jobId: job.jobId, message: 'Inspect', attachments, requestId: 'cancel-upload' });
  await h.fake.whenHeld('t3_attachment_prepare_upload');
  await h.agent.call('work_cancel', { jobId: job.jobId });
  h.fake.holdResponses.clear();
  h.fake.releaseHeld();
  assert.equal((await followup).code, 'job_state_conflict');
  assert.equal(h.fake.attachmentSends.length, 0);
});

for (const status of [400, 413]) test(`a permanent HTTP ${status} upload refusal fails its job without blocking the host`, async (t) => {
  const h = await startJobHarness(t);
  h.fake.uploadStatus = status;
  const rejected = await startJob(h.agent, 'Inspect files', { attachments });
  const healthy = await startJob(h.agent, 'Text-only healthy work');
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(rejected.jobId).state, 'failed');
  assert.equal(h.gw.services.jobs.store.require(rejected.jobId).lastErrorCode, 'invalid_argument');
  assert.ok(h.fake.threadForJob(healthy.jobId));
  assert.equal(h.gw.services.db.prepare('SELECT payload FROM job_launch_attachments WHERE job_id = ?').get(rejected.jobId), undefined);
});

test('native attachment claim errors never disclose filenames or content in job errors', async (t) => {
  const h = await startJobHarness(t);
  h.fake.failures.set('t3_thread_launch', { code: 'orchestration_error', message: `Cannot claim ${FILE.name}: ${FILE.data}` });
  const job = await startJob(h.agent, 'Inspect files', { attachments });
  await h.tick();
  const view = await h.agent.call('work_status', { jobId: job.jobId });
  assert.equal(h.gw.services.jobs.store.require(job.jobId).state, 'failed');
  for (const secret of [FILE.name, FILE.data]) assert.equal(JSON.stringify(view).includes(secret), false);
  assertNotLogged(h.gw, [FILE.name, FILE.data]);
});

test('restart reconciliation clears bytes left by a crash after T3 accepted a launch', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent, 'Inspect files', { attachments });
  h.fake.dropResponseOnce.add('t3_thread_launch');
  await h.tick();
  // Recreate the durable crash point: T3 accepted the launch but the gateway never committed its outcome/cleanup.
  h.gw.services.db.prepare("UPDATE jobs SET state = 'dispatching' WHERE id = ?").run(job.jobId);
  h.gw.services.db.prepare('INSERT INTO job_launch_attachments (job_id, payload) VALUES (?, ?)').run(job.jobId, JSON.stringify(attachments));
  await h.agent.client.close();
  await h.gw.gateway.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = await startJobHarness(t, { fake: h.fake, dataDir: h.gw.dataDir, door: h.gw.door });
  await next.tick();
  assert.equal(next.gw.services.jobs.store.require(job.jobId).state, 'running');
  assert.equal(next.gw.services.db.prepare('SELECT payload FROM job_launch_attachments WHERE job_id = ?').get(job.jobId), undefined);
  assert.equal(h.fake.threads.size, 1);
  assert.equal(h.fake.uploads.size, 2);
});

test('a root folder reservation lost during staging is reacquired or refused before sending', async (t) => {
  const h = await startJobHarness(t);
  const first = await startJob(h.agent);
  const second = await startJob(h.agent);
  await h.tick();
  for (const job of [first, second]) {
    const thread = h.fake.threadForJob(job.jobId);
    h.fake.finishTurn(thread.threadId, 'Done');
  }
  await h.tick();
  h.gw.services.db.prepare("UPDATE jobs SET workspace_kind = 'root', workspace_root_key = 'synthetic-folder' WHERE id IN (?, ?)")
    .run(first.jobId, second.jobId);
  h.fake.holdResponses.add('t3_attachment_prepare_upload');
  const args = { jobId: first.jobId, message: 'Inspect', attachments, requestId: 'root-files' };
  const pending = h.agent.callError('work_continue', args);
  await h.fake.whenHeld('t3_attachment_prepare_upload');
  h.gw.clock.advance(11 * 60_000);
  await h.tick();
  assert.equal(h.gw.services.jobs.store.reserveRoot(second.jobId).kind, 'held');
  h.fake.holdResponses.clear();
  h.fake.releaseHeld();
  assert.equal((await pending).code, 'workspace_root_busy');
  assert.equal(h.fake.attachmentSends.length, 0);
});

test('a follow-up whose running root job becomes idle while staging owns a resume token before sending', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const store = h.gw.services.jobs.store;
  store.update(job.jobId, { workspaceKind: 'root', workspaceRootKey: 'synthetic-root' });
  const thread = h.fake.threadForJob(job.jobId);
  h.fake.holdResponses.add('t3_attachment_prepare_upload');
  const pending = h.agent.call('work_continue', { jobId: job.jobId, message: 'Inspect', attachments, requestId: 'became-idle' });
  await h.fake.whenHeld('t3_attachment_prepare_upload');
  const child = h.fake.delegate(thread.threadId, 'Synthetic helper');
  h.fake.finishTurn(thread.threadId, 'Delegated');
  await h.tick();
  assert.equal(store.require(job.jobId).state, 'idle');
  assert.notEqual(store.require(job.jobId).workspaceRootHeldAt, null, 'delegated work still holds the folder');
  assert.deepEqual(store.require(job.jobId).workspaceResumeTokens, []);
  h.fake.holdResponses.clear();
  h.fake.holdResponses.add('t3_thread_send_attachments');
  h.fake.releaseHeld();
  await h.fake.whenHeld('t3_thread_send_attachments');
  assert.equal(store.require(job.jobId).workspaceResumeTokens.length, 1, 'this operation owns its own token');
  h.fake.settleDelegated(child.childThreadId, 'completed');
  h.fake.holdResponses.clear();
  h.fake.releaseHeld();
  await pending;
  assert.deepEqual(store.require(job.jobId).workspaceResumeTokens, []);
});

test('every concurrent standing-thread control is audited exactly once, including lock refusals and replays', async (t) => {
  const h = await startJobHarness(t);
  const thread = h.fake.launchDirect({ projectId: 'project-1', title: 'Synthetic coordinator', message: 'Coordinate' });
  h.fake.finishTurn(thread.threadId, 'Ready');
  const { job } = await h.gw.services.jobs.adopt({ project: 'pilot', threadId: thread.threadId });
  const args = { jobId: job.id, message: 'Inspect', attachments, requestId: 'audited-files' };
  const count = () => h.gw.services.db.prepare("SELECT COUNT(*) AS n FROM thread_action_events WHERE job_id = ? AND action = 'continue'").get(job.id)!.n;
  h.fake.holdResponses.add('t3_attachment_prepare_upload');
  const pending = h.agent.call('work_continue', args);
  await h.fake.whenHeld('t3_attachment_prepare_upload');
  assert.equal((await h.agent.callError('work_continue', args)).code, 'job_state_conflict');
  assert.equal(count(), 2);
  h.fake.holdResponses.clear();
  h.fake.releaseHeld();
  await pending;
  assert.equal(count(), 2);
  await h.agent.call('work_continue', args);
  assert.equal(count(), 3);
  assert.equal(h.fake.attachmentSends.length, 1);
});
