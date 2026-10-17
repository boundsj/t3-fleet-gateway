import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { newJobId } from '../src/jobs/ids.ts';
import { HOUR, MINUTE } from '../src/time.ts';
import { startFakeT3, type FakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway, type TestGateway } from './helpers/gateway.ts';
import { agentWithToken, assertNotLogged, type Agent } from './helpers/jobs.ts';
import { startOAuthHarness, type OAuthHarness } from './helpers/oauthHarness.ts';
import {
  approveAsShown,
  authorizationResponse,
  authorizeUrl,
  CALLBACK,
  checkedFields,
  loadApprovalPage,
  machineFields,
  pkcePair,
  registerClient,
  signIn,
  standardAuthorizeParams,
  submitApproval,
  tokenRequest,
  type IssuedTokens,
} from './helpers/oauthFlow.ts';
import { tempDir } from './helpers/tmp.ts';

const count = (h: OAuthHarness, sql: string): number => (h.db.prepare(sql).get() as { n: number }).n;

async function openPage(h: OAuthHarness, scope?: string) {
  const clientId = await registerClient(h.baseUrl);
  const { verifier, challenge } = pkcePair();
  const page = await loadApprovalPage(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, challenge, { scope })));
  return { clientId, verifier, page };
}

async function exchange(h: OAuthHarness, clientId: string, verifier: string, approval: Response): Promise<IssuedTokens> {
  const code = (await authorizationResponse(approval)).searchParams.get('code') ?? '';
  const response = await tokenRequest(h.baseUrl, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: verifier });
  assert.equal(response.status, 200);
  return (await response.json()) as IssuedTokens;
}

function refresh(h: OAuthHarness, clientId: string, refreshToken: string, scope?: string): Promise<Response> {
  return tokenRequest(h.baseUrl, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, ...(scope === undefined ? {} : { scope }) });
}

async function refreshed(h: OAuthHarness, clientId: string, refreshToken: string, scope?: string): Promise<IssuedTokens> {
  const response = await refresh(h, clientId, refreshToken, scope);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as IssuedTokens;
}

describe('host grants: approval page', () => {
  test('offers All machines or Selected machines with escaped labels and ids; fleet requests default to All', async (t) => {
    const h = await startOAuthHarness(t, undefined, [{ id: 'mini', label: 'Mini <b>"one"</b>' }, { id: 'macbook' }]);
    const { page } = await openPage(h, 'fleet:read fleet:operate');
    assert.equal(page.status, 200);
    assert.match(page.html, /<input type="radio" name="hosts_mode" value="all" checked> All machines: every host on this gateway, including hosts added later/);
    assert.match(page.html, /<input type="radio" name="hosts_mode" value="selected"> Selected machines only/);
    assert.match(page.html, /<input type="checkbox" name="host" value="mini"> Mini &lt;b&gt;&quot;one&quot;&lt;\/b&gt; <code>mini<\/code>/);
    assert.match(page.html, /<input type="checkbox" name="host" value="macbook"> <code>macbook<\/code>/);
    assert.match(page.html, /name="access" value="operate" checked>/);
    assert.equal(page.html.includes('<b>'), false);
    assert.equal(/<script/i.test(page.html), false);
    assert.match(page.headers.get('content-security-policy') ?? '', /^default-src 'none'; style-src 'sha256-[^']+'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'$/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
  });

  test('Selected machines grants host scopes only; All, and a form without machine fields, grant the fleet scopes', async (t) => {
    const h = await startOAuthHarness(t);
    const cases: [string, 'all' | string[] | undefined, string][] = [
      ['read', ['mini'], 'host:mini:read'],
      ['operate', ['mini', 'macbook', 'mini'], 'host:macbook:read host:macbook:operate host:mini:read host:mini:operate'],
      ['operate', 'all', 'fleet:read fleet:operate'],
      ['read', undefined, 'fleet:read'],
    ];
    for (const [access, hosts, scope] of cases) {
      const { clientId, verifier, page } = await openPage(h);
      const machines = hosts === undefined ? { form: {}, extra: [] } : machineFields(hosts);
      const approval = await submitApproval(h.baseUrl, page.fields, { approval_code: h.approvals.mint().code, access, ...machines.form }, machines.extra);
      const tokens = await exchange(h, clientId, verifier, approval);
      assert.equal(tokens.scope, scope, `${access} ${JSON.stringify(hosts)}`);
      assert.deepEqual(h.tokens.verifyAccessToken(tokens.access_token)?.scopes, scope.split(' '));
    }
  });

  test('refuses an empty, unknown, ambiguous or malformed machine choice before the approval code is spent', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, verifier, page } = await openPage(h);
    const code = h.approvals.mint().code;
    const refusals: [Record<string, string>, [string, string][], RegExp][] = [
      [{ hosts_mode: 'selected' }, [], /Tick at least one machine/],
      [{ hosts_mode: 'selected' }, [['host', 'studio']], /not configured on this gateway/],
      [{ hosts_mode: 'selected' }, [['host', '']], /not configured on this gateway/],
      [{ hosts_mode: 'selected' }, [['host', 'mini'], ['host', 'MINI']], /not configured on this gateway/],
      [{ hosts_mode: 'all' }, [['host', 'mini']], /Machines are ticked but All machines is chosen/],
      [{}, [['host', 'mini']], /Machines are ticked but All machines is chosen/],
      [{ hosts_mode: 'some' }, [], /Choose All machines or Selected machines/],
      [{ hosts_mode: 'all' }, [['hosts_mode', 'selected'], ['host', 'mini']], /Choose All machines or Selected machines/],
    ];
    for (const [form, extra, message] of refusals) {
      const response = await submitApproval(h.baseUrl, page.fields, { approval_code: code, access: 'operate', ...form }, extra);
      assert.equal(response.status, 400, JSON.stringify([form, extra]));
      assert.match(await response.text(), message);
    }
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM authorization_codes'), 0, 'no authorization code was issued');
    assert.equal(h.approvals.globalFailures(), 0, 'a refused choice is not a failed approval');
    const approval = await submitApproval(h.baseUrl, page.fields, { approval_code: code, access: 'read', hosts_mode: 'selected' }, [['host', 'mini']]);
    assert.equal((await exchange(h, clientId, verifier, approval)).scope, 'host:mini:read', 'the same code still works');
  });

  test('a request for host scopes sets a ceiling on machines and access; unknown or tampered host scopes are refused', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, verifier, page } = await openPage(h, 'host:mini:read');
    assert.equal(page.fields.scope, 'host:mini:read');
    assert.match(page.html, /<dt>Requested access<\/dt><dd>host:mini:read<\/dd>/);
    assert.match(page.html, /name="hosts_mode" value="all" disabled>/);
    assert.match(page.html, /name="hosts_mode" value="selected" checked>/);
    assert.match(page.html, /name="host" value="mini" checked>/);
    assert.match(page.html, /name="host" value="macbook" disabled>/);
    assert.match(page.html, /name="access" value="read" checked>/);
    assert.match(page.html, /name="access" value="operate" disabled>/);
    const code = h.approvals.mint().code;
    const beyond: [Record<string, string>, [string, string][]][] = [
      [{ access: 'operate', hosts_mode: 'selected' }, [['host', 'mini']]],
      [{ access: 'read', hosts_mode: 'all' }, []],
      [{ access: 'read' }, []],
      [{ access: 'read', hosts_mode: 'selected' }, [['host', 'mini'], ['host', 'macbook']]],
    ];
    for (const [form, extra] of beyond) {
      const response = await submitApproval(h.baseUrl, page.fields, { approval_code: code, ...form }, extra);
      assert.equal(response.status, 400, JSON.stringify([form, extra]));
      assert.match(await response.text(), /more access than the agent asked for/);
    }
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM authorization_codes'), 0);
    const approval = await submitApproval(h.baseUrl, page.fields, { approval_code: code, access: 'read', hosts_mode: 'selected' }, [['host', 'mini']]);
    assert.equal((await exchange(h, clientId, verifier, approval)).scope, 'host:mini:read');

    // Operate requested on one host covers read there too (Operate implies read), and no more than that.
    const mixed = await openPage(h, 'host:macbook:read host:mini:operate');
    assert.match(mixed.page.html, /name="access" value="operate" checked>/);
    assert.match(mixed.page.html, /name="host" value="macbook" checked>/);
    const mixedCode = h.approvals.mint().code;
    const tooMuch = await submitApproval(h.baseUrl, mixed.page.fields, { approval_code: mixedCode, access: 'operate', hosts_mode: 'selected' },
      [['host', 'mini'], ['host', 'macbook']]);
    assert.equal(tooMuch.status, 400, 'Operate on the MacBook was not asked for');
    const readBoth = await submitApproval(h.baseUrl, mixed.page.fields, { approval_code: mixedCode, access: 'read', hosts_mode: 'selected' },
      [['host', 'mini'], ['host', 'macbook']]);
    assert.equal((await exchange(h, mixed.clientId, mixed.verifier, readBoth)).scope, 'host:macbook:read host:mini:read');

    for (const scope of ['host:studio:read', 'host:Mini:read', 'host:mini:admin', 'host:mini']) {
      const response = await fetch(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, pkcePair().challenge, { scope })), { redirect: 'manual' });
      assert.equal(response.status, 303, scope);
      assert.equal(new URL(response.headers.get('location') ?? '').searchParams.get('error'), 'invalid_scope', scope);
    }
    const legacy = await openPage(h);
    const swapped = await submitApproval(h.baseUrl, { ...legacy.page.fields, scope: 'host:mini:read' }, {
      approval_code: h.approvals.mint().code, hosts_mode: 'selected',
    }, [['host', 'mini']]);
    assert.equal(swapped.status, 400);
    assert.match(await swapped.text(), /expired or was altered/);
  });
});

