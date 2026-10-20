import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GatewayError } from '../src/errors.ts';
import { startInputHash } from '../src/jobs/service.ts';
import { runWorkspaceProbe } from '../src/jobs/workspace.ts';
import { MINUTE, SECOND } from '../src/time.ts';
import { assertNotLogged, jobState, startJob, startJobHarness, type JobHarness, type JobHarnessOptions } from './helpers/jobs.ts';
import { tempDir } from './helpers/tmp.ts';

const probe = fileURLToPath(new URL('./helpers/workspaceProbe.js', import.meta.url));
const GIT = '/synthetic/git-repo';
const SHARED = '/synthetic/shared-git';

interface Probed extends JobHarness {
  state: string;
  /** Every request the synthetic probe has received, oldest first. */
  requests(): Record<string, unknown>[];
}

/** A job harness whose host chooses workspaces through the synthetic probe (and, unless told otherwise, every project is a repository). */
async function probed(t: TestContext, options: JobHarnessOptions = {}): Promise<Probed> {
  const state = tempDir(t);
  const h = await startJobHarness(t, { ...options, host: { workspaceProbeCommand: [process.execPath, probe, state], ...options.host } });
  h.fake.projects[0]!.workspaceRoot = GIT;
  h.fake.projects[1]!.workspaceRoot = `${GIT}-2`;
  h.fake.calls.length = 0;
  return {
    ...h,
    state,
    requests: () => (existsSync(join(state, 'requests.jsonl')) ? readFileSync(join(state, 'requests.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
  };
}

const store = (h: JobHarness) => h.gw.services.jobs.store;
type Launch = { workspaceStrategy: Record<string, unknown>; message: string; projectId: string };
const launchOf = (h: JobHarness, index: number) => h.fake.launches[index] as unknown as Launch;
const root = { type: 'root' } as const;

async function start(h: JobHarness, extra: Record<string, unknown>, requestId = `req-${Math.random().toString(36).slice(2)}`) {
  const { job } = await h.agent.call<{ job: { jobId: string; branch: string; workspaceMode: string | null } }>('work_start', { task: 'Synthetic task', requestId, ...extra });
  return job;
}

describe('hosts without a workspace probe keep the previous behavior', () => {
  test('alias-only starts keep their hash, stay downstream-free and launch a worktree from the local base', async (t) => {
    const h = await startJobHarness(t);
    h.fake.calls.length = 0;
    await h.fake.stop();
    const input = { project: 'docs', task: 'Synthetic task', requestId: 'legacy-docs' };
    const job = await start(h, input, input.requestId);
    assert.equal(h.fake.calls.length, 0);
    assert.equal(store(h).require(job.jobId).launchSpec, null);
    assert.equal(store(h).idempotencyKey(h.agent.clientId, 'work_start', input.requestId)?.inputHash, startInputHash(input));
    await h.fake.start();
    await h.tick();
    assert.deepEqual(launchOf(h, 0).workspaceStrategy, { type: 'worktree', baseRef: 'trunk', branch: job.branch, startFromOrigin: false });
    assert.equal(store(h).require(job.jobId).workspaceKind, null);
  });

  test('an explicit workspace is refused clearly, before anything else happens', async (t) => {
    const h = await startJobHarness(t);
    h.fake.calls.length = 0;
    const error = await h.agent.callError('work_start', { project: 'pilot', task: 'Synthetic', requestId: 'refused', workspace: root });
    assert.equal(error.code, 'invalid_argument');
    assert.match(error.text, /workspaceProbeCommand/);
    assert.equal(h.fake.calls.length, 0);
    assert.deepEqual(store(h).list({ limit: 10 }), []);
    // Any explicit choice, `auto` included, needs the probe.
    assert.equal((await h.agent.callError('work_start', { project: 'docs', task: 'x', requestId: 'r2', workspace: { type: 'auto' } })).code, 'invalid_argument');
    assert.equal(h.fake.calls.length, 0);
  });
});

describe('automatic workspace selection', () => {
  test('an alias-only start on an opted-in host is accepted with the host down, keeps the legacy hash and replays', async (t) => {
    const h = await probed(t);
    await h.fake.stop();
    const input = { project: 'docs', task: 'Synthetic task', requestId: 'optin-docs' };
    const job = await start(h, input, input.requestId);
    assert.equal(h.fake.calls.length, 0, 'nothing is read from T3');
    assert.equal(h.requests().length, 0, 'the probe is not run at acceptance');
    assert.equal(job.workspaceMode, null, 'undecided until it launches');
    const spec = store(h).require(job.jobId).launchSpec;
    assert.deepEqual(spec && spec.v === 3 ? [spec.projectId, spec.projectName, spec.alias, spec.workspace] : null, [null, null, 'docs', { type: 'auto', baseRef: 'trunk' }]);
    assert.equal(store(h).idempotencyKey(h.agent.clientId, 'work_start', input.requestId)?.inputHash, startInputHash(input));
    assert.equal((await h.agent.call<{ created: boolean }>('work_start', input)).created, false, 'a replay answers from the ledger');
    assert.equal(h.fake.calls.length, 0);
    assert.equal(await jobState(h.agent, job.jobId), 'queued');
    await h.tick();
    assert.equal(h.requests().length, 0, 'a host that is down is not probed');
  });

  test('a repository root gets a worktree from the fresh remote base, with the configured base ref', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4, host: { discovery: { enabled: true, allowWorkStart: true, baseRef: 'develop', branchPrefix: 'disc/' } } });
    const pilot = await start(h, { project: 'pilot' });
    const docs = await start(h, { project: 'docs' });
    h.fake.projects[2]!.workspaceRoot = `${GIT}-3`; // a T3 project no alias names
    const discovered = await start(h, { target: { host: 'main', projectId: 'project-3' } });
    await h.tick();
    assert.equal(h.fake.launches.length, 3);
    assert.deepEqual(launchOf(h, 0).workspaceStrategy, { type: 'worktree', baseRef: 'main', branch: pilot.branch, startFromOrigin: true });
    assert.deepEqual(launchOf(h, 1).workspaceStrategy, { type: 'worktree', baseRef: 'trunk', branch: docs.branch, startFromOrigin: true }, 'the alias\'s own baseRef, not main');
    assert.deepEqual(launchOf(h, 2).workspaceStrategy, { type: 'worktree', baseRef: 'develop', branch: discovered.branch, startFromOrigin: true }, 'the discovery policy baseRef');
    assert.match(discovered.branch, /^disc\//);
    assert.deepEqual(h.requests().map((request) => [request.baseRef, request.startFromOrigin, request.requireGit]), [['main', true, false], ['trunk', true, false], ['develop', true, false]]);
    for (const [index, job] of [pilot, docs, discovered].entries()) {
      assert.equal(store(h).require(job.jobId).workspaceKind, 'worktree');
      assert.match(launchOf(h, index).message, /in a fresh worktree on branch /);
    }
  });

  test('a folder that is not a repository root runs in the folder itself, with no branch', async (t) => {
    const h = await probed(t);
    h.fake.projects[0]!.workspaceRoot = '/synthetic/plain';
    const job = await start(h, { project: 'pilot' });
    assert.match(job.branch, /^fleet\//, 'the planned branch, until the folder is known');
    await h.tick();
    assert.deepEqual(launchOf(h, 0).workspaceStrategy, { type: 'root' });
    assert.match(launchOf(h, 0).message, /in the project’s own folder\.$/);
    const done = store(h).require(job.jobId);
    assert.deepEqual([done.workspaceKind, done.branch, done.state], ['root', '', 'running']);
    const view = await h.agent.call<{ workspaceMode: string; branch: string }>('work_status', { jobId: job.jobId });
    assert.deepEqual([view.workspaceMode, view.branch], ['root', '']);
  });

  test('explicit root and worktree choices are honored, with their base ref overrides', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const rootJob = await start(h, { project: 'pilot', workspace: root });
    assert.equal(rootJob.branch, '');
    assert.equal(rootJob.workspaceMode, 'root');
    const local = await start(h, { project: 'docs', workspace: { type: 'worktree', baseRef: 'release', startFromOrigin: false } });
    await h.tick();
    assert.deepEqual(launchOf(h, 0).workspaceStrategy, { type: 'root' });
    assert.deepEqual(launchOf(h, 1).workspaceStrategy, { type: 'worktree', baseRef: 'release', branch: local.branch, startFromOrigin: false });
    assert.deepEqual(h.requests().map((request) => [request.startFromOrigin, request.requireGit]), [[false, false], [false, true]]);
    // The choice is part of the request: the same request id with another workspace is a different request.
    const input = { project: 'pilot', task: 'Synthetic', requestId: 'hash', workspace: root };
    await h.agent.call('work_start', input);
    assert.equal((await h.agent.callError('work_start', { ...input, workspace: { type: 'auto' } })).code, 'request_id_conflict');
    assert.equal((await h.agent.call<{ created: boolean }>('work_start', input)).created, false);
  });

  test('scratch aliases take no workspace and are never probed', async (t) => {
    const h = await probed(t, { host: { discovery: { enabled: true }, defaultProject: 'pilot' }, pilot: { workspaceMode: 'scratch' } });
    assert.equal((await h.agent.callError('work_start', { target: { host: 'main' }, task: 'x', requestId: 'a', workspace: root })).code, 'invalid_argument');
    assert.equal((await h.agent.callError('work_start', { project: 'pilot', task: 'x', requestId: 'b', workspace: root })).code, 'invalid_argument');
    await start(h, { target: { host: 'main' } });
    await h.tick();
    assert.equal(h.fake.launches[0]!.scratch, true);
    assert.equal(h.requests().length, 0);
  });

  test('a host that chooses workspaces says so in fleet_status', async (t) => {
    const h = await probed(t);
    const fleet = await h.agent.call<{ hosts: { choosesWorkspace: boolean }[] }>('fleet_status');
    assert.equal(fleet.hosts[0]!.choosesWorkspace, true);
  });
});

describe('probe failures', () => {
  test('one failed probe fails only its job: a healthy job behind it launches in the same tick with one free slot', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 1 });
    h.fake.projects[0]!.workspaceRoot = '/synthetic/fail';
    const bad = await start(h, { project: 'pilot' });
    const good = await start(h, { project: 'docs' });
    await h.tick();
    const failed = store(h).require(bad.jobId);
    assert.deepEqual([failed.state, failed.lastErrorCode], ['failed', 'workspace_probe_failed']);
    assert.equal(h.fake.launches.length, 1, 'nothing was launched for the failed job');
    assert.equal(launchOf(h, 0).projectId, 'project-2');
    assert.equal(store(h).require(good.jobId).state, 'running');
  });

  test('a probe that exits 255 or times out is retried for that job only, a bounded number of times', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 1 });
    h.fake.projects[0]!.workspaceRoot = '/synthetic/ssh';
    const flaky = await start(h, { project: 'pilot' });
    const good = await start(h, { project: 'docs' });
    await h.tick();
    // The unreachable probe did not hold up the job behind it, and the job waits for its next attempt.
    assert.equal(store(h).require(good.jobId).state, 'running');
    assert.deepEqual([store(h).require(flaky.jobId).state, store(h).require(flaky.jobId).probeAttempts, store(h).require(flaky.jobId).lastErrorCode], ['queued', 1, 'workspace_probe_unavailable']);
    const probes = () => h.requests().filter((request) => request.root === '/synthetic/ssh').length;
    assert.equal(probes(), 1);
    await h.tick();
    assert.equal(probes(), 1, 'not before its retry time');
    h.fake.finishTurn(h.fake.threadForJob(good.jobId).threadId, 'done');
    await h.tickAfter(11 * SECOND);
    assert.equal(probes(), 2);
    await h.tickAfter(30 * SECOND);
    assert.equal(probes(), 3);
    const failed = store(h).require(flaky.jobId);
    assert.deepEqual([failed.state, failed.lastErrorCode], ['failed', 'workspace_probe_unavailable']);
    await h.tickAfter(5 * MINUTE);
    assert.equal(probes(), 3, 'no more attempts');
  });

  test('a transient probe failure recovers and launches', async (t) => {
    const h = await probed(t);
    h.fake.projects[0]!.workspaceRoot = '/synthetic/ssh';
    const job = await start(h, { project: 'pilot' });
    await h.tick();
    assert.equal(store(h).require(job.jobId).state, 'queued');
    writeFileSync(join(h.state, 'ok'), '');
    await h.tickAfter(11 * SECOND);
    const launched = store(h).require(job.jobId);
    assert.deepEqual([launched.state, launched.probeAttempts, launched.workspaceKind], ['running', 0, 'worktree']);
  });

  test('oversized, malformed and unreadable answers fail the job without launching, and leak nothing', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 5 });
    const secret = 'PRIVATE_SYNTHETIC_FOLDER';
    const jobs = [];
    for (const [index, folder] of [`/synthetic/huge/${secret}`, `/synthetic/bad-json/${secret}`, `/synthetic/fail/${secret}`].entries()) {
      h.fake.projects[0]!.workspaceRoot = folder;
      jobs.push(await start(h, { project: 'pilot', task: `PRIVATE_SYNTHETIC_TASK_${index}` }));
      await h.tick();
    }
    h.fake.projects[0]!.workspaceRoot = '';
    jobs.push(await start(h, { project: 'pilot' }));
    await h.tick();
    for (const job of jobs) {
      const done = store(h).require(job.jobId);
      assert.deepEqual([done.state, done.lastErrorCode], ['failed', 'workspace_probe_failed']);
      assert.doesNotMatch(done.lastErrorMessage ?? '', /PRIVATE|synthetic/i);
    }
    assert.equal(h.fake.launches.length, 0);
    assertNotLogged(h.gw, [secret, 'PRIVATE_SYNTHETIC_TASK', probe, h.state]);
  });

  test('a T3 host failure while reading the folder backs the host off and keeps the job queued', async (t) => {
    const h = await probed(t);
    const job = await start(h, { project: 'pilot' });
    const client = h.gw.services.registry.client('main');
    const original = client.listProjects.bind(client);
    let reads = 0;
    client.listProjects = async () => {
      // The catalog read at dispatch is fine; the read for the folder is where the host goes away.
      if (++reads === 2) throw new GatewayError('host_unreachable', 'Synthetic outage.');
      return original();
    };
    await h.tick();
    assert.equal(store(h).require(job.jobId).state, 'queued');
    assert.equal(h.requests().length, 0, 'no probe ran');
    assert.equal(h.gw.gateway.engine.status().hosts[0]?.errorCode, 'host_unreachable');
    client.listProjects = original;
    await h.tickAfter(5 * MINUTE);
    assert.equal(store(h).require(job.jobId).state, 'running');
  });

  test('a host whose probe was removed fails its queued v3 jobs without launching', async (t) => {
    const h = await probed(t);
    const job = await start(h, { project: 'pilot' });
    delete h.gw.services.config.hosts[0]!.workspaceProbeCommand;
    await h.tick();
    assert.deepEqual([store(h).require(job.jobId).state, store(h).require(job.jobId).lastErrorCode], ['failed', 'launch_policy_changed']);
    assert.equal(h.fake.launches.length, 0);
  });

  test('stopping the gateway kills a probe that is still running', async (t) => {
    const h = await probed(t);
    h.fake.projects[0]!.workspaceRoot = '/synthetic/slow';
    const job = await start(h, { project: 'pilot' });
    const ticking = h.tick();
    for (let waited = 0; !existsSync(join(h.state, 'slow.pid')) && waited < 100; waited++) await new Promise((resolve) => setTimeout(resolve, 50));
    const pid = Number(readFileSync(join(h.state, 'slow.pid'), 'utf8'));
    await h.gw.gateway.engine.stop();
    await ticking;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the probe process is gone');
    assert.equal(store(h).require(job.jobId).state, 'queued', 'an interrupted probe costs the job nothing');
    assert.equal(store(h).require(job.jobId).probeAttempts, 0);
  });
});

