import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway } from './helpers/gateway.ts';
import { signIn } from './helpers/oauthFlow.ts';

interface FleetStatus {
  gateway: { name: string; version: string };
  hosts: {
    id: string;
    label: string | null;
    reachable: boolean | null;
    t3Version: string | null;
    error: { code: string } | null;
    credential: { state: string; daysLeft: number | null; expiresAt: string | null; renewalError: { code: string } | null };
    maxConcurrentJobs: number;
    runningJobs: number;
    queuedJobs: number;
  }[];
  projects: { alias: string; description: string; host: string }[];
}

test('fleet_status reports hosts, credentials, job counts and projects', async (t) => {
  const up = await startFakeT3({ serverVersion: '1.2.3' });
  const down = await startFakeT3({ tokenLifetimeSeconds: 2 * 86400 });
  t.after(async () => {
    await up.stop();
    await down.stop();
  });
  const gw = await startTestGateway(t, {
    config: {
      hosts: [
        { id: 'alpha', label: 'Primary', t3Url: up.url, mintPairingCode: up.mintCommand(), maxConcurrentJobs: 3 },
        { id: 'beta', t3Url: down.url, mintPairingCode: down.mintCommand() },
        { id: 'gamma', t3Url: 'http://127.0.0.1:9' },
      ],
      projects: [
        { alias: 'pilot', description: 'Scratch repository', host: 'alpha', t3ProjectTitle: 'Synthetic project 1' },
        { alias: 'docs', host: 'beta', t3ProjectId: 'project-2' },
      ],
    },
  });
  const { registry } = gw.services;
  await registry.enroll('alpha');
  await registry.enroll('beta');
  down.rejectDecisions = true;
  await registry.renewDue();
  await down.stop();
  const insertJob = gw.services.db.prepare(
    `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, created_at, updated_at)
     VALUES (?, 'c', ?, 'pilot', 'alpha', ?, 'synthetic task', 't', 'b', 'approval-required', 0, 0)`,
  );
  for (const [id, state] of [['j1', 'running'], ['j2', 'needs_input'], ['j3', 'queued'], ['j4', 'failed'], ['j5', 'idle']] as const) {
    insertJob.run(id, id, state);
  }

  const { tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
  const client = new Client({ name: 'agent', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gw.baseUrl}/mcp`), { authProvider: { token: async () => tokens.access_token } }));
  t.after(() => client.close());
  const result = await client.callTool({ name: 'fleet_status', arguments: {} });
  assert.notEqual(result.isError, true);
  const status = result.structuredContent as unknown as FleetStatus;

  assert.equal(status.gateway.name, 't3-fleet-gateway');
  const [alpha, beta, gamma] = status.hosts;
  assert.equal(alpha?.reachable, true);
  assert.equal(alpha?.t3Version, '1.2.3');
  assert.equal(alpha?.label, 'Primary');
  assert.equal(alpha?.credential.state, 'active');
  assert.equal(alpha?.credential.daysLeft, 30, 'the test clock has not moved since enrollment');
  assert.equal(alpha?.maxConcurrentJobs, 3);
  assert.equal(alpha?.runningJobs, 2);
  assert.equal(alpha?.queuedJobs, 1);
  assert.equal(beta?.reachable, false);
  assert.equal(beta?.error?.code, 'host_unreachable');
  assert.equal(beta?.credential.state, 'renewal_due');
  assert.equal(beta?.credential.renewalError?.code, 'enrollment_failed');
  assert.equal(gamma?.reachable, null);
  assert.equal(gamma?.credential.state, 'missing');
  assert.deepEqual(status.projects, [
    { alias: 'pilot', description: 'Scratch repository', host: 'alpha' },
    { alias: 'docs', description: '', host: 'beta' },
  ]);
  const text = JSON.stringify(result.content);
  assert.match(text, /alpha: reachable, T3 1\.2\.3; credential expires in 30 days; 2 running, 1 queued \(max 3\)/);
  assert.match(text, /beta: unreachable; credential expires in 2 days, last renewal failed \(enrollment_failed\)/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic task/, 'no task text in status');
});

test('fleet_status reports a host that rejects the credential as reachable with a rejected credential', async (t) => {
  const fake = await startFakeT3({ serverVersion: '1.2.3' });
  t.after(() => fake.stop());
  const gw = await startTestGateway(t, { config: { hosts: [{ id: 'alpha', t3Url: fake.url, mintPairingCode: fake.mintCommand() }] } });
  await gw.services.registry.enroll('alpha');
  fake.revokeAllTokens();
  const { tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
  const client = new Client({ name: 'agent', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gw.baseUrl}/mcp`), { authProvider: { token: async () => tokens.access_token } }));
  t.after(() => client.close());
  const result = await client.callTool({ name: 'fleet_status', arguments: {} });
  const [alpha] = (result.structuredContent as unknown as FleetStatus).hosts;
  assert.equal(alpha?.reachable, true);
  assert.equal(alpha?.t3Version, null);
  assert.equal(alpha?.error?.code, 't3_unauthorized');
  assert.equal(alpha?.credential.state, 'rejected');
  const text = JSON.stringify(result.content);
  assert.match(text, /alpha: reachable; credential rejected by T3 \(the operator must run: t3-fleet-gateway hosts enroll alpha\)/);
  assert.doesNotMatch(text, /T3 null/);
});
