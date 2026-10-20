import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { describe, test, type TestContext } from 'node:test';
import { parseArgs } from 'node:util';
import { parseConfig } from '../src/config.ts';
import { DashboardChecks } from '../src/dashboard/checks.ts';
import { buildSnapshot, LIMITS, threadLink, type DashboardSnapshot } from '../src/dashboard/snapshot.ts';
import { newJobId } from '../src/jobs/ids.ts';
import { scopesForGrant } from '../src/oauth/scopes.ts';
import { DAY, HOUR, MINUTE } from '../src/time.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { loadApp } from './helpers/dashboardApp.ts';
import { FakeDocument } from './helpers/fakeDom.ts';
import { startTestGateway, type TestGateway } from './helpers/gateway.ts';
import { startJob, startJobHarness, type JobHarness } from './helpers/jobs.ts';
import { registerClient, signIn, tokenRequest } from './helpers/oauthFlow.ts';

// Synthetic content that must never reach the dashboard: worker text, task text, questions, delegated titles. A job's
// title is the agent's title or the task's first line (as T3 shows the thread), so the task body goes after it.
const TASK = 'Synthetic task: rewrite the parser\nSECRET-TASK-TEXT in the task body';
const REPLY = 'Synthetic reply: SECRET-WORKER-REPLY all done';
const QUESTION = 'Synthetic SECRET-QUESTION which database?';
const OPTION = 'SECRET-OPTION-LABEL';
const DELEGATED = 'SECRET-DELEGATED-TITLE';
const ALLOWED_HOST = 'dashboard.example.test';

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A request with full control of every header (fetch cannot set Host). */
function raw(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const API = { 'x-t3fg-dashboard': '1' };

async function snapshot(port: number, base = ''): Promise<DashboardSnapshot> {
  const response = await raw(port, { path: `${base}/api/snapshot`, headers: API });
  assert.equal(response.status, 200, response.body);
  return JSON.parse(response.body) as DashboardSnapshot;
}

async function runChecks(port: number, base = ''): Promise<{ run: { results: { id: string; level: string; code: string }[] }; snapshot: DashboardSnapshot }> {
  const response = await raw(port, { method: 'POST', path: `${base}/api/checks`, headers: { ...API, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200, response.body);
  return JSON.parse(response.body);
}

function dashboardPort(gw: TestGateway): number {
  assert.ok(gw.gateway.dashboard, 'the dashboard is enabled');
  return gw.gateway.dashboard.port;
}

async function harness(t: TestContext, dashboard: Record<string, unknown> = {}): Promise<JobHarness & { port: number }> {
  const h = await startJobHarness(t, { maxConcurrentJobs: 4, dashboard: { enabled: true, allowedHosts: [ALLOWED_HOST], ...dashboard } });
  return { ...h, port: dashboardPort(h.gw) };
}

/** Every row of the tables the dashboard reads, hashed: equal before and after means nothing was written. */
function ledgerHash(gw: TestGateway): string {
  const hash = createHash('sha256');
  for (const table of ['jobs', 'job_events', 'idempotency_keys', 'oauth_clients', 'token_families', 'access_tokens', 'refresh_tokens', 'host_credentials']) {
    hash.update(JSON.stringify(gw.services.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  }
  return hash.digest('hex');
}

describe('dashboard: configuration', () => {
  const base = { publicUrl: 'https://gateway.example.com', hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:3773' }] };

  test('is off by default and needs nothing from existing configs', () => {
    const config = parseConfig(base);
    assert.equal(config.dashboard.enabled, false);
    assert.deepEqual(config.dashboard.listen, { host: '127.0.0.1', port: 3791 });
    assert.equal(config.dashboard.basePath, '/');
  });

  test('refuses a non-loopback listener, the MCP port, malformed paths, hosts and labels', () => {
    const invalid = (dashboard: Record<string, unknown>, pattern: RegExp, extra: Record<string, unknown> = {}) =>
      assert.throws(() => parseConfig({ ...base, ...extra, dashboard }), pattern);
    invalid({ enabled: true, listen: { host: '0.0.0.0', port: 3791 } }, /dashboard\.listen\.host must be a loopback address/);
    invalid({ enabled: true, listen: { host: '127.0.0.1', port: 3790 } }, /dashboard\.listen\.port must differ from listen\.port/);
    for (const basePath of ['fleet', '/fleet/', '/Fleet', '/a b', '/../x', '//x']) invalid({ basePath }, /dashboard\.basePath/);
    for (const host of ['https://dash.example.test', 'dash.example.test/x', 'Dash.example.test', '']) invalid({ allowedHosts: [host] }, /dashboard\.allowedHosts/);
    invalid({ clientLabels: { 'not an id!': 'x' } }, /dashboard\.clientLabels/);
    invalid({ clientLabels: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`c${i}`, 'x'])) }, /at most 100 client labels/);
    assert.throws(() => parseConfig({ ...base, hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:3773', transportNote: 'x'.repeat(81) }] }), /transportNote/);
    // Disabled, the same port is harmless: nothing listens.
    assert.equal(parseConfig({ ...base, dashboard: { enabled: false, listen: { host: '127.0.0.1', port: 3790 } } }).dashboard.enabled, false);
    assert.equal(parseConfig({ ...base, dashboard: { basePath: '/ops/fleet' } }).dashboard.basePath, '/ops/fleet');
  });
});

describe('dashboard: listener isolation', () => {
  test('disabled: no listener, and the MCP listener serves none of it', async (t) => {
    const h = await startJobHarness(t);
    assert.equal(h.gw.gateway.dashboard, null);
    for (const path of ['/', '/api/snapshot', '/assets/app.js', '/index.html']) {
      assert.equal((await fetch(`${h.gw.baseUrl}${path}`)).status, 404, path);
    }
  });

  test('enabled: the MCP listener still serves none of it, and the dashboard serves no MCP or OAuth', async (t) => {
    const h = await harness(t, { basePath: '/fleet' });
    for (const path of ['/', '/fleet', '/fleet/', '/fleet/api/snapshot', '/fleet/assets/app.js', '/api/snapshot']) {
      const response = await fetch(`${h.gw.baseUrl}${path}`, { headers: API });
      assert.equal(response.status, 404, `MCP listener ${path}`);
    }
    assert.equal((await fetch(`${h.gw.baseUrl}/fleet/api/checks`, { method: 'POST', headers: { ...API, 'content-type': 'application/json' }, body: '{}' })).status, 404);
    for (const path of ['/mcp', '/oauth/token', '/oauth/register', '/oauth/authorize', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/fleet/mcp']) {
      for (const method of ['GET', 'POST']) {
        const response = await raw(h.port, { method, path, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        assert.equal(response.status, 404, `dashboard ${method} ${path}`);
      }
    }
    assert.notEqual(h.port, new URL(h.gw.baseUrl).port, 'separate listeners');
  });

  test('closes with the gateway', async (t) => {
    const h = await harness(t);
    assert.equal((await raw(h.port, { path: '/' })).status, 200);
    await h.gw.gateway.close();
    await assert.rejects(raw(h.port, { path: '/' }), /ECONNREFUSED|ECONNRESET|socket hang up/);
  });
});

describe('dashboard: request handling', () => {
  test('accepts its loopback address and configured hosts only (DNS rebinding), and never Funnel traffic', async (t) => {
    const h = await harness(t);
    for (const host of [`127.0.0.1:${h.port}`, `localhost:${h.port}`, ALLOWED_HOST, ALLOWED_HOST.toUpperCase()]) {
      assert.equal((await raw(h.port, { headers: { host } })).status, 200, host);
    }
    for (const host of ['attacker.example', `attacker.example:${h.port}`, `${ALLOWED_HOST}:8443`, '127.0.0.1', `127.0.0.1:${h.port + 1}`]) {
      const response = await raw(h.port, { headers: { host } });
      assert.equal(response.status, 421, host);
      assert.equal(response.body.includes(host), false, 'the refused host is not echoed');
    }
    const funnel = await raw(h.port, { headers: { host: ALLOWED_HOST, 'tailscale-funnel-request': '?1' } });
    assert.equal(funnel.status, 403);
    const refused = h.gw.logs.filter((line) => line.includes('dashboard.request_refused'));
    assert.ok(refused.length >= 6);
    assert.equal(refused.some((line) => line.includes('attacker')), false, 'refusals log a reason code, not the host');
  });

  test('every response carries a strict CSP and no-store where it matters', async (t) => {
    const h = await harness(t);
    for (const path of ['/', '/assets/app.js', '/assets/app.css', '/api/snapshot', '/nope']) {
      const response = await raw(h.port, { path, headers: API });
      const csp = String(response.headers['content-security-policy']);
      assert.match(csp, /default-src 'none'/, path);
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
      assert.equal(response.headers['x-frame-options'], 'DENY');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal(response.headers['set-cookie'], undefined, 'no session, no cookie');
    }
    assert.equal((await raw(h.port, { path: '/' })).headers['cache-control'], 'no-store');
    assert.equal((await raw(h.port, { path: '/api/snapshot', headers: API })).headers['cache-control'], 'no-store');
    const asset = await raw(h.port, { path: '/assets/app.js' });
    assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await raw(h.port, { path: '/assets/app.js', headers: { 'if-none-match': String(asset.headers.etag) } })).status, 304);
  });

  test('API requests need the dashboard header, same-origin fetch metadata, an allowed Origin and JSON', async (t) => {
    const h = await harness(t);
    assert.equal((await raw(h.port, { path: '/api/snapshot' })).status, 403, 'no header');
    assert.equal((await raw(h.port, { path: '/api/snapshot', headers: { ...API, 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await raw(h.port, { path: '/api/snapshot', headers: { ...API, 'sec-fetch-site': 'same-site' } })).status, 403);
    assert.equal((await raw(h.port, { path: '/api/snapshot', headers: { ...API, origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await raw(h.port, { path: '/api/snapshot', headers: { ...API, origin: 'null' } })).status, 403);
    assert.equal((await raw(h.port, { path: '/api/snapshot', headers: { ...API, 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${h.port}` } })).status, 200);
    assert.equal((await raw(h.port, { path: '/api/snapshot', headers: { ...API, origin: `https://${ALLOWED_HOST}` } })).status, 200);
    const post = (headers: Record<string, string>, body = '{}') => raw(h.port, { method: 'POST', path: '/api/checks', headers, body });
    assert.equal((await post({ 'content-type': 'application/json' })).status, 403, 'no header');
    assert.equal((await post({ ...API, 'content-type': 'application/x-www-form-urlencoded' }, 'a=1')).status, 415, 'a form post cannot run checks');
    assert.equal((await post({ ...API, 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post({ ...API, 'content-type': 'application/json', origin: 'https://attacker.example' })).status, 403);
    assert.equal((await post({ ...API, 'content-type': 'application/json' }, 'x'.repeat(4096))).status, 413);
    assert.equal((await raw(h.port, { method: 'GET', path: '/api/checks', headers: API })).status, 405);
    const preflight = await raw(h.port, { method: 'OPTIONS', path: '/api/checks', headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);
    for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await raw(h.port, { method, path: '/api/snapshot', headers: API })).status, 405, method);
  });

  test('serves under a base path, with relative asset URLs and no inline script or style', async (t) => {
    const h = await harness(t, { basePath: '/ops/fleet' });
    const redirect = await raw(h.port, { path: '/ops/fleet' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.location, '/ops/fleet/');
    const page = await raw(h.port, { path: '/ops/fleet/' });
    assert.equal(page.status, 200);
    assert.match(page.body, /<script type="module" src="assets\/app\.js"><\/script>/);
    assert.doesNotMatch(page.body, /<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/i);
    assert.equal((await raw(h.port, { path: '/ops/fleet/assets/app.css' })).status, 200);
    assert.equal((await raw(h.port, { path: '/ops/fleet/api/snapshot', headers: API })).status, 200);
    assert.equal((await raw(h.port, { path: '/' })).status, 404);
    assert.equal((await raw(h.port, { path: '/api/snapshot', headers: API })).status, 404);
  });
});

describe('dashboard: exposure', () => {
  test('checks confirm through the tunnel that the public URL does not serve the dashboard, and fail when it does', async (t) => {
    const h = await harness(t);
    let run = await runChecks(h.port);
    assert.equal(run.run.results.find((result) => result.id === 'dashboard_exposure')?.code, 'dashboard_not_public');
    // A tunnel pointed at the dashboard's port by mistake: the public URL now reaches the dashboard listener.
    h.gw.door.disconnect();
    h.gw.door.target = h.port;
    h.gw.clock.advance(10_000);
    run = await runChecks(h.port);
    const exposure = run.run.results.find((result) => result.id === 'dashboard_exposure');
    assert.equal(exposure?.level, 'fail');
    assert.equal(exposure?.code, 'dashboard_listener_public', 'refused by Host, and reported');
    h.gw.door.disconnect();
    h.gw.door.target = h.gw.gateway.port;

    // Failed checks need attention on the overview, on this and every later page load, not only on the Checks page.
    const later = await snapshot(h.port);
    const failed = later.attention.filter((item) => item.kind === 'gateway');
    assert.deepEqual(failed.map((item) => [item.ref, item.tone]).sort(), [['dashboard_exposure', 'bad'], ['public_url', 'bad']]);
    assert.ok(failed.every((item) => item.at === later.checks!.finishedAt && item.action?.kind === 'view'));
    assert.equal(later.attention.some((item) => item.kind === 'host'), false, 'the host answered: nothing about it is repeated');
    const app = await loadApp();
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    app.render(doc, root, { snapshot: later, route: { view: 'overview', id: null }, error: null, notice: null, loading: false, checking: false, fetchedAt: Date.now(), jobFilter: 'attention' },
      { refresh() {}, runChecks() {}, setJobFilter() {}, copy() {} });
    assert.doesNotMatch(root.textContent, /All clear/);
    assert.match(root.textContent, /2 things need your attention/);
  });
});

describe('dashboard: hosts', () => {
  test('a page load never contacts T3; checks do, read-only, and report reachability, refusal and outage honestly', async (t) => {
    const h = await harness(t);
    const before = h.fake.calls.length;
    let snap = await snapshot(h.port);
    assert.equal(h.fake.calls.length, before, 'building the snapshot calls nothing on T3');
    const host = snap.hosts[0]!;
    assert.equal(host.reachability.state, 'unchecked');
    assert.equal(host.reachability.checkedAt, null, 'no invented check time');
    assert.equal(host.status.tone, 'unknown');
    assert.equal(snap.checks, null);

    const ledger = ledgerHash(h.gw);
    let checked = await runChecks(h.port);
    assert.deepEqual(h.fake.calls.slice(before), ['t3_environment_read'], 'checks make one read-only call per host');
    assert.equal(ledgerHash(h.gw), ledger, 'checks write nothing');
    snap = checked.snapshot;
    assert.equal(snap.hosts[0]!.reachability.state, 'reachable');
    assert.equal(snap.hosts[0]!.reachability.t3Version, h.fake.serverVersion);
    assert.equal(snap.hosts[0]!.status.label, 'Answering');
    const byId = new Map(checked.run.results.map((result) => [result.id, result]));
    assert.equal(byId.get('database')?.level, 'ok');
    assert.equal(byId.get('data_dir')?.level, 'ok');
    assert.equal(byId.get('public_url')?.code, 'metadata_ok');
    assert.equal(byId.get('host:main:t3')?.code, 'reachable');
    assert.equal(byId.get('host:main:credential')?.code, 'credential_active');

    // T3 refuses the credential: host up, credential rejected, re-enroll advised.
    h.fake.revokeAllTokens();
    h.gw.clock.advance(10_000);
    checked = await runChecks(h.port);
    snap = checked.snapshot;
    assert.equal(snap.hosts[0]!.reachability.state, 'credential_rejected');
    const rejected = snap.attention.find((item) => item.kind === 'host');
    assert.equal(rejected?.tone, 'bad');
    assert.deepEqual(rejected?.action, { kind: 'command', label: 'Enroll again', command: 't3-fleet-gateway hosts enroll main' });

    // The host goes away: unreachable, with a code and fixed text; no claim about which hop failed.
    await h.fake.stop();
    h.gw.clock.advance(10_000);
    snap = (await runChecks(h.port)).snapshot;
    assert.equal(snap.hosts[0]!.reachability.state, 'unreachable');
    assert.equal(snap.hosts[0]!.reachability.errorCode, 'host_unreachable');
    assert.match(snap.hosts[0]!.reachability.detail, /cannot tell which hop failed/);
    assert.equal(snap.hosts[0]!.status.tone, 'bad');
    assert.ok(snap.attention.some((item) => item.title === "Can't reach main"));
    // The page load after it shows the same result with its time, still without contacting T3.
    const calls = h.fake.calls.length;
    const reloaded = await snapshot(h.port);
    assert.equal(reloaded.hosts[0]!.reachability.state, 'unreachable');
    assert.equal(h.fake.calls.length, calls);
  });

  test('a host check has an absolute deadline, even on a connection another caller is still initializing', async (t) => {
    const h = await harness(t);
    const { config, db, clock, logger, registry, jobs } = h.gw.services;
    // Another caller (the engine, discovery) opens the host's shared connection, with the client's long default timeout.
    h.fake.holdResponses.add('initialize');
    const ongoing = registry.client('main').listProjects();
    await h.fake.whenHeld('initialize');
    const checks = new DashboardChecks({ config, db, dataDir: h.gw.dataDir, registry, clock, logger, hostDeadlineMs: 200 });
    const run = await checks.run();
    const t3 = run.results.find((result) => result.id === 'host:main:t3');
    assert.equal(t3?.level, 'fail');
    assert.equal(t3?.code, 't3_timeout', 'a timeout, never a cached or assumed success');
    const sources = {
      config, db, clock, registry, store: jobs.store, engine: h.gw.gateway.engine, startedAt: clock(), mcpListen: 'test', lastChecks: () => checks.last,
    };
    let snap = buildSnapshot(sources);
    assert.equal(snap.hosts[0]!.reachability.state, 'unchecked', 'no answer yet');
    assert.ok(snap.attention.some((item) => item.kind === 'host' && item.ref === 'main' && item.tone === 'bad' && /T3 answers check failed/.test(item.title)));

    // The ongoing operation is unaffected, and the check's own read finishes later and is shown with its own time.
    h.fake.holdResponses.delete('initialize');
    h.fake.releaseHeld();
    assert.ok((await ongoing).length > 0, 'the other caller got its answer');
    const settled = await registry.health('main');
    assert.equal(settled.reachable, true);
    snap = buildSnapshot(sources);
    assert.equal(snap.hosts[0]!.reachability.state, 'reachable');
    assert.equal(snap.attention.some((item) => item.kind === 'host'), false, 'the late answer replaces the timed-out check');
  });

  test('a repeated check within seconds reuses the last run; the engine backoff and job marks are reported', async (t) => {
    const h = await harness(t);
    const first = await runChecks(h.port);
    const calls = h.fake.calls.length;
    const again = await runChecks(h.port);
    assert.equal((again.run as unknown as { reused: boolean }).reused, true);
    assert.equal(h.fake.calls.length, calls);
    assert.equal(first.run.results.length, again.run.results.length);

    await startJob(h.agent, TASK);
    await h.tick();
    await h.fake.stop();
    await h.tick();
    const snap = await snapshot(h.port);
    const host = snap.hosts[0]!;
    assert.ok(host.engine, 'the engine is backing off this host');
    assert.equal(host.engine.errorCode, 'host_unreachable');
    assert.ok(host.engine.failures >= 1);
    assert.ok(host.jobsUnreachableSince);
    assert.equal(host.status.label, 'Unreachable', 'the engine\'s failure counts even though the last check passed');
    assert.ok(snap.jobs.open[0]!.hostUnreachableSince);
  });

  test('a host without a credential is not enrolled; transport notes and policy come from the config', async (t) => {
    const fake = await startFakeT3();
    t.after(() => fake.close());
    const gw = await startTestGateway(t, {
      config: {
        hosts: [
          { id: 'main', t3Url: fake.url, label: 'Main', transportNote: 'SSH tunnel', access: 'auto', maxConcurrentJobs: 3, discovery: { enabled: true, allowWorkStart: true, runtimeMode: 'auto' } },
          { id: 'spare', t3Url: 'http://127.0.0.1:9', label: 'Spare' },
        ],
        projects: [{ alias: 'pilot', host: 'main', t3ProjectId: 'project-1', runtimeMode: 'auto', allowWorkStart: false, description: 'Coordinator only' }],
        dashboard: { enabled: true },
      },
    });
    const snap = await snapshot(dashboardPort(gw));
    const [main, spare] = snap.hosts;
    assert.equal(main!.transportNote, 'SSH tunnel');
    assert.equal(main!.loopback, true);
    assert.equal(main!.capacity.max, 3);
    assert.deepEqual(main!.discovery, { enabled: true, allowWorkStart: true, runtimeMode: 'auto' });
    assert.deepEqual(main!.projects.map((project) => [project.alias, project.allowWorkStart, project.modelConfigured]), [['pilot', false, false]]);
    assert.equal(spare!.reachability.state, 'not_enrolled');
    assert.equal(spare!.credential.state, 'missing');
    assert.ok(snap.attention.some((item) => item.ref === 'spare' && item.action?.kind === 'command'));
    // Never the mint command, its argv or anything else from the host config beyond what is listed above.
    assert.equal(JSON.stringify(snap).includes('pairing'), false);
  });
});

describe('dashboard: clients', () => {
  test('separates what a grant allows from what was observed, and unknown stays unknown', async (t) => {
    const h = await harness(t);
    const bearer = h.gw.services.tokens.issueOperatorToken({ name: 'Notion', scopes: scopesForGrant('operate', 'all'), expiresAt: h.gw.clock() + 30 * 86_400_000 });
    const expiring = h.gw.services.tokens.issueOperatorToken({ name: 'Short lived', scopes: scopesForGrant('read', ['main']), expiresAt: h.gw.clock() + 2 * HOUR });
    await h.agent.call('fleet_status');
    let snap = await snapshot(h.port);
    const byId = new Map(snap.clients.items.map((client) => [client.id, client]));

    const oauth = byId.get(h.agent.clientId)!;
    assert.equal(oauth.kind, 'oauth');
    assert.equal(oauth.grant.state, 'active');
    assert.ok(oauth.observed.lastMcpSuccessAt, 'its requests were observed');
    assert.equal(oauth.status.label, 'Seen recently');
    assert.deepEqual(oauth.redirectOrigins, ['https://agent.example.com']);
    assert.equal(oauth.observed.lastRefreshSuccessAt, null, 'never refreshed: unknown, not invented');

    const notion = byId.get(bearer.clientId)!;
    assert.equal(notion.kind, 'bearer');
    assert.equal(notion.grant.usableAccess, true);
    assert.equal(notion.observed.lastMcpSuccessAt, null);
    assert.equal(notion.status.label, 'Never observed');
    assert.equal(notion.status.tone, 'unknown', 'a usable grant is not shown as connected');
    assert.ok(snap.attention.some((item) => item.ref === bearer.clientId && item.tone === 'info'));
    assert.ok(snap.attention.some((item) => item.ref === expiring.clientId && /expires soon/.test(item.title)), 'bearer expiry warning');
    assert.deepEqual(byId.get(expiring.clientId)!.access.read, ['main']);

    // Expired: unusable, a new token is needed.
    h.gw.clock.advance(3 * HOUR);
    snap = await snapshot(h.port);
    const expired = snap.clients.items.find((client) => client.id === expiring.clientId)!;
    assert.equal(expired.grant.state, 'unusable');
    assert.equal(expired.status.label, 'Token unusable');
    assert.ok(snap.attention.some((item) => item.ref === expiring.clientId && item.tone === 'bad'));

    // Revoked by the operator: listed as revoked, never as an issue.
    h.gw.services.clients.revoke(bearer.clientId);
    snap = await snapshot(h.port);
    assert.equal(snap.clients.items.find((client) => client.id === bearer.clientId)!.grant.state, 'revoked');
    assert.equal(snap.attention.some((item) => item.ref === bearer.clientId), false);
    assert.equal(snap.clients.items.at(-1)!.id, bearer.clientId, 'revoked clients sort last');
  });

  test('a bearer replacement command keeps the token\'s access and hosts, and its name is one literal shell word', async (t) => {
    const h = await harness(t);
    const name = `Reader $(printf EXPANDED) \`printf TICKED\` "quoted" it's \${HOME} \\ end`;
    const restricted = h.gw.services.tokens.issueOperatorToken({ name, scopes: scopesForGrant('read', ['main']), expiresAt: h.gw.clock() + 2 * HOUR });
    const fleet = h.gw.services.tokens.issueOperatorToken({ name: 'Fleet', scopes: scopesForGrant('operate', 'all'), expiresAt: h.gw.clock() + 2 * HOUR });
    const prefixed = h.gw.services.tokens.issueOperatorToken({ name: '--reader', scopes: scopesForGrant('read', ['main']), expiresAt: h.gw.clock() + 2 * HOUR });
    const snap = await snapshot(h.port);
    const command = (clientId: string) => {
      const action = snap.attention.find((item) => item.ref === clientId && /expires soon/.test(item.title))?.action;
      assert.equal(action?.kind, 'command');
      return (action as { command: string }).command;
    };
    // The shell's own parse of the command, with a harmless printf in place of the CLI: one argument per line.
    const argv = (line: string) => execFileSync('/bin/sh', ['-c', line.replace(/^t3-fleet-gateway /, "printf '%s\\n' ")], { encoding: 'utf8' }).split('\n').slice(0, -1);
    assert.deepEqual(argv(command(restricted.clientId)), ['clients', 'token', `--name=${name}`, '--access', 'read', '--hosts', 'main']);
    assert.deepEqual(argv(command(fleet.clientId)), ['clients', 'token', '--name=Fleet', '--access', 'operate', '--hosts', 'all']);
    const parsed = parseArgs({ args: argv(command(prefixed.clientId)).slice(2), options: {
      name: { type: 'string' }, access: { type: 'string' }, hosts: { type: 'string' },
    } });
    assert.deepEqual({ ...parsed.values }, { name: '--reader', access: 'read', hosts: 'main' });
  });

  test('access is what usable tokens carry now: a narrowed refresh or an expired privileged grant never counts', async (t) => {
    const h = await harness(t);
    const { clientId, tokens } = await signIn(h.gw.baseUrl, h.gw.mintApprovalCode, { access: 'operate' });
    const narrowed = await tokenRequest(h.gw.baseUrl, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, scope: 'fleet:read' });
    assert.equal(narrowed.status, 200);
    h.gw.clock.advance(5 * MINUTE);
    let client = (await snapshot(h.port)).clients.items.find((item) => item.id === clientId)!;
    assert.equal(client.access.operate.length, 0, 'the operate tokens were rotated away and their grace window has passed');
    assert.equal(client.access.read, 'all');
    assert.equal(client.access.text, 'read (all hosts)');
    assert.equal(client.access.approved, 'operate (all hosts)', 'the approval ceiling is shown apart');

    // An operate grant that expired, and a newer read-only grant for the same client.
    const second = await signIn(h.gw.baseUrl, h.gw.mintApprovalCode, { access: 'operate' });
    h.gw.clock.advance(91 * DAY);
    await signIn(h.gw.baseUrl, h.gw.mintApprovalCode, { access: 'read', clientId: second.clientId });
    client = (await snapshot(h.port)).clients.items.find((item) => item.id === second.clientId)!;
    assert.equal(client.grant.state, 'active');
    assert.deepEqual([client.access.operate, client.access.read, client.access.approved], [[], 'all', 'operate (all hosts)']);
    const gone = (await snapshot(h.port)).clients.items.find((item) => item.id === clientId)!;
    assert.equal(gone.grant.state, 'unusable');
    assert.deepEqual([gone.access.text, gone.access.operate, gone.access.read], ['-', [], []], 'nothing is accepted from it any more');
  });

  test('token replay is flagged; labels from the config; registrations without approval are listed apart, as text', async (t) => {
    const hostile = '<img src=x onerror=alert(1)> "Agent"';
    const h = await harness(t);
    const { clientId, tokens } = await signIn(h.gw.baseUrl, h.gw.mintApprovalCode, { access: 'operate' });
    h.gw.services.config.dashboard.clientLabels[clientId] = 'Grok Bot';
    const refresh = (token: string) => tokenRequest(h.gw.baseUrl, { grant_type: 'refresh_token', refresh_token: token, client_id: clientId });
    assert.equal((await refresh(tokens.refresh_token)).status, 200);
    h.gw.clock.advance(5 * MINUTE);
    assert.equal((await refresh(tokens.refresh_token)).status, 400, 'replay after the grace window revokes the family');
    await registerClient(h.gw.baseUrl, { client_name: hostile });
    const snap = await snapshot(h.port);
    const client = snap.clients.items.find((item) => item.id === clientId)!;
    assert.equal(client.label, 'Grok Bot');
    assert.equal(client.registeredName, 'Test agent');
    assert.equal(client.grant.state, 'unusable', 'its only grant family was revoked; the client itself was not');
    assert.equal(client.grant.revokedFamilies[0]?.reason, 'refresh_token_reuse');
    assert.ok(client.observed.lastRefreshSuccessAt, 'the earlier successful refresh is recorded');
    const replay = snap.attention.find((item) => item.ref === clientId && /token reuse/.test(item.title));
    assert.equal(replay?.tone, 'bad');
    assert.equal(snap.clients.pending.count, 1);
    assert.equal(snap.clients.pending.recent[0]!.name, hostile, 'kept as text; the page renders it with textContent');
    assert.equal(snap.clients.items.some((item) => item.registeredName === hostile), false, 'an unapproved registration is never a client');
  });

  test('bounded: at most the configured number of clients, with the total', async (t) => {
    const h = await harness(t);
    for (let i = 0; i < LIMITS.clients + 5; i++) {
      h.gw.services.tokens.issueOperatorToken({ name: `Bulk ${i}`, scopes: scopesForGrant('read', 'all'), expiresAt: h.gw.clock() + 86_400_000 });
    }
    const snap = await snapshot(h.port);
    assert.equal(snap.clients.items.length, LIMITS.clients);
    assert.equal(snap.clients.total, LIMITS.clients + 6, 'every established client is counted, the harness agent included');
  });
});

describe('dashboard: jobs and privacy', () => {
  test('attention, links and code-only events; no task, reply, question or delegated title anywhere', async (t) => {
    const h = await harness(t);
    const approval = await startJob(h.agent, TASK);
    const question = await startJob(h.agent, `${TASK} again`);
    await h.tick();
    const approvalThread = h.fake.threadForJob(approval.jobId);
    const questionThread = h.fake.threadForJob(question.jobId);
    h.fake.requestApproval(approvalThread.threadId);
    h.fake.askQuestion(questionThread.threadId, [{ id: 'q1', header: 'Synthetic', question: QUESTION, options: [{ label: OPTION, description: OPTION }] }]);
    await h.tick();
    const failing = await startJob(h.agent, TASK);
    await h.tick();
    h.fake.finishTurn(h.fake.threadForJob(failing.jobId).threadId, REPLY);
    h.fake.userTurn(h.fake.threadForJob(failing.jobId).threadId, REPLY);
    h.fake.failRun(h.fake.threadForJob(failing.jobId).threadId);
    await h.tick();
    const { threadId: coordinator } = h.fake.launchDirect({ projectId: 'project-1', title: 'Synthetic coordinator', message: TASK });
    await h.gw.services.jobs.adopt({ project: 'pilot', threadId: coordinator });
    h.fake.delegate(coordinator, DELEGATED);
    h.fake.endTurn(coordinator);
    await h.tick();

    const snap = await snapshot(h.port);
    const text = JSON.stringify(snap);
    for (const secret of ['SECRET-TASK-TEXT', 'SECRET-WORKER-REPLY', 'SECRET-QUESTION', OPTION, DELEGATED, 'q1']) {
      assert.equal(text.includes(secret), false, `${secret} leaked into the snapshot`);
    }
    const job = (id: string) => [...snap.jobs.open, ...snap.jobs.recent].find((item) => item.id === id)!;
    assert.equal(job(approval.jobId).waitingFor, 'approval');
    assert.equal(job(approval.jobId).link, `t3-thread://v1/${approvalThread.threadId}`);
    assert.equal(job(question.jobId).waitingFor, 'question');
    assert.equal(job(question.jobId).pendingQuestions, 1);
    assert.equal(job(failing.jobId).state, 'failed');
    assert.equal(job(failing.jobId).error?.code, 't3_run_failed');
    assert.equal(job(approval.jobId).title.includes('[job:'), false, 'the marker is not part of the title shown');
    const standing = snap.jobs.open.find((item) => item.standing)!;
    assert.equal(standing.delegated.following, 1, 'counted, never titled');
    assert.equal(standing.startedBy.label, 'Operator (standing job)');
    assert.equal(job(approval.jobId).startedBy.clientId, h.agent.clientId);

    const titles = snap.attention.map((item) => item.title);
    assert.ok(titles.some((title) => /waiting for your approval/.test(title)));
    assert.ok(titles.some((title) => /asked a question/.test(title)));
    assert.ok(titles.some((title) => /failed/.test(title)));
    const approvalItem = snap.attention.find((item) => item.ref === approval.jobId)!;
    assert.deepEqual(approvalItem.action, { kind: 'link', label: 'Open in T3', href: `t3-thread://v1/${approvalThread.threadId}` });

    for (const event of snap.events) {
      assert.deepEqual(Object.keys(event).sort(), ['at', 'code', 'fromState', 'hostId', 'id', 'jobId', 'project', 'reason', 'summary', 'toState', 'type']);
    }
    assert.ok(snap.events.some((event) => event.reason === 'approval' && event.summary === 'running → needs_input (waiting for approval in T3)'));
    assert.ok(snap.events[0]!.id > snap.events.at(-1)!.id, 'newest first');

    // Nothing secret in the logs either, after page loads and checks.
    await runChecks(h.port);
    const log = h.gw.logs.join('\n');
    for (const secret of ['SECRET-TASK-TEXT', 'SECRET-WORKER-REPLY', 'SECRET-QUESTION', OPTION, DELEGATED]) assert.equal(log.includes(secret), false, secret);
  });

  test('never exposes a token, hash, credential, approval code, key or command', async (t) => {
    const h = await harness(t);
    const code = h.gw.services.approvals.mint().code;
    const bearer = h.gw.services.tokens.issueOperatorToken({ name: 'Notion', scopes: scopesForGrant('operate', 'all'), expiresAt: h.gw.clock() + HOUR });
    await startJob(h.agent, TASK);
    await h.tick();
    const db = h.gw.services.db;
    const secrets = [
      code, code.replace('-', ''), bearer.token, h.gw.services.key.toString('hex'), h.gw.services.key.toString('base64'),
      ...(db.prepare('SELECT token_hash AS v FROM access_tokens UNION ALL SELECT token_hash FROM refresh_tokens').all() as { v: string }[]).map((row) => row.v),
      ...(db.prepare('SELECT access_token AS v FROM host_credentials').all() as { v: string }[]).map((row) => row.v),
      ...(db.prepare('SELECT code_hash AS v FROM approval_codes').all() as { v: string }[]).map((row) => row.v),
      '/test/mint', process.execPath,
    ];
    const pages = [JSON.stringify(await snapshot(h.port)), JSON.stringify(await runChecks(h.port)), (await raw(h.port, { path: '/' })).body];
    for (const secret of secrets) {
      for (const page of pages) assert.equal(page.includes(secret), false, `secret material leaked: ${secret.slice(0, 6)}…`);
    }
  });

  test('bounded lists with totals, and links only from safe thread ids', async (t) => {
    const h = await harness(t);
    const store = h.gw.services.jobs.store;
    for (let i = 0; i < LIMITS.openJobs + 20; i++) {
      store.create({
        id: newJobId(), clientId: h.agent.clientId, requestId: `bulk-${i}`, inputHash: `hash-${i}`, projectAlias: 'pilot', hostId: 'main',
        task: TASK, title: `Bulk ${i}`, branch: `fleet/bulk-${i}`, runtimeMode: 'auto',
      });
    }
    const snap = await snapshot(h.port);
    assert.equal(snap.jobs.open.length, LIMITS.openJobs);
    assert.equal(snap.jobs.openTotal, LIMITS.openJobs + 20);
    assert.equal(snap.jobs.counts.queued, LIMITS.openJobs + 20);
    assert.equal(snap.events.length, LIMITS.events);
    assert.ok(snap.attention.length <= LIMITS.attention);
    assert.ok(Buffer.byteLength(JSON.stringify(snap)) < 512 * 1024, 'the snapshot stays small');

    assert.equal(threadLink('thread-123_abc:def.1'), 't3-thread://v1/thread-123_abc:def.1');
    for (const bad of ['', 'a b', 'x/../y', 'javascript:alert(1)//x"', '<script>', 'a'.repeat(201), null]) {
      assert.equal(threadLink(bad), null, String(bad));
    }
    const victim = snap.jobs.open[0]!;
    store.update(victim.id, { threadId: 'thread"><img src=x>' });
    const after = await snapshot(h.port);
    assert.equal(after.jobs.open.find((job) => job.id === victim.id)!.link, null);
  });

  test('scratch jobs (version 2 launch specs) are listed under their alias and host beside discovered and worktree jobs, with no branch', async (t) => {
    const h = await startJobHarness(t, {
      maxConcurrentJobs: 4,
      dashboard: { enabled: true, allowedHosts: [ALLOWED_HOST] },
      host: { discovery: { enabled: true, allowWorkStart: true }, defaultProject: 'pilot' },
      pilot: { workspaceMode: 'scratch' },
    });
    const port = dashboardPort(h.gw);
    const start = async (args: Record<string, unknown>) => (await h.agent.call<{ job: { jobId: string } }>('work_start', { task: TASK, ...args })).job.jobId;
    const scratch = await start({ target: { host: 'main' }, requestId: 'dash-scratch', title: 'Synthetic scratch job' });
    const named = await start({ project: 'pilot', requestId: 'dash-scratch-alias' });
    const discovered = await start({ target: { host: 'main', projectId: 'project-3' }, requestId: 'dash-discovered' });
    const worktree = await start({ project: 'docs', requestId: 'dash-worktree' });
    const jobs = [scratch, named, discovered, worktree];
    const specs = jobs.map((id) => h.gw.services.jobs.store.require(id).launchSpec?.v ?? null);
    assert.deepEqual(specs, [2, 2, 1, null], 'a version 2 spec, a version 1 spec and no spec all reach the dashboard');
    await h.tick();

    const snap = await snapshot(port);
    const job = (id: string) => snap.jobs.open.find((item) => item.id === id)!;
    for (const id of [scratch, named]) {
      assert.deepEqual([job(id).project, job(id).projectName, job(id).hostId, job(id).state, job(id).standing], ['pilot', null, 'main', 'running', false]);
      assert.equal(job(id).link, `t3-thread://v1/${h.fake.threadForJob(id).threadId}`);
      assert.equal(job(id).startedBy.clientId, h.agent.clientId);
    }
    assert.equal(job(scratch).title, 'Synthetic scratch job', 'the caller\'s title, without the thread marker');
    assert.deepEqual([job(discovered).project, job(discovered).projectName], ['@main/project-3', 'Synthetic project 3']);
    assert.deepEqual([job(worktree).project, job(worktree).projectName], ['docs', null]);
    const host = snap.hosts.find((candidate) => candidate.id === 'main')!;
    assert.equal(host.projects.find((project) => project.alias === 'pilot')!.openJobs, 2);
    assert.equal(host.discoveredOpenJobs, 1, 'only the job in a project with no alias counts as discovered');
    const scratchEvents = snap.events.filter((event) => event.jobId === scratch);
    assert.ok(scratchEvents.length >= 2, 'created and launched');
    assert.ok(scratchEvents.every((event) => event.project === 'pilot' && event.hostId === 'main'));

    // Nothing about the workspace or a branch: not for the scratch job, and not for the worktree jobs either.
    const text = JSON.stringify(snap);
    for (const id of jobs) {
      assert.equal(Object.keys(job(id)).some((key) => /branch|workspace|launch|baseRef/i.test(key)), false, id);
      assert.equal(text.includes(`agents/${id}`) || text.includes(`fleet/${id}`), false, `branch of ${id}`);
    }
    assert.equal(text.includes('SECRET-TASK-TEXT'), false);
    assert.equal(snap.attention.some((item) => jobs.includes(item.ref)), false, 'running jobs need nothing from the operator');
  });
});
