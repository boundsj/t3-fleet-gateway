import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ATTACHMENT_BYTES } from '../src/jobs/attachments.ts';
import { startInputHash } from '../src/jobs/service.ts';
import { CLAIM_WINDOW_MS, UPLOAD_WINDOW_MS } from '../src/jobs/stagedAttachments.ts';
import { assertNotLogged, connectAgent, startJob, startJobHarness, type Agent, type JobHarness } from './helpers/jobs.ts';

const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const TEXT_BYTES = Buffer.from('SYNTHETIC_STAGED_CONTENT');
const INLINE = { name: 'inline-notes.txt', mimeType: 'text/plain', data: Buffer.from('SYNTHETIC_INLINE_CONTENT').toString('base64') };

interface Prepared { attachmentId: string; uploadUrl: string; mimeType: string; sizeBytes: number; expiresAt: string; claimExpiresAt: string; name: string | null }

function prepare(agent: Agent, mimeType: string, sizeBytes: number, name?: string): Promise<Prepared> {
  return agent.call<Prepared>('work_attachment_prepare', { mimeType, sizeBytes, ...(name ? { name } : {}) });
}

function upload(url: string, body: Buffer, contentType: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': contentType, ...headers }, body });
}

async function staged(agent: Agent, bytes: Buffer, mimeType: string, name?: string): Promise<Prepared> {
  const prepared = await prepare(agent, mimeType, bytes.length, name);
  const response = await upload(prepared.uploadUrl, bytes, mimeType);
  assert.equal(response.status, 201, await response.clone().text());
  return prepared;
}

function row(h: JobHarness, id: string): Record<string, unknown> | undefined {
  return h.gw.services.db.prepare('SELECT * FROM staged_attachments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('token')!;
}

test('prepare, upload and claim: work_start launches with the staged bytes and replays without claiming again', async (t) => {
  const h = await startJobHarness(t);
  const prepared = await prepare(h.agent, 'image/png', PNG_BYTES.length, 'screenshot-a.png');
  assert.match(prepared.attachmentId, /^att_[A-Za-z0-9_-]{24}$/);
  const url = new URL(prepared.uploadUrl);
  assert.equal(url.origin + url.pathname, `${h.gw.baseUrl}/attachments`);
  assert.equal(Date.parse(prepared.expiresAt) - h.gw.clock(), UPLOAD_WINDOW_MS);
  assert.equal(Date.parse(prepared.claimExpiresAt) - h.gw.clock(), CLAIM_WINDOW_MS);
  assert.equal(row(h, prepared.attachmentId)?.token_hash === tokenOf(prepared.uploadUrl), false, 'only a hash of the token is stored');

  const response = await upload(prepared.uploadUrl, PNG_BYTES, 'image/png');
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await response.json(), { attachmentId: prepared.attachmentId, mimeType: 'image/png', sizeBytes: PNG_BYTES.length, status: 'uploaded' });

  const callsBefore = h.fake.calls.length;
  const args = { project: 'pilot', task: 'Inspect the screenshot', requestId: 'staged-start', attachments: [{ attachmentId: prepared.attachmentId }] };
  const first = await h.agent.call<{ job: { jobId: string }; created: boolean }>('work_start', args);
  assert.equal(first.created, true);
  assert.equal(h.fake.calls.length, callsBefore, 'acceptance stays downstream-free');
  const claimed = row(h, prepared.attachmentId)!;
  assert.equal(claimed.claimed_job_id, first.job.jobId);
  assert.equal(claimed.claimed_tool, 'work_start');
  assert.equal(claimed.data, null, 'the bytes moved to the job ledger');

  const replay = await h.agent.call<{ job: { jobId: string }; created: boolean }>('work_start', args);
  assert.deepEqual([replay.job.jobId, replay.created], [first.job.jobId, false]);
  assert.equal((await h.agent.callError('work_start', { ...args, attachments: [{ attachmentId: prepared.attachmentId, name: 'renamed.png' }] })).code, 'request_id_conflict');
  const reused = await h.agent.callError('work_start', { ...args, requestId: 'staged-start-2' });
  assert.equal(reused.code, 'invalid_argument');
  assert.match(reused.text, /already used/);

  await h.tick();
  const sent = h.fake.threadForJob(first.job.jobId).launch.attachments as { id: string; type: string; name: string }[];
  assert.deepEqual(sent.map((a) => [a.type, a.name]), [['image', 'screenshot-a.png']]);
  assert.deepEqual(h.fake.uploads.get(sent[0]!.id)?.bytes, PNG_BYTES);

  const views = JSON.stringify([await h.agent.call('work_status', { jobId: first.job.jobId }), await h.agent.call('work_list'), await h.agent.call('work_feed')]);
  for (const secret of [prepared.attachmentId, tokenOf(prepared.uploadUrl), 'screenshot-a.png']) assert.equal(views.includes(secret), false);
  const events = JSON.stringify(h.gw.services.db.prepare('SELECT * FROM job_events').all());
  assert.equal(events.includes(prepared.attachmentId), false);
  assertNotLogged(h.gw, [prepared.attachmentId, tokenOf(prepared.uploadUrl), prepared.uploadUrl, 'screenshot-a.png', PNG_BYTES.toString('base64')]);
  assert.ok(h.gw.logs.some((line) => line.includes('"path":"/attachments"') && line.includes('"status":201')), 'the request line has the bare path');
});

