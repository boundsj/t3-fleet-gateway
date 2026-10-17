import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { CATALOG_TTL_MS, decodeCursor, encodeCursor, MAX_MODELS, MAX_PROVIDERS, snapshotId } from '../src/hosts/catalog.ts';
import { startInputHash } from '../src/jobs/service.ts';
import { MINUTE, SECOND } from '../src/time.ts';
import { startFakeT3, syntheticProviders, type FakeOption, type FakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway, type TestGateway } from './helpers/gateway.ts';
import { agentWithToken, assertNotLogged, jobState, type Agent } from './helpers/jobs.ts';
import { signIn } from './helpers/oauthFlow.ts';

interface HostPage<T> {
  host: string;
  discovery: boolean;
  available: boolean;
  error: { code: string; message: string } | null;
  readAt: string | null;
  nextCursor: string | null;
  total: number | null;
  projects?: T[];
  models?: T[];
  providers?: { providerInstanceId: string; modelCount: number; constraints: string[]; canRunChildTask: boolean | null }[];
}

interface ProjectEntry {
  host: string;
  projectId: string;
  name: string;
  hasDefaultModel: boolean;
  launch: { allowed: boolean; source: string; alias: string | null; aliases: string[]; runtimeMode: string | null; baseRef: string | null; defaultModelSource: string | null };
  guidance: string;
}

interface ModelEntry {
  host: string;
  providerInstanceId: string;
  modelId: string;
  modelLabel: string | null;
  options: { id: string; type: string; choices: { id: string; isDefault: boolean }[] | null; currentValue: string | boolean | null }[];
}

interface StartedJob {
  jobId: string;
  state: string;
  title: string;
  project: string;
  host: string;
  projectId: string | null;
  projectName: string | null;
  source: string;
  model: { source: string; selection: Record<string, unknown> | null } | null;
  branch: string;
}

interface Fleet {
  mini: FakeT3;
  macbook: FakeT3;
  gw: TestGateway;
  /** Fleet-wide Operate. */
  agent: Agent;
  tick(): Promise<void>;
}

const HOSTS = (mini: FakeT3, macbook: FakeT3, extra: { mini?: Record<string, unknown>; macbook?: Record<string, unknown> } = {}) => [
  { id: 'mini', t3Url: mini.url, mintPairingCode: mini.mintCommand(), discovery: { enabled: true, allowWorkStart: true, runtimeMode: 'auto' }, ...extra.mini },
  { id: 'macbook', t3Url: macbook.url, mintPairingCode: macbook.mintCommand(), discovery: { enabled: true }, ...extra.macbook },
];

/** Both hosts have `Synthetic project 1..3`; mini's project-1 is the alias `alpha`, macbook's project-1 is `beta`. */
const PROJECTS = [
  { alias: 'alpha', description: 'Synthetic alpha', host: 'mini', t3ProjectId: 'project-1', runtimeMode: 'approval-required', baseRef: 'trunk', branchPrefix: 'alias/' },
  { alias: 'beta', description: 'Synthetic beta', host: 'macbook', t3ProjectId: 'project-1', runtimeMode: 'auto' },
];

async function startFleet(
  t: TestContext,
  options: { hosts?: Record<string, unknown>[]; projects?: Record<string, unknown>[]; mini?: FakeT3; macbook?: FakeT3 } = {},
): Promise<Fleet> {
  const mini = options.mini ?? (await startFakeT3());
  const macbook = options.macbook ?? (await startFakeT3());
  if (!options.mini) t.after(() => mini.close());
  if (!options.macbook) t.after(() => macbook.close());
  // The MacBook's provider has a different model list, so the two catalogs are distinguishable.
  if (!options.macbook) {
    macbook.providers = [
      { ...syntheticProviders()[0]!, providerInstanceId: 'synthetic-macbook', models: [{ id: 'synthetic-small', label: 'Synthetic small' }] },
      { providerInstanceId: 'synthetic-empty', driverKind: 'synthetic', displayName: 'No models here', models: [], canRunChildTask: false, canRunCrossProviderChildTask: false, constraints: ['Synthetic constraint: metadata only'] },
    ];
  }
  const gw = await startTestGateway(t, {
    config: { hosts: options.hosts ?? HOSTS(mini, macbook), projects: options.projects ?? PROJECTS },
    jobEngine: { autoStart: false },
  });
  await gw.services.registry.enroll('mini');
  await gw.services.registry.enroll('macbook');
  const agent = await connect(t, gw, 'operate');
  return { mini, macbook, gw, agent, tick: () => gw.gateway.engine.tick() };
}

async function connect(t: TestContext, gw: TestGateway, access: 'read' | 'operate', hosts?: 'all' | string[]): Promise<Agent> {
  const signedIn = await signIn(gw.baseUrl, gw.mintApprovalCode, { access, ...(hosts ? { hosts } : {}) });
  return agentWithToken(t, gw.baseUrl, signedIn.clientId, signedIn.tokens.access_token);
}

async function toolText(agent: Agent, name: string, args: Record<string, unknown> = {}): Promise<{ structured: unknown; text: string; isError: boolean }> {
  const result = await agent.client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[]).map((block) => block.text).join('\n');
  return { structured: result.structuredContent, text, isError: result.isError === true };
}

const requestId = () => `req-${Math.random().toString(36).slice(2)}`;
const countCalls = (fake: FakeT3, tool: string) => fake.calls.filter((call) => call === tool).length;