describe('the probe runner', () => {
  test('a timeout is unavailable and kills the child; oversize and abort are bounded', async (t) => {
    const state = tempDir(t);
    const command = [process.execPath, probe, state];
    await assert.rejects(runWorkspaceProbe(command, { root: '/synthetic/slow', startFromOrigin: false, requireGit: false }, { timeoutMs: 300 }), { code: 'workspace_probe_unavailable' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(Number(readFileSync(join(state, 'slow.pid'), 'utf8')), 0), { code: 'ESRCH' });
    await assert.rejects(runWorkspaceProbe(command, { root: '/synthetic/huge', startFromOrigin: false, requireGit: false }), { code: 'workspace_probe_failed' });
    await assert.rejects(runWorkspaceProbe(['/nonexistent/probe'], { root: '/x', startFromOrigin: false, requireGit: false }), { code: 'workspace_probe_failed' });
    const controller = new AbortController();
    const pending = runWorkspaceProbe(command, { root: '/synthetic/slow', startFromOrigin: false, requireGit: false }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(pending, { code: 'internal_error' });
    assert.deepEqual(await runWorkspaceProbe(command, { root: '/synthetic/ok', startFromOrigin: false, requireGit: false }), { kind: 'git', root: '/synthetic/ok' });
  });

  test('the folder and probe never reach job views, the feed, fleet tools or the logs', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 3 });
    h.fake.projects[0]!.workspaceRoot = '/synthetic/PRIVATE_FOLDER_NAME';
    const job = await start(h, { project: 'pilot', workspace: root });
    await h.tick();
    const seen = JSON.stringify([
      await h.agent.call('work_status', { jobId: job.jobId }),
      await h.agent.call('work_list', {}),
      await h.agent.call('work_feed', { cursor: 0, limit: 100 }),
      await h.agent.call('fleet_status'),
      JSON.stringify(h.fake.launches),
    ]);
    assert.doesNotMatch(seen, /PRIVATE_FOLDER_NAME/);
    assertNotLogged(h.gw, ['PRIVATE_FOLDER_NAME', probe, h.state]);
    assert.doesNotMatch(JSON.stringify(store(h).require(job.jobId)), /PRIVATE_FOLDER_NAME/, 'only a hash of the folder is kept');
  });
});