const machineChoice = (html: string) => checkedFields(html).filter(([name]) => name !== 'access');
const accessChoice = (html: string) => checkedFields(html).filter(([name]) => name === 'access').map(([, value]) => value);

describe('host grants: a refused approval keeps the choice', () => {
  test('a wrong approval code shows the chosen machines and access again; correcting only the code grants exactly them', async (t) => {
    const h = await startOAuthHarness(t);
    const cases: ['read' | 'operate', string[], string][] = [
      ['read', ['mini'], 'host:mini:read'],
      ['operate', ['mini'], 'host:mini:read host:mini:operate'],
      ['read', ['macbook', 'mini'], 'host:macbook:read host:mini:read'],
    ];
    for (const [access, hosts, scope] of cases) {
      // The agent asks for Operate on all machines, so the page's defaults are Operate and All machines.
      const { clientId, verifier, page } = await openPage(h, 'fleet:read fleet:operate');
      assert.deepEqual(accessChoice(page.html), ['operate']);
      assert.deepEqual(machineChoice(page.html), [['hosts_mode', 'all']]);
      const machines = machineFields(hosts);
      const failuresBefore = h.approvals.globalFailures();
      const wrong = await submitApproval(h.baseUrl, page.fields, { approval_code: 'WRONG-CODE', access, ...machines.form }, machines.extra);
      assert.equal(wrong.status, 400);
      const shown = await wrong.text();
      assert.match(shown, /approval code was not accepted/);
      assert.equal(h.approvals.globalFailures(), failuresBefore + 1, 'a wrong code is still a failed attempt');
      assert.deepEqual(accessChoice(shown), [access], `${access} ${hosts}`);
      const inPageOrder = ['mini', 'macbook'].filter((id) => hosts.includes(id)).map((id) => ['host', id]);
      assert.deepEqual(machineChoice(shown), [['hosts_mode', 'selected'], ...inPageOrder], `${access} ${hosts}`);
      const approval = await approveAsShown(h.baseUrl, shown, h.approvals.mint().code);
      const tokens = await exchange(h, clientId, verifier, approval);
      assert.equal(tokens.scope, scope, `${access} ${hosts}`);
      assert.deepEqual(h.tokens.verifyAccessToken(tokens.access_token)?.scopes, scope.split(' '));
    }
  });

  test('every refused choice is shown again as chosen, and a retry as shown is refused again rather than granting all', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, verifier, page } = await openPage(h, 'fleet:read fleet:operate');
    const code = h.approvals.mint().code;
    type Retry = [Record<string, string>, [string, string][], string[], [string, string][], RegExp | undefined];
    const selectedMini: [string, string][] = [['hosts_mode', 'selected'], ['host', 'mini']];
    const retries: Retry[] = [
      // form, repeated fields, access shown, machines shown, the refusal of a retry as shown (none: it would be granted)
      [{ decision: 'later', access: 'read', hosts_mode: 'selected' }, [['host', 'mini']], ['read'], selectedMini, undefined],
      [{ access: 'admin', hosts_mode: 'selected' }, [['host', 'mini']], [], selectedMini, /Choose Read or Operate/],
      [{ access: 'read', hosts_mode: 'selected' }, [], ['read'], [['hosts_mode', 'selected']], /Tick at least one machine/],
      [{ access: 'read', hosts_mode: 'selected' }, [['host', '<script>x</script>']], ['read'], [['hosts_mode', 'selected']], /Tick at least one/],
      [{ access: 'read', hosts_mode: 'selected' }, [['host', 'mini'], ['host', 'studio']], ['read'], selectedMini, undefined],
      [{ access: 'read', hosts_mode: 'all' }, [['host', 'mini']], ['read'], [['hosts_mode', 'all'], ['host', 'mini']], /Machines are ticked/],
      [{ access: 'read' }, [['host', 'mini']], ['read'], selectedMini, undefined],
      [{ access: 'read', hosts_mode: 'some' }, [], ['read'], [['hosts_mode', 'selected']], /Tick at least one machine/],
      [{ access: 'read', hosts_mode: 'all' }, [['hosts_mode', 'selected']], ['read'], [['hosts_mode', 'selected']], /Tick at least one machine/],
    ];
    for (const [form, extra, access, machines, again] of retries) {
      const label = JSON.stringify([form, extra]);
      const refused = await submitApproval(h.baseUrl, page.fields, { approval_code: code, ...form }, extra);
      assert.equal(refused.status, 400, label);
      const shown = await refused.text();
      assert.deepEqual(accessChoice(shown), access, label);
      assert.deepEqual(machineChoice(shown), machines, label);
      assert.equal(shown.includes('studio') || shown.includes('script>x'), false, `${label}: unconfigured input is not shown`);
      if (again === undefined) continue;
      const retry = await approveAsShown(h.baseUrl, shown, code);
      assert.equal(retry.status, 400, label);
      assert.match(await retry.text(), again, label);
    }
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM authorization_codes'), 0, 'no authorization code was issued');
    assert.equal(h.approvals.globalFailures(), 0, 'no refusal spent or failed the approval code');
    // A selection that kept configured hosts only is granted as shown.
    const kept = await submitApproval(h.baseUrl, page.fields, { approval_code: 'WRONG-CODE', access: 'read', hosts_mode: 'selected' },
      [['host', 'mini'], ['host', 'studio']]);
    const approval = await approveAsShown(h.baseUrl, await kept.text(), code);
    assert.equal((await exchange(h, clientId, verifier, approval)).scope, 'host:mini:read');
  });

  test('beyond a host request\'s ceiling, a retry shows no disabled choice checked and is refused again', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, verifier, page } = await openPage(h, 'host:mini:read');
    const code = h.approvals.mint().code;
    const operate = await submitApproval(h.baseUrl, page.fields, { approval_code: code, access: 'operate', hosts_mode: 'selected' },
      [['host', 'mini']]);
    const operateShown = await operate.text();
    assert.match(operateShown, /more access than the agent asked for/);
    assert.match(operateShown, /name="access" value="operate" disabled>/);
    assert.deepEqual(accessChoice(operateShown), []);
    assert.match(await (await approveAsShown(h.baseUrl, operateShown, code)).text(), /Choose Read or Operate/);
    const all = await submitApproval(h.baseUrl, page.fields, { approval_code: code, access: 'read', hosts_mode: 'all' });
    const allShown = await all.text();
    assert.match(allShown, /name="hosts_mode" value="all" disabled>/);
    assert.deepEqual(machineChoice(allShown), [['hosts_mode', 'selected']]);
    assert.match(await (await approveAsShown(h.baseUrl, allShown, code)).text(), /Tick at least one machine/);
    const both = await submitApproval(h.baseUrl, page.fields, { approval_code: code, access: 'read', hosts_mode: 'selected' },
      [['host', 'mini'], ['host', 'macbook']]);
    const bothShown = await both.text();
    assert.match(bothShown, /name="host" value="macbook" disabled>/);
    assert.deepEqual(machineChoice(bothShown), [['hosts_mode', 'selected'], ['host', 'mini']]);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM authorization_codes'), 0);
    const approval = await approveAsShown(h.baseUrl, bothShown, code);
    assert.equal((await exchange(h, clientId, verifier, approval)).scope, 'host:mini:read');
  });

  test('a form without machine fields keeps the page defaults after a wrong code, as it meant all machines', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, verifier, page } = await openPage(h);
    const wrong = await submitApproval(h.baseUrl, page.fields, { approval_code: 'WRONG-CODE', access: 'read' });
    const shown = await wrong.text();
    assert.match(shown, /approval code was not accepted/);
    assert.deepEqual(checkedFields(shown), [['access', 'read'], ['hosts_mode', 'all']]);
    const approval = await approveAsShown(h.baseUrl, shown, h.approvals.mint().code);
    assert.equal((await exchange(h, clientId, verifier, approval)).scope, 'fleet:read');
  });
});

