import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { parseLaunchSpec } from '../src/jobs/launchSpec.ts';
import { startInputHash } from '../src/jobs/service.ts';
import { MINUTE } from '../src/time.ts';
import { assertNotLogged, jobState, startJobHarness, type StartedJob } from './helpers/jobs.ts';

const selection = { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'low' } };
const scratch = {
  host: { access: 'full-access', discovery: { enabled: true }, defaultProject: 'pilot', defaultModelSelection: selection },
  pilot: { workspaceMode: 'scratch', runtimeMode: 'full-access' },
};
type ScratchJob = StartedJob & { host: string; project: string; projectId: string; workspaceMode: string | null };
const input = (requestId: string) => ({ target: { host: 'main' }, task: 'PRIVATE_SYNTHETIC_SCRATCH_TASK', requestId, title: 'Investigate the synthetic result' });

describe('projectless work', () => {
  test('host-only, scratch alias and pinned direct target launch root with no branch and the exact caller title', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t, { ...scratch, maxConcurrentJobs: 4 });
    fake.projects[0]!.title = 'PRIVATE_SYNTHETIC_SCRATCH_NAME';
    const starts = [input('host'), { ...input('alias'), target: undefined, project: 'pilot' }, { ...input('id'), target: { host: 'main', projectId: 'project-1' } }];
    for (const start of starts) {
      const { job } = await agent.call<{ job: ScratchJob }>('work_start', start);
      assert.deepEqual([job.host, job.project, job.projectId, job.workspaceMode, job.branch], ['main', 'pilot', 'project-1', 'scratch', '']);
      const spec = gw.services.jobs.store.require(job.jobId).launchSpec;
      assert.equal(spec?.v, 2);
      if (spec?.v !== 2) assert.fail('scratch must have a v2 spec');
      assert.deepEqual(spec.workspace, { kind: 'scratch' });
      assert.equal(spec.hostId, 'main');
      assert.equal(spec.defaultProject, start.requestId === 'host' ? 'pilot' : null);
      assert.deepEqual(spec.model, { source: 'host', selection });
      assert.equal(job.title, `Investigate the synthetic result [job:${job.jobId}]`);
    }
    // A later model default must not rewrite the already recorded launch.
    gw.services.config.hosts[0]!.defaultModelSelection = { model: 'synthetic-large' };
    await tick();
    assert.equal(fake.launches.length, 3);
    for (const launch of fake.launches) {
      assert.deepEqual(launch.workspaceStrategy, { type: 'root' });
      assert.equal(launch.projectId, 'project-1');
      assert.equal(launch.runtimeMode, 'full-access');
      assert.deepEqual(launch.modelSelection, selection);
      assert.ok(typeof launch.message === 'string');
      assert.match(launch.message, /^PRIVATE_SYNTHETIC_SCRATCH_TASK\n\n---\nStarted through/);
      assert.match(launch.message, /internal scratch workspace\.$/);
      assert.doesNotMatch(launch.message, /branch|worktree/);
    }
    const fleet = await agent.call<{ hosts: { defaultProject: string | null }[]; projects: { alias: string; workspaceMode: string }[] }>('fleet_status');
    assert.equal(fleet.hosts[0]!.defaultProject, 'pilot');
    assert.equal(fleet.projects.find((project) => project.alias === 'pilot')?.workspaceMode, 'scratch');
    const catalog = await agent.call<{ hosts: { projects: { projectId: string; launch: { workspaceMode: string; baseRef: string | null; branchPrefix: string | null }; guidance: string }[] }[] }>('fleet_projects');
    const entry = catalog.hosts[0]!.projects.find((project) => project.projectId === 'project-1')!;
    assert.deepEqual([entry.launch.workspaceMode, entry.launch.baseRef, entry.launch.branchPrefix], ['scratch', null, null]);
    assert.match(entry.guidance, /internal scratch/);
    assert.match((await agent.callError('work_list', { target: { host: 'main' } })).text, /projectId/, 'list filters still require an explicit project id');
    assertNotLogged(gw, ['PRIVATE_SYNTHETIC_SCRATCH_TASK', 'PRIVATE_SYNTHETIC_SCRATCH_NAME', 'Investigate the synthetic result', 'synthetic-effort']);
  });

  test('named project targets remain worktrees and unknown named projects do not fall back to scratch', async (t) => {
    const { fake, agent, tick } = await startJobHarness(t, { ...scratch, host: { ...scratch.host, discovery: { enabled: true, allowWorkStart: true } } });
    const { job } = await agent.call<{ job: ScratchJob }>('work_start', { ...input('named'), target: { host: 'main', projectId: 'project-3' } });
    assert.equal(job.workspaceMode, 'worktree');
    assert.ok(job.branch.length > 0);
    assert.equal((await agent.callError('work_start', { project: 'unknown-named-project', task: 'Synthetic', requestId: 'missing-name' })).code, 'not_found');
    assert.equal((await agent.callError('work_start', { ...input('missing-id'), target: { host: 'main', projectId: 'missing' } })).code, 'not_found');
    await tick();
    assert.deepEqual(fake.launches[0]!.workspaceStrategy, { type: 'worktree', baseRef: 'main', branch: job.branch, startFromOrigin: false });
  });

  test('host-only replay hashes the original intention before resolving a changed default', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t, scratch);
    const first = await agent.call<{ job: ScratchJob }>('work_start', input('replay'));
    fake.calls.length = 0;
    gw.services.config.hosts[0]!.defaultProject = 'docs';
    const replay = await agent.call<{ job: ScratchJob; created: boolean }>('work_start', input('replay'));
    assert.equal(replay.created, false);
    assert.equal(replay.job.jobId, first.job.jobId);
    assert.deepEqual(fake.calls, [], 'replay does not resolve the new binding');
    assert.notEqual(startInputHash(input('replay')), startInputHash({ ...input('replay'), target: { host: 'main', projectId: 'project-1' } }));
    await tick();
    assert.equal(await jobState(agent, first.job.jobId), 'failed');
    assert.equal(gw.services.jobs.store.require(first.job.jobId).lastErrorCode, 'launch_policy_changed');
    assert.equal(fake.launches.length, 0);
  });

  for (const workspace of ['scratch', 'worktree'] as const) {
    for (const drift of ['removed', 'renamed', 'moved'] as const) {
      test(`${workspace} alias replay survives an alias that was ${drift}`, async (t) => {
        const { fake, gw, agent } = await startJobHarness(t, workspace === 'scratch' ? scratch : {});
        const start = { project: 'pilot', task: 'Synthetic alias replay', requestId: `alias-${drift}` };
        const first = await agent.call<{ job: ScratchJob }>('work_start', start);
        const project = gw.services.config.projects[0]!;
        if (drift === 'removed') gw.services.config.projects.splice(0, 1);
        if (drift === 'renamed') project.alias = 'renamed-pilot';
        if (drift === 'moved') project.host = 'other';
        fake.calls.length = 0;
        const replay = await agent.call<{ job: ScratchJob; created: boolean }>('work_start', start);
        assert.deepEqual([replay.created, replay.job.jobId, replay.job.host], [false, first.job.jobId, 'main']);
        assert.equal((await agent.callError('work_start', { ...start, task: 'Different synthetic task' })).code, 'request_id_conflict');
        assert.deepEqual(fake.calls, [], 'replay and conflict do not resolve the current alias');
        assert.equal(gw.services.jobs.store.list({ limit: 10 }).length, 1);
      });
    }
  }

  test('alias replay authorizes the stored host before a conflict or malformed job can be revealed', async (t) => {
    const { fake, gw, agent } = await startJobHarness(t, scratch);
    const start = { project: 'pilot', task: 'Synthetic restricted replay', requestId: 'restricted-replay' };
    const { job } = await agent.call<{ job: ScratchJob }>('work_start', start);
    gw.services.config.hosts.push({ ...gw.services.config.hosts[0]!, id: 'other' });
    gw.services.config.projects[0]!.host = 'other';
    const narrowed = { clientId: agent.clientId, scopes: ['host:other:read', 'host:other:operate'] as const };
    fake.calls.length = 0;
    for (const task of [start.task, 'Different synthetic task']) {
      await assert.rejects(gw.services.jobs.start(narrowed, { ...start, task }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal('code' in error && error.code, 'insufficient_scope');
        assert.doesNotMatch(error.message, new RegExp(`${job.jobId}|main|other`));
        return true;
      });
    }
    gw.services.db.prepare('UPDATE jobs SET launch_spec = ? WHERE id = ?').run('{', job.jobId);
    await assert.rejects(gw.services.jobs.start(narrowed, start), { code: 'insufficient_scope' });
    assert.deepEqual(fake.calls, []);
  });

  for (const race of [
    { host: 'main', changed: false, malformed: false, outcome: 'replay' },
    { host: 'main', changed: true, malformed: false, outcome: 'request_id_conflict' },
    { host: 'other', changed: false, malformed: false, outcome: 'insufficient_scope' },
    { host: 'other', changed: true, malformed: false, outcome: 'insufficient_scope' },
    { host: 'other', changed: false, malformed: true, outcome: 'insufficient_scope' },
    { host: 'other', changed: true, malformed: true, outcome: 'insufficient_scope' },
  ] as const) {
    test(`transactional replay on ${race.host}, changed=${race.changed}, malformed=${race.malformed} returns ${race.outcome}`, async (t) => {
      const { fake, gw, agent } = await startJobHarness(t, scratch);
      const start = { project: 'pilot', task: 'Synthetic racing replay', requestId: 'racing-replay' };
      const caller = { clientId: agent.clientId, scopes: ['host:main:read', 'host:main:operate'] as const };
      fake.holdResponses.add('t3_project_list');
      const pending = gw.services.jobs.start(caller, start);
      await fake.whenHeld('t3_project_list');
      const competing = gw.services.jobs.store.create({
        id: 'racejob001',
        clientId: agent.clientId,
        requestId: start.requestId,
        inputHash: startInputHash({ ...start, task: race.changed ? 'Different synthetic task' : start.task }),
        projectAlias: 'pilot',
        hostId: race.host,
        task: start.task,
        title: 'Private competing job title',
        branch: '',
        runtimeMode: 'full-access',
      }).job;
      if (race.malformed) gw.services.db.prepare('UPDATE jobs SET launch_spec = ? WHERE id = ?').run('{', competing.id);
      fake.holdResponses.delete('t3_project_list');
      fake.releaseHeld();
      if (race.outcome === 'replay') {
        assert.deepEqual(await pending, { job: competing, created: false });
      } else {
        await assert.rejects(pending, (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal('code' in error && error.code, race.outcome);
          assert.doesNotMatch(error.message, /racejob001|main|other|Private competing job title/);
          return true;
        });
      }
      assert.equal(gw.services.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n, 1);
      assert.equal(fake.launches.length, 0);
    });
  }

  for (const drift of ['workspace', 'project', 'host', 'disabled', 'runtime', 'ceiling', 'discovery'] as const) {
    test(`queued scratch rejects ${drift} policy drift before launch`, async (t) => {
      const { fake, gw, agent, tick } = await startJobHarness(t, scratch);
      const { job } = await agent.call<{ job: ScratchJob }>('work_start', input(`drift-${drift}`));
      const host = gw.services.config.hosts[0]!;
      const project = gw.services.config.projects[0]!;
      switch (drift) {
        case 'workspace': project.workspaceMode = 'worktree'; break;
        case 'project': project.t3ProjectId = 'project-2'; break;
        case 'host': project.host = 'other'; break;
        case 'disabled': project.allowWorkStart = false; break;
        case 'runtime': project.runtimeMode = 'approval-required'; break;
        case 'ceiling': host.access = 'approval-required'; break;
        case 'discovery': host.discovery.enabled = false; break;
      }
      await tick();
      assert.equal(await jobState(agent, job.jobId), 'failed');
      assert.equal(gw.services.jobs.store.require(job.jobId).lastErrorCode, 'launch_policy_changed');
      assert.equal(fake.launches.length, 0);
    });
  }

  test('host defaults require discovery; explicit scratch aliases still work without it', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t, { ...scratch, host: { ...scratch.host, discovery: { enabled: false } } });
    fake.calls.length = 0;
    assert.equal((await agent.callError('work_start', input('discovery-off'))).code, 'discovery_disabled');
    assert.deepEqual(fake.calls, []);
    const { job } = await agent.call<{ job: ScratchJob }>('work_start', { project: 'pilot', task: 'Synthetic', requestId: 'alias-off' });
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'running');
    assert.deepEqual(fake.launches[0]!.workspaceStrategy, { type: 'root' });
    gw.services.config.hosts[0]!.discovery.enabled = true;
    delete gw.services.config.hosts[0]!.defaultProject;
    fake.calls.length = 0;
    assert.equal((await agent.callError('work_start', input('no-default'))).code, 'not_found');
    assert.deepEqual(fake.calls, []);
  });

  test('host authorization precedes missing defaults, discovery and all downstream reads', async (t) => {
    const { fake, gw } = await startJobHarness(t, scratch);
    fake.calls.length = 0;
    await assert.rejects(gw.services.jobs.start({ clientId: 'synthetic-hidden', scopes: [] }, input('hidden')), { code: 'not_found' });
    await assert.rejects(gw.services.jobs.start({ clientId: 'synthetic-read', scopes: ['host:main:read'] }, input('read')), { code: 'insufficient_scope' });
    assert.deepEqual(fake.calls, []);
  });

  test('a direct target never bypasses a pinned scratch alias restriction', async (t) => {
    const { fake, gw, agent } = await startJobHarness(t, scratch);
    gw.services.config.projects[0]!.allowWorkStart = false;
    for (const [index, extra] of [{ target: { host: 'main' } }, { project: 'pilot' }, { target: { host: 'main', projectId: 'project-1' } }].entries()) {
      assert.equal((await agent.callError('work_start', { ...extra, task: 'Synthetic', requestId: `disabled-${index}` })).code, 'start_disabled');
    }
    assert.equal(fake.launches.length, 0);
  });

  test('lost scratch launch response survives restart and changed bindings without a duplicate or another project', async (t) => {
    const first = await startJobHarness(t, scratch);
    first.fake.dropResponseOnce.add('t3_thread_launch');
    const { job } = await first.agent.call<{ job: ScratchJob }>('work_start', input('lost'));
    await first.tick();
    assert.equal(await jobState(first.agent, job.jobId), 'unknown');
    assert.equal(first.fake.launches.length, 1);
    await first.agent.client.close();
    await first.gw.gateway.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await startJobHarness(t, { ...scratch, fake: first.fake, dataDir: first.gw.dataDir, door: first.gw.door, pilot: { ...scratch.pilot, t3ProjectId: 'project-2' } });
    second.gw.clock.advance(MINUTE);
    await second.tick();
    assert.equal(await jobState(second.agent, job.jobId), 'running');
    assert.equal(first.fake.launches.length, 1);
    assert.equal(first.fake.threadForJob(job.jobId).projectId, 'project-1');
    assert.deepEqual(first.fake.launches[0]!.workspaceStrategy, { type: 'root' });
  });

  test('legacy alias hashes and downstream-free queueing survive; removing aliases leaves idle threads usable', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t);
    fake.calls.length = 0;
    const legacy = { project: 'pilot', task: 'Synthetic legacy task', requestId: 'legacy-golden' };
    const { job } = await agent.call<{ job: ScratchJob }>('work_start', legacy);
    assert.equal(startInputHash(legacy), '06c29f1b765f51ba0ee05f4151a4a0adf3717bc6e0ca2b0acbd039c6634e0508');
    assert.equal(gw.services.jobs.store.idempotencyKey(agent.clientId, 'work_start', legacy.requestId)?.inputHash, startInputHash(legacy));
    assert.deepEqual(fake.calls, []);
    assert.equal(job.workspaceMode, 'worktree');
    assert.equal(gw.services.jobs.store.require(job.jobId).launchSpec, null);
    await tick();
    fake.finishTurn(fake.threadForJob(job.jobId).threadId, 'Synthetic legacy result');
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'idle');
    gw.services.config.projects.length = 0;
    await agent.call('work_continue', { jobId: job.jobId, message: 'Synthetic follow-up after removing the alias', requestId: 'legacy-followup' });
    assert.equal(await jobState(agent, job.jobId), 'running');
    assert.equal(fake.launches.length, 1);
  });

  test('adopted standing jobs expose unknown workspace mode without changing the branch field', async (t) => {
    const { fake, gw, agent } = await startJobHarness(t, scratch);
    const thread = fake.launchDirect({ projectId: 'project-1', title: 'Synthetic standing scratch', workspaceStrategy: { type: 'root' }, message: 'Synthetic' });
    const { job } = await gw.services.jobs.adopt({ project: 'pilot', threadId: thread.threadId });
    const status = await agent.call<ScratchJob>('work_status', { jobId: job.id });
    assert.equal(status.workspaceMode, null);
    assert.equal(status.branch, '');
  });

  test('malformed and unsupported persisted specs cannot fall back to legacy worktree dispatch', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t, scratch);
    const { job } = await agent.call<{ job: ScratchJob }>('work_start', input('corrupt'));
    for (const text of ['{', '{"v":3,"projectId":"project-1"}', '{"v":2,"projectId":"project-1"}', '{"v":1,"projectId":"project-1"}']) {
      gw.services.db.prepare('UPDATE jobs SET launch_spec = ? WHERE id = ?').run(text, job.jobId);
      assert.throws(() => gw.services.jobs.store.require(job.jobId), { code: 'database_error' });
      await tick();
      assert.equal(fake.launches.length, 0);
    }
    assert.equal(parseLaunchSpec(null), null);
  });
});