describe('root reservations', () => {
  async function twoRootJobs(h: Probed) {
    // Two aliases (and T3 projects) that name one folder.
    h.fake.projects[0]!.workspaceRoot = SHARED;
    h.fake.projects[1]!.workspaceRoot = SHARED;
    const first = await start(h, { project: 'pilot', workspace: root });
    const second = await start(h, { project: 'docs', workspace: root });
    return { first, second };
  }

  test('two aliases that point at the same folder never run together; the other waits without taking a slot', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const { first, second } = await twoRootJobs(h);
    const other = await start(h, { project: 'pilot', workspace: { type: 'worktree' } });
    await h.tick();
    assert.equal(store(h).require(first.jobId).state, 'running');
    const waiting = store(h).require(second.jobId);
    assert.deepEqual([waiting.state, waiting.lastErrorCode], ['queued', 'workspace_root_busy']);
    assert.equal(store(h).require(other.jobId).state, 'running', 'a worktree job in the same repository is not serialized');
    assert.equal(store(h).slotHolders('main'), 2);
    // Further ticks do not probe the waiting job again while the folder is held.
    const probes = h.requests().length;
    await h.tick();
    await h.tick();
    assert.equal(h.requests().length, probes);
    // It starts as soon as the first job is at rest.
    h.fake.finishTurn(h.fake.threadForJob(first.jobId).threadId, 'done');
    await h.tick();
    assert.equal(store(h).require(first.jobId).state, 'idle');
    assert.equal(store(h).require(first.jobId).workspaceRootHeldAt, null);
    await h.tick();
    assert.equal(store(h).require(second.jobId).state, 'running');
  });

  test('an unrelated job is not starved by a root job waiting for its folder', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 2 });
    h.fake.projects[0]!.workspaceRoot = SHARED;
    h.fake.projects[1]!.workspaceRoot = SHARED;
    const first = await start(h, { project: 'pilot', workspace: root });
    const waiting = await Promise.all([1, 2, 3, 4, 5, 6].map(() => start(h, { project: 'docs', workspace: root })));
    await h.tick();
    assert.equal(store(h).require(first.jobId).state, 'running');
    assert.ok(waiting.every((job) => store(h).require(job.jobId).state === 'queued'));
    // A later job in another folder launches in the next tick even though six older jobs wait.
    const later = await start(h, { project: 'pilot', workspace: { type: 'worktree' } });
    await h.tick();
    assert.equal(store(h).require(later.jobId).state, 'running');
  });

  test('a follow-up to an idle root job is refused while another job holds the folder, and works once it is free', async (t) => {
    const h = await probed(t);
    const { first, second } = await twoRootJobs(h);
    await h.tick();
    h.fake.finishTurn(h.fake.threadForJob(first.jobId).threadId, 'first done');
    await h.tick();
    await h.tick();
    assert.equal(await jobState(h.agent, first.jobId), 'idle');
    assert.equal(await jobState(h.agent, second.jobId), 'running');
    const sends = h.fake.sends.length;
    const refused = await h.agent.callError('work_continue', { jobId: first.jobId, message: 'More work', requestId: 'again' });
    assert.equal(refused.code, 'workspace_root_busy');
    assert.equal(h.fake.sends.length, sends, 'nothing reached T3');
    assert.equal(await jobState(h.agent, first.jobId), 'idle');
    h.fake.finishTurn(h.fake.threadForJob(second.jobId).threadId, 'second done');
    await h.tick();
    // The same request id may be sent again now.
    const sent = await h.agent.call<{ job: { state: string } }>('work_continue', { jobId: first.jobId, message: 'More work', requestId: 'again' });
    assert.equal(sent.job.state, 'running');
    assert.equal(h.fake.sends.length, sends + 1);
    assert.notEqual(store(h).require(first.jobId).workspaceRootHeldAt, null);
    // And now the other job is the one that cannot resume.
    assert.equal((await h.agent.callError('work_continue', { jobId: second.jobId, message: 'Mine', requestId: 'mine' })).code, 'workspace_root_busy');
  });

  test('concurrent follow-ups to two idle jobs of one folder: exactly one wins', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const { first, second } = await twoRootJobs(h);
    await h.tick();
    h.fake.finishTurn(h.fake.threadForJob(first.jobId).threadId, 'first done');
    await h.tick();
    await h.tick();
    h.fake.finishTurn(h.fake.threadForJob(second.jobId).threadId, 'second done');
    await h.tick();
    assert.deepEqual([await jobState(h.agent, first.jobId), await jobState(h.agent, second.jobId)], ['idle', 'idle']);
    const results = await Promise.all([
      h.agent.client.callTool({ name: 'work_continue', arguments: { jobId: first.jobId, message: 'A', requestId: 'cont-a' } }),
      h.agent.client.callTool({ name: 'work_continue', arguments: { jobId: second.jobId, message: 'B', requestId: 'cont-b' } }),
    ]);
    assert.deepEqual(results.map((result) => result.isError === true).sort(), [false, true]);
    const holders = [first, second].filter((job) => store(h).require(job.jobId).workspaceRootHeldAt !== null);
    assert.equal(holders.length, 1);
  });

  test('answering a question of an idle root job takes the folder back first', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const { first, second } = await twoRootJobs(h);
    await h.tick();
    const thread = h.fake.threadForJob(first.jobId);
    const requestId = h.fake.askQuestion(thread.threadId, [{ id: 'q1', header: 'H', question: 'Which?', options: [{ label: 'A', description: 'a' }] }]);
    h.fake.endTurn(thread.threadId);
    await h.tick();
    // The job went idle with the question still listed (the gateway sees needs_input, which holds); force the idle case through the ledger.
    store(h).transition(first.jobId, { from: ['needs_input'], to: 'idle', detail: { reason: 'test' } });
    assert.equal(store(h).require(first.jobId).workspaceRootHeldAt, null);
    await h.tick();
    assert.equal(store(h).require(second.jobId).state, 'running');
    const refused = await h.agent.callError('work_respond', { jobId: first.jobId, requestId, answers: { q1: 'A' } });
    assert.equal(refused.code, 'workspace_root_busy');
    assert.equal(h.fake.responses.length, 0);
  });

  test('the folder stays held through needs_input, an unknown launch, cancel_requested and delegated work', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 6 });
    h.fake.projects[0]!.workspaceRoot = SHARED;
    h.fake.projects[1]!.workspaceRoot = SHARED;
    const holder = await start(h, { project: 'pilot', workspace: root });
    const waiting = await start(h, { project: 'docs', workspace: root });
    await h.tick();
    const holderThread = h.fake.threadForJob(holder.jobId);
    // needs_input
    h.fake.requestApproval(holderThread.threadId);
    await h.tick();
    assert.equal(await jobState(h.agent, holder.jobId), 'needs_input');
    assert.equal(await jobState(h.agent, waiting.jobId), 'queued');
    h.fake.grantApprovals(holderThread.threadId);
    // delegated work: the coordinator's own turn ends while its helper still runs
    const { childThreadId } = h.fake.delegate(holderThread.threadId, 'Helper task');
    h.fake.finishTurn(holderThread.threadId, 'Delegated');
    await h.tick();
    const status = await h.agent.call<{ state: string; waitingOnDelegatedWork: boolean }>('work_status', { jobId: holder.jobId });
    assert.deepEqual([status.state, status.waitingOnDelegatedWork], ['idle', true]);
    assert.notEqual(store(h).require(holder.jobId).workspaceRootHeldAt, null, 'the idle coordinator keeps its folder while the helper works');
    await h.tick();
    assert.equal(await jobState(h.agent, waiting.jobId), 'queued');
    // The helper finishes, T3 resumes the coordinator by itself, and it finishes: only then is the folder free.
    h.fake.finishDelegated(childThreadId, 'Helper done');
    await h.tickAfter(MINUTE + SECOND); // an idle job is looked at once a minute
    assert.equal(await jobState(h.agent, holder.jobId), 'running');
    assert.equal(await jobState(h.agent, waiting.jobId), 'queued');
    h.fake.finishTurn(holderThread.threadId, 'All done');
    await h.tick();
    assert.equal(store(h).require(holder.jobId).state, 'idle');
    assert.equal(store(h).require(holder.jobId).workspaceRootHeldAt, null);
    await h.tick();
    assert.equal(await jobState(h.agent, waiting.jobId), 'running');
  });

  test('an unknown launch holds the folder until it is confirmed or fails; cancel releases it', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 6, watcher: { reconcileWindowMinutes: 10 } });
    h.fake.projects[0]!.workspaceRoot = SHARED;
    h.fake.projects[1]!.workspaceRoot = SHARED;
    h.fake.statusOnce.set('t3_thread_launch', 502);
    const lost = await start(h, { project: 'pilot', workspace: root });
    const behind = await start(h, { project: 'docs', workspace: root });
    await h.tick();
    // The launch never reached T3, but the gateway cannot tell yet: the job is unknown and holds the folder.
    assert.equal(store(h).require(lost.jobId).state, 'unknown');
    assert.notEqual(store(h).require(lost.jobId).workspaceRootHeldAt, null);
    await h.tickAfter(MINUTE);
    assert.equal(store(h).require(behind.jobId).state, 'queued');
    // The window runs out: the job fails and the folder is free.
    await h.tickAfter(10 * MINUTE);
    assert.equal(store(h).require(lost.jobId).state, 'failed');
    assert.equal(store(h).require(lost.jobId).workspaceRootHeldAt, null);
    await h.tick();
    assert.equal(await jobState(h.agent, behind.jobId), 'running');
    assert.notEqual(store(h).require(behind.jobId).workspaceRootHeldAt, null);
    await h.agent.call('work_cancel', { jobId: behind.jobId });
    // cancel_requested still holds the folder: the interrupt may not have landed. T3 confirming the stop releases it.
    assert.notEqual(store(h).require(behind.jobId).workspaceRootHeldAt, null);
    await h.tick();
    assert.equal(store(h).require(behind.jobId).state, 'cancelled');
    assert.equal(store(h).require(behind.jobId).workspaceRootHeldAt, null);
    assert.equal(h.fake.launches.length, 1);
  });

  test('reservations survive a restart, and a restarted gateway does not run a second job in the folder', async (t) => {
    const dataDir = join(tempDir(t), 'data');
    const first = await probed(t, { dataDir, maxConcurrentJobs: 4 });
    first.fake.projects[0]!.workspaceRoot = SHARED;
    first.fake.projects[1]!.workspaceRoot = SHARED;
    const holder = await start(first, { project: 'pilot', workspace: root });
    await first.tick();
    assert.equal(await jobState(first.agent, holder.jobId), 'running');
    await first.gw.gateway.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await startJobHarness(t, { dataDir, door: first.gw.door, fake: first.fake, maxConcurrentJobs: 4, host: { workspaceProbeCommand: [process.execPath, probe, first.state] } });
    const waiting = await start(second, { project: 'docs', workspace: root });
    await second.tick();
    assert.equal(first.fake.launches.length, 1);
    assert.equal(store(second).require(waiting.jobId).state, 'queued');
    // The first job finishes while the restarted gateway watches it; the waiting job then launches.
    first.fake.finishTurn(first.fake.threadForJob(holder.jobId).threadId, 'done');
    await second.tick();
    await second.tick();
    assert.equal(store(second).require(waiting.jobId).state, 'running');
    assert.equal(first.fake.launches.length, 2);
  });

  test('a resume whose outcome is unknown keeps the folder until the grace period ends', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const { first, second } = await twoRootJobs(h);
    await h.tick();
    // The first job finishes, and a follow-up to it is sent before the waiting job launches; its outcome stays unknown.
    h.fake.finishTurn(h.fake.threadForJob(first.jobId).threadId, 'done');
    assert.ok(store(h).transition(first.jobId, { from: ['running'], to: 'idle', detail: { reason: 'completed' } }));
    assert.equal(store(h).reserveRoot(first.jobId).kind, 'held');
    assert.notEqual(store(h).require(first.jobId).workspaceRootHeldAt, null);
    await h.tick();
    assert.equal(await jobState(h.agent, second.jobId), 'queued', 'the held folder keeps the other job waiting');
    await h.tickAfter(11 * MINUTE);
    assert.equal(store(h).require(first.jobId).workspaceRootHeldAt, null, 'given up after the grace period');
    await h.tick();
    assert.equal(await jobState(h.agent, second.jobId), 'running');
  });

  test('a definite send failure gives the reservation back', async (t) => {
    const h = await probed(t);
    h.fake.projects[0]!.workspaceRoot = SHARED;
    const job = await start(h, { project: 'pilot', workspace: root });
    await h.tick();
    h.fake.finishTurn(h.fake.threadForJob(job.jobId).threadId, 'done');
    await h.tick();
    h.fake.failures.set('t3_thread_send', { code: 'invalid_request', message: 'Synthetic refusal.' });
    await h.agent.callError('work_continue', { jobId: job.jobId, message: 'x', requestId: 'fails' });
    assert.equal(store(h).require(job.jobId).workspaceRootHeldAt, null);
    assert.equal(await jobState(h.agent, job.jobId), 'idle');
  });

  test('work started in T3 itself in a folder another job holds is recorded, not prevented', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const { first, second } = await twoRootJobs(h);
    await h.tick();
    h.fake.finishTurn(h.fake.threadForJob(first.jobId).threadId, 'done');
    await h.tick();
    await h.tick();
    assert.equal(await jobState(h.agent, second.jobId), 'running');
    // Someone types into the idle first job's thread in T3: the gateway cannot stop that, and says so.
    h.fake.userTurn(h.fake.threadForJob(first.jobId).threadId, 'Typed in T3');
    await h.tickAfter(2 * MINUTE);
    assert.equal(await jobState(h.agent, first.jobId), 'running');
    assert.equal(store(h).require(first.jobId).workspaceRootHeldAt, null);
    const feed = await h.agent.call<{ events: { type: string; jobId: string; reason: string | null }[] }>('work_feed', { cursor: 0, limit: 100 });
    assert.ok(feed.events.some((event) => event.type === 'workspace_root_contended' && event.jobId === first.jobId && event.reason === 'workspace_root_busy'));
  });
});