test('work_continue mixes inline and staged files, claims at the send and replays the delivered request', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const image = await staged(h.agent, PNG_BYTES, 'image/png');
  const text = await staged(h.agent, TEXT_BYTES, 'text/plain', 'staged-notes.txt');
  const args = { jobId: job.jobId, message: 'Review these', requestId: 'mixed',
    attachments: [{ attachmentId: image.attachmentId }, INLINE, { attachmentId: text.attachmentId, name: 'override.txt' }] };
  const sent = await h.agent.call<{ delivery: string; replayed: boolean }>('work_continue', args);
  assert.deepEqual([sent.delivery, sent.replayed], ['accepted', false]);
  assert.equal(h.fake.attachmentSends.length, 1);
  const delivered = (h.fake.attachmentSends[0] as { attachments: { id: string; name: string; type: string }[] }).attachments;
  assert.deepEqual(delivered.map((a) => [a.type, a.name]), [['image', 'attachment-1.png'], ['file', 'inline-notes.txt'], ['file', 'override.txt']]);
  assert.deepEqual(delivered.map((a) => h.fake.uploads.get(a.id)?.bytes), [PNG_BYTES, Buffer.from(INLINE.data, 'base64'), TEXT_BYTES]);
  for (const id of [image.attachmentId, text.attachmentId]) {
    assert.deepEqual([row(h, id)?.claimed_job_id, row(h, id)?.claimed_tool, row(h, id)?.data], [job.jobId, 'work_continue', null]);
  }
  const replay = await h.agent.call<{ replayed: boolean }>('work_continue', args);
  assert.equal(replay.replayed, true);
  assert.equal(h.fake.attachmentSends.length, 1);
  assert.equal((await h.agent.callError('work_continue', { ...args, requestId: 'mixed-again' })).code, 'invalid_argument');
  assertNotLogged(h.gw, [image.attachmentId, text.attachmentId, 'staged-notes.txt', 'override.txt', 'SYNTHETIC_STAGED_CONTENT']);
});

test('a follow-up whose upload to T3 fails claims nothing and the same requestId retries with the same staged id', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const file = await staged(h.agent, TEXT_BYTES, 'text/plain');
  const args = { jobId: job.jobId, message: 'Review', requestId: 'retry', attachments: [{ attachmentId: file.attachmentId }] };
  h.fake.uploadStatus = 500;
  assert.equal((await h.agent.callError('work_continue', args)).code, 'host_unreachable');
  assert.equal(row(h, file.attachmentId)?.claimed_at, null);
  h.fake.uploadStatus = 200;
  await h.agent.call('work_continue', args);
  assert.equal(h.fake.attachmentSends.length, 1);
  assert.notEqual(row(h, file.attachmentId)?.claimed_at, null);
});

