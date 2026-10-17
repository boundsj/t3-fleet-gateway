import * as z from 'zod';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayError } from '../src/errors.ts';
import { startJobHarness, startJob } from './helpers/jobs.ts';
const helper = fileURLToPath(new URL('../scripts/workspace-probe.js', import.meta.url));
const command = [process.execPath, helper];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const probe = (root: string, extra = {}) => JSON.parse(execFileSync(process.execPath, [helper], { input: JSON.stringify({ root, baseRef: 'main', startFromOrigin: true, ...extra }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));

test('destination helper and public launch preserve Git remote base, explicit root and non-Git semantics', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-workspace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seed = join(dir, 'seed'); mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', 'Synthetic'); git(seed, 'config', 'user.email', 'synthetic@example.invalid');
  writeFileSync(join(seed, 'file'), 'A'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'A');
  const a = git(seed, 'rev-parse', 'HEAD');
  const origin = join(dir, 'origin.git'); git(dir, 'clone', '--bare', seed, origin);
  const local = join(dir, 'local'); git(dir, 'clone', origin, local);
  writeFileSync(join(seed, 'file'), 'B'); git(seed, 'commit', '-am', 'B'); git(seed, 'push', origin, 'main');
  const b = git(seed, 'rev-parse', 'HEAD');
  assert.notEqual(a, b);
  git(local, 'checkout', '-b', 'local-branch'); writeFileSync(join(local, 'dirty'), 'preserved');
  const plain = join(dir, 'plain'); mkdirSync(plain);
  assert.equal(probe(local).kind, 'git'); assert.equal(probe(plain).kind, 'root');
  const nested = join(local, 'nested'); mkdirSync(nested);
  assert.equal(probe(nested).kind, 'root');
  assert.throws(() => probe(nested, { requireGit: true }));
  for (const marker of ['directory', 'broken-link']) {
    const corrupt = join(local, marker); mkdirSync(corrupt);
    if (marker === 'directory') mkdirSync(join(corrupt, '.git'));
    else symlinkSync(join(dir, 'absent-metadata'), join(corrupt, '.git'));
    assert.throws(() => probe(corrupt));
    assert.throws(() => probe(corrupt, { startFromOrigin: false }));
  }
  const redirected = JSON.parse(execFileSync(process.execPath, [helper], {
    input: JSON.stringify({ root: plain, baseRef: 'main', startFromOrigin: true }), encoding: 'utf8',
    env: { ...process.env, GIT_DIR: join(local, '.git'), GIT_WORK_TREE: local }, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  assert.equal(redirected.kind, 'root');
  const h = await startJobHarness(t, { maxConcurrentJobs: 5, host: { workspaceProbeCommand: command } });
  h.fake.projects[0]!.workspaceRoot = local;
  const auto = await startJob(h.agent);
  await h.tick();
  const launch = z.object({ workspaceStrategy: z.object({ type: z.literal('worktree'), branch: z.string(), baseRef: z.string(), startFromOrigin: z.boolean() }) }).parse(h.fake.launches[0]);
  assert.equal(launch.workspaceStrategy.startFromOrigin, true); assert.equal(launch.workspaceStrategy.baseRef, 'main');
  git(local, 'fetch', 'origin', 'main');
  const wt = join(dir, 'wt'); git(local, 'worktree', 'add', '-b', launch.workspaceStrategy.branch!, wt, 'origin/main');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), b); assert.equal(git(local, 'rev-parse', 'HEAD'), a);
  const explicit = await startJob(h.agent, 'local checkout', { workspace: { type: 'root' } }); await h.tick();
  assert.deepEqual(h.fake.launches[1]!.workspaceStrategy, { type: 'root' }); assert.equal(explicit.branch, '');
  assert.equal(git(local, 'branch', '--show-current'), 'local-branch'); assert.equal(readFileSync(join(local, 'dirty'), 'utf8'), 'preserved');
  h.fake.projects[0]!.workspaceRoot = plain;
  const nonGit = await startJob(h.agent, 'plain directory');
  await h.tick(); await h.tick();
  assert.equal(nonGit.branch, ''); assert.deepEqual(h.fake.launches.at(-1)!.workspaceStrategy, { type: 'root' });
  assert.ok(auto.branch.startsWith('fleet/'));
  const invalid = await h.agent.callError('work_start', { project: 'pilot', task: 'synthetic', requestId: 'plain-wt', workspace: { type: 'worktree' } });
  assert.equal(invalid.code, 'invalid_argument');
  const root = await startJob(h.agent, 'explicit plain', { workspace: { type: 'root' } });
  assert.equal(root.branch, '');
});

test('workspace probe fails closed for unavailable origins, invalid directories, failed Git and malformed output', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-workspace-fail-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-b', 'main');
  assert.throws(() => probe(dir));
  const bare = join(dir, 'empty-origin'); git(dir, 'init', '--bare', bare); git(dir, 'remote', 'add', 'origin', bare);
  assert.throws(() => probe(dir), 'missing remote main');
  const inaccessible = join(dir, 'inaccessible'); mkdirSync(inaccessible); chmodSync(inaccessible, 0);
  try { assert.throws(() => probe(inaccessible)); } finally { chmodSync(inaccessible, 0o700); }
  const broken = join(dir, 'broken'); mkdirSync(broken); symlinkSync(join(dir, 'absent-metadata'), join(broken, '.git'));
  assert.throws(() => probe(broken));
  assert.throws(() => execFileSync(process.execPath, [helper], { input: JSON.stringify({ root: dir, baseRef: 'main', startFromOrigin: false }), env: { ...process.env, PATH: '/nonexistent' }, stdio: ['pipe', 'pipe', 'pipe'] }));
  assert.throws(() => probe(join(dir, 'missing')));
  mkdirSync(join(dir, 'corrupt')); mkdirSync(join(dir, 'corrupt', '.git'));
  assert.throws(() => probe(join(dir, 'corrupt')));
  const h = await startJobHarness(t, { host: { workspaceProbeCommand: [process.execPath, '-e', 'process.stdout.write("{}");'] } });
  const error = await h.agent.callError('work_start', { project: 'pilot', task: 'synthetic', requestId: 'malformed' });
  assert.equal(error.code, 'invalid_argument'); assert.equal(h.fake.launches.length, 0);
});

test('new resolution persists, replays without downstream and conflicts on explicit workspace; queued roots revalidate', async (t) => {
  const h = await startJobHarness(t);
  const input = { project: 'pilot', task: 'synthetic', requestId: 'workspace-replay', workspace: { type: 'root' } };
  const first = await h.agent.call<{ job: { jobId: string } }>('work_start', input);
  const spec = h.gw.services.jobs.store.get(first.job.jobId)!.launchSpec;
  assert.equal(spec?.v, 3);
  await h.fake.stop();
  assert.equal((await h.agent.call<{ created: boolean }>('work_start', input)).created, false);
  assert.equal((await h.agent.callError('work_start', { ...input, workspace: { type: 'auto' } })).code, 'request_id_conflict');
  await h.fake.start();
  h.fake.projects[0]!.workspaceRoot = '/synthetic/changed'; await h.tick();
  const saved = h.gw.services.jobs.store.get(first.job.jobId)!;
  assert.equal(saved.state, 'failed'); assert.equal(saved.lastErrorCode, 'launch_policy_changed'); assert.equal(h.fake.launches.length, 0);
});

test('legacy null and v1 jobs retain local-base dispatch and original replay hashes', async (t) => {
  const { startInputHash } = await import('../src/jobs/service.ts');
  const h = await startJobHarness(t);
  for (const v of [0, 1]) {
    const input = { project: 'pilot', task: `legacy ${v}`, requestId: `legacy-${v}` };
    const id = v === 0 ? 'legacy0000' : 'legacy0001';
    h.gw.services.jobs.store.create({ id, clientId: h.agent.clientId, requestId: input.requestId, inputHash: startInputHash(input),
      projectAlias: 'pilot', hostId: 'main', task: input.task, title: `Legacy [job:${id}]`, branch: `fleet/${id}`, runtimeMode: 'auto',
      ...(v === 1 ? { t3ProjectId: 'project-1', launchSpec: { v: 1, projectId: 'project-1', projectName: 'Synthetic', source: 'alias', alias: 'pilot',
        baseRef: 'main', runtimeMode: 'auto', model: { source: 't3_default', selection: null } } } : {}),
    });
    h.fake.calls.length = 0;
    assert.equal((await h.agent.call<{ created: boolean }>('work_start', input)).created, false);
    assert.deepEqual(h.fake.calls, []);
  }
  await h.tick();
  assert.equal(h.fake.launches.length, 2);
  for (const launch of h.fake.launches) assert.equal(z.object({ workspaceStrategy: z.object({ startFromOrigin: z.literal(false) }) }).parse(launch).workspaceStrategy.startFromOrigin, false);
});

test('missing command and changed Git classification fail without launching', async (t) => {
  const absent = await startJobHarness(t, { host: { workspaceProbeCommand: undefined } });
  assert.match((await absent.agent.callError('work_start', { project: 'pilot', task: 'synthetic', requestId: 'no-probe' })).text, /workspaceProbeCommand/);
  const dir = mkdtempSync(join(tmpdir(), 'fleet-workspace-change-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = await startJobHarness(t, { host: { workspaceProbeCommand: command } });
  h.fake.projects[0]!.workspaceRoot = dir;
  const job = await startJob(h.agent, 'classification change');
  git(dir, 'init', '-b', 'main');
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(job.jobId).lastErrorCode, 'launch_policy_changed');
  assert.equal(h.fake.launches.length, 0);
});


test('probe transport failure on the second project read preserves queued state and host backoff', async (t) => {
  const h = await startJobHarness(t);
  const job = await startJob(h.agent);
  const client = h.gw.services.registry.client('main');
  const original = client.listProjects.bind(client);
  let reads = 0;
  client.listProjects = async () => {
    if (++reads === 2) throw new GatewayError('host_unreachable', 'Synthetic host outage.');
    return original();
  };
  await h.tick();
  assert.equal(reads, 2);
  assert.equal(h.gw.services.jobs.store.require(job.jobId).state, 'queued');
  assert.equal(h.fake.launches.length, 0);
  await h.tick();
  assert.equal(reads, 2);
  client.listProjects = original;
  await h.tickAfter(60000);
  assert.equal(h.fake.launches.length, 1);
});

test('workspace probe redacts invalid output and isolates SSH exit 255 to a retryable job probe failure', async (t) => {
  for (const output of ["'secret-private-path-not-json'", "'x'.repeat(16385)"]) {
    const h = await startJobHarness(t, { host: { workspaceProbeCommand: [process.execPath, '-e', `process.stderr.write('secret-stderr'); process.stdout.write(${output});`] } });
    const result = await h.agent.callError('work_start', { project: 'pilot', task: 'synthetic', requestId: 'redaction' });
    assert.equal(result.code, 'invalid_argument');
    assert.equal(result.text.includes('secret'), false);
    assert.equal(h.gw.logs.join('\n').includes('secret'), false);
  }
  const dir = mkdtempSync(join(tmpdir(), 'fleet-probe-ssh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const flag = join(dir, 'offline');
  const script = `const fs = require('fs'); if (fs.existsSync(${JSON.stringify(flag)})) process.exit(255); process.stdout.write(JSON.stringify({kind:'root', root:'/synthetic/project-1', identity:'1:2'}));`;
  const h = await startJobHarness(t, { host: { workspaceProbeCommand: [process.execPath, '-e', script] } });
  const job = await startJob(h.agent);
  writeFileSync(flag, '');
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(job.jobId).state, 'queued');
  assert.equal(h.fake.launches.length, 0);
  assert.equal(h.gw.services.jobs.store.require(job.jobId).lastErrorCode, 'workspace_probe_unavailable');
  assert.equal(h.gw.services.jobs.store.require(job.jobId).hostUnreachableSince, null);
  rmSync(flag);
  await h.tickAfter(60000);
  assert.equal(h.fake.launches.length, 1);
});

test('scratch aliases reject workspace overrides and explicit workspace conflicts on discovered targets', async (t) => {
  const scratch = await startJobHarness(t, { pilot: { workspaceMode: 'scratch' } });
  for (const workspace of [{ type: 'root' }, { type: 'auto' }, { type: 'worktree' }]) {
    const error = await scratch.agent.callError('work_start', { project: 'pilot', task: 'synthetic', requestId: `scratch-${workspace.type}`, workspace });
    assert.equal(error.code, 'invalid_argument');
  }
  const h = await startJobHarness(t, { host: { discovery: { enabled: true, allowWorkStart: true } } });
  const input = { target: { host: 'main', projectId: 'project-1' }, task: 'synthetic', requestId: 'target-workspace', workspace: { type: 'root' } };
  await h.agent.call('work_start', input);
  await h.fake.stop();
  assert.equal((await h.agent.call<{ created: boolean }>('work_start', input)).created, false);
  assert.equal((await h.agent.callError('work_start', { ...input, workspace: { type: 'auto' } })).code, 'request_id_conflict');
});


test('workspace probe command deadline reports a retryable timeout without output', async (t) => {
  const h = await startJobHarness(t, { host: { workspaceProbeCommand: [process.execPath, '-e', "process.stderr.write('secret-timeout'); setTimeout(() => {}, 60000);"] } });
  const error = await h.agent.callError('work_start', { project: 'pilot', task: 'synthetic', requestId: 'probe-deadline' });
  assert.equal(error.code, 'workspace_probe_unavailable');
  assert.equal(error.text.includes('secret-timeout'), false);
  assert.equal(h.fake.launches.length, 0);
});


test('explicit worktree Git becoming plain fails policy validation before requireGit', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-explicit-class-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-b', 'main');
  const h = await startJobHarness(t, { host: { workspaceProbeCommand: command } });
  h.fake.projects[0]!.workspaceRoot = dir;
  const job = await startJob(h.agent, 'explicit local base', { workspace: { type: 'worktree', startFromOrigin: false } });
  rmSync(join(dir, '.git'), { recursive: true });
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(job.jobId).lastErrorCode, 'launch_policy_changed');
  assert.equal(h.fake.launches.length, 0);
});

test('persistent probe failure is bounded per job while other launches and unknown reconciliation continue', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-probe-isolation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const flag = join(dir, 'offline');
  const script = `const fs = require('fs'); let body=''; process.stdin.on('data', x => body+=x); process.stdin.on('end', () => { const input=JSON.parse(body); if (input.root==='/synthetic/project-1' && fs.existsSync(${JSON.stringify(flag)})) process.exit(255); process.stdout.write(JSON.stringify({kind:'root', root:input.root, identity:'1:2'})); });`;
  const h = await startJobHarness(t, { maxConcurrentJobs: 3, watcher: { reconcileWindowMinutes: 1 }, host: { workspaceProbeCommand: [process.execPath, '-e', script] } });
  const unknown = await startJob(h.agent, 'unknown');
  const store = h.gw.services.jobs.store;
  store.transition(unknown.jobId, { from: ['queued'], to: 'dispatching', changes: { t3ProjectId: 'project-1', dispatchStartedAt: h.gw.clock() } });
  store.transition(unknown.jobId, { from: ['dispatching'], to: 'unknown' });
  const failed = await startJob(h.agent, 'failed probe');
  const next = await startJob(h.agent, 'healthy', { project: 'docs' });
  writeFileSync(flag, '');
  await h.tick();
  assert.equal(store.require(next.jobId).state, 'running');
  assert.equal(store.require(next.jobId).hostUnreachableSince, null);
  assert.equal(store.require(unknown.jobId).hostUnreachableSince, null);
  assert.equal(store.require(failed.jobId).lastErrorCode, 'workspace_probe_unavailable');
  await h.tickAfter(30000);
  assert.equal(store.require(failed.jobId).state, 'queued');
  await h.tickAfter(30001);
  assert.equal(store.require(failed.jobId).state, 'failed');
  assert.equal(store.require(failed.jobId).lastErrorCode, 'workspace_probe_unavailable');
  assert.equal(store.require(unknown.jobId).state, 'failed');
  assert.equal(store.require(unknown.jobId).lastErrorCode, 'launch_not_confirmed');
  assert.equal(h.fake.launches.length, 1);
  assert.equal(h.gw.logs.join('\n').includes('jobs.host_unreachable'), false);
});


