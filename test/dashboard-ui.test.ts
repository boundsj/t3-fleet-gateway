import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { DashboardSnapshot } from '../src/dashboard/snapshot.ts';
import { APP_URL, assertSafeTree, loadApp, VIEWS } from './helpers/dashboardApp.ts';
import { FakeDocument } from './helpers/fakeDom.ts';

const EVIL = '<img src=x onerror=alert(1)>"\'><script>alert(2)</script>';
const NOW = '2026-01-15T12:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

/** Every string the server could carry from untrusted or operator-written input is hostile here. */
function hostileSnapshot(): DashboardSnapshot {
  const job = (id: string, state: DashboardSnapshot['jobs']['open'][number]['state'], link: string | null) => ({
    id, title: `${EVIL} job`, project: EVIL, projectName: EVIL, hostId: 'h1', state, standing: false,
    startedBy: { clientId: 'c1', label: EVIL }, runtimeMode: EVIL, createdAt: ago(60), stateChangedAt: ago(5), updatedAt: ago(5), finishedAt: ago(5),
    waitingFor: state === 'needs_input' ? 'approval' as const : null, pendingQuestions: 0,
    delegated: { following: 1, untracked: 0, endedAt: null }, hostUnreachableSince: ago(3), error: { code: EVIL, detail: EVIL }, link,
  });
  const jobs = [job('j1', 'needs_input', 'javascript:alert(1)'), job('j2', 'failed', 't3-thread://v1/thread-1'), job('j3', 'running', 'https://attacker.example/x')];
  return {
    generatedAt: NOW,
    demoLabel: EVIL,
    gateway: {
      name: 't3-fleet-gateway', version: EVIL, node: 'v24', startedAt: ago(600), publicUrl: EVIL, mcpListen: EVIL,
      engine: { running: true, intervalSeconds: 10, lastTickAt: ago(0) }, database: { schemaVersion: 8, expectedVersion: 8 },
    },
    checks: {
      startedAt: ago(1), finishedAt: ago(1), reused: false,
      results: [
        { id: 'public_url', group: 'gateway', hostId: null, name: EVIL, level: 'fail', code: EVIL, detail: EVIL },
        { id: 'host:h1:t3', group: 'host', hostId: 'h1', name: EVIL, level: 'warn', code: EVIL, detail: EVIL },
      ],
    },
    hosts: [{
      id: 'h1', label: EVIL, transportNote: EVIL, t3Url: EVIL, loopback: false, status: { tone: 'bad', label: EVIL },
      reachability: { state: 'unreachable', checkedAt: ago(1), t3Version: EVIL, errorCode: EVIL, detail: EVIL },
      engine: { unreachableSince: ago(4), nextAttemptAt: ago(-1), failures: 2, errorCode: EVIL }, jobsUnreachableSince: ago(4),
      credential: { state: 'renewal_due', expiresAt: ago(-3000), daysLeft: 2, renewalError: { code: EVIL, at: ago(30), detail: EVIL } },
      access: EVIL, capacity: { max: 2, used: 5, queued: 1, open: 3, standingOpen: 1 },
      discovery: { enabled: true, allowWorkStart: true, runtimeMode: EVIL },
      projects: [{ alias: EVIL, description: EVIL, runtimeMode: EVIL, allowWorkStart: false, modelConfigured: false, openJobs: 1, standingJobs: 1 }],
      discoveredOpenJobs: 1,
    }],
    clients: {
      items: [{
        id: 'c1', label: EVIL, registeredName: `${EVIL}2`, kind: 'oauth', redirectOrigins: [EVIL],
        access: { text: EVIL, operate: [EVIL], read: 'all', unconfiguredHosts: [EVIL], approved: EVIL },
        grant: { state: 'unusable', usableAccess: false, usableRefresh: false, accessUsableUntil: null, refreshUsableUntil: null, families: 2,
          revokedFamilies: [{ at: ago(10), reason: EVIL, detail: EVIL }] },
        observed: { lastMcpSuccessAt: null, lastRefreshSuccessAt: ago(100), lastUsedAt: ago(100) },
        createdAt: ago(1000), revokedAt: null, status: { tone: 'bad', label: EVIL, detail: EVIL },
      }],
      total: 1,
      pending: { count: 1, recent: [{ id: 'p1', name: EVIL, createdAt: ago(20) }] },
    },
    jobs: { counts: { queued: 0, dispatching: 0, running: 1, needs_input: 1, idle: 0, cancel_requested: 0, cancelled: 0, failed: 1, unknown: 0, released: 0 },
      open: jobs.filter((item) => item.state !== 'failed'), openTotal: 2, recent: jobs.filter((item) => item.state === 'failed'), attention: jobs },
    events: [{ id: 1, at: ago(2), jobId: 'j1', hostId: 'h1', project: EVIL, type: 'state_changed', fromState: 'running', toState: 'needs_input', reason: EVIL, code: EVIL, summary: EVIL }],
    attention: [
      { tone: 'bad', kind: 'job', ref: 'j1', title: EVIL, detail: EVIL, at: ago(1), action: { kind: 'link', label: EVIL, href: 'javascript:alert(1)' } },
      { tone: 'warn', kind: 'host', ref: 'h1', title: EVIL, detail: EVIL, at: null, action: { kind: 'command', label: EVIL, command: EVIL } },
      { tone: 'info', kind: 'client', ref: 'c1', title: EVIL, detail: EVIL, at: null, action: { kind: 'view', label: EVIL, view: '../../evil"' } },
    ],
  } as DashboardSnapshot;
}

