import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PULL_REQUESTS, prKey, pullRequestEvents, pullRequestListSchema, readPullRequests } from '../src/jobs/pullRequests.ts';
import type { JobDetailView } from '../src/mcp/workTools.ts';
import { DEFAULT_WEBHOOK_EVENTS } from '../src/webhooks/config.ts';
import { agentWithToken, assertNotLogged, startJob, startJobHarness } from './helpers/jobs.ts';

type State = 'open' | 'merged' | 'closed' | null;
const pr = (state: State = 'open', number = 21) => ({
  host: 'github.com', repository: 'sample/widgets', number, url: `https://github.com/sample/widgets/pull/${number}`, state,
});
/** A repository with capitals as a live T3 lists it: the repository in lower case, the URL in GitHub's casing. */
const cased = (state: State = 'open', number = 16) => ({
  host: 'github.com', repository: 'sample/mixedcase', number, url: `https://github.com/Sample/MixedCase/pull/${number}`, state,
});
/** `count` linked PRs numbered from 1, merged unless `states` says otherwise. */
const linked = (count: number, states: Record<number, State> = {}) =>
  Array.from({ length: count }, (_, i) => cased(i + 1 in states ? (states[i + 1] as State) : 'merged', i + 1));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const numbers = (prs: readonly { number: number }[] | null | undefined) => (prs ?? []).map((p) => p.number).sort((a, b) => a - b);
const types = (events: readonly { type: string }[]) => events.map((e) => e.type);
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
    assert.doesNotMatch(textOf(result), /left out/, 'the note about the bound appears only at the bound');
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

test('unknown baselines are silent; an unlink or an unknown state is not a merge', () => {
  assert.deepEqual(pullRequestEvents(null, [pr(), pr('merged', 22)]), []);
  assert.deepEqual(pullRequestEvents([pr()], []), [], 'unlink is not a merge');
  assert.deepEqual(pullRequestEvents([pr()], [pr(null)]), []);
  assert.deepEqual(DEFAULT_WEBHOOK_EVENTS, ['needs_input', 'idle', 'failed', 'cancelled', 'delegated_work_ended']);
});

test('a lower-case repository with a URL in GitHub casing is accepted, and the URL is kept as T3 gave it', () => {
  assert.deepEqual(readPullRequests([cased()]), [cased()]);
  assert.equal(readPullRequests([cased()])?.[0]?.url, 'https://github.com/Sample/MixedCase/pull/16');
  // The host is compared without case too (a URL's own host is lower-cased by the URL parser); the URL is still kept as given.
  const upper = { ...cased(), host: 'GitHub.com', url: 'HTTPS://GITHUB.COM/Sample/MixedCase/pull/16' };
  assert.deepEqual(readPullRequests([upper]), [upper]);
  // Case is the only leniency: the URL has to name this repository and number.
  assert.equal(readPullRequests([{ ...cased(), repository: 'sample/other' }]), null);
  assert.equal(readPullRequests([{ ...cased(), number: 17 }]), null);
});

test('a URL that does not name the PR on its host over plain HTTPS is still rejected', () => {
  for (const url of ['javascript:alert(1)', 'http://github.com/sample/widgets/pull/21', 'https://github.com:8443/sample/widgets/pull/21',
    'https://user:pass@github.com/sample/widgets/pull/21', 'https://github.com/sample/widgets/pull/21?token=private',
    'https://github.com/sample/widgets/pull/21#files', 'https://elsewhere.example/sample/widgets/pull/21',
    'https://github.com/other/widgets/pull/21', 'https://github.com/sample/widgets/pull/22', 'https://github.com/sample/widgets/pull/21/',
    'https://github.com/sample/widgets/pull/21/files', 'https://github.com/sample/widgets/issues/21', 'not a url', '']) {
    assert.equal(readPullRequests([{ ...pr(), url }]), null, url);
  }
});