test('a staged id belongs to the agent that prepared it; read-only agents cannot prepare', async (t) => {
  const h = await startJobHarness(t);
  const file = await staged(h.agent, TEXT_BYTES, 'text/plain');
  const other = await connectAgent(t, h.gw);
  const refused = await other.callError('work_start', { project: 'pilot', task: 'Steal', requestId: 'other', attachments: [{ attachmentId: file.attachmentId }] });
  assert.equal(refused.code, 'invalid_argument');
  assert.match(refused.text, /unknown attachmentId/);
  assert.equal(refused.text.includes(file.attachmentId), false, 'errors name positions, never ids');
  const otherJob = await startJob(other);
  await h.tick();
  assert.equal((await other.callError('work_continue', { jobId: otherJob.jobId, message: 'x', requestId: 'o', attachments: [{ attachmentId: file.attachmentId }] })).code, 'invalid_argument');
  assert.equal(row(h, file.attachmentId)?.claimed_at, null);
  await startJob(h.agent, 'Mine', { attachments: [{ attachmentId: file.attachmentId }] });

  const reader = await connectAgent(t, h.gw, 'read');
  assert.equal((await reader.callError('work_attachment_prepare', { mimeType: 'text/plain', sizeBytes: 4 })).code, 'insufficient_scope');
});

test('expired uploads and expired staged files are refused, and the sweep deletes them', async (t) => {
  const h = await startJobHarness(t);
  const late = await prepare(h.agent, 'text/plain', TEXT_BYTES.length);
  const unused = await staged(h.agent, TEXT_BYTES, 'text/plain');
  const used = await staged(h.agent, TEXT_BYTES, 'text/plain');
  await startJob(h.agent, 'Use one', { attachments: [{ attachmentId: used.attachmentId }] });
  const pending = await prepare(h.agent, 'text/plain', TEXT_BYTES.length);
  assert.equal((await h.agent.callError('work_start', { project: 'pilot', task: 'x', requestId: 'early', attachments: [{ attachmentId: pending.attachmentId }] })).code, 'invalid_argument');

  h.gw.clock.advance(UPLOAD_WINDOW_MS);
  assert.equal((await upload(late.uploadUrl, TEXT_BYTES, 'text/plain')).status, 401);
  const notUploaded = await h.agent.callError('work_start', { project: 'pilot', task: 'x', requestId: 'never', attachments: [{ attachmentId: pending.attachmentId }] });
  assert.match(notUploaded.text, /expired before it was uploaded/);
  assert.equal(h.gw.services.jobs.staged.sweep(), 2, 'both prepared-only rows past their upload window');
  assert.equal(row(h, late.attachmentId), undefined);
  assert.ok(row(h, unused.attachmentId));

  h.gw.clock.advance(CLAIM_WINDOW_MS - UPLOAD_WINDOW_MS);
  const expired = await h.agent.callError('work_start', { project: 'pilot', task: 'x', requestId: 'expired', attachments: [{ attachmentId: unused.attachmentId }] });
  assert.equal(expired.code, 'invalid_argument');
  assert.match(expired.text, /expired/);
  assert.equal(h.gw.services.jobs.staged.sweep(), 2, 'the unclaimed upload and the claimed row');
  assert.equal((h.gw.services.db.prepare('SELECT COUNT(*) AS n FROM staged_attachments').get() as { n: number }).n, 0);
});

