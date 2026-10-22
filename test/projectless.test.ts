import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { readLaunchSpec } from '../src/jobs/launchSpec.ts';
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
      fake.calls.length = 0;
      const { job } = await agent.call<{ job: ScratchJob & { projectName: string | null } }>('work_start', start);
      // Only an explicit project id reads the host (to resolve it); the alias and the host default are recorded from the configuration.
      assert.equal(fake.calls.length > 0, start.requestId === 'id', `${start.requestId}: reads of T3 at start`);
      assert.deepEqual([job.host, job.project, job.projectId, job.workspaceMode, job.branch, job.projectName], ['main', 'pilot', 'project-1', 'scratch', '', null]);
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
      // T3 refuses `scratch` beside a project or a workspace strategy, so a scratch launch sends neither.
      assert.equal(launch.scratch, true);
      assert.deepEqual(['projectId', 'workspaceStrategy'].filter((field) => field in launch), []);
      assert.equal(launch.runtimeMode, 'full-access');
      assert.deepEqual(launch.modelSelection, selection);
      assert.ok(typeof launch.message === 'string');
      assert.match(launch.message, /^PRIVATE_SYNTHETIC_SCRATCH_TASK\n\n---\nStarted through/);
      assert.match(launch.message, /internal scratch workspace\.$/);
      assert.doesNotMatch(launch.message, /branch|worktree/);
    }
    const folders = [...fake.threads.values()].map((thread) => [thread.projectId, thread.scratchFolder]);
    assert.deepEqual(folders.map(([projectId]) => projectId), ['project-1', 'project-1', 'project-1'], 'T3 files scratch threads under its scratch project');
    assert.equal(new Set(folders.map(([, folder]) => folder)).size, 3, 'each scratch thread has a folder of its own');
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
    // The refused replay did not read the job's row: reading a plan it cannot parse is logged, and that line would show the job exists.
    const reported = () => gw.logs.filter((line) => line.includes('job.launch_spec_unreadable')).length;
    assert.equal(reported(), 0, 'nothing is logged about a job the replaying caller may not operate');
    // The same request from a caller who may operate the job is a replay of it, and reading it reports the plan once.
    const replay = await agent.call<{ job: ScratchJob; created: boolean }>('work_start', start);
    assert.deepEqual([replay.created, replay.job.jobId], [false, job.jobId]);
    assert.equal(reported(), 1);
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
      // A model selection makes the start await the host's capabilities, which is the window the competing request lands in.
      const start = { project: 'pilot', task: 'Synthetic racing replay', requestId: 'racing-replay', modelSelection: selection };
      const caller = { clientId: agent.clientId, scopes: ['host:main:read', 'host:main:operate'] as const };
      fake.holdResponses.add('orchestrator_capabilities');
      const pending = gw.services.jobs.start(caller, start);
      await fake.whenHeld('orchestrator_capabilities');
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
      fake.holdResponses.delete('orchestrator_capabilities');
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

  for (const drift of ['workspace', 'project', 'host', 'disabled', 'runtime', 'ceiling', 'default'] as const) {
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
        case 'default': host.defaultProject = 'docs'; break;
      }
      await tick();
      assert.equal(await jobState(agent, job.jobId), 'failed');
      assert.equal(gw.services.jobs.store.require(job.jobId).lastErrorCode, 'launch_policy_changed');
      assert.equal(fake.launches.length, 0);
    });
  }

  test('a pinned scratch project that is gone from the host fails the queued job before any launch', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t, scratch);
    const { job } = await agent.call<{ job: ScratchJob }>('work_start', input('pin-gone'));
    fake.projects.splice(0, 1);
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'failed');
    assert.equal(gw.services.jobs.store.require(job.jobId).lastErrorCode, 'project_not_found');
    assert.equal(fake.launches.length, 0);
  });

  test('the host default and a scratch alias need no discovery; an explicit id or selection still does', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t, { ...scratch, host: { ...scratch.host, discovery: { enabled: false } } });
    fake.calls.length = 0;
    const queued = await agent.call<{ job: ScratchJob }>('work_start', input('discovery-off'));
    assert.deepEqual(fake.calls, [], 'recorded from the configuration alone');
    assert.deepEqual([queued.job.state, queued.job.workspaceMode], ['queued', 'scratch']);
    assert.equal((await agent.callError('work_start', { ...input('id-off'), target: { host: 'main', projectId: 'project-1' } })).code, 'discovery_disabled');
    assert.equal((await agent.callError('work_start', { ...input('selection-off'), modelSelection: selection })).code, 'discovery_disabled');
    assert.equal((await agent.callError('work_start', { project: 'pilot', task: 'Synthetic', requestId: 'alias-selection-off', modelSelection: selection })).code, 'discovery_disabled');
    assert.deepEqual(fake.calls, []);
    await tick();
    assert.equal(await jobState(agent, queued.job.jobId), 'running');
    assert.equal(fake.launches[0]!.scratch, true);
    const { job } = await agent.call<{ job: ScratchJob }>('work_start', { project: 'pilot', task: 'Synthetic', requestId: 'alias-off' });
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'running');
    delete gw.services.config.hosts[0]!.defaultProject;
    fake.calls.length = 0;
    assert.equal((await agent.callError('work_start', input('no-default'))).code, 'not_found');
    assert.deepEqual(fake.calls, []);
  });

  test('scratch starts with the host down: queued without a read of T3, launched when it is back; no T3 project name is recorded', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t, scratch);
    fake.projects[0]!.title = 'PRIVATE_SYNTHETIC_SCRATCH_NAME';
    await fake.stop();
    const hostOnly = await agent.call<{ job: ScratchJob & { projectName: string | null; state: string } }>('work_start', input('down-host'));
    const alias = await agent.call<{ job: ScratchJob & { projectName: string | null; state: string } }>('work_start', { ...input('down-alias'), target: undefined, project: 'pilot' });
    for (const { job } of [hostOnly, alias]) assert.deepEqual([job.state, job.projectName, job.workspaceMode], ['queued', null, 'scratch']);
    assert.equal(gw.services.jobs.store.require(hostOnly.job.jobId).launchSpec?.projectName, null);
    await fake.start();
    await tick();
    assert.deepEqual([await jobState(agent, hostOnly.job.jobId), await jobState(agent, alias.job.jobId)], ['running', 'running']);
    assertNotLogged(gw, ['PRIVATE_SYNTHETIC_SCRATCH_NAME']);
  });

  test('an explicit model selection on a scratch alias is validated against the fresh catalog at start and again at dispatch', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t, scratch);
    const bad = { instanceId: 'synthetic-provider', model: 'not-advertised' };
    assert.equal((await agent.callError('work_start', { ...input('bad-selection'), modelSelection: bad })).code, 'invalid_argument');
    assert.equal(gw.services.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n, 0);
    const { job } = await agent.call<{ job: ScratchJob }>('work_start', { ...input('good-selection'), modelSelection: selection });
    const spec = gw.services.jobs.store.require(job.jobId).launchSpec;
    assert.deepEqual(spec?.model, { source: 'explicit', selection });
    fake.providers = [];
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'failed');
    assert.equal(gw.services.jobs.store.require(job.jobId).lastErrorCode, 'model_selection_invalid');
    assert.equal(fake.launches.length, 0);
  });

  test('a launch T3 files under another project than the pin is followed, with one fixed warning', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t, scratch);
    fake.scratchProjectId = 'project-2';
    const { job } = await agent.call<{ job: ScratchJob }>('work_start', input('mismatch'));
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'running');
    assert.equal(fake.threadForJob(job.jobId).projectId, 'project-2');
    const warnings = gw.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === 'job.scratch_project_mismatch');
    assert.deepEqual(warnings.map(({ time: _time, ...rest }) => rest), [{ level: 'warn', event: 'job.scratch_project_mismatch', jobId: job.jobId, hostId: 'main' }]);
    fake.finishTurn(fake.threadForJob(job.jobId).threadId, 'Synthetic result');
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'idle', 'the thread is followed by id');
    assertNotLogged(gw, ['PRIVATE_SYNTHETIC_SCRATCH_TASK']);
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
    assert.equal(first.fake.launches[0]!.scratch, true);
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
    const { fake, gw, agent, tick } = await startJobHarness(t, { ...scratch, maxConcurrentJobs: 4 });
    const texts = ['{', '{"v":3,"projectId":"project-1"}', '{"v":2,"projectId":"project-1"}', '{"v":1,"projectId":"project-1"}'];
    for (const [index, text] of texts.entries()) {
      const { job } = await agent.call<{ job: ScratchJob }>('work_start', input(`corrupt-${index}`));
      gw.services.db.prepare('UPDATE jobs SET launch_spec = ? WHERE id = ?').run(text, job.jobId);
      const stored = gw.services.jobs.store.require(job.jobId);
      assert.deepEqual([stored.launchSpec, stored.launchSpecUnreadable], [null, true], 'reading does not throw, and does not call it an alias job');
      await tick();
      const status = await agent.call<{ state: string; lastError: { code: string } | null }>('work_status', { jobId: job.jobId });
      // A job read as having no spec would fail as launch_policy_changed here, because its alias is now a scratch alias.
      assert.deepEqual([status.state, status.lastError?.code], ['failed', 'database_error']);
    }
    assert.equal(fake.launches.length, 0);
    assert.deepEqual(readLaunchSpec(null), { kind: 'none' });
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
  // A scratch pin is T3's scratch project: a worktree alias on the same id would put branches there. Another host's alias, another id and a second scratch alias are fine.
  const worktreeOnPin = { alias: 'docs', host: 'main', t3ProjectId: 'pinned-synthetic-id' };
  assert.throws(() => parseConfig({ ...base, projects: [project, worktreeOnPin] }), /scratch alias "scratch" shares its pinned T3 project with non-scratch alias "docs" on host "main"/);
  assert.throws(() => parseConfig({ ...base, projects: [worktreeOnPin, project] }), /shares its pinned T3 project/);
  const other = { id: 'other', t3Url: 'http://127.0.0.1:9' };
  parseConfig({ ...base, hosts: [...base.hosts, other], projects: [project, { ...worktreeOnPin, host: 'other' }] });
  parseConfig({ ...base, projects: [project, { ...worktreeOnPin, t3ProjectId: 'another-id' }, { ...project, alias: 'scratch-two' }] });
  assert.throws(() => parseConfig({ ...base, hosts: [{ ...host, access: 'approval-required' }], projects: [{ ...project, runtimeMode: 'full-access' }] }), /exceeds host/);
});