test('a queued job in probe backoff does not starve the next healthy job', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-probe-backoff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const flag = join(dir, 'offline');
  const script = `const fs = require('fs'); let body=''; process.stdin.on('data', x => body+=x); process.stdin.on('end', () => { const input=JSON.parse(body); if (input.root==='/synthetic/project-1' && fs.existsSync(${JSON.stringify(flag)})) process.exit(255); process.stdout.write(JSON.stringify({kind:'root', root:input.root, identity:'1:2'})); });`;
  const h = await startJobHarness(t, { maxConcurrentJobs: 1, host: { workspaceProbeCommand: [process.execPath, '-e', script] } });
  const waiting = await startJob(h.agent, 'waiting');
  writeFileSync(flag, '');
  await h.tick();
  const next = await startJob(h.agent, 'healthy', { project: 'docs' });
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(waiting.jobId).state, 'queued');
  assert.equal(h.gw.services.jobs.store.require(next.jobId).state, 'running');
  assert.equal(h.fake.launches.length, 1);
});


test('changed Git identity takes priority over missing origin on the replacement', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-probe-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const initial = join(dir, 'initial'); mkdirSync(initial);
  git(initial, 'init', '-b', 'main');
  git(initial, 'config', 'user.name', 'Synthetic'); git(initial, 'config', 'user.email', 'synthetic@example.invalid');
  git(initial, 'commit', '--allow-empty', '-m', 'A');
  const origin = join(dir, 'origin.git'); git(dir, 'clone', '--bare', initial, origin);
  git(initial, 'remote', 'add', 'origin', origin);
  const replacement = join(dir, 'replacement'); mkdirSync(replacement); git(replacement, 'init', '-b', 'main');
  const h = await startJobHarness(t, { host: { workspaceProbeCommand: command } });
  h.fake.projects[0]!.workspaceRoot = initial;
  const job = await startJob(h.agent, 'identity change');
  h.fake.projects[0]!.workspaceRoot = replacement;
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(job.jobId).lastErrorCode, 'launch_policy_changed');
  assert.equal(h.fake.launches.length, 0);
});