test('a list is read entry by entry: bad entries are skipped, duplicates count once, none valid is unknown, none at all is empty', () => {
  const bad = { ...pr('open', 2), url: 'https://elsewhere.example/sample/widgets/pull/2' };
  assert.deepEqual(readPullRequests([pr('open', 1), bad, pr('merged', 3)]), [pr('open', 1), pr('merged', 3)]);
  // Whatever is not a PR object goes the same way.
  const junk = [null, 'text', 7, [], {}, { ...pr(), number: 0 }, { ...pr(), state: 'draft' }];
  assert.deepEqual(readPullRequests([...junk, pr('open', 5)]), [pr('open', 5)]);
  // The same host, repository and number, compared without case, is one PR: the first one listed stays.
  const again = { ...pr('merged'), host: 'GitHub.com', repository: 'Sample/Widgets', url: 'https://github.com/Sample/Widgets/pull/21' };
  assert.deepEqual(readPullRequests([pr(), again, pr('open', 22)]), [pr(), pr('open', 22)]);
  assert.deepEqual(readPullRequests([again, pr()]), [again]);
  // A list that has entries but no valid one is unknown, never a misleading empty list. An empty list is none.
  assert.equal(readPullRequests([bad]), null);
  assert.equal(readPullRequests(junk), null);
  assert.deepEqual(readPullRequests([]), []);
  // Not a list at all.
  for (const value of [undefined, null, 'text', 7, {}, { pullRequests: [pr()] }]) assert.equal(readPullRequests(value), null);
});

test('more than twenty PRs keep every open one, then the newest', () => {
  // 25 linked, #4 and #25 open, the rest merged: the five left out are the oldest merged ones, #1-#3, #5 and #6.
  const all = linked(25, { 4: 'open', 25: 'open' });
  const kept = readPullRequests(all);
  assert.equal(kept?.length, MAX_PULL_REQUESTS);
  assert.deepEqual(numbers(kept), [4, ...range(7, 25)]);
  // The result does not depend on the order T3 listed them in, is stored in key order, and reads back unchanged.
  assert.deepEqual(readPullRequests([...all].reverse()), kept);
  assert.deepEqual(kept, [...kept!].sort((a, b) => prKey(a).localeCompare(prKey(b))));
  assert.deepEqual(readPullRequests(kept), kept);
  // Closed and unknown PRs rank with the merged ones.
  assert.deepEqual(numbers(readPullRequests(linked(22, { 1: null, 2: 'closed', 3: 'open' }))), range(3, 22));
  // More than twenty open ones keep the twenty newest.
  assert.deepEqual(numbers(readPullRequests(linked(25).map((p) => ({ ...p, state: 'open' })))), range(6, 25));
  // Equal numbers in different repositories are ordered by key: which one is cut never depends on the order listed.
  const tie = [pr('merged', 1), cased('merged', 1), ...range(2, 20).map((n) => cased('merged', n))];
  for (const order of [tie, [...tie].reverse()]) {
    assert.equal(readPullRequests(order)?.find((p) => p.number === 1)?.repository, 'sample/mixedcase');
  }
});

test('the list schema takes the answer of T3 as it comes: an object with a list, entries judged later', () => {
  assert.equal(pullRequestListSchema.safeParse({ pullRequests: [...linked(25), null, 'text', { number: 'x' }], other: 1 }).success, true);
  for (const answer of [{}, { pullRequests: 'text' }, { pullRequests: null }, [], 'text']) {
    assert.equal(pullRequestListSchema.safeParse(answer).success, false);
  }
});