test('scratch configuration requires a pinned id and a same-host scratch default alias', () => {
  const host = { id: 'main', t3Url: 'http://127.0.0.1:9' };
  const project = { alias: 'scratch', host: 'main', workspaceMode: 'scratch', t3ProjectId: 'pinned-synthetic-id' };
  const base = { publicUrl: 'https://gateway.example.com', hosts: [{ ...host, defaultProject: 'scratch' }], projects: [project] };
  assert.equal(parseConfig(base).projects[0]!.workspaceMode, 'scratch');
  assert.equal(parseConfig({ ...base, hosts: [host], projects: [{ ...project, workspaceMode: undefined }] }).projects[0]!.workspaceMode, 'worktree');
  for (const projects of [[], [{ ...project, workspaceMode: 'worktree' }], [{ ...project, host: 'other' }]]) {
    assert.throws(() => parseConfig({ ...base, projects }), /defaultProject/);
  }
  assert.throws(() => parseConfig({ ...base, projects: [{ ...project, t3ProjectId: undefined, t3ProjectTitle: 'No project' }] }), /explicit t3ProjectId pin/);
  assert.throws(() => parseConfig({ ...base, hosts: [{ ...host, access: 'approval-required' }], projects: [{ ...project, runtimeMode: 'full-access' }] }), /exceeds host/);
});