describe('host grants: refresh', () => {
  test('rotation, grace retries and narrowing keep a restricted grant restricted; generic fleet scopes never widen it', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, tokens } = await signIn(h.baseUrl, () => h.approvals.mint().code, { access: 'operate', hosts: ['mini', 'macbook'] });
    const both = 'host:macbook:read host:macbook:operate host:mini:read host:mini:operate';
    assert.equal(tokens.scope, both);
    const rotated = await refreshed(h, clientId, tokens.refresh_token);
    assert.equal(rotated.scope, both);
    const sibling = await refreshed(h, clientId, tokens.refresh_token);
    assert.equal(sibling.scope, both, 'a grace retry gets the same scope');
    // What a client that knows only the advertised scopes would send: it keeps exactly its hosts.
    const generic = await refreshed(h, clientId, rotated.refresh_token, 'fleet:read fleet:operate');
    assert.equal(generic.scope, both);
    assert.deepEqual(h.tokens.verifyAccessToken(generic.access_token)?.scopes, both.split(' '));
    const mini = await refreshed(h, clientId, generic.refresh_token, 'host:mini:read host:mini:operate');
    assert.equal(mini.scope, 'host:mini:read host:mini:operate');
    const reader = await refreshed(h, clientId, mini.refresh_token, 'fleet:read');
    assert.equal(reader.scope, 'host:mini:read');
    for (const scope of ['host:macbook:read', 'host:mini:operate', 'fleet:operate', 'fleet:read fleet:operate', '', 'host:mini:admin', 'host:Mini:read']) {
      const response = await refresh(h, clientId, reader.refresh_token, scope);
      assert.equal(response.status, 400, scope);
      assert.equal(((await response.json()) as { error: string }).error, 'invalid_scope', scope);
    }
    const kept = await refreshed(h, clientId, reader.refresh_token);
    assert.equal(kept.scope, 'host:mini:read', 'refused requests neither widen nor revoke the grant');
    assert.deepEqual(h.tokens.verifyAccessToken(kept.access_token)?.scopes, ['host:mini:read']);
  });

  test('fleet grants refresh exactly as before: no host scopes, no widening', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, tokens } = await signIn(h.baseUrl, () => h.approvals.mint().code, { access: 'read' });
    assert.equal(tokens.scope, 'fleet:read');
    for (const scope of ['fleet:read fleet:operate', 'host:mini:read']) {
      const response = await refresh(h, clientId, tokens.refresh_token, scope);
      assert.equal(((await response.json()) as { error: string }).error, 'invalid_scope', scope);
    }
    assert.equal((await refreshed(h, clientId, tokens.refresh_token)).scope, 'fleet:read');
  });
});