test('the upload token is single use; bad, missing and repeated tokens and foreign origins are refused', async (t) => {
  const h = await startJobHarness(t);
  const prepared = await prepare(h.agent, 'text/plain', TEXT_BYTES.length);
  const base = `${h.gw.baseUrl}/attachments`;
  for (const url of [base, `${base}?token=t3fgu_${'A'.repeat(43)}`, `${base}?token=nonsense`, `${prepared.uploadUrl}&token=${tokenOf(prepared.uploadUrl)}`]) {
    const response = await upload(url, TEXT_BYTES, 'text/plain');
    assert.equal(response.status, 401, url);
    assert.equal(((await response.json()) as { error: string }).error, 'invalid_token');
  }
  const foreign = await upload(prepared.uploadUrl, TEXT_BYTES, 'text/plain', { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  assert.equal(row(h, prepared.attachmentId)?.upload_started_at, null, 'a refused origin does not spend the token');
  assert.equal((await upload(prepared.uploadUrl, TEXT_BYTES, 'text/plain', { origin: h.gw.baseUrl })).status, 201);
  assert.equal((await upload(prepared.uploadUrl, TEXT_BYTES, 'text/plain')).status, 401, 'reused token');
  assert.equal((await fetch(prepared.uploadUrl)).status, 405);
  assertNotLogged(h.gw, [tokenOf(prepared.uploadUrl)]);
});

test('size, Content-Type and image signature must match what was prepared; a failed upload spends the token and frees the slot', async (t) => {
  const h = await startJobHarness(t);
  const cases: [string, Buffer, string, Buffer, string, number][] = [
    ['short body', TEXT_BYTES, 'text/plain', TEXT_BYTES.subarray(1), 'text/plain', 400],
    ['long body', TEXT_BYTES, 'text/plain', Buffer.concat([TEXT_BYTES, Buffer.from('x')]), 'text/plain', 413],
    ['other Content-Type', TEXT_BYTES, 'text/plain', TEXT_BYTES, 'text/markdown', 415],
    ['missing Content-Type', TEXT_BYTES, 'text/plain', TEXT_BYTES, '', 415],
    ['not a PNG', PNG_BYTES, 'image/png', Buffer.alloc(PNG_BYTES.length, 1), 'image/png', 400],
    ['JPEG bytes as PNG', PNG_BYTES, 'image/png', Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(PNG_BYTES.length - 3)]), 'image/png', 400],
  ];
  for (const [label, prepared, mimeType, body, contentType, status] of cases) {
    const slot = await prepare(h.agent, mimeType, prepared.length);
    const response = await fetch(slot.uploadUrl, { method: 'POST', body, ...(contentType ? { headers: { 'content-type': contentType } } : {}) });
    assert.equal(response.status, status, label);
    assert.equal(row(h, slot.attachmentId), undefined, `${label}: the failed slot is gone`);
    assert.equal((await upload(slot.uploadUrl, prepared, mimeType)).status, 401, `${label}: the token is spent`);
  }
  // Parameters on the media type are ignored; the type itself must match.
  const slot = await prepare(h.agent, 'text/plain', TEXT_BYTES.length);
  assert.equal((await upload(slot.uploadUrl, TEXT_BYTES, 'Text/Plain; charset=utf-8')).status, 201);
});

test('prepare validates like inline attachments and caps unclaimed files per agent at 8 files and 10 MiB', async (t) => {
  const h = await startJobHarness(t);
  for (const input of [{ mimeType: 'image/svg+xml', sizeBytes: 10 }, { mimeType: 'text/plain', sizeBytes: 0 },
    { mimeType: 'text/plain', sizeBytes: MAX_ATTACHMENT_BYTES + 1 }, { mimeType: 'text/plain', sizeBytes: 5, name: '../etc' },
    { mimeType: 'text/plain', sizeBytes: 1.5 }]) {
    const error = await h.agent.callError('work_attachment_prepare', input);
    assert.match(error.code, /invalid_argument|Input validation error/, JSON.stringify(input));
  }
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push((await prepare(h.agent, 'text/plain', 1)).attachmentId);
  assert.equal((await h.agent.callError('work_attachment_prepare', { mimeType: 'text/plain', sizeBytes: 1 })).code, 'invalid_argument');
  const other = await connectAgent(t, h.gw);
  await prepare(other, 'text/plain', MAX_ATTACHMENT_BYTES);
  await prepare(other, 'text/plain', MAX_ATTACHMENT_BYTES);
  assert.equal((await other.callError('work_attachment_prepare', { mimeType: 'text/plain', sizeBytes: 1 })).code, 'invalid_argument', 'byte cap');
  // A claimed file no longer counts.
  const file = await staged(other, TEXT_BYTES, 'text/plain').catch(() => undefined);
  assert.equal(file, undefined, 'still capped');
  h.gw.clock.advance(UPLOAD_WINDOW_MS);
  const fresh = await staged(other, TEXT_BYTES, 'text/plain');
  await startJob(other, 'Claim', { attachments: [{ attachmentId: fresh.attachmentId }] });
  for (let i = 0; i < 8; i++) await prepare(other, 'text/plain', 1);
});

