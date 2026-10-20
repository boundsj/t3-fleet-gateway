import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import type { LaunchSpec } from '../src/jobs/launchSpec.ts';
import { JobStore } from '../src/jobs/store.ts';
import { createLogger } from '../src/log.ts';
import { assertNotLogged, jobState, startJobHarness, type JobHarness } from './helpers/jobs.ts';
import { tempDir } from './helpers/tmp.ts';

// Text that lives only in a stored launch spec. It must reach no log line, event detail, tool result or dashboard page.
const MARKER = 'PRIVATE_SYNTHETIC_SPEC_MARKER';
// What a build that knows more than this one (or damage) leaves behind: unreadable here, whatever it says.
const UNSUPPORTED = JSON.stringify({ v: 99, projectId: 'project-1', note: MARKER });
const FIXED_MESSAGE = "This job's stored launch plan could not be read. Start the work again.";
const SELECTION = { instanceId: 'synthetic-provider', model: 'synthetic-model' };
const DASHBOARD = { enabled: true, allowedHosts: ['dashboard.example.test'] };
/** `pilot` is the machine's scratch alias and its default: host-only starts and `project: 'pilot'` record version 2 specs. */
const SCRATCH = { host: { discovery: { enabled: true }, defaultProject: 'pilot' }, pilot: { workspaceMode: 'scratch' } };

interface JobSummary {
  jobId: string;
  state: string;
  project: string;
  host: string;
  projectId: string | null;
  projectName: string | null;
  source: string;
  model: unknown;
  workspaceMode: string | null;
  branch: string;
}
interface JobDetail extends JobSummary {
  lastError: { code: string; message: string } | null;
}
interface Feed {
  events: { jobId: string; type: string; fromState: string | null; toState: string | null; reason: string | null; code: string | null }[];
}
interface Snapshot {
  jobs: {
    open: { id: string; state: string; project: string; projectName: string | null; hostId: string }[];
    recent: { id: string; state: string; error: { code: string; detail: string | null } | null }[];
  };
}

async function start(h: JobHarness, args: Record<string, unknown>): Promise<string> {
  return (await h.agent.call<{ job: { jobId: string } }>('work_start', { task: 'Synthetic task', ...args })).job.jobId;
}

/** Written straight into the ledger, as damage or a record from a newer build would leave it. */
function corrupt(h: JobHarness, jobId: string, text = UNSUPPORTED): void {
  h.gw.services.db.prepare('UPDATE jobs SET launch_spec = ? WHERE id = ?').run(text, jobId);
}

/** The stored text reaches no log line, no event detail and none of the results given: codes and fixed text only. */
function assertNoSpecText(h: JobHarness, ...results: unknown[]): void {
  assertNotLogged(h.gw, [MARKER]);
  assert.equal(JSON.stringify(h.gw.services.db.prepare('SELECT detail FROM job_events').all()).includes(MARKER), false, 'event details');
  for (const result of results) assert.equal(JSON.stringify(result).includes(MARKER), false);
}

function unreadableWarnings(h: JobHarness): Record<string, unknown>[] {
  return h.gw.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === 'job.launch_spec_unreadable');
}