test('a full snapshot is a window: a PR leaving it or an old one returning to it is not news, a PR that outranks its last entry is', () => {
  const read = (states: Record<number, State>, count = 25) => readPullRequests(linked(count, states))!;
  // 25 linked, #4 and #25 open: the window is #4 and #7-#25.
  const before = read({ 4: 'open', 25: 'open' });
  assert.deepEqual(numbers(before), [4, ...range(7, 25)]);
  // #4 is closed: it leaves the window and the old merged #6 returns to it. Nothing happened to #6.
  assert.deepEqual(pullRequestEvents(before, read({ 4: 'closed', 25: 'open' })), []);
  // A newly linked closed PR pushes the oldest merged one out: nothing either.
  assert.deepEqual(pullRequestEvents(before, read({ 4: 'open', 25: 'open', 26: 'closed' }, 26)), []);
  // A new open PR is news, and so is one that arrives merged and is newer than the window's last entry.
  assert.deepEqual(types(pullRequestEvents(before, read({ 4: 'open', 25: 'open', 26: 'open' }, 26))), ['pull_request_opened']);
  assert.deepEqual(types(pullRequestEvents(before, read({ 4: 'open', 25: 'open' }, 26))), ['pull_request_merged']);
  // An old PR that was cut and is open now outranks the window's last entry: reopened, so news.
  assert.deepEqual(types(pullRequestEvents(before, read({ 2: 'open', 4: 'open', 25: 'open' }))), ['pull_request_opened']);
  // A PR inside the window changing state is news as always.
  assert.deepEqual(types(pullRequestEvents(before, read({ 25: 'merged', 4: 'open' }))), ['pull_request_merged']);
  // A snapshot below the bound has left nothing out: every PR that was not in it is new.
  assert.deepEqual(types(pullRequestEvents([pr('open', 1)], [pr('open', 1), pr('merged', 2)])), ['pull_request_merged']);
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

test('an oversized snapshot is bounded to twenty, and terminal jobs stop polling', async (t) => {
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
  const bounded = gw.services.jobs.store.require(job.jobId);
  assert.deepEqual(numbers(bounded.pullRequests), range(2, 21), 'the twenty newest of 21 open PRs');
  assert.ok(bounded.pullRequestsCheckedAt! > previous!, 'the read counts as fresh');
  gw.services.jobs.store.transition(job.jobId, { from: ['running'], to: 'cancelled' });
  fake.pullRequests.set(threadId, [pr('merged')]);
  await tickAfter(60_001);
  assert.deepEqual(gw.services.jobs.store.require(job.jobId).pullRequests, bounded.pullRequests);
});

test('a list with entries but none valid is unknown: the last snapshot and its freshness stay, and an empty list is none', async (t) => {
  const { fake, gw, agent, tick, tickAfter } = await startJobHarness(t);
  const job = await startJob(agent);
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  const stored = () => gw.services.jobs.store.require(job.jobId);
  fake.pullRequests.set(threadId, [pr()]);
  await tickAfter(60_001);
  const known = stored();
  fake.pullRequests.set(threadId, [{ ...pr('merged'), url: 'https://elsewhere.example/sample/widgets/pull/21' }]);
  await tickAfter(60_001);
  assert.deepEqual(stored().pullRequests, [pr()]);
  assert.equal(stored().pullRequestsCheckedAt, known.pullRequestsCheckedAt);
  fake.pullRequests.set(threadId, []);
  await tickAfter(60_001);
  assert.deepEqual(stored().pullRequests, [], 'an empty list is a known empty snapshot');
  const merged = gw.services.jobs.store.recentEvents(job.jobId, 100).filter((e) => e.type === 'pull_request_merged');
  assert.deepEqual(merged, [], 'an unlink is not a merge');
});

test('the T3 client hands over a long list or an odd entry as it comes; judging entries is the reader job', async (t) => {
  const { fake, gw, agent, tick } = await startJobHarness(t);
  const job = await startJob(agent);
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  fake.pullRequests.set(threadId, [...linked(25), null, 'text', { number: 'x' }] as unknown as Record<string, unknown>[]);
  const answer = await gw.services.registry.client('main').listThreadPullRequests(threadId);
  assert.equal(answer.pullRequests.length, 28);
  assert.equal(readPullRequests(answer.pullRequests)?.length, MAX_PULL_REQUESTS);
});

for (const inline of [true, false]) {
  test(`capitals and over twenty PRs: a bounded snapshot, no event as the window moves (${inline ? 'inline' : 'fallback'})`, async (t) => {
    const { fake, gw, agent, tick, tickAfter } = await startJobHarness(t);
    fake.inlinePullRequests = inline;
    const job = await startJob(agent);
    await tick();
    const { threadId } = fake.threadForJob(job.jobId);
    const recent = () => gw.services.jobs.store.recentEvents(job.jobId, 100);
    const prEvents = () => types(recent()).filter((type) => type.startsWith('pull_request_')).sort();
    // 25 linked PRs, #4 and #25 open, plus an entry from another forge and two that are no PR at all.
    const gitlab = { ...pr('open', 3), host: 'gitlab.example', url: 'https://gitlab.example/sample/widgets/-/merge_requests/3' };
    const odd = [gitlab, null, 'text'];
    const withPrivate = (p: ReturnType<typeof cased>) => ({ ...p, title: 'PRIVATE-PR-TITLE', headBranch: 'PRIVATE-BRANCH' });
    const set = (list: unknown[]) => fake.pullRequests.set(threadId, list as Record<string, unknown>[]);
    set([...linked(25, { 4: 'open', 25: 'open' }).map(withPrivate), ...odd]);
    await tickAfter(60_001);
    const result = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId } });
    const view = result.structuredContent as JobDetailView;
    assert.deepEqual(numbers(view.pullRequests), [4, ...range(7, 25)], 'every open PR, then the newest, twenty in all');
    for (const p of view.pullRequests!) {
      assert.equal(p.url, `https://github.com/Sample/MixedCase/pull/${p.number}`, 'shown exactly as T3 gave it');
      assert.equal(p.repository, 'sample/mixedcase');
    }
    assert.match(textOf(result), /20 shown; older ones may be left out/);
    assert.deepEqual(prEvents(), ['pull_request_merged', 'pull_request_opened'], 'a launched job starts from none: one event per kind');
    // A newly linked closed PR pushes the oldest merged one out of the window. That raises nothing, and the read is still fresh.
    set(linked(26, { 4: 'open', 25: 'open', 26: 'closed' }).map(withPrivate));
    await tickAfter(60_001);
    const next = await agent.call<JobDetailView>('work_status', { jobId: job.jobId });
    assert.deepEqual(numbers(next.pullRequests), [4, ...range(8, 26)]);
    assert.deepEqual(prEvents(), ['pull_request_merged', 'pull_request_opened']);
    assert.notEqual(next.pullRequestsCheckedAt, view.pullRequestsCheckedAt);
    assertNotLogged(gw, ['PRIVATE-PR-TITLE', 'PRIVATE-BRANCH', 'MixedCase']);
    assert.equal(JSON.stringify(recent()).includes('MixedCase'), false, 'event details are code-only');
  });
}

