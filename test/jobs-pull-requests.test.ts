import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  displayPullRequests, MAX_PULL_REQUESTS, MAX_TRACKED_PULL_REQUESTS, prKey, pullRequestEvents, pullRequestListSchema, readPullRequests,
} from '../src/jobs/pullRequests.ts';
import type { JobDetailView, JobView } from '../src/mcp/workTools.ts';
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
/** The same repository's PRs from `from` to `to`, all open. */
const opened = (from: number, to: number) => range(from, to).map((n) => cased('open', n));
/** The numbers, sorted: which PRs a list holds. */
const numbers = (prs: readonly { number: number }[] | null | undefined) => (prs ?? []).map((p) => p.number).sort((a, b) => a - b);
/** The numbers as listed: in which order a list shows them. */
const listed = (prs: readonly { number: number }[] | null | undefined) => (prs ?? []).map((p) => p.number);
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
    assert.doesNotMatch(textOf(result), /shown/, 'the note about the bound appears only above twenty followed PRs');
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
  // Owner and repository are compared without case, whichever of the two (or both) differs from T3's lower-case listing.
  for (const url of ['https://github.com/SAMPLE/MIXEDCASE/pull/16', 'https://github.com/Sample/mixedcase/pull/16',
    'https://github.com/sample/MixedCase/pull/16']) {
    assert.deepEqual(readPullRequests([{ ...cased(), url }]), [{ ...cased(), url }], url);
  }
  // The listing may have the capitals instead, and the URL none.
  const capitals = { ...cased(), repository: 'Sample/MixedCase', url: 'https://github.com/sample/mixedcase/pull/16' };
  assert.deepEqual(readPullRequests([capitals]), [capitals]);
  // Case of the host, the owner and the repository is the only leniency: the URL has to name this repository and number.
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