test('staged and inline files share the 8-file and 10 MiB request totals', async (t) => {
  const h = await startJobHarness(t);
  const big = Buffer.alloc(MAX_ATTACHMENT_BYTES, 65);
  const a = await staged(h.agent, big, 'text/plain');
  const b = await staged(h.agent, big, 'text/plain');
  const tooMuch = await h.agent.callError('work_start', { project: 'pilot', task: 'x', requestId: 'total',
    attachments: [{ attachmentId: a.attachmentId }, INLINE, { attachmentId: b.attachmentId }] });
  assert.equal(tooMuch.code, 'invalid_argument');
  assert.match(tooMuch.text, /10 MiB/);
  assert.equal(row(h, a.attachmentId)?.claimed_at, null, 'nothing claimed on a refused request');
  const nine = Array.from({ length: 9 }, () => ({ attachmentId: a.attachmentId }));
  assert.equal((await h.agent.callError('work_start', { project: 'pilot', task: 'x', requestId: 'nine', attachments: nine })).code, 'invalid_argument');
  const twice = await h.agent.callError('work_start', { project: 'pilot', task: 'x', requestId: 'twice', attachments: [{ attachmentId: a.attachmentId }, { attachmentId: a.attachmentId }] });
  assert.match(twice.text, /repeats a staged attachment/);
  for (const item of [{ attachmentId: a.attachmentId, data: INLINE.data }, { attachmentId: 'att_short' }, { attachmentId: a.attachmentId, mimeType: 'text/plain' }]) {
    assert.equal((await h.agent.callError('work_start', { project: 'pilot', task: 'x', requestId: 'shape', attachments: [item] })).code, 'invalid_argument');
  }
  const job = await startJob(h.agent, 'Both big files', { attachments: [{ attachmentId: a.attachmentId }, { attachmentId: b.attachmentId }] });
  await h.tick();
  assert.equal((h.fake.threadForJob(job.jobId).launch.attachments as unknown[]).length, 2);
});

test('request hashes cover staged ids and name overrides, and keep inline-only hashes unchanged', () => {
  const input = { project: 'pilot', task: 'Synthetic', requestId: 'r' };
  const id = `att_${'a'.repeat(24)}`;
  const staged = startInputHash({ ...input, attachments: [{ attachmentId: id }] });
  assert.equal(startInputHash({ ...input, attachments: [{ attachmentId: id }] }), staged);
  assert.notEqual(startInputHash({ ...input, attachments: [{ attachmentId: `att_${'b'.repeat(24)}` }] }), staged);
  assert.notEqual(startInputHash({ ...input, attachments: [{ attachmentId: id, name: 'x.png' }] }), staged);
  assert.notEqual(startInputHash({ ...input, attachments: [{ attachmentId: id }, INLINE] }), staged);
});

test('the upload route lives on the MCP listener only, never the dashboard', async (t) => {
  const h = await startJobHarness(t, { dashboard: { enabled: true, allowedHosts: ['dashboard.example.test'] } });
  const dashboard = h.gw.gateway.dashboard!;
  const prepared = await prepare(h.agent, 'text/plain', TEXT_BYTES.length);
  const response = await fetch(`http://127.0.0.1:${dashboard.port}${dashboard.path === '/' ? '' : dashboard.path}/attachments?token=${tokenOf(prepared.uploadUrl)}`,
    { method: 'POST', headers: { 'content-type': 'text/plain' }, body: TEXT_BYTES });
  assert.notEqual(response.status, 201);
  assert.equal(row(h, prepared.attachmentId)?.upload_started_at, null);
  assert.equal((await upload(prepared.uploadUrl, TEXT_BYTES, 'text/plain')).status, 201);
});

test('one staged file is held by one follow-up at a time; a concurrent request using it is refused before loading bytes', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const file = await staged(h.agent, TEXT_BYTES, 'text/plain');
  const attachments = [{ attachmentId: file.attachmentId }];
  h.fake.holdResponses.add('t3_attachment_prepare_upload');
  const first = h.agent.call('work_continue', { jobId: job.jobId, message: 'A', requestId: 'hold-a', attachments });
  await h.fake.whenHeld('t3_attachment_prepare_upload');
  const second = await h.agent.callError('work_continue', { jobId: job.jobId, message: 'B', requestId: 'hold-b', attachments });
  assert.equal(second.code, 'job_state_conflict');
  h.fake.holdResponses.clear();
  h.fake.releaseHeld();
  await first;
  assert.equal(h.fake.attachmentSends.length, 1);
  // The refused request held nothing: its requestId is free, and the id is now claimed.
  assert.match((await h.agent.callError('work_continue', { jobId: job.jobId, message: 'B', requestId: 'hold-b', attachments })).text, /already used/);
});