test('an adopted job with a full snapshot: PRs entering and leaving the window are no news unless they are new', async (t) => {
  const { fake, gw, tick, tickAfter } = await startJobHarness(t);
  const { threadId } = fake.launchDirect({ projectId: 'project-1', title: 'Synthetic coordinator', message: 'Synthetic work' });
  fake.pullRequests.set(threadId, linked(25, { 4: 'open', 25: 'open' }));
  const { job } = await gw.services.jobs.adopt({ project: 'pilot', threadId });
  const stored = () => numbers(gw.services.jobs.store.require(job.id).pullRequests);
  const events = () => types(gw.services.jobs.store.recentEvents(job.id, 100)).filter((type) => type.startsWith('pull_request_'));
  await tick();
  assert.deepEqual(stored(), [4, ...range(7, 25)]);
  assert.deepEqual(events(), [], 'the first snapshot of an adopted job is a baseline');
  // The old open #4 is closed: it leaves the window and the old merged #6 returns to it. Nothing happened to #6.
  fake.pullRequests.set(threadId, linked(25, { 4: 'closed', 25: 'open' }));
  await tickAfter(60_001);
  assert.deepEqual(stored(), range(6, 25));
  assert.deepEqual(events(), []);
  // News still gets through a full window: a newly linked open PR, then one that arrives merged.
  fake.pullRequests.set(threadId, linked(26, { 4: 'closed', 25: 'open', 26: 'open' }));
  await tickAfter(60_001);
  assert.deepEqual(events(), ['pull_request_opened']);
  fake.pullRequests.set(threadId, linked(27, { 4: 'closed', 25: 'open', 26: 'open' }));
  await tickAfter(60_001);
  assert.deepEqual(events(), ['pull_request_opened', 'pull_request_merged']);
  assert.deepEqual(stored(), range(8, 27));
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