interface Fleet {
  mini: FakeT3;
  macbook: FakeT3;
  gw: TestGateway;
  /** Signed in through a form without machine fields, as before host selection: a fleet-wide Operate grant. */
  trusted: Agent & { tokens: IssuedTokens };
  tick(): Promise<void>;
}

const FLEET_HOSTS = (mini: FakeT3, macbook: FakeT3) => [
  { id: 'mini', label: 'Synthetic mini', t3Url: mini.url, mintPairingCode: mini.mintCommand() },
  { id: 'macbook', label: 'Synthetic macbook', t3Url: macbook.url, mintPairingCode: macbook.mintCommand() },
];
const FLEET_PROJECTS = [
  { alias: 'alpha', description: 'Synthetic alpha', host: 'mini', t3ProjectId: 'project-1', runtimeMode: 'auto' },
  { alias: 'beta', description: 'Synthetic beta', host: 'macbook', t3ProjectId: 'project-1', runtimeMode: 'auto' },
];

async function startFleet(t: TestContext): Promise<Fleet> {
  const mini = await startFakeT3();
  const macbook = await startFakeT3();
  t.after(() => mini.close());
  t.after(() => macbook.close());
  const gw = await startTestGateway(t, { config: { hosts: FLEET_HOSTS(mini, macbook), projects: FLEET_PROJECTS }, jobEngine: { autoStart: false } });
  await gw.services.registry.enroll('mini');
  await gw.services.registry.enroll('macbook');
  const trusted = await connect(t, gw, 'operate');
  return { mini, macbook, gw, trusted, tick: () => gw.gateway.engine.tick() };
}

async function connect(t: TestContext, gw: TestGateway, access: 'read' | 'operate', hosts?: 'all' | string[], clientId?: string): Promise<Agent & { tokens: IssuedTokens }> {
  const signedIn = await signIn(gw.baseUrl, gw.mintApprovalCode, { access, ...(hosts ? { hosts } : {}), ...(clientId ? { clientId } : {}) });
  return { ...(await agentWithToken(t, gw.baseUrl, signedIn.clientId, signedIn.tokens.access_token)), tokens: signedIn.tokens };
}

async function startIn(agent: Agent, project: string, task: string, requestId = `req-${Math.random().toString(36).slice(2)}`) {
  return (await agent.call<{ job: { jobId: string; title: string } }>('work_start', { project, task, requestId })).job;
}

async function toolText(agent: Agent, name: string, args: Record<string, unknown> = {}): Promise<{ structured: unknown; text: string; isError: boolean }> {
  const result = await agent.client.callTool({ name, arguments: args });
  return { structured: result.structuredContent, text: JSON.stringify(result.content), isError: result.isError === true };
}