test('the pull segment is the lowercase one GitHub serves, and the number is canonical', () => {
  // GitHub answers /PULL/23 with a 404, so a URL that only matches once case is folded is no link to the PR.
  const at = (path: string, number = 23) =>
    ({ host: 'github.com', repository: 'owner/repo', number, url: `https://github.com${path}`, state: 'open' as const });
  assert.deepEqual(readPullRequests([at('/owner/repo/pull/23')]), [at('/owner/repo/pull/23')]);
  assert.deepEqual(readPullRequests([at('/Owner/REPO/pull/23')]), [at('/Owner/REPO/pull/23')], 'owner and repository may differ in case');
  for (const path of ['/owner/repo/PULL/23', '/Owner/Repo/PULL/23', '/owner/repo/Pull/23', '/owner/repo/pULL/23']) {
    assert.equal(readPullRequests([at(path)]), null, path);
  }
  // Nor does a host in capitals change that.
  assert.equal(readPullRequests([{ ...at('/owner/repo/PULL/23'), url: 'https://GITHUB.COM/owner/repo/PULL/23' }]), null);
  // No leading zeros or signs on the number either.
  for (const path of ['/owner/repo/pull/023', '/owner/repo/pull/0023', '/owner/repo/pull/+23']) assert.equal(readPullRequests([at(path)]), null, path);
  // A rejected entry skips only itself.
  assert.deepEqual(readPullRequests([at('/owner/repo/PULL/23'), at('/owner/repo/pull/24', 24)]), [at('/owner/repo/pull/24', 24)]);
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

test('up to 200 PRs are followed; beyond that every open one stays, then the newest', () => {
  // Everything up to the bound is kept, whatever the states.
  assert.deepEqual(numbers(readPullRequests(linked(25, { 4: 'open', 25: 'open' }))), range(1, 25));
  assert.equal(readPullRequests(linked(MAX_TRACKED_PULL_REQUESTS))?.length, MAX_TRACKED_PULL_REQUESTS);
  // 205 linked, #4 and #205 open, the rest merged: the five left out are the oldest merged ones, #1-#3, #5 and #6.
  const all = linked(205, { 4: 'open', 205: 'open' });
  const kept = readPullRequests(all);
  assert.equal(kept?.length, MAX_TRACKED_PULL_REQUESTS);
  assert.deepEqual(numbers(kept), [4, ...range(7, 205)]);
  // The result does not depend on the order T3 listed them in, is stored in key order, and reads back unchanged.
  assert.deepEqual(readPullRequests([...all].reverse()), kept);
  assert.deepEqual(kept, [...kept!].sort((a, b) => prKey(a).localeCompare(prKey(b))));
  assert.deepEqual(readPullRequests(kept), kept);
  // Closed and unknown PRs rank with the merged ones.
  assert.deepEqual(numbers(readPullRequests(linked(202, { 1: null, 2: 'closed', 3: 'open' }))), range(3, 202));
  // More than 200 open ones keep the 200 newest.
  assert.deepEqual(numbers(readPullRequests(linked(205).map((p) => ({ ...p, state: 'open' })))), range(6, 205));
  // Equal numbers in different repositories are ordered by key: which one is cut never depends on the order listed.
  const tie = [pr('merged', 1), cased('merged', 1), ...range(2, 200).map((n) => cased('merged', n))];
  for (const order of [tie, [...tie].reverse()]) {
    assert.equal(readPullRequests(order)?.find((p) => p.number === 1)?.repository, 'sample/mixedcase');
  }
});

test('what is shown is the twenty most relevant PRs, open ones first and then the newest, whatever order they come in', () => {
  const tracked = readPullRequests(linked(25, { 4: 'open', 25: 'open' }))!;
  const shown = displayPullRequests(tracked);
  // The open #25 and #4, then the newest of the rest down to #7: twenty in all, in that order.
  assert.equal(shown.length, MAX_PULL_REQUESTS);
  assert.deepEqual(listed(shown), [25, 4, ...range(7, 24).reverse()]);
  assert.deepEqual(displayPullRequests([...tracked].reverse()), shown);
  assert.equal(tracked.length, 25, 'the tracked list is not touched');
  // A short list is shown whole in the same order, and exactly twenty is no different from more.
  assert.deepEqual(listed(displayPullRequests(readPullRequests(linked(3, { 1: 'open' }))!)), [1, 3, 2]);
  assert.deepEqual(listed(displayPullRequests(readPullRequests(linked(20))!)), range(1, 20).reverse());
  assert.deepEqual(displayPullRequests([]), []);
  // Closed and unknown PRs rank with the merged ones; with more than twenty open ones the twenty newest show.
  assert.deepEqual(listed(displayPullRequests(readPullRequests(linked(22, { 1: null, 2: 'closed', 3: 'open' }))!)), [3, ...range(4, 22).reverse()]);
  assert.deepEqual(listed(displayPullRequests(readPullRequests(opened(1, 30))!)), range(11, 30).reverse());
  // Even from the most that is followed, twenty show.
  assert.equal(displayPullRequests(readPullRequests(linked(300))!).length, MAX_PULL_REQUESTS);
  // Equal numbers in different repositories settle by key.
  assert.deepEqual(displayPullRequests([pr('merged', 5), cased('merged', 5)]).map((p) => p.repository), ['sample/mixedcase', 'sample/widgets']);
});

test('the list schema takes the answer of T3 as it comes: an object with a list, entries judged later', () => {
  assert.equal(pullRequestListSchema.safeParse({ pullRequests: [...linked(25), null, 'text', { number: 'x' }], other: 1 }).success, true);
  for (const answer of [{}, { pullRequests: 'text' }, { pullRequests: null }, [], 'text']) {
    assert.equal(pullRequestListSchema.safeParse(answer).success, false);
  }
});

test('below the tracking bound nothing is left out: a merge is seen whether the PR was followed or arrived merged', () => {
  // Twenty open PRs, then #1 and #2 are unlinked and #21 opens and merges between two polls. Twenty used to count as a full window,
  // and a merged PR cannot outrank a window of open ones, so this merge went unreported then and at every later poll.
  const twenty = readPullRequests(opened(1, 20))!;
  const afterNew = readPullRequests([...opened(3, 20), cased('merged', 21)])!;
  assert.equal(twenty.length, 20);
  assert.deepEqual(types(pullRequestEvents(twenty, afterNew)), ['pull_request_merged']);
  assert.deepEqual(pullRequestEvents(afterNew, afterNew), [], 'and it is reported once');
  // Twenty-one open PRs, then #2 merges. The 20-PR snapshot cut the merged PR before it was compared.
  const twentyOne = readPullRequests(opened(1, 21))!;
  assert.equal(twentyOne.length, 21, 'all of them are followed');
  const afterMerge = readPullRequests([cased('open', 1), cased('merged', 2), ...opened(3, 21)])!;
  assert.equal(afterMerge.length, 21);
  assert.deepEqual(types(pullRequestEvents(twentyOne, afterMerge)), ['pull_request_merged']);
  assert.deepEqual(pullRequestEvents(afterMerge, afterMerge), []);
  // One below the bound is still no window: the first sequence again, with 199 open PRs.
  const nearly = readPullRequests(opened(1, MAX_TRACKED_PULL_REQUESTS - 1))!;
  assert.equal(nearly.length, MAX_TRACKED_PULL_REQUESTS - 1);
  assert.deepEqual(types(pullRequestEvents(nearly, readPullRequests([...opened(3, 199), cased('merged', 200)])!)), ['pull_request_merged']);
  // A PR the previous list did not hold is new in either state, a state change to open or merged is news, anything else is not.
  assert.deepEqual(types(pullRequestEvents([pr('open', 1)], [pr('open', 1), pr('merged', 2)])), ['pull_request_merged']);
  assert.deepEqual(types(pullRequestEvents([pr('open', 1)], [pr('open', 1), pr('open', 2)])), ['pull_request_opened']);
  assert.deepEqual(types(pullRequestEvents([pr('closed', 1)], [pr('open', 1)])), ['pull_request_opened'], 'reopened');
  assert.deepEqual(pullRequestEvents([pr('open', 1)], [pr('closed', 1), pr('closed', 2), pr(null, 3)]), []);
  // One logical event per kind, however many PRs changed.
  assert.deepEqual(types(pullRequestEvents([pr('open', 1), pr('open', 2)], [pr('merged', 1), pr('merged', 2), pr('open', 3), pr('open', 4)])),
    ['pull_request_opened', 'pull_request_merged']);
});

test('a list at the tracking bound is a window: a PR leaving it or an old one returning to it is not news, a PR that outranks its last entry is', () => {
  const read = (states: Record<number, State>, count = 205) => readPullRequests(linked(count, states))!;
  // 205 linked, #4 and #205 open: the window is #4 and #7-#205.
  const before = read({ 4: 'open', 205: 'open' });
  assert.equal(before.length, MAX_TRACKED_PULL_REQUESTS);
  assert.deepEqual(numbers(before), [4, ...range(7, 205)]);
  // #4 is closed: it leaves the window and the old merged #6 returns to it. Nothing happened to #6.
  assert.deepEqual(pullRequestEvents(before, read({ 4: 'closed', 205: 'open' })), []);
  // 201 linked, #100 open and the rest merged: the oldest, #1, is left out. Unlinking #100 brings #1 back into the window. Not news.
  const full = readPullRequests(linked(201, { 100: 'open' }))!;
  assert.deepEqual(numbers(full), range(2, 201));
  const back = readPullRequests(linked(201, { 100: 'open' }).filter((p) => p.number !== 100))!;
  assert.deepEqual(numbers(back), [1, ...range(2, 201).filter((n) => n !== 100)]);
  assert.deepEqual(pullRequestEvents(full, back), [], 'an old PR coming back into a full list because another left is not news');
  // A newly linked closed PR pushes the oldest merged one out: nothing either.
  assert.deepEqual(pullRequestEvents(before, read({ 4: 'open', 205: 'open', 206: 'closed' }, 206)), []);
  // A new open PR is news, and so is one that arrives merged and is newer than the window's last entry.
  assert.deepEqual(types(pullRequestEvents(before, read({ 4: 'open', 205: 'open', 206: 'open' }, 206))), ['pull_request_opened']);
  assert.deepEqual(types(pullRequestEvents(before, read({ 4: 'open', 205: 'open' }, 206))), ['pull_request_merged']);
  // An old PR that was cut and is open now outranks the window's last entry: reopened, so news.
  assert.deepEqual(types(pullRequestEvents(before, read({ 2: 'open', 4: 'open', 205: 'open' }))), ['pull_request_opened']);
  // A PR inside the window changing state is news as always.
  assert.deepEqual(types(pullRequestEvents(before, read({ 205: 'merged', 4: 'open' }))), ['pull_request_merged']);
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

test('a list past twenty is followed in full and shown in part, and terminal jobs stop polling', async (t) => {
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
  const followed = gw.services.jobs.store.require(job.jobId);
  assert.deepEqual(numbers(followed.pullRequests), range(1, 21), 'all 21 open PRs are followed');
  assert.deepEqual(numbers((await agent.call<JobDetailView>('work_status', { jobId: job.jobId })).pullRequests), range(2, 21), 'the twenty newest are shown');
  assert.ok(followed.pullRequestsCheckedAt! > previous!, 'the read counts as fresh');
  gw.services.jobs.store.transition(job.jobId, { from: ['running'], to: 'cancelled' });
  fake.pullRequests.set(threadId, [pr('merged')]);
  await tickAfter(60_001);
  assert.deepEqual(gw.services.jobs.store.require(job.jobId).pullRequests, followed.pullRequests);
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
  const read = readPullRequests(answer.pullRequests);
  assert.equal(read?.length, 25, 'every valid entry is followed');
  assert.equal(displayPullRequests(read!).length, MAX_PULL_REQUESTS, 'and twenty of them are shown');
});

for (const inline of [true, false]) {
  test(`capitals and over twenty PRs: all are followed, twenty are shown, and no event as the shown ones change (${inline ? 'inline' : 'fallback'})`, async (t) => {
    const { fake, gw, agent, tick, tickAfter } = await startJobHarness(t);
    fake.inlinePullRequests = inline;
    const job = await startJob(agent);
    await tick();
    const { threadId } = fake.threadForJob(job.jobId);
    const recent = () => gw.services.jobs.store.recentEvents(job.jobId, 100);
    const prEvents = () => types(recent()).filter((type) => type.startsWith('pull_request_')).sort();
    const followed = () => numbers(gw.services.jobs.store.require(job.jobId).pullRequests);
    // 25 linked PRs, #4 and #25 open, plus an entry from another forge and two that are no PR at all.
    const gitlab = { ...pr('open', 3), host: 'gitlab.example', url: 'https://gitlab.example/sample/widgets/-/merge_requests/3' };
    const odd = [gitlab, null, 'text'];
    const withPrivate = (p: ReturnType<typeof cased>) => ({ ...p, title: 'PRIVATE-PR-TITLE', headBranch: 'PRIVATE-BRANCH' });
    const set = (list: unknown[]) => fake.pullRequests.set(threadId, list as Record<string, unknown>[]);
    set([...linked(25, { 4: 'open', 25: 'open' }).map(withPrivate), ...odd]);
    await tickAfter(60_001);
    const result = await agent.client.callTool({ name: 'work_status', arguments: { jobId: job.jobId } });
    const view = result.structuredContent as JobDetailView;
    assert.deepEqual(listed(view.pullRequests), [25, 4, ...range(7, 24).reverse()], 'every open PR, then the newest, twenty in all');
    for (const p of view.pullRequests!) {
      assert.equal(p.url, `https://github.com/Sample/MixedCase/pull/${p.number}`, 'shown exactly as T3 gave it');
      assert.equal(p.repository, 'sample/mixedcase');
    }
    assert.match(textOf(result), /PRs \(20 of 25 shown; open ones first, then the newest\)/);
    assert.deepEqual(followed(), range(1, 25), 'the job follows all 25');
    assert.deepEqual(prEvents(), ['pull_request_merged', 'pull_request_opened'], 'a launched job starts from none: one event per kind');
    // A newly linked closed PR changes what is shown (the oldest merged one drops out). That raises nothing, and the read is still fresh.
    set(linked(26, { 4: 'open', 25: 'open', 26: 'closed' }).map(withPrivate));
    await tickAfter(60_001);
    const next = await agent.call<JobDetailView>('work_status', { jobId: job.jobId });
    assert.deepEqual(numbers(next.pullRequests), [4, ...range(8, 26)]);
    assert.deepEqual(followed(), range(1, 26));
    assert.deepEqual(prEvents(), ['pull_request_merged', 'pull_request_opened']);
    assert.notEqual(next.pullRequestsCheckedAt, view.pullRequestsCheckedAt);
    assertNotLogged(gw, ['PRIVATE-PR-TITLE', 'PRIVATE-BRANCH', 'MixedCase']);
    assert.equal(JSON.stringify(recent()).includes('MixedCase'), false, 'event details are code-only');
  });
}

for (const inline of [true, false]) {
  test(`a merge is reported when a PR opens and merges between two polls and when a followed PR merges past twenty (${inline ? 'inline' : 'fallback'})`, async (t) => {
    const { fake, gw, agent, tick, tickAfter } = await startJobHarness(t);
    fake.inlinePullRequests = inline;
    const first = await startJob(agent);
    const second = await startJob(agent);
    await tick();
    const prEvents = (jobId: string) => types(gw.services.jobs.store.recentEvents(jobId, 100)).filter((type) => type.startsWith('pull_request_'));
    const set = (jobId: string, list: unknown[]) => fake.pullRequests.set(fake.threadForJob(jobId).threadId, list as Record<string, unknown>[]);
    // One thread links 20 open PRs, the other 21.
    set(first.jobId, opened(1, 20));
    set(second.jobId, opened(1, 21));
    await tickAfter(60_001);
    assert.deepEqual(prEvents(first.jobId), ['pull_request_opened']);
    assert.deepEqual(prEvents(second.jobId), ['pull_request_opened']);
    assert.deepEqual(numbers(gw.services.jobs.store.require(second.jobId).pullRequests), range(1, 21), 'all 21 are followed');
    // First: #1 and #2 are unlinked, and #21 opens and merges between two polls. Second: #2 merges.
    set(first.jobId, [...opened(3, 20), cased('merged', 21)]);
    set(second.jobId, [cased('open', 1), cased('merged', 2), ...opened(3, 21)]);
    await tickAfter(60_001);
    assert.deepEqual(prEvents(first.jobId), ['pull_request_opened', 'pull_request_merged']);
    assert.deepEqual(prEvents(second.jobId), ['pull_request_opened', 'pull_request_merged']);
    // Each is reported once: the next polls see the same lists, and the feed carries both merges.
    await tickAfter(60_001);
    assert.deepEqual(prEvents(first.jobId), ['pull_request_opened', 'pull_request_merged']);
    assert.deepEqual(prEvents(second.jobId), ['pull_request_opened', 'pull_request_merged']);
    const feed = await agent.call<{ events: { jobId: string; type: string }[] }>('work_feed');
    assert.deepEqual(feed.events.filter((e) => e.type === 'pull_request_merged').map((e) => e.jobId).sort(), [first.jobId, second.jobId].sort());
  });
}

test('an adopted job at the tracking bound: PRs entering and leaving the list are no news unless they are new', async (t) => {
  const { fake, gw, tick, tickAfter } = await startJobHarness(t);
  const { threadId } = fake.launchDirect({ projectId: 'project-1', title: 'Synthetic coordinator', message: 'Synthetic work' });
  fake.pullRequests.set(threadId, linked(205, { 4: 'open', 205: 'open' }));
  const { job } = await gw.services.jobs.adopt({ project: 'pilot', threadId });
  const stored = () => numbers(gw.services.jobs.store.require(job.id).pullRequests);
  const events = () => types(gw.services.jobs.store.recentEvents(job.id, 100)).filter((type) => type.startsWith('pull_request_'));
  await tick();
  assert.deepEqual(stored(), [4, ...range(7, 205)], 'the 200 best of 205');
  assert.deepEqual(events(), [], 'the first snapshot of an adopted job is a baseline');
  // The old open #4 is closed: it leaves the list and the old merged #6 returns to it. Nothing happened to #6.
  fake.pullRequests.set(threadId, linked(205, { 4: 'closed', 205: 'open' }));
  await tickAfter(60_001);
  assert.deepEqual(stored(), range(6, 205));
  assert.deepEqual(events(), []);
  // News still gets through a list at the bound: a newly linked open PR, then one that arrives merged.
  fake.pullRequests.set(threadId, linked(206, { 4: 'closed', 205: 'open', 206: 'open' }));
  await tickAfter(60_001);
  assert.deepEqual(events(), ['pull_request_opened']);
  fake.pullRequests.set(threadId, linked(207, { 4: 'closed', 205: 'open', 206: 'open' }));
  await tickAfter(60_001);
  assert.deepEqual(events(), ['pull_request_opened', 'pull_request_merged']);
  assert.deepEqual(stored(), range(8, 207));
});

test('snapshots stored by 0.1.13 (at most twenty) still read, and the first read after the upgrade follows the rest', async (t) => {
  const { fake, gw, agent, tick, tickAfter } = await startJobHarness(t, { maxConcurrentJobs: 3 });
  const merged = await startJob(agent);
  const open = await startJob(agent);
  await tick();
  const store = gw.services.jobs.store;
  const prEvents = (jobId: string) => types(store.recentEvents(jobId, 100)).filter((type) => type.startsWith('pull_request_'));
  /** What 0.1.13 left in the column: the open PRs first, then the newest, twenty at most, in key order. */
  const written013 = (jobId: string, list: ReturnType<typeof cased>[]) => {
    const kept = [...list].sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.number - a.number)
      .slice(0, 20).sort((a, b) => prKey(a).localeCompare(prKey(b)));
    gw.services.db.prepare('UPDATE jobs SET pull_requests = ?, pull_requests_checked_at = ? WHERE id = ?').run(JSON.stringify(kept), gw.clock(), jobId);
    return kept;
  };
  // 25 linked, #4 and #25 open: 0.1.13 kept #4 and #7-#25. The five it left out are merged.
  const all = linked(25, { 4: 'open', 25: 'open' });
  const kept = written013(merged.jobId, all);
  assert.deepEqual(numbers(kept), [4, ...range(7, 25)]);
  assert.deepEqual(store.require(merged.jobId).pullRequests, kept, 'a stored list of twenty reads back unchanged');
  // 22 open: 0.1.13 kept #3-#22. The two it left out, #1 and #2, are open.
  const keptOpen = written013(open.jobId, opened(1, 22));
  assert.deepEqual(numbers(keptOpen), range(3, 22));
  fake.pullRequests.set(fake.threadForJob(merged.jobId).threadId, all);
  fake.pullRequests.set(fake.threadForJob(open.jobId).threadId, opened(1, 22));
  await tickAfter(60_001);
  // The extra PRs are new to the list: at most one event of each kind, once, as documented. Nothing else changes.
  assert.deepEqual(numbers(store.require(merged.jobId).pullRequests), range(1, 25));
  assert.deepEqual(prEvents(merged.jobId), ['pull_request_merged']);
  assert.deepEqual(numbers(store.require(open.jobId).pullRequests), range(1, 22));
  assert.deepEqual(prEvents(open.jobId), ['pull_request_opened']);
  await tickAfter(60_001);
  assert.deepEqual(prEvents(merged.jobId), ['pull_request_merged']);
  assert.deepEqual(prEvents(open.jobId), ['pull_request_opened']);
  // What is shown is what 0.1.13 showed.
  assert.deepEqual(numbers((await agent.call<JobDetailView>('work_status', { jobId: merged.jobId })).pullRequests), numbers(kept));
  assert.deepEqual(numbers((await agent.call<JobDetailView>('work_status', { jobId: open.jobId })).pullRequests), numbers(keptOpen));
  // A thread with twenty or fewer PRs raises nothing at all on the first read.
  const small = await startJob(agent);
  await tick();
  const smallList = linked(20, { 20: 'open' });
  const keptSmall = written013(small.jobId, smallList);
  assert.equal(keptSmall.length, 20);
  fake.pullRequests.set(fake.threadForJob(small.jobId).threadId, smallList);
  await tickAfter(60_001);
  assert.deepEqual(prEvents(small.jobId), []);
});

test('every job tool shows at most twenty PRs, open ones first, and the text says how many the job follows', async (t) => {
  const { fake, gw, agent, tick, tickAfter } = await startJobHarness(t);
  const job = await startJob(agent);
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  // 25 linked PRs, #4 and #25 open. The turn has finished, so the job is idle and needs attention.
  fake.pullRequests.set(threadId, linked(25, { 4: 'open', 25: 'open' }));
  fake.finishTurn(threadId, 'Synthetic done');
  await tickAfter(60_001);
  assert.equal(gw.services.jobs.store.require(job.jobId).state, 'idle');
  assert.equal(gw.services.jobs.store.require(job.jobId).pullRequests?.length, 25);
  const links = (text: string) => (text.match(/https:\/\/github\.com\/Sample\/MixedCase\/pull\//g) ?? []).length;
  const check = (view: JobView, text: string, tool: string) => {
    assert.deepEqual(listed(view.pullRequests), [25, 4, ...range(7, 24).reverse()], `${tool}: open ones first, then the newest`);
    assert.match(text, /PRs \(20 of 25 shown; open ones first, then the newest\): sample\/mixedcase#25 open /, tool);
    assert.equal(links(text), MAX_PULL_REQUESTS, `${tool}: twenty links in the text`);
  };
  const call = (name: string, args: Record<string, unknown>) => agent.client.callTool({ name, arguments: args });
  const status = await call('work_status', { jobId: job.jobId });
  check(status.structuredContent as JobDetailView, textOf(status), 'work_status');
  const list = await call('work_list', {});
  check((list.structuredContent as { jobs: JobView[] }).jobs[0]!, textOf(list), 'work_list');
  const feed = await call('work_feed', {});
  const attention = (feed.structuredContent as { attention: JobView[] }).attention.find((item) => item.jobId === job.jobId);
  assert.ok(attention, 'the idle job needs attention');
  assert.deepEqual(listed(attention.pullRequests), [25, 4, ...range(7, 24).reverse()], 'work_feed attention');
  const messages = await call('work_messages', { jobId: job.jobId });
  check((messages.structuredContent as { job: JobView }).job, textOf(messages), 'work_messages');
  // At the tracking bound the count is a floor: the thread may link more than the job follows.
  fake.pullRequests.set(threadId, linked(205, { 4: 'open', 25: 'open' }));
  await tickAfter(60_001);
  assert.equal(gw.services.jobs.store.require(job.jobId).pullRequests?.length, MAX_TRACKED_PULL_REQUESTS);
  const bounded = await call('work_status', { jobId: job.jobId });
  assert.match(textOf(bounded), /PRs \(20 of 200\+ shown; open ones first, then the newest\)/);
  assert.equal(listed((bounded.structuredContent as JobDetailView).pullRequests).length, MAX_PULL_REQUESTS);
  // The tools that change a job show the same view.
  const sent = await call('work_continue', { jobId: job.jobId, message: 'Synthetic follow-up', requestId: 'follow-up-1' });
  assert.equal(listed((sent.structuredContent as { job: JobView }).job.pullRequests).length, MAX_PULL_REQUESTS, 'work_continue');
  assert.match(textOf(sent), /20 of 200\+ shown/);
  const cancelled = await call('work_cancel', { jobId: job.jobId });
  assert.equal(listed((cancelled.structuredContent as { job: JobView }).job.pullRequests).length, MAX_PULL_REQUESTS, 'work_cancel');
  assert.match(textOf(cancelled), /20 of 200\+ shown/);
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