const actions = () => {
  const calls: string[] = [];
  return {
    calls,
    handlers: {
      refresh: () => calls.push('refresh'),
      runChecks: () => calls.push('runChecks'),
      setJobFilter: (filter: unknown) => calls.push(`filter:${String(filter)}`),
      copy: (text: unknown) => calls.push(`copy:${String(text)}`),
    },
  };
};

describe('dashboard page: safe rendering', () => {
  test('the browser code has no HTML-parsing, eval, storage or cookie APIs, and the page shell no inline code', () => {
    // Comments name the forbidden APIs; code must not use them.
    const source = readFileSync(APP_URL, 'utf8').replaceAll(/^\s*\/\/.*$/gm, '').replaceAll(/\/\*[\s\S]*?\*\//g, '');
    for (const pattern of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /localStorage/, /sessionStorage/, /document\.cookie/, /\.style\s*=/, /setAttribute\(\s*['"]style/]) {
      assert.equal(pattern.test(source), false, String(pattern));
    }
    const html = readFileSync(new URL('../src/dashboard/assets/index.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=|https?:\/\//i);
    const css = readFileSync(new URL('../src/dashboard/assets/app.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /url\(|@import|https?:/, 'no external or embedded resources in the stylesheet');
  });

  test('hostile text renders as text in every view; unsafe links are dropped', async () => {
    const app = await loadApp();
    const snap = hostileSnapshot();
    for (const view of VIEWS) {
      const doc = new FakeDocument();
      const root = doc.createElement('div');
      const { handlers } = actions();
      app.render(doc, root, { snapshot: snap, route: { view, id: null }, error: null, notice: null, loading: false, checking: false, fetchedAt: Date.parse(NOW), jobFilter: 'attention' }, handlers, Date.parse(NOW));
      assertSafeTree(root);
      assert.ok(root.textContent.includes(EVIL), `${view} shows hostile text verbatim, as text`);
      const hrefs = root.elements('a').map((link) => link.getAttribute('href'));
      assert.equal(hrefs.some((href) => href?.startsWith('javascript') || href?.startsWith('https://attacker')), false, view);
    }
  });

  test('a thread link of the documented form is kept; the job and its actions are wired', async () => {
    const app = await loadApp();
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const { calls, handlers } = actions();
    const model = { snapshot: hostileSnapshot(), route: { view: 'jobs', id: null }, error: null, notice: null, loading: false, checking: false, fetchedAt: Date.parse(NOW), jobFilter: 'attention' };
    app.render(doc, root, model, handlers, Date.parse(NOW));
    const threadLinks = root.elements('a').filter((link) => link.getAttribute('href')?.startsWith('t3-thread:'));
    assert.deepEqual(threadLinks.map((link) => link.getAttribute('href')), ['t3-thread://v1/thread-1'], 'only the safe link of the three');
    root.click('Open');
    assert.deepEqual(calls, ['filter:open']);
    app.render(doc, root, { ...model, route: { view: 'checks', id: null } }, handlers, Date.parse(NOW));
    root.click('Run checks');
    app.render(doc, root, { ...model, route: { view: 'overview', id: null } }, handlers, Date.parse(NOW));
    root.click('Copy');
    assert.deepEqual(calls, ['filter:open', 'runChecks', `copy:${EVIL}`]);
  });

  test('loading, error and busy states; unknown times are never invented', async () => {
    const app = await loadApp();
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const { handlers } = actions();
    app.render(doc, root, { snapshot: null, route: { view: 'overview', id: null }, error: 'The gateway did not answer.', notice: null, loading: true, checking: false, fetchedAt: 0, jobFilter: 'attention' }, handlers);
    assert.match(root.textContent, /The gateway did not answer\./);
    assert.equal(root.getAttribute('aria-busy'), 'true');
    const snap = hostileSnapshot();
    app.render(doc, root, { snapshot: snap, route: { view: 'clients', id: 'c1' }, error: null, notice: null, loading: false, checking: true, fetchedAt: Date.parse(NOW), jobFilter: 'attention' }, handlers, Date.parse(NOW));
    assert.match(root.textContent, /Last successful requestunknown/, 'a null success time reads unknown');
    assert.ok(root.elements('article').some((card) => card.getAttribute('class')?.includes('is-selected')), 'the linked client is highlighted');
    app.render(doc, root, { snapshot: snap, route: { view: 'checks', id: null }, error: null, notice: null, loading: false, checking: true, fetchedAt: Date.parse(NOW), jobFilter: 'attention' }, handlers, Date.parse(NOW));
    const busy = root.elements('button').find((button) => button.textContent.includes('Checking'));
    assert.equal(busy?.getAttribute('aria-busy'), 'true');
    assert.equal(busy?.getAttribute('disabled'), '');
  });

  test('routes and links are parsed strictly', async () => {
    const app = await loadApp();
    assert.deepEqual(app.parseRoute('#/hosts/forge'), { view: 'hosts', id: 'forge' });
    assert.deepEqual(app.parseRoute('#/clients/a"b'), { view: 'clients', id: null });
    assert.deepEqual(app.parseRoute('#/nowhere'), { view: 'overview', id: null });
    assert.deepEqual(app.parseRoute(''), { view: 'overview', id: null });
    for (const good of ['#/jobs', '#/hosts/forge', 't3-thread://v1/abc-1']) assert.equal(app.safeHref(good), true, good);
    for (const bad of ['javascript:alert(1)', 'https://example.com', '//evil', 't3-thread://v1/a b', 't3-thread://v2/x', '#/x"y', 'data:text/html,x', null]) {
      assert.equal(app.safeHref(bad), false, String(bad));
    }
  });
});