describe('resume ownership of a held folder', () => {
  /** An idle root job A that has the folder to itself and has nothing in flight, as the tests start from. */
  async function idleRoot(h: Probed) {
    h.fake.projects[0]!.workspaceRoot = SHARED;
    h.fake.projects[1]!.workspaceRoot = SHARED;
    const a = await start(h, { project: 'pilot', workspace: root });
    await h.tick();
    h.fake.finishTurn(h.fake.threadForJob(a.jobId).threadId, 'done');
    await h.tick();
    assert.equal(store(h).require(a.jobId).state, 'idle');
    assert.equal(store(h).require(a.jobId).workspaceRootHeldAt, null);
    return a;
  }
  const waitingJob = (h: Probed) => start(h, { project: 'docs', workspace: root });
  const holder = (h: Probed, jobId: string) => store(h).require(jobId).workspaceRootHeldAt;
  const call = (h: Probed, name: string, args: Record<string, unknown>) => h.agent.client.callTool({ name, arguments: args });
  const sendsAre = async (h: Probed, count: number) => {
    for (let waited = 0; h.fake.sends.length < count && waited < 200; waited++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.fake.sends.length, count);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  test('a retry after an unknown send refreshes the grace period: the sweep cannot free the folder under it', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const a = await idleRoot(h);
    h.fake.statusOnce.set('t3_thread_send', 502);
    const first = await call(h, 'work_continue', { jobId: a.jobId, message: 'More', requestId: 'resend' });
    assert.equal(first.isError, true, 'the outcome of the first send is unknown');
    assert.notEqual(holder(h, a.jobId), null);
    const q = await waitingJob(h);
    await h.tick();
    assert.equal(store(h).require(q.jobId).state, 'queued');
    await h.tickAfter(9 * MINUTE + 59 * SECOND);
    assert.equal(store(h).require(q.jobId).state, 'queued', 'inside the grace period');
    h.fake.holdResponses.add('t3_thread_send');
    const retry = call(h, 'work_continue', { jobId: a.jobId, message: 'More', requestId: 'resend' });
    await h.fake.whenHeld('t3_thread_send');
    // The original attempt is now more than ten minutes old; the retry is in flight and has restarted the period.
    await h.tickAfter(20 * SECOND);
    assert.notEqual(holder(h, a.jobId), null, 'the retry in flight still holds the folder');
    assert.equal(store(h).require(q.jobId).state, 'queued', 'the other job did not launch under the retry');
    h.fake.holdResponses.delete('t3_thread_send');
    h.fake.releaseHeld();
    assert.equal((await retry).isError, undefined);
    assert.equal(await jobState(h.agent, a.jobId), 'running');
    assert.equal(h.fake.launches.length, 1, 'still only the first job');
    // Normal recovery: when the resumed turn is over the waiting job starts.
    h.fake.finishTurn(h.fake.threadForJob(a.jobId).threadId, 'done again');
    await h.tick();
    await h.tick();
    assert.equal(store(h).require(q.jobId).state, 'running');
  });

  for (const order of ['taken first', 'second first'] as const) {
    test(`two concurrent follow-ups to one idle job: a definite failure of one never frees the folder under the other (${order} fails)`, async (t) => {
      const h = await probed(t, { maxConcurrentJobs: 4 });
      const a = await idleRoot(h);
      const q = await waitingJob(h);
      h.fake.holdResponses.add('t3_thread_send');
      // The call that fails definitely (T3 answers with an error once the message has been handled) is the first or the second to arrive.
      const fails = order === 'taken first' ? 0 : 1;
      const calls: Promise<{ isError?: boolean | undefined }>[] = [];
      for (const index of [0, 1]) {
        if (index === fails) h.fake.failuresAfterEffect.set('t3_thread_send', { code: 'invalid_request', message: 'Synthetic refusal.' });
        calls.push(call(h, 'work_continue', { jobId: a.jobId, message: `Follow-up ${index}`, requestId: `double-${index}` }));
        await sendsAre(h, index + 1);
        h.fake.failuresAfterEffect.delete('t3_thread_send');
      }
      h.fake.holdResponses.delete('t3_thread_send');
      // The failing call finishes first while the other is still in flight.
      h.fake.releaseHeld(fails === 0 ? 'first' : 'last');
      assert.equal((await calls[fails]!).isError, true);
      await settle();
      assert.notEqual(holder(h, a.jobId), null, 'the other call is still in flight');
      await h.tick();
      assert.equal(store(h).require(q.jobId).state, 'queued');
      h.fake.releaseHeld();
      assert.equal((await calls[1 - fails]!).isError, undefined);
      assert.equal(await jobState(h.agent, a.jobId), 'running');
      assert.equal(store(h).require(q.jobId).state, 'queued', 'the resumed job keeps the folder');
    });
  }

  test('when both concurrent follow-ups fail definitely the folder is free again, and only then', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const a = await idleRoot(h);
    const q = await waitingJob(h);
    h.fake.holdResponses.add('t3_thread_send');
    h.fake.failuresAfterEffect.set('t3_thread_send', { code: 'invalid_request', message: 'Synthetic refusal.' });
    const calls = [0, 1].map((index) => call(h, 'work_continue', { jobId: a.jobId, message: `Follow-up ${index}`, requestId: `both-${index}` }));
    await sendsAre(h, 2);
    h.fake.holdResponses.delete('t3_thread_send');
    h.fake.releaseHeld('first');
    await settle();
    assert.notEqual(holder(h, a.jobId), null, 'one attempt is still in flight');
    h.fake.releaseHeld();
    assert.deepEqual((await Promise.all(calls)).map((result) => result.isError), [true, true]);
    assert.equal(holder(h, a.jobId), null);
    assert.equal(await jobState(h.agent, a.jobId), 'idle');
    await h.tick();
    assert.equal(store(h).require(q.jobId).state, 'running');
  });

  test('a definite refusal of a retry never frees the hold an earlier unknown attempt left', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const a = await idleRoot(h);
    h.fake.statusOnce.set('t3_thread_send', 502);
    assert.equal((await call(h, 'work_continue', { jobId: a.jobId, message: 'More', requestId: 'retry-refused' })).isError, true);
    const q = await waitingJob(h);
    h.fake.failures.set('t3_thread_send', { code: 'invalid_request', message: 'Synthetic refusal.' });
    assert.equal((await call(h, 'work_continue', { jobId: a.jobId, message: 'More', requestId: 'retry-refused' })).isError, true);
    h.fake.failures.delete('t3_thread_send');
    assert.notEqual(holder(h, a.jobId), null, 'the first attempt may have been delivered');
    await h.tick();
    assert.equal(store(h).require(q.jobId).state, 'queued');
    // The uncertainty survives a restart of the engine's memory (it is in the ledger) and ends only with the grace period.
    await h.tickAfter(11 * MINUTE);
    await h.tick();
    assert.equal(holder(h, a.jobId), null);
    assert.equal(store(h).require(q.jobId).state, 'running');
  });

  test('an answer follows the same rule: a refused retry does not free the hold of an unknown answer', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    h.fake.projects[0]!.workspaceRoot = SHARED;
    h.fake.projects[1]!.workspaceRoot = SHARED;
    const a = await start(h, { project: 'pilot', workspace: root });
    await h.tick();
    const thread = h.fake.threadForJob(a.jobId);
    const requestId = h.fake.askQuestion(thread.threadId, [{ id: 'q1', header: 'H', question: 'Which?', options: [{ label: 'A', description: 'a' }] }]);
    h.fake.endTurn(thread.threadId);
    await h.tick();
    // The job is at rest with the question still listed (forced through the ledger: the watcher would call it needs_input).
    store(h).transition(a.jobId, { from: ['needs_input'], to: 'idle', detail: { reason: 'test' } });
    assert.equal(holder(h, a.jobId), null);
    h.fake.statusOnce.set('t3_pending_request_respond', 502);
    assert.equal((await call(h, 'work_respond', { jobId: a.jobId, requestId, answers: { q1: 'A' } })).isError, true);
    assert.notEqual(holder(h, a.jobId), null);
    const q = await waitingJob(h);
    h.fake.failures.set('t3_pending_request_respond', { code: 'invalid_request', message: 'Synthetic refusal.' });
    assert.equal((await call(h, 'work_respond', { jobId: a.jobId, requestId, answers: { q1: 'A' } })).isError, true);
    h.fake.failures.delete('t3_pending_request_respond');
    assert.notEqual(holder(h, a.jobId), null, 'the first answer may have been delivered');
    await h.tick();
    assert.equal(store(h).require(q.jobId).state, 'queued');
    // The question is still listed, so the watcher puts the job back to needs_input: the state holds the folder from here on.
    await h.tickAfter(11 * MINUTE);
    assert.equal(await jobState(h.agent, a.jobId), 'needs_input');
    assert.notEqual(holder(h, a.jobId), null);
    assert.equal(store(h).require(a.jobId).workspaceResumeTokens.length, 1, 'an unrelated state change cannot settle an unknown answer');
    assert.equal(store(h).require(q.jobId).state, 'queued');
  });

  test('a successful sibling cannot settle another follow-up still awaiting its response', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const a = await idleRoot(h);
    const q = await waitingJob(h);
    h.fake.holdResponses.add('t3_thread_send');
    const first = call(h, 'work_continue', { jobId: a.jobId, message: 'First', requestId: 'success-first' });
    await sendsAre(h, 1);
    const second = call(h, 'work_continue', { jobId: a.jobId, message: 'Second', requestId: 'success-second' });
    await sendsAre(h, 2);
    assert.equal(store(h).require(a.jobId).workspaceResumeTokens.length, 2);
    h.fake.releaseHeld('first');
    assert.notEqual((await first).isError, true);
    assert.equal(store(h).require(a.jobId).workspaceResumeTokens.length, 1, 'only the successful call settled');
    h.fake.finishTurn(h.fake.threadForJob(a.jobId).threadId, 'Done between polls');
    await h.tickAfter(2 * MINUTE);
    assert.notEqual(holder(h, a.jobId), null, 'the sibling still awaiting owns the idle reservation');
    assert.equal(store(h).require(q.jobId).state, 'queued');
    h.fake.holdResponses.delete('t3_thread_send');
    h.fake.releaseHeld();
    assert.notEqual((await second).isError, true);
    assert.deepEqual(store(h).require(a.jobId).workspaceResumeTokens, []);
    await h.tickAfter(2 * MINUTE);
    assert.equal(store(h).require(q.jobId).state, 'running');
  });

  test('an unknown sibling survives the other call succeeding and the run finishing, until the bounded sweep', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const a = await idleRoot(h);
    const q = await waitingJob(h);
    h.fake.statusOnce.set('t3_thread_send', 502);
    assert.equal((await call(h, 'work_continue', { jobId: a.jobId, message: 'Unknown', requestId: 'sibling-unknown' })).isError, true);
    assert.equal(store(h).require(a.jobId).workspaceResumeTokens.length, 1);
    assert.equal((await call(h, 'work_continue', { jobId: a.jobId, message: 'Known', requestId: 'sibling-known' })).isError, undefined);
    assert.equal(store(h).require(a.jobId).workspaceResumeTokens.length, 1, 'only the known success settled');
    h.fake.finishTurn(h.fake.threadForJob(a.jobId).threadId, 'Done');
    await h.tickAfter(2 * MINUTE);
    assert.equal(await jobState(h.agent, a.jobId), 'idle');
    assert.notEqual(holder(h, a.jobId), null, 'the unknown attempt still owns the idle reservation');
    assert.equal(store(h).require(q.jobId).state, 'queued');
    await h.tickAfter(11 * MINUTE);
    assert.equal(holder(h, a.jobId), null, 'given up by the bounded sweep');
    await h.tick();
    assert.equal(store(h).require(q.jobId).state, 'running');
  });

  test('a successful answer from stale idle state holds by running state before settling its token', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const a = await idleRoot(h);
    const q = await waitingJob(h);
    const thread = h.fake.threadForJob(a.jobId);
    const requestId = h.fake.askQuestion(thread.threadId, [{ id: 'q1', header: 'H', question: 'Which?', options: [{ label: 'A', description: 'a' }] }]);
    await h.agent.call('work_respond', { jobId: a.jobId, requestId, answers: { q1: 'A' } });
    assert.equal(store(h).require(a.jobId).state, 'running');
    assert.deepEqual(store(h).require(a.jobId).workspaceResumeTokens, []);
    assert.notEqual(holder(h, a.jobId), null);
    await h.tick();
    assert.equal(store(h).require(q.jobId).state, 'queued');
    h.fake.finishTurn(thread.threadId, 'Done');
    await h.tick();
    assert.equal(store(h).require(q.jobId).state, 'running');
  });

  test('terminal state does not discard a pending attempt, and its definite settlement releases the folder', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const a = await idleRoot(h);
    const q = await waitingJob(h);
    const attempt = store(h).reserveRoot(a.jobId);
    assert.equal(attempt.kind, 'held');
    if (attempt.kind !== 'held') throw Error('No reservation');
    store(h).transition(a.jobId, { from: ['idle'], to: 'cancelled' });
    await h.tick();
    assert.equal(store(h).require(q.jobId).state, 'queued', 'a terminal state does not settle the call');
    store(h).abandonResume(a.jobId, attempt.token);
    await h.tick();
    assert.equal(store(h).require(q.jobId).state, 'running');
  });

  test('the ownership token of an attempt in flight never leaves the ledger and is gone once its call settles', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4 });
    const a = await idleRoot(h);
    h.fake.holdResponses.add('t3_thread_send');
    const pending = call(h, 'work_continue', { jobId: a.jobId, message: 'More', requestId: 'token' });
    await h.fake.whenHeld('t3_thread_send');
    const [token] = store(h).require(a.jobId).workspaceResumeTokens;
    assert.ok(token, 'an attempt in flight has an owner');
    const seen = JSON.stringify([await h.agent.call('work_status', { jobId: a.jobId }), await h.agent.call('work_list', {}), await h.agent.call('work_feed', { cursor: 0, limit: 100 })]);
    assert.equal(seen.includes(token), false);
    h.fake.holdResponses.delete('t3_thread_send');
    h.fake.releaseHeld();
    await pending;
    assertNotLogged(h.gw, [token]);
    assert.deepEqual(store(h).require(a.jobId).workspaceResumeTokens, [], 'the running job holds by state, not by attempt');
  });
});

