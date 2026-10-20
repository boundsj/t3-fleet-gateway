import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pullRequestEvents, readPullRequests } from '../src/jobs/pullRequests.ts';
import type { JobDetailView } from '../src/mcp/workTools.ts';
import { DEFAULT_WEBHOOK_EVENTS } from '../src/webhooks/config.ts';
import { agentWithToken, assertNotLogged, startJob, startJobHarness } from './helpers/jobs.ts';

const pr = (state: 'open' | 'merged' | 'closed' | null = 'open', number = 21) => ({
  host: 'github.com', repository: 'sample/widgets', number, url: `https://github.com/sample/widgets/pull/${number}`, state,
});
const textOf = (r: { content?: unknown }) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');

for (const inline of [true, false]) {
  test(`PR states reach text clients and feed, deduplicated (${inline ? 'inline' : 'fallback'})`, async (t) => {
    const { fake, gw, agent, tick, tickAfter } = await startJobHarness(t);
    fake.inlinePullRequests = inline;
    const job = await startJob(agent);
    await tick();
    const { threadId } = fake.threadForJob(job.jobId);
    fake.pullRequests.set(threadId, [{ ...pr(), title: 'PRIVATE-PR-TITLE', headBranch: 'PRIVATE-BRANCH' }]);
    await tickAfter(60_001);
    const result = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId } });
    const view = result.structuredContent as JobDetailView;
    assert.deepEqual(view.pullRequests, [pr()]);
    assert.ok(view.pullRequestsCheckedAt);
    assert.match(textOf(result), /sample\/widgets#21 open https:\/\/github.com/);
    const list = await agent.client.callTool({ name: 'work_list', arguments: {} });
    assert.match(textOf(list), /#21 open/);
    const events = () => gw.services.jobs.store.recentEvents(job.jobId, 100);
    assert.equal(events().filter((e) => e.type === 'pull_request_opened').length, 1);
    await tickAfter(60_001);
    assert.equal(events().filter((e) => e.type === 'pull_request_opened').length, 1);
    fake.pullRequests.set(threadId, [pr('merged')]);
    await tickAfter(60_001);
    assert.equal(events().filter((e) => e.type === 'pull_request_merged').length, 1);
    const feed = await agent.client.callTool({ name: 'work_feed', arguments: {} });
    assert.match(textOf(feed), /pull_request_merged/);
    assert.equal(fake.calls.filter((c) => c === 'list_thread_pull_requests').length, inline ? 0 : 3);
    assertNotLogged(gw, ['PRIVATE-PR-TITLE', 'PRIVATE-BRANCH', pr().url, pr().repository]);
    assert.equal(JSON.stringify(events()).includes(pr().url), false, 'event details are code-only');
  });
}

test('optional lookup errors preserve cached metadata and do not back off or fail jobs', async (t) => {
  const { fake, gw, agent, tick, tickAfter } = await startJobHarness(t);
  const job = await startJob(agent);
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  fake.pullRequests.set(threadId, [pr()]);
  await tickAfter(60_001);
  fake.failures.set('list_thread_pull_requests', { code: 'not_found', message: 'PRIVATE-OPTIONAL-ERROR' });
  await tickAfter(60_001);
  const count = fake.calls.filter((c) => c === 'list_thread_pull_requests').length;
  await tick();
  assert.equal(fake.calls.filter((c) => c === 'list_thread_pull_requests').length, count, 'failed attempts are throttled too');
  const status = await agent.call<JobDetailView>('work_status', { jobId: job.jobId });
  assert.equal(status.state, 'running');
  assert.deepEqual(status.pullRequests, [pr()]);
  const second = await startJob(agent);
  await tick();
  assert.equal((await agent.call<JobDetailView>('work_status', { jobId: second.jobId })).state, 'running');
  assertNotLogged(gw, ['PRIVATE-OPTIONAL-ERROR']);
});

test('unknown baselines are silent; malformed, duplicate and oversized snapshots stay unknown', () => {
  assert.deepEqual(pullRequestEvents(null, [pr(), pr('merged', 22)]), []);
  assert.deepEqual(pullRequestEvents([pr()], []), [], 'unlink is not a merge');
  assert.deepEqual(pullRequestEvents([pr()], [pr(null)]), []);
  assert.equal(readPullRequests([pr(), pr()]), null);
  assert.equal(readPullRequests(Array.from({ length: 21 }, (_, i) => pr('open', i + 1))), null);
  for (const url of ['javascript:alert(1)', 'https://user:pass@github.com/sample/widgets/pull/21',
    'https://github.com/sample/widgets/pull/21?token=private', 'https://elsewhere.example/sample/widgets/pull/21']) {
    assert.equal(readPullRequests([{ ...pr(), url }]), null);
  }
  assert.deepEqual(DEFAULT_WEBHOOK_EVENTS, ['needs_input', 'idle', 'failed', 'cancelled', 'delegated_work_ended']);
});

