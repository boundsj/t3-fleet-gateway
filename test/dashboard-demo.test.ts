import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { startDemoFleet, type Scenario } from '../scripts/lib/demo-fleet.ts';
import type { DashboardSnapshot } from '../src/dashboard/snapshot.ts';
import { assertSafeTree, loadApp, VIEWS } from './helpers/dashboardApp.ts';
import { FakeDocument } from './helpers/fakeDom.ts';

/**
 * The synthetic demo fleet (scripts/dashboard-demo.ts) end to end: each scenario seeds through the gateway's public
 * paths, the dashboard serves a snapshot that says what the scenario promises, holds none of the synthetic task, reply,
 * question or delegated-task text the fake workers carry, and every view renders safely from it.
 */

const FORBIDDEN = ['Synthetic task', 'Synthetic reply', 'Synthetic question', 'Synthetic delegated', 'Synthetic follow-up', 'Synthetic delegate call', 'Coordinate the harbor'];

async function withFleet(scenario: Scenario, check: (snap: DashboardSnapshot) => void): Promise<void> {
  const fleet = await startDemoFleet({ scenario, badge: 'Synthetic demo' });
  try {
    const response = await fetch(new URL('api/snapshot', fleet.dashboardUrl), { headers: { 'x-t3fg-dashboard': '1' } });
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const content of FORBIDDEN) assert.equal(text.includes(content), false, `${scenario}: "${content}" reached the dashboard`);
    const snap = JSON.parse(text) as DashboardSnapshot;
    assert.equal(snap.demoLabel, 'Synthetic demo');
    check(snap);
    const app = await loadApp();
    for (const view of VIEWS) {
      const doc = new FakeDocument();
      const root = doc.createElement('div');
      app.render(doc, root, { snapshot: snap, route: { view, id: null }, error: null, notice: null, loading: false, checking: false, fetchedAt: Date.now(), jobFilter: 'attention' },
        { refresh() {}, runChecks() {}, setJobFilter() {}, copy() {} });
      assertSafeTree(root);
      assert.ok(root.textContent.length > 200, `${scenario}/${view} rendered`);
    }
  } finally {
    await fleet.close();
  }
}