describe('older records and malformed specs', () => {
  test('queued version 1 and version 2 specs keep their meaning on an opted-in host, with no probe', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 4, host: { discovery: { enabled: true }, defaultProject: 'pilot' }, pilot: { workspaceMode: 'scratch' } });
    const base = { clientId: h.agent.clientId, projectAlias: 'docs', hostId: 'main', task: 'Synthetic', branch: 'agents/legacy', runtimeMode: 'approval-required' };
    store(h).create({
      ...base, id: 'legacy0001', requestId: 'r1', inputHash: 'h1', title: 'Legacy v1 [job:legacy0001]', t3ProjectId: 'project-2',
      launchSpec: { v: 1, projectId: 'project-2', projectName: 'Synthetic project 2', source: 'alias', alias: 'docs', baseRef: 'trunk', runtimeMode: 'approval-required', model: { source: 'project', selection: { model: 'synthetic-large' } } },
    });
    store(h).create({ ...base, id: 'legacy0002', requestId: 'r2', inputHash: 'h2', title: 'Legacy plain [job:legacy0002]' });
    await h.tick();
    assert.equal(h.requests().length, 0, 'no probe for records written before the host chose workspaces');
    assert.deepEqual(launchOf(h, 0).workspaceStrategy, { type: 'worktree', baseRef: 'trunk', branch: 'agents/legacy', startFromOrigin: false });
    assert.deepEqual(launchOf(h, 1).workspaceStrategy, { type: 'worktree', baseRef: 'trunk', branch: 'agents/legacy', startFromOrigin: false });
    // A scratch alias on an opted-in host still launches scratch.
    await start(h, { target: { host: 'main' } });
    await h.tick();
    assert.equal(h.fake.launches[2]!.scratch, true);
  });

  test('a malformed version 3 spec fails only its job: the queue, watch, list and tools carry on', async (t) => {
    const h = await probed(t, { maxConcurrentJobs: 1 });
    const bad = await start(h, { project: 'pilot' });
    const good = await start(h, { project: 'docs' });
    h.gw.services.db.prepare('UPDATE jobs SET launch_spec = ? WHERE id = ?').run('{"v":3,"workspace":{"type":"bogus"},"projectId":null}', bad.jobId);
    const listed = await h.agent.call<{ jobs: { jobId: string; workspaceMode: string | null }[] }>('work_list', {});
    assert.equal(listed.jobs.find((job) => job.jobId === bad.jobId)?.workspaceMode, null);
    await h.tick();
    const failed = store(h).require(bad.jobId);
    assert.deepEqual([failed.state, failed.lastErrorCode], ['failed', 'database_error']);
    assert.equal(store(h).require(good.jobId).state, 'running', 'the healthy job behind it launched in the same tick');
    assert.equal(h.requests().length, 1);
    await h.agent.call('work_status', { jobId: bad.jobId });
  });
});