describe('discovery: off by default', () => {
  test('existing configs, aliases and launches behave as before, and no catalog call ever reaches a host', async (t) => {
    const mini = await startFakeT3();
    const macbook = await startFakeT3();
    t.after(() => mini.close());
    t.after(() => macbook.close());
    const { gw, agent, tick } = await startFleet(t, {
      mini,
      macbook,
      hosts: [
        { id: 'mini', t3Url: mini.url, mintPairingCode: mini.mintCommand() },
        { id: 'macbook', t3Url: macbook.url, mintPairingCode: macbook.mintCommand() },
      ],
    });
    assert.deepEqual(gw.services.config.hosts[0]!.discovery, { enabled: false, allowWorkStart: false, runtimeMode: 'approval-required', baseRef: 'main', branchPrefix: 'fleet/' });
    const status = await agent.call<{ hosts: { id: string; discovery: { enabled: boolean; allowWorkStart: boolean } }[]; projects: { alias: string }[] }>('fleet_status');
    assert.deepEqual(status.hosts.map((host) => host.discovery), [{ enabled: false, allowWorkStart: false }, { enabled: false, allowWorkStart: false }]);
    assert.deepEqual(status.projects.map((project) => project.alias), ['alpha', 'beta']);

    const projects = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects');
    assert.deepEqual(projects.hosts.map((host) => [host.host, host.discovery, host.available, host.error?.code, host.projects]), [
      ['mini', false, false, 'discovery_disabled', []],
      ['macbook', false, false, 'discovery_disabled', []],
    ]);
    const models = await agent.call<{ hosts: HostPage<ModelEntry>[] }>('fleet_models', { host: 'mini', refresh: true });
    assert.deepEqual(models.hosts.map((host) => [host.available, host.error?.code, host.models, host.providers]), [[false, 'discovery_disabled', [], []]]);
    const cursor = encodeCursor({ hostId: 'mini', kind: 'projects', snapshot: snapshotId(), offset: 0 });
    assert.equal((await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini', cursor })).hosts[0]!.error?.code, 'discovery_disabled');

    // Targets and selections are refused on a host without discovery, before any catalog read.
    const target = await agent.callError('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic', requestId: requestId() });
    assert.equal(target.code, 'discovery_disabled');
    const selected = await agent.callError('work_start', {
      project: 'alpha', task: 'Synthetic', requestId: requestId(), modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model' },
    });
    assert.equal(selected.code, 'discovery_disabled');
    assert.equal(countCalls(mini, 'orchestrator_capabilities') + countCalls(macbook, 'orchestrator_capabilities'), 0, 'no capabilities read');
    assert.equal(countCalls(mini, 't3_project_list'), 0, 'work_start never read the project list before dispatch');

    // The ordinary alias path is unchanged: downstream-free until dispatch, same launch input, same hash.
    const input = { project: 'alpha', task: 'Synthetic alias task', requestId: 'legacy-1' };
    const started = await agent.call<{ job: StartedJob; created: boolean }>('work_start', input);
    assert.equal(started.created, true);
    assert.deepEqual([started.job.source, started.job.model, started.job.projectId, started.job.projectName], ['alias', null, null, null]);
    assert.equal(gw.services.jobs.store.idempotencyKey(agent.clientId, 'work_start', 'legacy-1')?.inputHash, startInputHash(input));
    assert.equal(startInputHash(input), startInputHash({ ...input, title: undefined }), 'the alias-only hash is the pre-discovery hash');
    assert.equal(countCalls(mini, 't3_project_list'), 0);
    await tick();
    assert.deepEqual(mini.launches[0]?.workspaceStrategy, { type: 'worktree', baseRef: 'trunk', branch: `alias/${started.job.jobId}`, startFromOrigin: false });
    assert.equal(mini.launches[0]?.modelSelection, undefined);
    assert.equal((await agent.call<{ job: StartedJob }>('work_start', input)).job.jobId, started.job.jobId, 'replays');
    assert.equal((await agent.call<{ projectId: string | null }>('work_status', { jobId: started.job.jobId })).projectId, 'project-1', 'learned at dispatch');
    assert.equal(countCalls(mini, 'orchestrator_capabilities'), 0);
  });

  test('config: allowWorkStart needs enabled, the launch runtime mode respects the host access, and a read-only host may browse', () => {
    const base = { publicUrl: 'https://gateway.example.ts.net' };
    const invalid = (host: Record<string, unknown>, pattern: RegExp) =>
      assert.throws(() => parseConfig({ ...base, hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:3773', ...host }] }), pattern);
    invalid({ discovery: { allowWorkStart: true } }, /hosts\[0\]\.discovery\.allowWorkStart: discovery\.allowWorkStart needs discovery\.enabled true/);
    invalid({ access: 'approval-required', discovery: { enabled: true, allowWorkStart: true, runtimeMode: 'auto' } }, /discovery\.runtimeMode "auto" exceeds host "main" access "approval-required"/);
    invalid({ access: 'read-only', discovery: { enabled: true, allowWorkStart: true } }, /discovery\.runtimeMode "approval-required" exceeds host "main" access "read-only"/);
    invalid({ discovery: { enabled: true, extra: 1 } }, /discovery/);
    const browsing = parseConfig({ ...base, hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:3773', access: 'read-only', discovery: { enabled: true } }] });
    assert.deepEqual(browsing.hosts[0]!.discovery, { enabled: true, allowWorkStart: false, runtimeMode: 'approval-required', baseRef: 'main', branchPrefix: 'fleet/' });
  });
});

describe('discovery: fleet_projects and fleet_models', () => {
  test('two hosts with same-named projects and different models are told apart; unavailable hosts never hide the others', async (t) => {
    const { mini, macbook, agent } = await startFleet(t);
    await macbook.stop();
    const projects = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects');
    assert.deepEqual(projects.hosts.map((host) => [host.host, host.available, host.total]), [['mini', true, 3], ['macbook', false, null]]);
    assert.ok(['host_unreachable', 't3_response_lost'].includes(projects.hosts[1]!.error?.code ?? ''), projects.hosts[1]!.error?.code);
    const mini1 = projects.hosts[0]!.projects!.find((project) => project.name === 'Synthetic project 1')!;
    assert.deepEqual([mini1.host, mini1.projectId, mini1.launch.source, mini1.launch.alias, mini1.launch.allowed, mini1.launch.runtimeMode, mini1.launch.baseRef],
      ['mini', 'project-1', 'alias', 'alpha', true, 'approval-required', 'trunk']);
    assert.match(mini1.guidance, /work_start \{ project: "alpha" \}/);
    const mini2 = projects.hosts[0]!.projects!.find((project) => project.projectId === 'project-2')!;
    assert.deepEqual([mini2.launch.source, mini2.launch.alias, mini2.launch.allowed, mini2.launch.runtimeMode, mini2.launch.defaultModelSource], ['discovered', null, true, 'auto', 't3_default']);
    assert.match(mini2.guidance, /work_start \{ target: \{ host: "mini", projectId: "project-2" \} \}/);

    await macbook.start();
    const both = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { refresh: true });
    const byName = (host: HostPage<ProjectEntry>) => host.projects!.filter((project) => project.name === 'Synthetic project 1').map((project) => [project.host, project.projectId, project.launch.alias]);
    assert.deepEqual(both.hosts.flatMap(byName), [['mini', 'project-1', 'alpha'], ['macbook', 'project-1', 'beta']]);
    // The MacBook allows browsing but no launches into unconfigured projects.
    const macbook2 = both.hosts[1]!.projects!.find((project) => project.projectId === 'project-2')!;
    assert.deepEqual([macbook2.launch.source, macbook2.launch.allowed], ['discovered', false]);
    assert.match(macbook2.guidance, /does not accept work_start into unconfigured projects/);

    const models = await toolText(agent, 'fleet_models');
    const hosts = (models.structured as { hosts: HostPage<ModelEntry>[] }).hosts;
    assert.deepEqual(hosts.map((host) => [host.host, host.total, host.models!.map((model) => `${model.providerInstanceId}/${model.modelId}`)]), [
      ['mini', 2, ['synthetic-provider/synthetic-model', 'synthetic-provider/synthetic-large']],
      ['macbook', 1, ['synthetic-macbook/synthetic-small']],
    ]);
    assert.deepEqual(hosts[1]!.providers!.map((provider) => [provider.providerInstanceId, provider.modelCount, provider.canRunChildTask, provider.constraints]), [
      ['synthetic-macbook', 1, true, []],
      ['synthetic-empty', 0, false, ['Synthetic constraint: metadata only']],
    ]);
    const effort = hosts[0]!.models![0]!.options.find((option) => option.id === 'synthetic-effort')!;
    assert.deepEqual(effort.choices!.map((choice) => [choice.id, choice.isDefault]), [['low', false], ['medium', true], ['high', false]]);
    assert.equal(hosts[0]!.models![0]!.options.find((option) => option.id === 'synthetic-fast')?.type, 'boolean');
    // Text-only clients get every id and every choice.
    assert.match(models.text, /instanceId "synthetic-provider" model "synthetic-model" "Synthetic model": options synthetic-effort \(select: low, medium\*, high; currently medium\); synthetic-fast \(boolean, currently false\)/);
    assert.match(models.text, /instanceId "synthetic-macbook" model "synthetic-small"/);
    assert.match(models.text, /provider "synthetic-empty" \(synthetic, No models here\): 0 model\(s\), constraints: Synthetic constraint: metadata only/);
    assert.ok(countCalls(mini, 'orchestrator_capabilities') >= 1);
  });

  test('a host-restricted agent sees only its hosts; an explicit other host is unknown and never read', async (t) => {
    const { mini, macbook, gw } = await startFleet(t);
    const restricted = await connect(t, gw, 'read', ['mini']);
    const projects = await restricted.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects');
    assert.deepEqual(projects.hosts.map((host) => host.host), ['mini']);
    const macbookCalls = macbook.calls.length;
    for (const tool of ['fleet_projects', 'fleet_models']) {
      const refused = await restricted.callError(tool, { host: 'macbook', refresh: true });
      assert.equal(refused.code, 'not_found', tool);
      assert.equal(refused.text, 'not_found: No host "macbook". fleet_status lists the hosts you can use.');
      assert.equal((await restricted.callError(tool, { host: 'studio' })).text, 'not_found: No host "studio". fleet_status lists the hosts you can use.');
    }
    assert.equal(macbook.calls.length, macbookCalls, 'nothing reached the hidden host');
    const cursor = encodeCursor({ hostId: 'macbook', kind: 'projects', snapshot: snapshotId(), offset: 0 });
    assert.equal((await restricted.callError('fleet_projects', { host: 'macbook', cursor })).code, 'not_found');
    assert.equal(macbook.calls.length, macbookCalls);
    // A read-only agent browses but cannot launch.
    const models = await restricted.call<{ hosts: HostPage<ModelEntry>[] }>('fleet_models', { host: 'mini' });
    assert.equal(models.hosts[0]!.total, 2);
    const launch = await restricted.callError('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic', requestId: requestId() });
    assert.equal(launch.code, 'insufficient_scope');
    assert.equal(countCalls(mini, 't3_project_list'), 1, 'the refused launch read nothing');
    const nobody = gw.services.tokens.issueOperatorToken({ name: 'Synthetic gone', scopes: ['host:studio:read'], expiresAt: gw.clock() + 60 * MINUTE });
    const gone = await agentWithToken(t, gw.baseUrl, nobody.clientId, nobody.token);
    assert.deepEqual(await gone.call('fleet_projects'), { hosts: [] });
  });

  test('pages with cursors bound to one snapshot, caches for 30 seconds, refreshes on demand and reports oversized catalogs', async (t) => {
    const mini = await startFakeT3({ projectCount: 7 });
    t.after(() => mini.close());
    const { gw, agent } = await startFleet(t, { mini });
    const first = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini', limit: 3 });
    assert.deepEqual([first.hosts[0]!.total, first.hosts[0]!.projects!.length], [7, 3]);
    assert.equal(countCalls(mini, 't3_project_list'), 1);
    const cursor = first.hosts[0]!.nextCursor!;
    assert.deepEqual(decodeCursor(cursor), { hostId: 'mini', kind: 'projects', snapshot: decodeCursor(cursor)!.snapshot, offset: 3 });
    assert.match(decodeCursor(cursor)!.snapshot, /^[A-Za-z0-9_-]{16}$/, 'a random snapshot id, not a counter');
    assert.equal((await agent.callError('fleet_projects', { cursor })).text, 'invalid_argument: A cursor continues one host: pass host with it.');
    assert.equal((await agent.callError('fleet_projects', { host: 'mini', cursor, refresh: true })).code, 'invalid_argument');
    assert.equal((await agent.callError('fleet_models', { host: 'mini', cursor })).code, 'invalid_argument', 'a cursor from another tool');
    assert.equal((await agent.callError('fleet_projects', { host: 'macbook', cursor })).code, 'invalid_argument', 'a cursor from another host');
    assert.equal((await agent.callError('fleet_projects', { host: 'mini', cursor: 'not-a-cursor' })).code, 'invalid_argument');
    const second = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini', cursor, limit: 3 });
    const third = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini', cursor: second.hosts[0]!.nextCursor!, limit: 3 });
    const ids = [...first.hosts[0]!.projects!, ...second.hosts[0]!.projects!, ...third.hosts[0]!.projects!].map((project) => project.projectId);
    assert.deepEqual(ids, mini.projects.map((project) => project.id), 'every project exactly once');
    assert.equal(third.hosts[0]!.nextCursor, null);
    assert.equal(countCalls(mini, 't3_project_list'), 1, 'pages come from the snapshot');

    // Within the TTL the snapshot answers; after it, or on refresh, T3 is read again and old cursors are refused.
    gw.clock.advance(CATALOG_TTL_MS - SECOND);
    await agent.call('fleet_projects', { host: 'mini' });
    assert.equal(countCalls(mini, 't3_project_list'), 1);
    mini.projects.push({ id: 'project-8', title: 'Synthetic project 8', deletedAt: null, defaultModelSelection: null });
    await agent.call('fleet_projects', { host: 'mini', refresh: true });
    assert.equal(countCalls(mini, 't3_project_list'), 2);
    const stale = await agent.callError('fleet_projects', { host: 'mini', cursor });
    assert.match(stale.text, /has been replaced or expired\. Start again without cursor/);
    gw.clock.advance(CATALOG_TTL_MS);
    const again = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini', limit: 100 });
    assert.equal(countCalls(mini, 't3_project_list'), 3, 'expired: read again');
    assert.equal(again.hosts[0]!.total, 8);
    assert.deepEqual(again.hosts[0]!.projects!.at(-1)!.launch, {
      allowed: true, source: 'discovered', alias: null, aliases: [], runtimeMode: 'auto', workspaceMode: 'worktree', baseRef: 'main', branchPrefix: 'fleet/', defaultModelSource: null,
    });
    assert.match(again.hosts[0]!.projects!.at(-1)!.guidance, /No default model: pass modelSelection/);

    // Concurrent callers share one in-flight read; a failure is not a successful stale answer.
    gw.clock.advance(CATALOG_TTL_MS);
    mini.toolDelays.set('t3_project_list', 50);
    const [a, b] = await Promise.all([agent.call('fleet_projects', { host: 'mini' }), agent.call('fleet_projects', { host: 'mini' })]);
    assert.deepEqual(a, b);
    assert.equal(countCalls(mini, 't3_project_list'), 4, 'one read for two concurrent callers');
    mini.toolDelays.delete('t3_project_list');
    gw.clock.advance(CATALOG_TTL_MS);
    mini.failures.set('t3_project_list', { code: 'internal', message: 'Synthetic failure' });
    const failed = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini' });
    assert.deepEqual([failed.hosts[0]!.available, failed.hosts[0]!.error?.code, failed.hosts[0]!.projects], [false, 't3_tool_failed', []]);
    mini.failures.delete('t3_project_list');

    // Catalogs beyond the bounds are unavailable as a whole, never cut.
    mini.projectListStuckCursor = 0;
    const stuck = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini', refresh: true });
    assert.equal(stuck.hosts[0]!.error?.code, 't3_invalid_response');
    mini.projectListStuckCursor = null;
    mini.providers = Array.from({ length: MAX_PROVIDERS + 1 }, (_, index) => ({ ...syntheticProviders()[0]!, providerInstanceId: `synthetic-${index}` }));
    const tooMany = await agent.call<{ hosts: HostPage<ModelEntry>[] }>('fleet_models', { host: 'mini', refresh: true });
    assert.deepEqual([tooMany.hosts[0]!.available, tooMany.hosts[0]!.error?.code, tooMany.hosts[0]!.models, tooMany.hosts[0]!.providers], [false, 'catalog_limit', [], []]);
    mini.providers = [{ ...syntheticProviders()[0]!, models: Array.from({ length: MAX_MODELS + 1 }, (_, index) => ({ id: `synthetic-${index}`, label: null })) }];
    assert.equal((await agent.call<{ hosts: HostPage<ModelEntry>[] }>('fleet_models', { host: 'mini', refresh: true })).hosts[0]!.error?.code, 'catalog_limit');
    mini.providers = syntheticProviders();
    const paged = await agent.call<{ hosts: HostPage<ModelEntry>[] }>('fleet_models', { host: 'mini', refresh: true, limit: 1 });
    assert.deepEqual([paged.hosts[0]!.total, paged.hosts[0]!.models!.length, paged.hosts[0]!.providers!.length], [2, 1, 1]);
    const rest = await agent.call<{ hosts: HostPage<ModelEntry>[] }>('fleet_models', { host: 'mini', cursor: paged.hosts[0]!.nextCursor! });
    assert.deepEqual([rest.hosts[0]!.models!.map((model) => model.modelId), rest.hosts[0]!.nextCursor], [['synthetic-large'], null]);
  });

  test('catalog content never reaches the logs', async (t) => {
    const { mini, gw, agent } = await startFleet(t);
    mini.projects[1]!.title = 'PRIVATE_PROJECT_TITLE_SYNTHETIC';
    mini.providers[0]!.models[0]!.options![0]!.options![0]!.label = 'PRIVATE_CHOICE_LABEL_SYNTHETIC';
    mini.providers[0]!.constraints = ['PRIVATE_CONSTRAINT_SYNTHETIC'];
    await agent.call('fleet_projects', { refresh: true });
    await agent.call('fleet_models', { refresh: true });
    const refused = await agent.callError('work_start', {
      target: { host: 'mini', projectId: 'project-2' }, task: 'PRIVATE_TASK_SYNTHETIC', requestId: requestId(),
      modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'PRIVATE_BAD_VALUE' } },
    });
    assert.equal(refused.code, 'invalid_argument');
    assertNotLogged(gw, ['PRIVATE_PROJECT_TITLE_SYNTHETIC', 'PRIVATE_CHOICE_LABEL_SYNTHETIC', 'PRIVATE_CONSTRAINT_SYNTHETIC', 'PRIVATE_TASK_SYNTHETIC', 'PRIVATE_BAD_VALUE', 'synthetic-effort']);
  });
});

describe('discovery: work_start with a target or a model selection', () => {
  test('a direct target launches with the discovery policy and records its launch spec; selected options reach T3 unchanged', async (t) => {
    const { mini, gw, agent, tick } = await startFleet(t);
    const selection = { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-fast': false, 'synthetic-effort': 'high' } };
    const result = await agent.call<{ job: StartedJob; created: boolean }>('work_start', {
      target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic discovered task', requestId: 'direct-1', modelSelection: selection,
    });
    const { job } = result;
    assert.equal(result.created, true);
    assert.deepEqual(
      [job.state, job.project, job.host, job.projectId, job.projectName, job.source, job.branch],
      ['queued', '@mini/project-2', 'mini', 'project-2', 'Synthetic project 2', 'discovered', `fleet/${job.jobId}`],
    );
    assert.deepEqual(job.model, { source: 'explicit', selection: { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'high', 'synthetic-fast': false } } });
    const stored = gw.services.jobs.store.require(job.jobId);
    assert.deepEqual(stored.launchSpec, {
      v: 1, projectId: 'project-2', projectName: 'Synthetic project 2', source: 'discovered', alias: null, baseRef: 'main', runtimeMode: 'auto',
      model: { source: 'explicit', selection: { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'high', 'synthetic-fast': false } } },
    });
    assert.equal(stored.t3ProjectId, 'project-2', 'the project id is recorded before dispatch');
    const reads = countCalls(mini, 'orchestrator_capabilities');
    await tick();
    assert.equal(countCalls(mini, 'orchestrator_capabilities'), reads + 1, 'the selection is checked again right before the launch');
    assert.deepEqual(mini.launches[0], {
      projectId: 'project-2',
      title: job.title,
      workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: job.branch, startFromOrigin: false },
      runtimeMode: 'auto',
      modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'high', 'synthetic-fast': false } },
      message: `Synthetic discovered task\n\n---\nStarted through t3-fleet-gateway as job ${job.jobId}, in a fresh worktree on branch ${job.branch}.`,
    });
    assert.equal(await jobState(agent, job.jobId), 'running');
    // Job views, lists and the feed carry the target.
    const listed = await agent.call<{ jobs: StartedJob[] }>('work_list', { target: { host: 'mini', projectId: 'project-2' } });
    assert.deepEqual(listed.jobs.map((item) => item.jobId), [job.jobId]);
    assert.deepEqual((await agent.call<{ jobs: StartedJob[] }>('work_list', { target: { host: 'macbook', projectId: 'project-2' } })).jobs, []);
    assert.deepEqual((await agent.call<{ jobs: StartedJob[] }>('work_list', { project: '@mini/project-2' })).jobs.map((item) => item.jobId), [job.jobId]);
    const feed = await agent.call<{ events: { jobId: string; type: string; project: string; host: string; projectId: string | null }[] }>('work_feed');
    assert.deepEqual(feed.events.filter((event) => event.type === 'created').map((event) => [event.jobId, event.project, event.host, event.projectId]),
      [[job.jobId, '@mini/project-2', 'mini', 'project-2']]);
    // Replays with the options in another order; a changed selection or target under the same id conflicts.
    const replay = await agent.call<{ job: StartedJob; created: boolean }>('work_start', {
      target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic discovered task', requestId: 'direct-1',
      modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'high', 'synthetic-fast': false } },
    });
    assert.deepEqual([replay.created, replay.job.jobId], [false, job.jobId]);
    for (const changed of [
      { modelSelection: { ...selection, options: { ...selection.options, 'synthetic-effort': 'low' } } },
      { modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-large' } },
      { target: { host: 'mini', projectId: 'project-3' } },
      { modelSelection: undefined },
    ]) {
      const conflict = await agent.callError('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic discovered task', requestId: 'direct-1', modelSelection: selection, ...changed });
      assert.equal(conflict.code, 'request_id_conflict', JSON.stringify(changed));
    }
    assert.equal(mini.launches.length, 1);
  });

  test('omitting the selection keeps the whole default: project, then host, then T3, with no merge across levels', async (t) => {
    const mini = await startFakeT3();
    const macbook = await startFakeT3();
    t.after(() => mini.close());
    t.after(() => macbook.close());
    const { gw, agent, tick } = await startFleet(t, {
      mini,
      macbook,
      hosts: [
        { id: 'mini', t3Url: mini.url, mintPairingCode: mini.mintCommand(), maxConcurrentJobs: 4, discovery: { enabled: true, allowWorkStart: true, runtimeMode: 'auto' }, defaultModelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-large' } },
        { id: 'macbook', t3Url: macbook.url, mintPairingCode: macbook.mintCommand() },
      ],
      projects: [
        { alias: 'alpha', host: 'mini', t3ProjectId: 'project-1', runtimeMode: 'auto', modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'low' } } },
        { alias: 'gamma', host: 'mini', t3ProjectId: 'project-3', runtimeMode: 'auto' },
      ],
    });
    mini.projects[1]!.defaultModelSelection = null;
    const alias = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'mini', projectId: 'project-1' }, task: 'Synthetic', requestId: requestId() });
    const host = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic', requestId: requestId() });
    const discovered = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic', requestId: requestId() });
    assert.deepEqual([alias.job.model, host.job.model, discovered.job.model], [
      { source: 'project', selection: { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'low' } } },
      { source: 'host', selection: { instanceId: 'synthetic-provider', model: 'synthetic-large' } },
      { source: 'host', selection: { instanceId: 'synthetic-provider', model: 'synthetic-large' } },
    ]);
    assert.deepEqual([alias.job.project, alias.job.source, host.job.project, discovered.job.project], ['alpha', 'alias', 'gamma', '@mini/project-2']);
    await tick();
    assert.deepEqual(mini.launches.map((launch) => launch.modelSelection), [
      { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'low' } },
      { instanceId: 'synthetic-provider', model: 'synthetic-large' },
      { instanceId: 'synthetic-provider', model: 'synthetic-large' },
    ]);
    // An explicit selection replaces the whole configured object: no options are carried over from the project config.
    const explicit = await agent.call<{ job: StartedJob }>('work_start', {
      project: 'alpha', task: 'Synthetic', requestId: requestId(), modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-large' },
    });
    assert.deepEqual(explicit.job.model, { source: 'explicit', selection: { instanceId: 'synthetic-provider', model: 'synthetic-large' } });
    assert.equal(explicit.job.branch, `fleet/${explicit.job.jobId}`);
    await tick();
    assert.deepEqual(mini.launches.at(-1)?.modelSelection, { instanceId: 'synthetic-provider', model: 'synthetic-large' });
    assert.equal(gw.services.jobs.store.require(explicit.job.jobId).launchSpec?.source, 'alias');
  });

  test('a project without any model is refused before a job exists; invalid selections start nothing', async (t) => {
    const { mini, gw, agent } = await startFleet(t);
    mini.projects[1]!.defaultModelSelection = null;
    const none = await agent.callError('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic', requestId: requestId() });
    assert.equal(none.code, 'invalid_argument');
    assert.match(none.text, /has no default model and the host sets no defaultModelSelection: pass modelSelection/);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ instanceId: 'synthetic-other', model: 'synthetic-model' }, /does not advertise model "synthetic-model" on provider instance "synthetic-other".*Available \(instanceId\/model\): synthetic-provider\/synthetic-model, synthetic-provider\/synthetic-large/],
      [{ instanceId: 'synthetic-provider', model: 'synthetic-missing' }, /does not advertise model "synthetic-missing"/],
      [{ instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'extreme' } }, /Option "synthetic-effort" of model synthetic-model on synthetic-provider \(host mini\) takes one of "low", "medium", "high", not "extreme"/],
      [{ instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-fast': 'yes' } }, /Option "synthetic-fast" .* is a boolean; pass true or false, not "yes"/],
      [{ instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-unknown': true } }, /Option "synthetic-unknown" is not a selectable option .*; its options: synthetic-effort \(one of low, medium, high\); synthetic-fast \(boolean\)/],
      [{ instanceId: 'synthetic-provider', model: 'synthetic-large', options: { 'synthetic-effort': 'low' } }, /it advertises no selectable options/],
    ];
    for (const [modelSelection, pattern] of cases) {
      const refused = await agent.callError('work_start', { target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic', requestId: requestId(), modelSelection });
      assert.equal(refused.code, 'invalid_argument', JSON.stringify(modelSelection));
      assert.match(refused.text, pattern);
    }
    // Options T3 advertises with a type this build does not know are listed but never selectable.
    const future_option: FakeOption = { id: 'synthetic-future', label: 'Future', type: 'slider' };
    mini.providers[0]!.models[0]!.options!.push(future_option);
    const future = await agent.callError('work_start', {
      target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic', requestId: requestId(),
      modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-future': 'x' } },
    });
    assert.match(future.text, /"synthetic-future" is not a selectable option/);
    const listed = await toolText(agent, 'fleet_models', { host: 'mini', refresh: true });
    assert.match(listed.text, /synthetic-future \(slider, not selectable\)/);
    assert.equal(gw.services.jobs.store.list({ limit: 10 }).length, 0, 'no job was created');
    assert.equal(mini.launches.length, 0);
    // Oversized or malformed selections are refused by the schema.
    const big = await agent.callError('work_start', {
      target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic', requestId: requestId(),
      modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model', options: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`o${index}`, true])) },
    });
    assert.match(big.text, /at most 32 options/);
    assert.match((await agent.callError('work_start', { project: 'alpha', target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic', requestId: requestId() })).text, /exactly one of project/);
    assert.match((await agent.callError('work_start', { task: 'Synthetic', requestId: requestId() })).text, /exactly one of project/);
  });

  test('targeting by id never gets around a configured project: its alias policy applies, and ambiguity requires the alias', async (t) => {
    const mini = await startFakeT3();
    t.after(() => mini.close());
    const coordinator = mini.launchDirect({ projectId: 'project-1', title: 'Synthetic coordinator', message: 'Synthetic' }).threadId;
    mini.finishTurn(coordinator, 'Synthetic ready');
    mini.projects.push({ id: 'project-4', title: 'Synthetic project 2', deletedAt: null, defaultModelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model' } });
    const { gw, agent, tick } = await startFleet(t, {
      mini,
      projects: [
        { alias: 'alpha', host: 'mini', t3ProjectId: 'project-1', runtimeMode: 'auto', allowWorkStart: false },
        { alias: 'twin-a', host: 'mini', t3ProjectId: 'project-3', runtimeMode: 'approval-required', baseRef: 'release', branchPrefix: 'twin/' },
        { alias: 'twin-b', host: 'mini', t3ProjectId: 'project-3', runtimeMode: 'auto' },
        { alias: 'by-title', host: 'mini', t3ProjectTitle: 'Synthetic project 2', runtimeMode: 'auto' },
        { alias: 'beta', host: 'macbook', t3ProjectId: 'project-1', runtimeMode: 'auto' },
      ],
    });
    const standing = (await gw.services.jobs.adopt({ project: 'alpha', threadId: coordinator, title: 'Synthetic CoS' })).job;
    const projects = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini' });
    const byId = Object.fromEntries(projects.hosts[0]!.projects!.map((project) => [project.projectId, project]));
    assert.deepEqual([byId['project-1']!.launch.allowed, byId['project-1']!.launch.alias], [false, 'alpha']);
    assert.match(byId['project-1']!.guidance, /Configured as project "alpha", which does not accept work_start: send work to its standing jobs with work_continue/);
    assert.deepEqual([byId['project-3']!.launch.source, byId['project-3']!.launch.aliases, byId['project-3']!.launch.allowed], ['ambiguous', ['twin-a', 'twin-b'], false]);
    assert.deepEqual([byId['project-2']!.launch.source, byId['project-2']!.launch.aliases], ['ambiguous', ['by-title']]);
    assert.deepEqual([byId['project-4']!.launch.source, byId['project-4']!.launch.aliases], ['ambiguous', ['by-title']]);

    const bypass = await agent.callError('work_start', { target: { host: 'mini', projectId: 'project-1' }, task: 'Synthetic', requestId: requestId() });
    assert.equal(bypass.code, 'start_disabled');
    assert.match(bypass.text, new RegExp(`Project "alpha" does not accept work_start.*${standing.id}`));
    const twins = await agent.callError('work_start', { target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic', requestId: requestId() });
    assert.equal(twins.code, 'invalid_argument');
    assert.match(twins.text, /configured under aliases twin-a, twin-b\. Start it with project set to the alias you mean, not with target/);
    const titled = await agent.callError('work_start', { target: { host: 'mini', projectId: 'project-4' }, task: 'Synthetic', requestId: requestId() });
    assert.match(titled.text, /configured under alias by-title, whose title matches several T3 projects/);
    assert.equal(gw.services.jobs.store.list({ limit: 10 }).filter((job) => !job.standing).length, 0, 'nothing was started');

    // The alias form with a selection uses that alias's policy exactly.
    const twin = await agent.call<{ job: StartedJob }>('work_start', {
      project: 'twin-a', task: 'Synthetic twin task', requestId: requestId(), modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-large' },
    });
    assert.deepEqual([twin.job.project, twin.job.source, twin.job.projectId, twin.job.branch], ['twin-a', 'alias', 'project-3', `twin/${twin.job.jobId}`]);
    await tick();
    assert.deepEqual(mini.launches.at(-1)?.workspaceStrategy, { type: 'worktree', baseRef: 'release', branch: twin.job.branch, startFromOrigin: false });
    assert.equal(mini.launches.at(-1)?.runtimeMode, 'approval-required');
    const disabledAlias = await agent.callError('work_start', {
      project: 'alpha', task: 'Synthetic', requestId: requestId(), modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-large' },
    });
    assert.equal(disabledAlias.code, 'start_disabled');
    const unknown = await agent.callError('work_start', { target: { host: 'mini', projectId: 'project-99' }, task: 'Synthetic', requestId: requestId() });
    assert.equal(unknown.text, 'not_found: Host mini has no T3 project "project-99". fleet_projects lists them.');
  });

  test('a browse-only host refuses launches into unconfigured projects but still launches its aliases with a selection', async (t) => {
    const { macbook, agent, tick } = await startFleet(t);
    const refused = await agent.callError('work_start', { target: { host: 'macbook', projectId: 'project-2' }, task: 'Synthetic', requestId: requestId() });
    assert.equal(refused.code, 'start_disabled');
    assert.match(refused.text, /Host macbook does not accept work_start into T3 projects without a configured alias \(discovery\.allowWorkStart is false\)\. Projects that accept work there: beta/);
    const viaAlias = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'macbook', projectId: 'project-1' }, task: 'Synthetic', requestId: requestId() });
    assert.deepEqual([viaAlias.job.project, viaAlias.job.source], ['beta', 'alias']);
    const selected = await agent.call<{ job: StartedJob }>('work_start', {
      project: 'beta', task: 'Synthetic', requestId: requestId(), modelSelection: { instanceId: 'synthetic-macbook', model: 'synthetic-small' },
    });
    assert.deepEqual(selected.job.model, { source: 'explicit', selection: { instanceId: 'synthetic-macbook', model: 'synthetic-small' } });
    const wrongHost = await agent.callError('work_start', {
      project: 'beta', task: 'Synthetic', requestId: requestId(), modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model' },
    });
    assert.match(wrongHost.text, /Host macbook does not advertise model "synthetic-model" on provider instance "synthetic-provider"/);
    await tick();
    assert.equal(macbook.launches.length, 2);
  });

  test('replays are checked before any catalog read, across hosts and agents', async (t) => {
    const { mini, macbook, gw, agent } = await startFleet(t);
    const first = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic replay', requestId: 'replay-1' });
    const miniCalls = mini.calls.length;
    const same = await agent.call<{ job: StartedJob; created: boolean }>('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic replay', requestId: 'replay-1' });
    assert.deepEqual([same.created, same.job.jobId], [false, first.job.jobId]);
    assert.equal(mini.calls.length, miniCalls, 'a replay reads nothing');
    const crossHost = await agent.callError('work_start', { target: { host: 'macbook', projectId: 'project-1' }, task: 'Synthetic replay', requestId: 'replay-1' });
    assert.equal(crossHost.code, 'request_id_conflict');
    assert.equal(macbook.calls.filter((call) => call === 't3_project_list').length, 0);
    // Another agent restricted to the MacBook cannot replay this agent's request id onto the mini.
    const other = await connect(t, gw, 'operate', ['macbook']);
    const foreign = await other.callError('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic replay', requestId: 'replay-1' });
    assert.equal(foreign.code, 'not_found');
    // Two concurrent starts with one request id create one job.
    const input = { target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic concurrent', requestId: 'concurrent-1' };
    const results = await Promise.all([agent.client.callTool({ name: 'work_start', arguments: input }), agent.client.callTool({ name: 'work_start', arguments: input })]);
    const created = results.map((result) => (result.structuredContent as { created?: boolean; job?: StartedJob } | undefined));
    const jobIds = new Set(created.map((result) => result?.job?.jobId).filter((id) => id !== undefined));
    assert.equal(jobIds.size, 1, `one job for two concurrent starts: ${JSON.stringify(results.map((result) => result.content))}`);
    assert.equal(gw.services.jobs.store.list({ limit: 10, target: { hostId: 'mini', projectId: 'project-3' } }).length, 1);
  });

  test('queued targeted jobs survive a restart without an alias, are cancelled while queued, and fail before launch when their model is gone', async (t) => {
    const mini = await startFakeT3();
    const macbook = await startFakeT3();
    t.after(() => mini.close());
    t.after(() => macbook.close());
    const { gw, agent } = await startFleet(t, { mini, macbook, hosts: HOSTS(mini, macbook, { mini: { maxConcurrentJobs: 1 } }) });
    const selection = { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'high' } };
    const first = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic first', requestId: 'r1', modelSelection: selection });
    const second = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic second', requestId: 'r2', modelSelection: selection });
    const third = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic third', requestId: 'r3' });
    await gw.gateway.engine.tick();
    assert.deepEqual([await jobState(agent, first.job.jobId), await jobState(agent, second.job.jobId), await jobState(agent, third.job.jobId)], ['running', 'queued', 'queued']);

    // Restart: the stored spec is enough; the engine needs no alias and no config entry for @mini/project-2.
    await gw.gateway.close();
    gw.door.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const restarted = await startTestGateway(t, {
      config: { hosts: HOSTS(mini, macbook, { mini: { maxConcurrentJobs: 2 } }), projects: PROJECTS },
      dataDir: gw.dataDir, door: gw.door, clock: gw.clock, jobEngine: { autoStart: false },
    });
    const again = await connect(t, restarted, 'operate');
    const cancelled = await again.call<{ outcome: string; job: StartedJob }>('work_cancel', { jobId: third.job.jobId });
    assert.deepEqual([cancelled.outcome, cancelled.job.state], ['cancelled', 'cancelled']);
    // The host no longer advertises the selected option value: the second job fails before any launch.
    mini.providers[0]!.models[0]!.options![0]!.options = [{ id: 'low', label: 'Low' }];
    await restarted.gateway.engine.tick();
    const failed = await again.call<{ state: string; lastError: { code: string; message: string } | null; recentEvents: { reason: string | null; code: string | null; toState: string | null }[] }>(
      'work_status', { jobId: second.job.jobId },
    );
    assert.equal(failed.state, 'failed');
    assert.equal(failed.lastError?.code, 'model_selection_invalid');
    assert.match(failed.lastError?.message ?? '', /no longer available on host mini: Option "synthetic-effort"/);
    assert.deepEqual([failed.recentEvents.at(-1)?.reason, failed.recentEvents.at(-1)?.code, failed.recentEvents.at(-1)?.toState], ['model_selection_invalid', 'model_selection_invalid', 'failed']);
    assert.equal(mini.launches.length, 1, 'nothing else was launched');
    assertNotLogged(restarted, ['synthetic-effort', 'Synthetic second']);

    // A host that cannot answer leaves a queued job queued; it launches once the host is back.
    const fourth = await again.call<{ job: StartedJob }>('work_start', {
      target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic fourth', requestId: 'r4', modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-large' },
    });
    await mini.stop();
    await restarted.gateway.engine.tick();
    assert.equal(await jobState(again, fourth.job.jobId), 'queued');
    await mini.start();
    restarted.clock.advance(5 * MINUTE);
    await restarted.gateway.engine.tick();
    assert.equal(await jobState(again, fourth.job.jobId), 'running');
    assert.deepEqual(mini.launches.at(-1)?.modelSelection, { instanceId: 'synthetic-provider', model: 'synthetic-large' });
  });

  test('a lost launch response of a targeted job is reconciled from its recorded project, never relaunched', async (t) => {
    const { mini, gw, agent, tick } = await startFleet(t);
    mini.dropResponseOnce.add('t3_thread_launch');
    const { job } = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic lost launch', requestId: requestId() });
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'unknown');
    assert.equal(mini.launches.length, 1);
    gw.clock.advance(MINUTE);
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'running');
    assert.equal(mini.launches.length, 1, 'never relaunched');
    assert.equal(mini.threadForJob(job.jobId).projectId, 'project-2');
  });

  test('T3 refusing a discovered launch for want of a model tells the agent to pass modelSelection', async (t) => {
    const { mini, agent, tick } = await startFleet(t);
    const { job } = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic', requestId: requestId() });
    mini.projects[1]!.defaultModelSelection = null;
    await tick();
    const status = await agent.call<{ state: string; lastError: { code: string; message: string } | null }>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'failed');
    assert.equal(status.lastError?.code, 'invalid_request');
    assert.match(status.lastError?.message ?? '', /pass modelSelection to work_start \(fleet_models lists the choices\), or the operator sets defaultModelSelection for host "mini"/);
  });
});

