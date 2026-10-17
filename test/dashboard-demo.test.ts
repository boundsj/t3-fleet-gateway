import assert from 'node:assert/strict';
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
      assert.equal(states.failed, 1);
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

  test('empty: a fresh install, unchecked and unconnected', async () => {
    await withFleet('empty', (snap) => {
      assert.equal(snap.clients.items.length, 0);
      assert.equal(snap.jobs.openTotal, 0);
      assert.equal(snap.events.length, 0);
      assert.equal(snap.checks, null);
      assert.ok(snap.hosts.every((host) => host.reachability.state === 'unchecked'));
    });
  });
});