/** Stop a fleet's gateway and let pooled client connections through its front door close, as the restart tests in jobs-watch do. */
async function stopGateway(gw: TestGateway): Promise<void> {
  await gw.gateway.close();
  gw.door.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const unknownJob = (jobId: string) => `not_found: No job ${jobId}. Use work_list to see jobs.`;

describe('host grants: work tools on two hosts', () => {
  test('an Operate-only grant narrowed by refresh can still cancel an allowed job', async (t) => {
    const { gw, trusted } = await startFleet(t);
    const job = await startIn(trusted, 'beta', 'Synthetic operate-only cancellation');
    const agent = await connect(t, gw, 'operate', ['macbook']);
    const response = await tokenRequest(gw.baseUrl, {
      grant_type: 'refresh_token', client_id: agent.clientId, refresh_token: agent.tokens.refresh_token, scope: 'host:macbook:operate',
    });
    assert.equal(response.status, 200);
    const tokens = (await response.json()) as IssuedTokens;
    assert.equal(tokens.scope, 'host:macbook:operate');
    const narrowed = await agentWithToken(t, gw.baseUrl, agent.clientId, tokens.access_token);
    assert.equal((await narrowed.call<{ outcome: string }>('work_cancel', { jobId: job.jobId })).outcome, 'cancelled');
  });

  test('hidden jobs with malformed or unsupported launch specs return the same error as unknown jobs', async (t) => {
    const { mini, macbook, gw, trusted } = await startFleet(t);
    const hidden = await startIn(trusted, 'beta', 'Synthetic hidden launch spec');
    const agent = await connect(t, gw, 'operate', ['mini']);
    const calls = [mini.calls.length, macbook.calls.length];
    const denied: [string, Record<string, unknown>][] = [
      ['work_status', { jobId: hidden.jobId }],
      ['work_messages', { jobId: hidden.jobId }],
      ['work_continue', { jobId: hidden.jobId, message: 'Synthetic follow-up', requestId: 'hidden-continue' }],
      ['work_respond', { jobId: hidden.jobId, requestId: 'synthetic-question', answers: {} }],
      ['work_cancel', { jobId: hidden.jobId }],
    ];
    for (const spec of ['{', '{"v":99}']) {
      gw.services.db.prepare('UPDATE jobs SET launch_spec = ? WHERE id = ?').run(spec, hidden.jobId);
      for (const [tool, args] of denied) {
        assert.equal((await agent.callError(tool, args)).text, unknownJob(hidden.jobId), tool);
      }
      assert.equal((await trusted.callError('work_status', { jobId: hidden.jobId })).code, 'database_error');
    }
    assert.deepEqual([mini.calls.length, macbook.calls.length], calls);
  });

  test('a mini-only Operate agent reads, starts and steers mini work; MacBook work is invisible and untouched', async (t) => {
    const fleet = await startFleet(t);
    const { mini, macbook, gw, trusted, tick } = fleet;
    const alpha = await startIn(trusted, 'alpha', 'Synthetic alpha task');
    const beta = await startIn(trusted, 'beta', 'Synthetic beta hidden task');
    await tick();
    const alphaThread = mini.threadForJob(alpha.jobId).threadId;
    const betaThread = macbook.threadForJob(beta.jobId).threadId;
    macbook.finishTurn(betaThread, 'Synthetic beta hidden reply');
    const betaQuestion = macbook.askQuestion(betaThread, [
      { id: 'q', header: 'Synthetic beta header', question: 'Synthetic beta hidden question?', options: [{ label: 'Synthetic beta option', description: 'd' }] },
    ]);
    await tick();
    const agent = await connect(t, gw, 'operate', ['mini']);

    const status = await toolText(agent, 'fleet_status');
    const fleetView = status.structured as { hosts: { id: string }[]; projects: { alias: string }[] };
    assert.deepEqual(fleetView.hosts.map((host) => host.id), ['mini']);
    assert.deepEqual(fleetView.projects.map((project) => project.alias), ['alpha']);
    assert.match(status.text, /1 host\(s\), 1 project\(s\)/);
    for (const hidden of ['macbook', 'beta', 'Synthetic beta']) assert.equal(status.text.includes(hidden), false, hidden);

    const listed = await toolText(agent, 'work_list');
    assert.deepEqual((listed.structured as { jobs: { jobId: string }[] }).jobs.map((job) => job.jobId), [alpha.jobId]);
    assert.equal(listed.text.includes(beta.jobId), false);
    assert.equal((await agent.callError('work_list', { project: 'beta' })).text, 'not_found: No project "beta". Known projects: alpha. fleet_status lists them.');

    const macbookCalls = macbook.calls.length;
    const denied: [string, Record<string, unknown>][] = [
      ['work_status', { jobId: beta.jobId }],
      ['work_status', { jobId: beta.jobId, pendingRequestId: betaQuestion }],
      ['work_messages', { jobId: beta.jobId }],
      ['work_continue', { jobId: beta.jobId, message: 'Synthetic steer for beta', requestId: 'steer-beta' }],
      ['work_respond', { jobId: beta.jobId, requestId: betaQuestion, answers: { q: 'Synthetic beta option' } }],
      ['work_cancel', { jobId: beta.jobId }],
    ];
    for (const [tool, args] of denied) {
      assert.equal((await agent.callError(tool, args)).text, unknownJob(beta.jobId), `${tool}: the same answer as an unknown job`);
    }
    assert.equal((await agent.callError('work_status', { jobId: 'zzzzzzzzzz' })).text, unknownJob('zzzzzzzzzz'));
    assert.equal((await agent.callError('work_start', { project: 'beta', task: 'Synthetic', requestId: 'start-beta' })).text,
      'not_found: No project "beta". Known projects: alpha. fleet_status lists them.');
    assert.equal(macbook.calls.length, macbookCalls, 'no call reached the MacBook');
    assert.equal(gw.services.jobs.store.list({ limit: 100 }).length, 2, 'no job was created');

    // Mini work, including a job another agent started: read, steer, answer and cancel.
    const alphaView = await agent.call<{ startedByYou: boolean }>('work_status', { jobId: alpha.jobId });
    assert.equal(alphaView.startedByYou, false);
    const continued = await agent.call<{ delivery: string }>('work_continue', { jobId: alpha.jobId, message: 'Synthetic alpha follow-up', requestId: 'steer-alpha' });
    assert.equal(continued.delivery, 'steered');
    assert.equal(mini.sends.at(-1)?.message, 'Synthetic alpha follow-up');
    const alphaQuestion = mini.askQuestion(alphaThread, [{ id: 'q', header: 'Synthetic', question: 'Synthetic alpha question?', options: [] }]);
    await tick();
    await agent.call('work_respond', { jobId: alpha.jobId, requestId: alphaQuestion, answers: { q: 'Synthetic answer' } });
    assert.equal(mini.responses.at(-1)?.requestId, alphaQuestion);
    const own = await startIn(agent, 'alpha', 'Synthetic own alpha task');
    assert.equal((await agent.call<{ outcome: string }>('work_cancel', { jobId: own.jobId })).outcome, 'cancelled');

    const feed = await agent.call<{ events: { jobId: string }[]; attention: { jobId: string }[] }>('work_feed', { limit: 200 });
    assert.ok(feed.events.length > 0);
    assert.ok(feed.events.every((event) => event.jobId !== beta.jobId), 'no MacBook events');
    assert.ok(feed.attention.every((job) => job.jobId !== beta.jobId), 'no MacBook attention');
    const trustedFeed = await trusted.call<{ attention: { jobId: string }[] }>('work_feed', {});
    assert.ok(trustedFeed.attention.some((job) => job.jobId === beta.jobId), 'the fleet-wide agent sees the MacBook question');
    assertNotLogged(gw, ['Synthetic beta hidden', 'Synthetic beta header']);
  });

  test('a read-only agent for selected machines reads full messages and questions there and cannot change anything', async (t) => {
    const { mini, macbook, gw, trusted, tick } = await startFleet(t);
    const alpha = await startIn(trusted, 'alpha', 'Synthetic alpha task');
    const beta = await startIn(trusted, 'beta', 'Synthetic beta task');
    await tick();
    const reply = `Synthetic alpha reply ${'x'.repeat(3000)} end`;
    mini.finishTurn(mini.threadForJob(alpha.jobId).threadId, reply);
    await tick();
    const reader = await connect(t, gw, 'read', ['mini']);

    const messages = await reader.call<{ messages: { text: string }[] }>('work_messages', { jobId: alpha.jobId });
    assert.equal(messages.messages[0]?.text, reply, 'the full message');
    const question = mini.askQuestion(mini.threadForJob(alpha.jobId).threadId, [
      { id: 'q', header: 'Synthetic header', question: 'Synthetic visible question?', options: [{ label: 'Synthetic yes', description: 'd' }] },
    ]);
    gw.clock.advance(MINUTE);
    await tick();
    const status = await toolText(reader, 'work_status', { jobId: alpha.jobId });
    assert.match(status.text, /Synthetic visible question\?/);

    const miniCalls = mini.calls.length;
    for (const [tool, args] of [
      ['work_start', { project: 'alpha', task: 'Synthetic', requestId: 'r1' }],
      ['work_continue', { jobId: alpha.jobId, message: 'Synthetic', requestId: 'r2' }],
      ['work_respond', { jobId: alpha.jobId, requestId: question, answers: { q: 'Synthetic yes' } }],
      ['work_cancel', { jobId: alpha.jobId }],
    ] as const) {
      assert.equal((await reader.callError(tool, args)).code, 'insufficient_scope', tool);
    }
    assert.equal(mini.calls.length, miniCalls, 'no mutation reached T3');
    assert.equal((await reader.callError('work_messages', { jobId: beta.jobId })).text, unknownJob(beta.jobId));

    // Hidden jobs never take a place on a page: lists, feed and attention filter before their limits.
    const { nextCursor } = await reader.call<{ nextCursor: string }>('work_feed', { limit: 200 });
    const second = await startIn(trusted, 'alpha', 'Synthetic second alpha task');
    for (let index = 0; index < 5; index++) await startIn(trusted, 'beta', `Synthetic beta task ${index}`);
    const page = await reader.call<{ events: { jobId: string; type: string }[]; hasMore: boolean; nextCursor: string }>('work_feed', { cursor: nextCursor, limit: 1 });
    assert.deepEqual(page.events.map((event) => [event.jobId, event.type]), [[second.jobId, 'created']]);
    assert.equal(page.hasMore, false);
    const rest = await reader.call<{ events: unknown[]; nextCursor: string }>('work_feed', { cursor: page.nextCursor });
    assert.deepEqual(rest.events, []);
    assert.equal(rest.nextCursor, page.nextCursor);
    const newest = await reader.call<{ jobs: { jobId: string }[] }>('work_list', { limit: 1 });
    assert.deepEqual(newest.jobs.map((job) => job.jobId), [second.jobId]);

    const store = gw.services.jobs.store;
    for (let index = 0; index < 55; index++) {
      const id = newJobId();
      store.create({ id, clientId: 'synthetic', requestId: `bulk-${index}`, inputHash: `h${index}`, projectAlias: 'beta', hostId: 'macbook',
        task: 'Synthetic bulk', title: `Synthetic bulk ${index}`, branch: `fleet/${id}`, runtimeMode: 'auto' });
      store.transition(id, { from: ['queued'], to: 'needs_input' });
    }
    const attention = await reader.call<{ attention: { jobId: string }[] }>('work_feed', { cursor: page.nextCursor });
    assert.deepEqual(attention.attention.map((job) => job.jobId).sort(), [alpha.jobId].sort(), '55 hidden jobs do not fill the 50 attention places');

    const counts = await reader.call<{ hosts: { id: string; runningJobs: number; queuedJobs: number }[] }>('fleet_status');
    assert.deepEqual(counts.hosts, [{ ...counts.hosts[0], id: 'mini', runningJobs: 1, queuedJobs: 1 }]);
  });

  test('read on one host and operate on another: the readable host is visible but not operable', async (t) => {
    const { mini, macbook, gw, trusted, tick } = await startFleet(t);
    const alpha = await startIn(trusted, 'alpha', 'Synthetic alpha task');
    const beta = await startIn(trusted, 'beta', 'Synthetic beta task');
    await tick();
    const { clientId, token } = gw.services.tokens.issueOperatorToken({
      name: 'Synthetic mixed', scopes: ['host:macbook:read', 'host:mini:read', 'host:mini:operate'], expiresAt: gw.clock() + HOUR,
    });
    const mixed = await agentWithToken(t, gw.baseUrl, clientId, token);
    assert.equal((await mixed.call<{ jobId: string }>('work_status', { jobId: beta.jobId })).jobId, beta.jobId);
    const macbookCalls = macbook.calls.length;
    const refused = await mixed.callError('work_continue', { jobId: beta.jobId, message: 'Synthetic', requestId: 'r1' });
    assert.equal(refused.code, 'insufficient_scope');
    assert.match(refused.text, /on host macbook, where this agent has read access only/);
    assert.equal((await mixed.callError('work_cancel', { jobId: beta.jobId })).code, 'insufficient_scope');
    assert.equal((await mixed.callError('work_start', { project: 'beta', task: 'Synthetic', requestId: 'r2' })).code, 'insufficient_scope');
    assert.equal(macbook.calls.length, macbookCalls);
    await mixed.call('work_continue', { jobId: alpha.jobId, message: 'Synthetic mixed follow-up', requestId: 'r3' });
    assert.equal(mini.sends.at(-1)?.message, 'Synthetic mixed follow-up');
  });

  test('standing jobs on an allowed host stay usable; those elsewhere stay hidden', async (t) => {
    const { mini, macbook, gw, tick } = await startFleet(t);
    // Each fake numbers its threads from 1; a real T3's thread ids do not collide across hosts.
    macbook.launchDirect({ projectId: 'project-2', title: 'Synthetic unrelated', message: 'Synthetic' });
    const miniThread = mini.launchDirect({ projectId: 'project-1', title: 'Synthetic mini coordinator', message: 'Synthetic' }).threadId;
    mini.finishTurn(miniThread, 'Synthetic coordinator reply');
    const macbookThread = macbook.launchDirect({ projectId: 'project-1', title: 'Synthetic macbook coordinator', message: 'Synthetic' }).threadId;
    macbook.finishTurn(macbookThread, 'Synthetic hidden coordinator reply');
    const miniStanding = (await gw.services.jobs.adopt({ project: 'alpha', threadId: miniThread })).job;
    const macbookStanding = (await gw.services.jobs.adopt({ project: 'beta', threadId: macbookThread })).job;
    const agent = await connect(t, gw, 'operate', ['mini']);
    const status = await toolText(agent, 'fleet_status');
    assert.deepEqual((status.structured as { projects: { standingJobs: { jobId: string }[] }[] }).projects.map((project) => project.standingJobs.map((job) => job.jobId)),
      [[miniStanding.id]]);
    assert.equal(status.text.includes('Synthetic macbook coordinator'), false);
    const mine = await agent.call<{ jobs: { jobId: string }[] }>('work_list', { mine: true });
    assert.deepEqual(mine.jobs.map((job) => job.jobId), [miniStanding.id], 'mine includes standing jobs on allowed hosts only');
    await agent.call('work_continue', { jobId: miniStanding.id, message: 'Synthetic coordinator instruction', requestId: 'r1' });
    assert.equal(mini.sends.at(-1)?.message, 'Synthetic coordinator instruction');
    await tick();
    assert.equal((await agent.callError('work_continue', { jobId: macbookStanding.id, message: 'Synthetic', requestId: 'r2' })).text, unknownJob(macbookStanding.id));
  });

  test('stored scopes that are malformed, or name a host that is gone, grant nothing', async (t) => {
    const { gw, trusted, tick } = await startFleet(t);
    const alpha = await startIn(trusted, 'alpha', 'Synthetic alpha task');
    await tick();
    const gone = gw.services.tokens.issueOperatorToken({ name: 'Synthetic gone', scopes: ['host:studio:read', 'host:studio:operate'], expiresAt: gw.clock() + HOUR });
    const agent = await agentWithToken(t, gw.baseUrl, gone.clientId, gone.token);
    const status = await agent.call<{ hosts: unknown[]; projects: unknown[] }>('fleet_status');
    assert.deepEqual([status.hosts, status.projects], [[], []]);
    assert.deepEqual(await agent.call('work_list'), { jobs: [] });
    assert.equal((await agent.callError('work_status', { jobId: alpha.jobId })).text, unknownJob(alpha.jobId));
    assert.equal((await agent.callError('work_start', { project: 'alpha', task: 'Synthetic', requestId: 'r1' })).code, 'not_found');

    const broken = gw.services.tokens.issueOperatorToken({ name: 'Synthetic broken', scopes: ['host:mini:read'], expiresAt: gw.clock() + HOUR });
    gw.services.db.prepare("UPDATE access_tokens SET scope = 'host:mini:read host:mini:admin' WHERE family_id IN (SELECT id FROM token_families WHERE client_id = ?)")
      .run(broken.clientId);
    const malformed = await agentWithToken(t, gw.baseUrl, broken.clientId, broken.token);
    for (const tool of ['fleet_status', 'work_list', 'work_feed']) assert.equal((await malformed.callError(tool)).code, 'insufficient_scope', tool);
  });
});

describe('host grants: compatibility', () => {
  test('fleet-wide OAuth and bearer grants work on every host, refresh without approval, and cover a host added later', async (t) => {
    const { mini, macbook, gw, trusted, tick } = await startFleet(t);
    const bearer = gw.services.tokens.issueOperatorToken({ name: 'Synthetic bearer', scopes: ['fleet:read', 'fleet:operate'], expiresAt: gw.clock() + 365 * 24 * HOUR });
    const bearerAgent = await agentWithToken(t, gw.baseUrl, bearer.clientId, bearer.token);
    const allForm = await connect(t, gw, 'operate', 'all');
    assert.equal(allForm.tokens.scope, 'fleet:read fleet:operate');
    const jobs = [];
    for (const [agent, project] of [[trusted, 'alpha'], [trusted, 'beta'], [bearerAgent, 'beta'], [allForm, 'alpha']] as const) {
      jobs.push(await startIn(agent, project, `Synthetic ${project} task`));
    }
    await tick();
    for (const agent of [trusted, bearerAgent, allForm]) {
      const status = await agent.call<{ hosts: { id: string }[] }>('fleet_status');
      assert.deepEqual(status.hosts.map((host) => host.id), ['mini', 'macbook']);
      assert.equal((await agent.call<{ jobs: unknown[] }>('work_list')).jobs.length, 4);
    }
    await bearerAgent.call('work_continue', { jobId: jobs[0]!.jobId, message: 'Synthetic bearer on mini', requestId: 'b1' });
    await allForm.call('work_continue', { jobId: jobs[1]!.jobId, message: 'Synthetic all on macbook', requestId: 'a1' });
    assert.equal(mini.sends.at(-1)?.message, 'Synthetic bearer on mini');
    assert.equal(macbook.sends.at(-1)?.message, 'Synthetic all on macbook');

    // Refresh needs no new approval and keeps the fleet scopes.
    const response = await tokenRequest(gw.baseUrl, { grant_type: 'refresh_token', refresh_token: trusted.tokens.refresh_token, client_id: trusted.clientId });
    assert.equal(response.status, 200);
    const renewed = (await response.json()) as IssuedTokens;
    assert.equal(renewed.scope, 'fleet:read fleet:operate');
    const restricted = await connect(t, gw, 'operate', ['mini']);
    const restrictedRenewed = (await (await tokenRequest(gw.baseUrl, {
      grant_type: 'refresh_token', refresh_token: restricted.tokens.refresh_token, client_id: restricted.clientId,
    })).json()) as IssuedTokens;

    // Restart with a third host, and the alias beta moved to the mini: fleet grants cover the new host; the restricted one does not.
    const studio = await startFakeT3();
    t.after(() => studio.close());
    await stopGateway(gw);
    const moved = FLEET_PROJECTS.map((project) => (project.alias === 'beta' ? { ...project, host: 'mini', t3ProjectId: 'project-2' } : project));
    const restarted = await startTestGateway(t, {
      config: {
        hosts: [...FLEET_HOSTS(mini, macbook), { id: 'studio', t3Url: studio.url, mintPairingCode: studio.mintCommand() }],
        projects: moved,
      },
      dataDir: gw.dataDir, door: gw.door, clock: gw.clock, jobEngine: { autoStart: false },
    });
    const fleetAfter = await agentWithToken(t, restarted.baseUrl, trusted.clientId, renewed.access_token);
    assert.deepEqual((await fleetAfter.call<{ hosts: { id: string }[] }>('fleet_status')).hosts.map((host) => host.id), ['mini', 'macbook', 'studio']);
    const bearerAfter = await agentWithToken(t, restarted.baseUrl, bearer.clientId, bearer.token);
    assert.deepEqual((await bearerAfter.call<{ hosts: { id: string }[] }>('fleet_status')).hosts.map((host) => host.id), ['mini', 'macbook', 'studio']);
    const restrictedAfter = await agentWithToken(t, restarted.baseUrl, restricted.clientId, restrictedRenewed.access_token);
    assert.deepEqual((await restrictedAfter.call<{ hosts: { id: string }[] }>('fleet_status')).hosts.map((host) => host.id), ['mini']);
  });

  test('replays and reassigned aliases cannot reach a job on a host the grant does not cover', async (t) => {
    const { mini, macbook, gw, trusted, tick } = await startFleet(t);
    const task = 'Synthetic beta task for replay';
    const beta = await startIn(trusted, 'beta', task, 'replay-start');
    await tick();
    await trusted.call('work_continue', { jobId: beta.jobId, message: 'Synthetic replayed follow-up', requestId: 'replay-continue' });
    // The same client approved again for the mini only: request ids are per client, so its earlier ones are shared.
    const narrowed = await connect(t, gw, 'operate', ['mini'], trusted.clientId);
    assert.equal(narrowed.clientId, trusted.clientId);
    const sends = macbook.sends.length;
    assert.equal((await narrowed.callError('work_continue', { jobId: beta.jobId, message: 'Synthetic replayed follow-up', requestId: 'replay-continue' })).text,
      unknownJob(beta.jobId), 'a delivered request is not replayed for a job on another host');

    await stopGateway(gw);
    const moved = FLEET_PROJECTS.map((project) => (project.alias === 'beta' ? { ...project, host: 'mini', t3ProjectId: 'project-2' } : project));
    const restarted = await startTestGateway(t, {
      config: { hosts: FLEET_HOSTS(mini, macbook), projects: moved }, dataDir: gw.dataDir, door: gw.door, clock: gw.clock, jobEngine: { autoStart: false },
    });
    const agent = await agentWithToken(t, restarted.baseUrl, narrowed.clientId, narrowed.tokens.access_token);
    const replay = await agent.callError('work_start', { project: 'beta', task, requestId: 'replay-start' });
    assert.equal(replay.code, 'insufficient_scope');
    assert.equal(replay.text.includes(beta.jobId) || replay.text.includes('macbook'), false, 'nothing about the job is revealed');
    assert.equal(restarted.services.jobs.store.list({ limit: 10 }).length, 1, 'no new job');
    const fresh = await startIn(agent, 'beta', task, 'replay-start-2');
    assert.equal(restarted.services.jobs.store.get(fresh.jobId)?.hostId, 'mini', 'new work goes to the host the alias names now');
    assert.equal(macbook.sends.length, sends, 'nothing reached the MacBook');
  });
});

describe('host grants: clients token --hosts', () => {
  async function cli(gw: TestGateway, configPath: string, args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, {
      env: { ...process.env, T3FG_CONFIG: configPath, T3FG_DATA_DIR: gw.dataDir },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  test('mints tokens for selected hosts, all hosts by default or by name, and refuses unknown or malformed lists', async (t) => {
    const { gw, trusted, tick } = await startFleet(t);
    const alpha = await startIn(trusted, 'alpha', 'Synthetic alpha task');
    const beta = await startIn(trusted, 'beta', 'Synthetic beta task');
    await tick();
    const configPath = join(tempDir(t), 'config.json');
    writeFileSync(configPath, JSON.stringify({ publicUrl: gw.baseUrl, hosts: [{ id: 'mini', t3Url: 'http://127.0.0.1:9' }, { id: 'macbook', t3Url: 'http://127.0.0.1:9' }] }));
    const clients = () => (gw.services.db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n;
    const before = clients();
    for (const [hosts, code, message] of [
      ['', 2, /--hosts must be all, or a comma-separated list/],
      [',', 2, /--hosts must be all/],
      ['mini,', 2, /--hosts must be all/],
      ['MINI', 2, /--hosts must be all/],
      ['mini macbook', 2, /--hosts must be all/],
      ['all,mini', 2, /--hosts all cannot be combined/],
      ['mini,studio', 1, /error \(host_not_found\): No host studio in the config\. Configured hosts: mini, macbook\. No token was created\./],
    ] as const) {
      const refused = await cli(gw, configPath, ['clients', 'token', '--name', 'Synthetic', '--hosts', hosts]);
      assert.deepEqual([refused.code, refused.out], [code, ''], hosts);
      assert.match(refused.err, message);
    }
    assert.equal(clients(), before, 'nothing was created');
    assert.match((await cli(gw, configPath, ['pair', '--hosts', 'mini'])).err, /--hosts is only for clients token/);
    assert.match((await cli(gw, configPath, ['--help'])).out, /--hosts all\|<id>,<id>/);

    const minted = await cli(gw, configPath, ['clients', 'token', '--name', 'Synthetic mini agent', '--hosts', 'mini']);
    assert.equal(minted.code, 0, minted.err);
    assert.match(minted.out, /\("Synthetic mini agent", operate access to host mini only\)\. Its token expires/);
    const [, clientId = ''] = /^Created client (\S+) /.exec(minted.out) ?? [];
    const token = minted.out.split('\n')[1] ?? '';
    const agent = await agentWithToken(t, gw.baseUrl, clientId, token);
    assert.deepEqual((await agent.call<{ hosts: { id: string }[] }>('fleet_status')).hosts.map((host) => host.id), ['mini']);
    assert.deepEqual((await agent.call<{ jobs: { jobId: string }[] }>('work_list')).jobs.map((job) => job.jobId), [alpha.jobId]);
    assert.equal((await agent.callError('work_status', { jobId: beta.jobId })).text, unknownJob(beta.jobId));

    const reader = await cli(gw, configPath, ['clients', 'token', '--name', 'Synthetic reader', '--access', 'read', '--hosts', 'mini,macbook,mini']);
    assert.match(reader.out, /\("Synthetic reader", read access to hosts mini, macbook only\)/);
    const all = await cli(gw, configPath, ['clients', 'token', '--name', 'Synthetic all', '--hosts', 'all', '--ttl', 'never']);
    assert.match(all.out, /\("Synthetic all", operate access to all hosts, including hosts added later\)\. Its token never expires:/);
    const allToken = all.out.split('\n')[1] ?? '';
    const allAgent = await agentWithToken(t, gw.baseUrl, '', allToken);
    assert.deepEqual((await allAgent.call<{ hosts: { id: string }[] }>('fleet_status')).hosts.map((host) => host.id), ['mini', 'macbook']);

    const listed = await cli(gw, configPath, ['clients', 'list']);
    assert.match(listed.out, /Synthetic mini agent\s+operate: mini\s+active/);
    assert.match(listed.out, /Synthetic reader\s+read: macbook, mini\s+active/);
    assert.match(listed.out, /Synthetic all\s+operate \(all hosts\)\s+active/);
    assert.match(listed.out, new RegExp(`${trusted.clientId}\\s+Test agent\\s+operate \\(all hosts\\)\\s+unrevoked`));
    const diagnosed = await cli(gw, configPath, ['clients', 'diagnose', clientId]);
    assert.match(diagnosed.out, /granted access: operate: mini\n/);
    for (const output of [minted.out.split('\n').slice(2).join('\n'), listed.out, diagnosed.out, reader.err, all.err]) {
      assert.equal(output.includes(token) || output.includes(allToken), false);
    }
  });
});