test('a retried follow-up whose staged file expires before the send boundary reports the real error and stays retryable', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  const file = await staged(h.agent, TEXT_BYTES, 'text/plain');
  const args = { jobId: job.jobId, message: 'Review', requestId: 'crash-retry', attachments: [{ attachmentId: file.attachmentId }] };
  // As if an earlier process recorded the request id and stopped before marking the send.
  h.gw.services.jobs.store.claimIdempotencyKey(h.agent.clientId, 'work_continue', 'crash-retry', {
    inputHash: (await import('../src/jobs/service.ts')).inputHash('work_continue', { jobId: job.jobId, message: 'Review', attachments: [{ attachmentId: file.attachmentId, name: null }] }),
    jobId: job.jobId,
  });
  h.fake.uploadStatus = 500;
  assert.equal((await h.agent.callError('work_continue', args)).code, 'host_unreachable');
  h.fake.uploadStatus = 200;
  await h.agent.call('work_continue', args);
  assert.equal(h.fake.attachmentSends.length, 1);
});

test('revoking a client stops its outstanding upload URLs and deletes its unclaimed files', async (t) => {
  const h = await startJobHarness(t);
  const pending = await prepare(h.agent, 'text/plain', TEXT_BYTES.length);
  const uploaded = await staged(h.agent, TEXT_BYTES, 'text/plain');
  h.gw.services.clients.revoke(h.agent.clientId);
  assert.equal((await upload(pending.uploadUrl, TEXT_BYTES, 'text/plain')).status, 401);
  assert.equal(row(h, pending.attachmentId), undefined);
  assert.equal(row(h, uploaded.attachmentId), undefined);
});

test('an upload must complete before its deadline', async (t) => {
  const h = await startJobHarness(t);
  const prepared = await prepare(h.agent, 'text/plain', TEXT_BYTES.length);
  const slot = h.gw.services.jobs.staged.beginUpload(tokenOf(prepared.uploadUrl))!;
  assert.ok(slot);
  h.gw.clock.advance(UPLOAD_WINDOW_MS);
  assert.equal(h.gw.services.jobs.staged.remainingMs(slot), 0);
  assert.equal(h.gw.services.jobs.staged.completeUpload(slot, TEXT_BYTES), false);
});

test('refusals close the connection, and an oversized chunked body still gets its 413', async (t) => {
  const h = await startJobHarness(t);
  const { request } = await import('node:http');
  const send = (path: string, headers: Record<string, string>, chunks: Buffer[]) => new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
    const url = new URL(path, h.gw.baseUrl);
    const req = request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST', headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode!, connection: res.headers.connection });
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
  const refused = await send('/attachments?token=nope', { 'content-type': 'text/plain', 'content-length': String(TEXT_BYTES.length) }, [TEXT_BYTES]);
  assert.deepEqual(refused, { status: 401, connection: 'close' });
  const prepared = await prepare(h.agent, 'text/plain', 8);
  const chunked = await send(new URL(prepared.uploadUrl).pathname + new URL(prepared.uploadUrl).search,
    { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' }, [Buffer.alloc(6, 65), Buffer.alloc(6, 65)]);
  assert.deepEqual(chunked, { status: 413, connection: 'close' });
  assert.equal(row(h, prepared.attachmentId), undefined);
});

test('image signatures compare bytes, not a lossy text decode', async () => {
  const { signatureMatches } = await import('../src/jobs/attachments.ts');
  const gif = Buffer.from('GIF89a', 'latin1');
  assert.equal(signatureMatches('image/gif', gif), true);
  assert.equal(signatureMatches('image/gif', Buffer.from(gif.map((byte) => byte | 0x80))), false);
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);
  assert.equal(signatureMatches('image/webp', webp), true);
  assert.equal(signatureMatches('image/webp', Buffer.from(webp.map((byte, i) => i < 4 ? byte | 0x80 : byte))), false);
});