describe('discovery: review fixes', () => {
  test('a direct target is classified from a fresh project read, so a title renamed after browsing cannot turn a coordinator into a discovered launch', async (t) => {
    const mini = await startFakeT3();
    const macbook = await startFakeT3();
    t.after(() => mini.close());
    t.after(() => macbook.close());
    const coordinator = mini.launchDirect({ projectId: 'project-1', title: 'Synthetic coordinator', message: 'Synthetic' }).threadId;
    mini.finishTurn(coordinator, 'Synthetic ready');
    const launchesBefore = mini.launches.length;
    const { gw, agent, tick } = await startFleet(t, {
      mini,
      macbook,
      hosts: HOSTS(mini, macbook, { mini: { maxConcurrentJobs: 1 } }),
      projects: [{ alias: 'cos', host: 'mini', t3ProjectTitle: 'Synthetic coordinator project', runtimeMode: 'auto', allowWorkStart: false }],
    });
    mini.projects[0]!.title = 'Synthetic coordinator project';
    const standing = (await gw.services.jobs.adopt({ project: 'cos', threadId: coordinator, title: 'Synthetic CoS' })).job;
    // Warm the browse cache: project-2 is a plain discovered project right now.
    const browsed = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini' });
    assert.deepEqual(browsed.hosts[0]!.projects!.map((project) => [project.projectId, project.launch.source, project.launch.allowed]), [
      ['project-1', 'alias', false], ['project-2', 'discovered', true], ['project-3', 'discovered', true],
    ]);
    const reads = countCalls(mini, 't3_project_list');
    // The operator renames projects in T3 within the cache TTL: the configured title now uniquely names project-2.
    mini.projects[0]!.title = 'Synthetic project 1';
    mini.projects[1]!.title = 'Synthetic coordinator project';
    const refused = await agent.callError('work_start', { target: { host: 'mini', projectId: 'project-2' }, task: 'Synthetic', requestId: requestId() });
    assert.equal(refused.code, 'start_disabled');
    assert.match(refused.text, new RegExp(`Project "cos" does not accept work_start.*${standing.id}`));
    assert.equal(countCalls(mini, 't3_project_list'), reads + 1, 'work_start read the host, not the browse cache');
    assert.equal(gw.services.jobs.store.list({ limit: 10 }).filter((job) => !job.standing).length, 0, 'no job was created');
    assert.equal(mini.launches.length, launchesBefore);
    // A browse within the TTL still answers from the cache: only launches insist on a fresh read.
    await agent.call('fleet_projects', { host: 'mini' });
    assert.equal(countCalls(mini, 't3_project_list'), reads + 1);
    // A host that cannot answer fails the request closed: nothing is resolved from the snapshot held before.
    mini.failures.set('t3_project_list', { code: 'internal', message: 'Synthetic failure' });
    const unreadable = await agent.callError('work_start', { target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic', requestId: requestId() });
    assert.notEqual(unreadable.code, 'start_disabled');
    assert.equal(gw.services.jobs.store.list({ limit: 10 }).filter((job) => !job.standing).length, 0, 'no job was created from the stale snapshot');
    mini.failures.delete('t3_project_list');

    // Right before the launch the policy is checked again: a queued targeted job whose project was renamed into a
    // configured title by then fails instead of launching under the discovery policy.
    const first = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic first', requestId: requestId() });
    const queued = await agent.call<{ job: StartedJob }>('work_start', { target: { host: 'mini', projectId: 'project-1' }, task: 'Synthetic queued', requestId: requestId() });
    await tick();
    assert.deepEqual([await jobState(agent, first.job.jobId), await jobState(agent, queued.job.jobId)], ['running', 'queued']);
    mini.projects[1]!.title = 'Synthetic project 2';
    mini.projects[0]!.title = 'Synthetic coordinator project';
    await agent.call('work_cancel', { jobId: first.job.jobId });
    await tick();
    const failed = await agent.call<{ state: string; lastError: { code: string; message: string } | null }>('work_status', { jobId: queued.job.jobId });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.lastError?.code, 'launch_policy_changed');
    assert.match(failed.lastError?.message ?? '', /T3 project project-1 on host mini is now configured under alias cos/);
    assert.equal(mini.launches.length, launchesBefore + 1, 'the renamed project was never launched into');
    assertNotLogged(gw, ['Synthetic coordinator project', 'Synthetic queued']);
  });

  test('a page cursor names its snapshot, so a cursor from before a restart is refused even when the new process has read once', async (t) => {
    const mini = await startFakeT3({ projectCount: 5 });
    const macbook = await startFakeT3();
    t.after(() => mini.close());
    t.after(() => macbook.close());
    const { gw, agent } = await startFleet(t, { mini, macbook });
    const first = await agent.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini', limit: 2 });
    const cursor = first.hosts[0]!.nextCursor!;
    await gw.gateway.close();
    gw.door.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const restarted = await startTestGateway(t, {
      config: { hosts: HOSTS(mini, macbook), projects: PROJECTS },
      dataDir: gw.dataDir, door: gw.door, clock: gw.clock, jobEngine: { autoStart: false },
    });
    const again = await connect(t, restarted, 'operate');
    assert.match((await again.callError('fleet_projects', { host: 'mini', cursor })).text, /has been replaced or expired\. Start again without cursor/);
    // The new process's first read would have been "generation 1" again under a counter; the old cursor must still not page it.
    mini.projects.splice(1, 1);
    const fresh = await again.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini', limit: 2 });
    assert.notEqual(decodeCursor(fresh.hosts[0]!.nextCursor!)!.snapshot, decodeCursor(cursor)!.snapshot);
    assert.match((await again.callError('fleet_projects', { host: 'mini', cursor })).text, /has been replaced or expired\. Start again without cursor/);
    const rest = await again.call<{ hosts: HostPage<ProjectEntry>[] }>('fleet_projects', { host: 'mini', cursor: fresh.hosts[0]!.nextCursor!, limit: 10 });
    assert.deepEqual([...fresh.hosts[0]!.projects!, ...rest.hosts[0]!.projects!].map((project) => project.projectId), ['project-1', 'project-3', 'project-4', 'project-5'], 'no duplicate, no mix of two reads');
    // A guessed cursor with a well-formed id is refused too.
    const guessed = encodeCursor({ hostId: 'mini', kind: 'projects', snapshot: snapshotId(), offset: 0 });
    assert.equal((await again.callError('fleet_projects', { host: 'mini', cursor: guessed })).code, 'invalid_argument');
  });

  test('a selection or target with a field the gateway does not know is refused by the public schema, and no job exists', async (t) => {
    const { mini, gw, agent, tick } = await startFleet(t);
    const misplaced = await agent.callError('work_start', {
      target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic', requestId: requestId(),
      modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model', reasoningEffort: 'high' },
    });
    assert.match(misplaced.text, /reasoningEffort/);
    const extraTarget = await agent.callError('work_start', {
      target: { host: 'mini', projectId: 'project-3', branch: 'synthetic' }, task: 'Synthetic', requestId: requestId(),
    });
    assert.match(extraTarget.text, /branch/);
    assert.equal(gw.services.jobs.store.list({ limit: 10 }).length, 0, 'no job was created');
    assert.equal(mini.launches.length, 0);
    // The same option in its place is accepted and reaches T3.
    const placed = await agent.call<{ job: StartedJob }>('work_start', {
      target: { host: 'mini', projectId: 'project-3' }, task: 'Synthetic', requestId: requestId(),
      modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'high' } },
    });
    await tick();
    assert.deepEqual(mini.launches.at(-1)?.modelSelection, { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'high' } });
    assert.deepEqual(placed.job.model, { source: 'explicit', selection: { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'high' } } });
  });
});