describe('dashboard demo fleet', () => {
  test('mixed: a host down, work waiting, a failure, a client never observed, a renewal failure', async () => {
    await withFleet('mixed', (snap) => {
      const hosts = new Map(snap.hosts.map((host) => [host.id, host]));
      assert.equal(hosts.get('forge')!.reachability.state, 'unreachable');
      assert.equal(hosts.get('studio')!.status.tone, 'good');
      assert.equal(hosts.get('lab')!.credential.renewalError?.code, 'enrollment_failed');
      const clients = new Map(snap.clients.items.map((client) => [client.label, client]));
      assert.deepEqual([...clients.keys()].sort(), ['Grok Bot', 'Muse', 'Notion']);
      assert.equal(clients.get('Notion')!.status.label, 'Never observed');
      assert.equal(clients.get('Grok Bot')!.registeredName, 'Grok connector');
      assert.ok(clients.get('Grok Bot')!.observed.lastRefreshSuccessAt);
      assert.equal(snap.clients.pending.count, 1);
      const states = snap.jobs.counts;
      assert.equal(states.needs_input, 2);
      assert.equal(states.failed, 0);
      assert.ok(snap.jobs.open.some((job) => job.state === 'idle' && job.error?.code === 't3_run_failed'));
      assert.equal(states.cancelled, 1);
      assert.ok(snap.jobs.open.some((job) => job.standing && job.delegated.following === 2));
      assert.ok(snap.attention.filter((item) => item.tone === 'bad' || item.tone === 'warn').length >= 4);
      assert.equal(snap.checks?.results.find((result) => result.id === 'public_url')?.level, 'ok', 'the public URL check reaches the demo gateway');
    });
  });

  test('healthy: nothing needs the operator', async () => {
    await withFleet('healthy', (snap) => {
      assert.ok(snap.hosts.every((host) => host.status.tone === 'good'), JSON.stringify(snap.hosts.map((host) => host.status)));
      assert.ok(snap.clients.items.every((client) => client.status.label === 'Seen recently'));
      assert.equal(snap.attention.filter((item) => item.tone === 'bad' || item.tone === 'warn').length, 0, JSON.stringify(snap.attention.map((item) => item.title)));
    });
  });

  test('auth-issue: token reuse revokes a grant and a bearer token nears expiry', async () => {
    await withFleet('auth-issue', (snap) => {
      const muse = snap.clients.items.find((client) => client.label === 'Muse')!;
      assert.equal(muse.grant.state, 'unusable');
      assert.equal(muse.grant.revokedFamilies[0]?.reason, 'refresh_token_reuse');
      assert.ok(snap.attention.some((item) => item.ref === muse.id && item.tone === 'bad'));
      assert.ok(snap.attention.some((item) => /bearer token expires soon/.test(item.title)));
    });
  });

  test('empty: freshly enrolled hosts and no connected agents', async () => {
    await withFleet('empty', (snap) => {
      assert.equal(snap.clients.items.length, 0);
      assert.equal(snap.jobs.openTotal, 0);
      assert.equal(snap.events.length, 0);
      assert.equal(snap.checks, null);
      assert.ok(snap.hosts.every((host) => host.reachability.state === 'reachable'));
    });
  });

  test('local webhook demo exercises connect, rejected and timed-out replacement, test and disconnect', async () => {
    const fleet = await startDemoFleet({ scenario: 'empty', webhookReceiver: true });
    try {
      const receiver = fleet.webhookReceiver!;
      const headers = { 'x-t3fg-dashboard': '1', 'content-type': 'application/json', origin: new URL(fleet.dashboardUrl).origin };
      const list = async () => {
        const response = await fetch(new URL('api/webhooks', fleet.dashboardUrl), { headers });
        assert.equal(response.status, 200);
        const text = await response.text();
        for (const secret of [receiver.acceptUrl, receiver.rejectUrl, receiver.timeoutUrl, receiver.authHeader, 'demo-only-key']) {
          assert.equal(text.includes(secret), false, 'management GET never returns saved URL/header material');
        }
        return JSON.parse(text) as {
          session: string;
          connections: { id: string; revision: string; source: string; projects: string[]; hosts: string[] }[];
        };
      };
      const first = await list();
      assert.deepEqual(first.connections, []);
      const mutate = async (action: string, input: Record<string, unknown>) => {
        const response = await fetch(new URL(`api/webhooks/${action}`, fleet.dashboardUrl), {
          method: 'POST', headers, body: JSON.stringify({ session: first.session, requestId: randomUUID(), ...input }),
        });
        return { status: response.status, body: await response.json() as { error?: string; code?: string; test?: { outcome: string; statusCode: number | null } } };
      };
      const blocked = await mutate('connect', { project: 'atlas-web', url: 'https://receiver.example.test/never-contacted', authHeader: receiver.authHeader });
      assert.equal(blocked.status, 400);
      assert.equal(blocked.body.error, 'invalid_route');
      assert.deepEqual(receiver.counts, { accepted: 0, rejected: 0, stalled: 0 });

      const connected = await mutate('connect', { project: 'atlas-web', url: receiver.acceptUrl, authHeader: receiver.authHeader });
      assert.equal(connected.status, 200);
      assert.equal(connected.body.code, 'connected');
      assert.deepEqual(connected.body.test, { outcome: 'delivered', statusCode: 202 });
      const connection = (await list()).connections[0]!;
      assert.equal(connection.source, 'dashboard');
      assert.deepEqual(connection.projects, ['atlas-web']);
      assert.deepEqual(connection.hosts, ['studio']);
      const target = { id: connection.id, revision: connection.revision };
      for (const [url, outcome, statusCode] of [[receiver.rejectUrl, 'http_error', 401], [receiver.timeoutUrl, 'timeout', null]] as const) {
        const rejected = await mutate('replace', { ...target, url, authHeader: receiver.authHeader });
        assert.equal(rejected.status, 502);
        assert.deepEqual(rejected.body.test, { outcome, statusCode });
        assert.equal((await list()).connections[0]!.revision, target.revision, 'failed test preserves working connection');
      }
      const tested = await mutate('test', target);
      assert.equal(tested.status, 200);
      assert.deepEqual(tested.body.test, { outcome: 'delivered', statusCode: 202 });
      assert.deepEqual(receiver.counts, { accepted: 2, rejected: 1, stalled: 1 });
      assert.equal((await mutate('disconnect', target)).status, 200);
      assert.deepEqual((await list()).connections, []);
    } finally {
      await fleet.close();
    }
  });
});