describe('a stored launch spec this build cannot read', () => {
  test('a bad plan at the head of the queue fails that job alone, and the jobs behind it launch in the same tick', async (t) => {
    const h = await startJobHarness(t, { maxConcurrentJobs: 2, host: { discovery: { enabled: true } } });
    // An explicit model selection records a version 1 spec on a worktree alias. Read as no spec, this job would launch as a
    // plain alias job from the configuration, without the model it was started with.
    const bad = await start(h, { project: 'pilot', modelSelection: SELECTION, requestId: 'bad' });
    const first = await start(h, { project: 'docs', requestId: 'good-1' });
    const second = await start(h, { project: 'docs', requestId: 'good-2' });
    assert.equal(h.gw.services.jobs.store.require(bad).launchSpec?.v, 1);
    corrupt(h, bad);

    await h.tick();
    assert.equal(h.fake.threads.size, 2, 'only the two jobs with readable plans launched, in the one tick');
    for (const id of [first, second]) {
      // Jobs without a stored spec are alias jobs, launched from the configuration as before.
      assert.deepEqual(h.fake.threadForJob(id).launch.workspaceStrategy, { type: 'worktree', baseRef: 'trunk', branch: `agents/${id}`, startFromOrigin: false });
      assert.equal(await jobState(h.agent, id), 'running');
    }
    assert.throws(() => h.fake.threadForJob(bad), /no thread for job/, 'never launched, not even as an alias job');

    const status = await h.agent.call<JobDetail>('work_status', { jobId: bad });
    assert.deepEqual([status.state, status.lastError], ['failed', { code: 'database_error', message: FIXED_MESSAGE }]);
    const feed = await h.agent.call<Feed>('work_feed');
    assert.deepEqual(
      feed.events.filter((event) => event.jobId === bad && event.type === 'state_changed').map((event) => [event.fromState, event.toState, event.reason, event.code]),
      [['queued', 'failed', 'database_error', 'database_error']],
      'a guarded transition, so the failure is in the feed',
    );
    await h.tick();
    assert.equal(h.fake.threads.size, 2, 'later ticks launch nothing more');
    assert.equal(h.gw.logs.filter((line) => line.includes('jobs.host_tick_failed')).length, 0, 'no step of the tick failed');
    assertNoSpecText(h, status, feed);
  });

  test('a bad plan on a running job does not stop the watcher from seeing another job on the host', async (t) => {
    const h = await startJobHarness(t, { maxConcurrentJobs: 3 });
    const bad = await start(h, { project: 'pilot', requestId: 'bad' });
    const good = await start(h, { project: 'docs', requestId: 'good' });
    await h.tick();
    corrupt(h, bad);

    h.fake.finishTurn(h.fake.threadForJob(good).threadId, 'Synthetic result of the good job');
    await h.tick();
    assert.equal(await jobState(h.agent, good), 'idle', 'the watcher saw the finished turn');
    // The job with the bad plan is followed like any other: it has a thread, and the plan was only ever the launch's.
    h.fake.finishTurn(h.fake.threadForJob(bad).threadId, 'Synthetic result of the bad job');
    await h.tick();
    assert.equal(await jobState(h.agent, bad), 'idle');
    const follow = await h.agent.call<{ job: { state: string } }>('work_continue', {
      jobId: bad, message: 'Synthetic follow-up', requestId: 'follow-up',
    });
    assert.equal(follow.job.state, 'running');
    assert.equal(h.fake.sends.at(-1)?.message, 'Synthetic follow-up');
    assert.equal(h.gw.logs.filter((line) => line.includes('jobs.host_tick_failed')).length, 0, 'no step of any tick failed');

    // One warning for the job, however often it is read, and it names only codes and ids.
    assert.deepEqual(unreadableWarnings(h).map(({ level, jobId, hostId }) => ({ level, jobId, hostId })), [{ level: 'warn', jobId: bad, hostId: 'main' }]);
    assertNoSpecText(h);
  });

  test('work_list, work_status, work_start replays and work_cancel work for a job with a bad plan, which shows no launch metadata', async (t) => {
    const h = await startJobHarness(t, {
      maxConcurrentJobs: 2,
      ...SCRATCH,
      host: { ...SCRATCH.host, discovery: { enabled: true, allowWorkStart: true } },
    });
    const scratch = await start(h, { target: { host: 'main' }, requestId: 'scratch' });
    const worktree = await start(h, { project: 'docs', requestId: 'worktree' });
    const waiting = await start(h, { target: { host: 'main' }, requestId: 'waiting' });
    const discovered = await start(h, { target: { host: 'main', projectId: 'project-3' }, requestId: 'discovered' });
    await h.tick();
    const states = await Promise.all([scratch, worktree, waiting, discovered].map((id) => jobState(h.agent, id)));
    assert.deepEqual(states, ['running', 'running', 'queued', 'queued']);
    corrupt(h, scratch);
    corrupt(h, waiting);
    corrupt(h, discovered);

    const listed = await h.agent.call<{ jobs: JobSummary[] }>('work_list');
    assert.deepEqual(listed.jobs.map((job) => job.jobId).sort(), [scratch, worktree, waiting, discovered].sort());
    const listing = new Map(listed.jobs.map((job) => [job.jobId, job]));
    // What the ledger columns say stays; what only the plan said is gone. The workspace is unknown, not a worktree.
    const expected: [string, string, string, string, string][] = [
      [scratch, 'pilot', 'alias', 'project-1', ''],
      [waiting, 'pilot', 'alias', 'project-1', ''],
      [discovered, '@main/project-3', 'discovered', 'project-3', `fleet/${discovered}`],
    ];
    for (const [id, project, source, projectId, branch] of expected) {
      const job = listing.get(id)!;
      assert.deepEqual(
        [job.project, job.host, job.projectId, job.source, job.projectName, job.model, job.workspaceMode, job.branch],
        [project, 'main', projectId, source, null, null, null, branch],
        id,
      );
    }
    assert.equal(listing.get(worktree)!.workspaceMode, 'worktree');
    const status = await h.agent.call<JobDetail>('work_status', { jobId: scratch });
    assert.deepEqual([status.state, status.workspaceMode, status.projectName, status.model, status.lastError], ['running', null, null, null, null]);
    assert.equal((await h.agent.call<JobDetail>('work_status', { jobId: worktree })).workspaceMode, 'worktree');
    const feed = await h.agent.call<Feed & { attention: unknown[] }>('work_feed');

    const replay = await h.agent.call<{ job: JobSummary; created: boolean }>('work_start', {
      target: { host: 'main' }, task: 'Synthetic task', requestId: 'waiting',
    });
    assert.deepEqual([replay.created, replay.job.jobId, replay.job.state, replay.job.workspaceMode], [false, waiting, 'queued', null]);
    const cancel = async (jobId: string) => (await h.agent.call<{ outcome: string }>('work_cancel', { jobId })).outcome;
    assert.equal(await cancel(waiting), 'cancelled', 'the agent can clear a queued job');
    assert.equal(await jobState(h.agent, waiting), 'cancelled');
    assert.equal(await cancel(scratch), 'cancel_requested', 'and interrupt a running one');
    assertNoSpecText(h, listed, status, feed, replay);
  });

  test('the dashboard snapshot loads and lists a job with a bad plan, then shows why a queued one failed', async (t) => {
    const h = await startJobHarness(t, { maxConcurrentJobs: 2, dashboard: DASHBOARD });
    const running = await start(h, { project: 'pilot', requestId: 'running' });
    const other = await start(h, { project: 'docs', requestId: 'other' });
    const queued = await start(h, { project: 'docs', requestId: 'queued' });
    await h.tick();
    corrupt(h, running);
    corrupt(h, queued);
    const snapshot = async (): Promise<Snapshot> => {
      const response = await fetch(`http://127.0.0.1:${h.gw.gateway.dashboard!.port}/api/snapshot`, { headers: { 'x-t3fg-dashboard': '1' } });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as Snapshot;
    };

    let snap = await snapshot();
    const open = (id: string) => snap.jobs.open.find((job) => job.id === id);
    assert.deepEqual([running, queued, other].map((id) => open(id)?.state), ['running', 'queued', 'running']);
    assert.deepEqual([open(running)?.project, open(running)?.hostId, open(running)?.projectName], ['pilot', 'main', null]);

    // A slot frees: the queued job with the bad plan fails in that tick and the page says why, in fixed text.
    h.fake.finishTurn(h.fake.threadForJob(other).threadId, 'Synthetic result');
    await h.tick();
    snap = await snapshot();
    const failed = snap.jobs.recent.find((job) => job.id === queued);
    assert.deepEqual([failed?.state, failed?.error?.code], ['failed', 'database_error']);
    assert.match(failed?.error?.detail ?? '', /launch plan could not be read/);
    assert.equal(h.fake.threads.size, 2, 'the failed job was never launched');
    assertNoSpecText(h, snap);
  });

  test('reads never throw; no spec stays no spec, and a spec that cannot be read is flagged, not read as none', (t) => {
    const lines: string[] = [];
    const db = openDatabase(join(tempDir(t), 'test.db'));
    t.after(() => db.close());
    const store = new JobStore(db, () => 1_000, createLogger({ sink: (line) => lines.push(line) }));
    const readable: LaunchSpec = {
      v: 2, projectId: 'project-1', projectName: null, source: 'alias', alias: 'pilot', hostId: 'main',
      workspace: { kind: 'scratch' }, defaultProject: null, runtimeMode: 'auto', model: { source: 't3_default', selection: null },
    };
    const unreadable: [string, string][] = [
      ['malformed JSON', `{"note":"${MARKER}"`],
      ['empty text', ''],
      ['JSON null', 'null'],
      ['not an object', `["${MARKER}"]`],
      ['an unknown version', UNSUPPORTED],
      ['version 1 without its fields', `{"v":1,"projectId":"project-1","note":"${MARKER}"}`],
      ['version 2 scratch without an alias', JSON.stringify({ ...readable, source: 'discovered', alias: null, note: MARKER })],
      ['an unknown field', JSON.stringify({ ...readable, note: MARKER })],
    ];
    const create = (id: string, launchSpec?: LaunchSpec) => store.create({
      id, clientId: 'c', requestId: id, inputHash: id, projectAlias: 'pilot', hostId: 'main', task: 'Synthetic', title: 'Synthetic',
      branch: '', runtimeMode: 'auto', ...(launchSpec ? { launchSpec } : {}),
    });
    create('legacy0001');
    create('spec0000001', readable);
    unreadable.forEach(([, text], index) => {
      create(`bad000000${index}`);
      db.prepare('UPDATE jobs SET launch_spec = ? WHERE id = ?').run(text, `bad000000${index}`);
    });
    const badIds = unreadable.map((_, index) => `bad000000${index}`);

    const flags = (ids: string[]) => ids.map((id) => {
      const job = store.get(id);
      assert.ok(job, id);
      return [job.launchSpec?.v ?? null, job.launchSpecUnreadable];
    });
    assert.deepEqual(flags(['legacy0001', 'spec0000001']), [[null, false], [2, false]], 'no spec is legacy; a readable one is read');
    for (const [index, [what]] of unreadable.entries()) assert.deepEqual(flags([badIds[index]!]), [[null, true]], what);
    assert.equal(store.require(badIds[0]!).launchSpecUnreadable, true);

    // Every read built on the row, each with all of them in its result.
    const all = ['legacy0001', 'spec0000001', ...badIds].sort();
    const ids = (jobs: { id: string }[]) => jobs.map((job) => job.id).sort();
    assert.deepEqual(ids(store.list({ limit: 100 })), all);
    assert.deepEqual(ids(store.queued('main', 100)), all);
    assert.deepEqual(ids(store.onHost('main', ['queued'])), all);
    db.prepare('INSERT INTO webhook_subscriptions (id, revision, identity, settings, route) VALUES (?, ?, ?, ?, ?)').run(
      'receiver', 'revision-1', 'identity-1', '{"events":["failed"],"excerptChars":0}',
      '{"url":"https://receiver.example.com/synthetic-path","header":"authorization","value":"Bearer synthetic-key"}',
    );
    for (const id of badIds) store.transition(id, { from: ['queued'], to: 'failed', changes: { lastErrorCode: 'database_error' } });
    assert.deepEqual(ids(store.attention(2_000, 60_000, 100)), [...badIds].sort(), 'guarded transitions work on them, and so does attention');
    const rows = db.prepare('SELECT payload FROM webhook_deliveries ORDER BY id').all() as { payload: string }[];
    const deliveries = rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    assert.deepEqual(
      deliveries.map((payload) => [payload.jobId, payload.type, payload.state]),
      badIds.map((id) => [id, 'failed', 'failed']),
      'and webhooks that match the failure get it',
    );
    assert.equal(JSON.stringify(deliveries).includes(MARKER), false);
    assert.equal(store.get(badIds[0]!, { hostIds: ['elsewhere'] }), undefined);
    assert.deepEqual(flags(badIds).map(([, unread]) => unread), badIds.map(() => true), 'the stored text is left as it was');
    assert.equal((db.prepare('SELECT launch_spec FROM jobs WHERE id = ?').get(badIds[4]!) as { launch_spec: string }).launch_spec, UNSUPPORTED);

    // A warning for each, once, with ids only.
    const warnings = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === 'job.launch_spec_unreadable');
    assert.deepEqual(warnings.map((entry) => entry.jobId).sort(), [...badIds].sort());
    assert.equal(lines.join('\n').includes(MARKER), false);
  });
});