describe('the reference probe script', () => {
  test('inspects real folders and fails closed', async (t) => {
    const { execFileSync } = await import('node:child_process');
    const { mkdirSync, symlinkSync } = await import('node:fs');
    const script = fileURLToPath(new URL('../scripts/workspace-probe.js', import.meta.url));
    const dir = tempDir(t, 't3fg-probe-');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const run = (input: Record<string, unknown>) => JSON.parse(execFileSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
    const seed = join(dir, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-b', 'main');
    git(seed, 'config', 'user.name', 'Synthetic');
    git(seed, 'config', 'user.email', 'synthetic@example.invalid');
    writeFileSync(join(seed, 'file'), 'A');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'A');
    const origin = join(dir, 'origin.git');
    git(dir, 'clone', '--bare', seed, origin);
    const local = join(dir, 'local');
    git(dir, 'clone', origin, local);
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const nested = join(local, 'nested');
    mkdirSync(nested);
    const real = (path: string) => execFileSync('realpath', [path], { encoding: 'utf8' }).trim();
    assert.deepEqual(run({ root: local, baseRef: 'main', startFromOrigin: true, requireGit: true }), { kind: 'git', root: real(local) });
    assert.deepEqual(run({ root: plain, startFromOrigin: false, requireGit: false }), { kind: 'root', root: real(plain) });
    assert.equal(run({ root: nested, startFromOrigin: false, requireGit: false }).kind, 'root', 'a subdirectory of a repository is an ordinary folder');
    const link = join(dir, 'link');
    symlinkSync(local, link);
    assert.equal(run({ root: link, startFromOrigin: false, requireGit: false }).root, real(local), 'canonical, so aliases of one folder share a reservation');
    assert.throws(() => run({ root: nested, startFromOrigin: false, requireGit: true }), 'a worktree needs a repository root');
    assert.throws(() => run({ root: local, baseRef: 'absent', startFromOrigin: true, requireGit: true }), 'the remote branch must exist');
    assert.throws(() => run({ root: join(dir, 'missing'), startFromOrigin: false, requireGit: false }));
    assert.throws(() => run({ root: 'relative', startFromOrigin: false, requireGit: false }));
    mkdirSync(join(plain, '.git'));
    assert.throws(() => run({ root: plain, startFromOrigin: false, requireGit: false }), 'a corrupt repository is not an ordinary folder');
  });
});