test('a failed first lookup stays unknown and a later valid baseline is silent for an existing job', async (t) => {
  const { fake, gw, agent, tick, tickAfter } = await startJobHarness(t);
  const job = await startJob(agent);
  await tick();
  gw.services.jobs.store.update(job.jobId, { pullRequests: null, pullRequestsCheckedAt: null });
  fake.failures.set('list_thread_pull_requests', { code: 'unknown_tool', message: 'optional unavailable' });
  await tickAfter(60_001);
  assert.equal((await agent.call<JobDetailView>('work_status', { jobId: job.jobId })).pullRequests, null);
  fake.failures.delete('list_thread_pull_requests');
  fake.pullRequests.set(fake.threadForJob(job.jobId).threadId, [pr()]);
  await tickAfter(60_001);
  assert.deepEqual((await agent.call<JobDetailView>('work_status', { jobId: job.jobId })).pullRequests, [pr()]);
  assert.equal(gw.services.jobs.store.recentEvents(job.jobId, 100).some((e) => e.type.startsWith('pull_request_')), false);
});

test('adoption baselines silently and a restart keeps merge dedupe and cached freshness', async (t) => {
  const first = await startJobHarness(t);
  const { threadId } = first.fake.launchDirect({ projectId: 'project-1', title: 'Synthetic coordinator', message: 'Synthetic work' });
  first.fake.pullRequests.set(threadId, [pr()]);
  const { job } = await first.gw.services.jobs.adopt({ project: 'pilot', threadId });
  await first.tick();
  assert.deepEqual(first.gw.services.jobs.store.require(job.id).pullRequests, [pr()]);
  assert.equal(first.gw.services.jobs.store.recentEvents(job.id, 100).some((e) => e.type.startsWith('pull_request_')), false);
  first.fake.pullRequests.set(threadId, [pr('merged')]);
  await first.tickAfter(60_001);
  const cached = first.gw.services.jobs.store.require(job.id);
  await first.gw.gateway.close();
  const second = await startJobHarness(t, { fake: first.fake, dataDir: first.gw.dataDir, clock: first.gw.clock });
  await second.tickAfter(60_001);
  assert.deepEqual(second.gw.services.jobs.store.require(job.id).pullRequests, cached.pullRequests);
  assert.equal(second.gw.services.jobs.store.recentEvents(job.id, 100).filter((e) => e.type === 'pull_request_merged').length, 1);
});

test('oversized inline snapshots retain the last good cache and terminal jobs stop polling', async (t) => {
  const { fake, gw, agent, tick, tickAfter } = await startJobHarness(t);
  fake.inlinePullRequests = true;
  const job = await startJob(agent);
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  fake.pullRequests.set(threadId, [pr()]);
  await tickAfter(60_001);
  const previous = gw.services.jobs.store.require(job.jobId).pullRequestsCheckedAt;
  fake.pullRequests.set(threadId, Array.from({ length: 21 }, (_, i) => pr('open', i + 1)));
  await tickAfter(60_001);
  assert.deepEqual(gw.services.jobs.store.require(job.jobId).pullRequests, [pr()]);
  assert.equal(gw.services.jobs.store.require(job.jobId).pullRequestsCheckedAt, previous);
  gw.services.jobs.store.transition(job.jobId, { from: ['running'], to: 'cancelled' });
  fake.pullRequests.set(threadId, [pr('merged')]);
  await tickAfter(60_001);
  assert.deepEqual(gw.services.jobs.store.require(job.jobId).pullRequests, [pr()]);
});

test('a bounded optional-lookup budget eventually visits every idle standing job', async (t) => {
  const h = await startJobHarness(t);
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    const { threadId } = h.fake.launchDirect({ projectId: 'project-1', title: `Synthetic ${i}`, message: 'Synthetic work' });
    h.fake.finishTurn(threadId, 'Synthetic done');
    h.fake.pullRequests.set(threadId, [pr('open', i + 1)]);
    ids.push((await h.gw.services.jobs.adopt({ project: 'pilot', threadId })).job.id);
  }
  await h.tick();
  assert.equal(h.fake.calls.filter((c) => c === 'list_thread_pull_requests').length, 4);
  await h.tickAfter(60_001);
  assert.ok(ids.every((id) => h.gw.services.jobs.store.require(id).pullRequests?.length === 1));
});


test('job PR metadata remains hidden behind the stored host grant', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  await h.tick();
  h.fake.pullRequests.set(h.fake.threadForJob(job.jobId).threadId, [pr()]);
  await h.tickAfter(60_001);
  const issued = h.gw.services.tokens.issueOperatorToken({ name: 'Synthetic restricted agent', scopes: ['host:other:read'], expiresAt: h.gw.clock() + 60_000 });
  const restricted = await agentWithToken(t, h.gw.baseUrl, issued.clientId, issued.token);
  const before = h.fake.calls.length;
  const result = await restricted.callError('work_status', { jobId: job.jobId });
  assert.equal(result.code, 'not_found');
  assert.equal(result.text.includes(pr().url), false);
  const list = await restricted.call<{ jobs: unknown[] }>('work_list', { scope: 'all' });
  assert.deepEqual(list.jobs, []);
  assert.equal(h.fake.calls.length, before, 'denied reads never reach T3');
});
