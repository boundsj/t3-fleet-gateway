import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Server, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { gatewayTools, startGateway, type GatewayServices } from '../src/gateway.ts';
import { silentLogger } from '../src/log.ts';
import { DAY } from '../src/time.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway } from './helpers/gateway.ts';
import { agentWithToken, startJob } from './helpers/jobs.ts';
import { tempDir } from './helpers/tmp.ts';

async function establishedGateway(t: TestContext) {
  const fake = await startFakeT3({ tokenLifetimeSeconds: 2 * DAY / 1000 });
  t.after(() => fake.close());
  const received: { path: string | undefined; body: string }[] = [];
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ path: req.url, body: Buffer.concat(chunks).toString() });
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  const dataDir = join(tempDir(t), 'data');
  mkdirSync(dataDir, { mode: 0o700 });
  writeFileSync(join(dataDir, 'sender.key'), 'synthetic-private-startup-key', { mode: 0o600 });
  const gw = await startTestGateway(t, {
    dataDir,
    config: {
      hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand() }],
      projects: [{ alias: 'pilot', host: 'main', t3ProjectId: 'project-1' }],
      dashboard: { enabled: true },
      webhooks: { subscriptions: [{ id: 'routine', enabled: true, url: `${origin}/original-recipient`,
        auth: { header: 'X-Synthetic-Sender', secretFile: 'sender.key' }, allowLoopbackHttp: true }] },
    },
    webhookSender: { autoStart: false }, jobEngine: { autoStart: false },
  });
  await gw.services.registry.enroll('main');
  const grant = gw.services.tokens.issueOperatorToken({
    name: 'Synthetic startup agent', scopes: ['fleet:read', 'fleet:operate'], expiresAt: gw.clock() + DAY,
  });
  const agent = await agentWithToken(t, gw.baseUrl, grant.clientId, grant.token);
  const job = await startJob(agent, 'Synthetic startup task', { title: 'Synthetic startup job' });
  await agent.call('work_cancel', { jobId: job.jobId });
  const snapshot = () => ['webhook_subscriptions', 'webhook_deliveries', 'webhook_attempts'].map((table) =>
    gw.services.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot();
  assert.equal(before[1]!.length, 1, 'the existing gateway has a committed pending delivery');
  const pending = before[1]![0]!;
  assert.equal(pending.state, 'pending');
  assert.ok(pending.payload);
  const changed = parseConfig({
    ...gw.services.config,
    hosts: [{ ...gw.services.config.hosts[0], mintPairingCodeProbe: [process.execPath, '--version'] }],
    webhooks: { subscriptions: [{ ...gw.services.config.webhooks.subscriptions[0], url: `${origin}/replacement-recipient` }] },
  });
  return { gw, fake, agent, job, changed, before, pending, snapshot, received };
}

/** Observe actual listener lifetimes without replacing socket creation, binding, errors, or reconciliation. */
function observeListeners(t: TestContext) {
  const original = Server.prototype.listen;
  const listeners: { server: Server; boundPort: number | null }[] = [];
  const spy = t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
    const entry = { server: this, boundPort: null as number | null };
    listeners.push(entry);
    this.once('listening', () => { entry.boundPort = (this.address() as AddressInfo).port; });
    return (original as (...input: unknown[]) => Server).apply(this, args);
  });
  return { listeners, restore: () => spy.mock.restore() };
}

async function failedStartup(t: TestContext, h: Awaited<ReturnType<typeof establishedGateway>>, options: {
  occupied?: 'mcp' | 'dashboard'; secretFile?: string;
}) {
  const config = options.secretFile ? parseConfig({ ...h.changed, webhooks: { subscriptions: [{
    ...h.changed.webhooks.subscriptions[0], auth: { header: 'X-Synthetic-Sender', secretFile: options.secretFile },
  }] } }) : h.changed;
  const downstreamCalls = [...h.fake.calls];
  const observed = observeListeners(t);
  let services: GatewayServices | undefined;
  const calls = { preflight: 0, renewal: 0, downstreamClient: 0, command: 0, close: 0 };
  let failure: unknown;
  try {
    const unexpected = await startGateway({
      config, dataDir: h.gw.dataDir, logger: silentLogger, clock: h.gw.clock,
      port: options.occupied === 'mcp' ? h.gw.gateway.port : 0,
      dashboardPort: options.occupied === 'dashboard' ? h.gw.gateway.dashboard!.port : 0,
      runCommand: async () => { calls.command++; return 'synthetic command output'; },
      tools(current) {
        services = current;
        const preflight = current.registry.preflight.bind(current.registry);
        const renewDue = current.registry.renewDue.bind(current.registry);
        const client = current.registry.client.bind(current.registry);
        const close = current.close.bind(current);
        t.mock.method(current.registry, 'preflight', (...args: Parameters<typeof preflight>) => { calls.preflight++; return preflight(...args); });
        t.mock.method(current.registry, 'renewDue', () => { calls.renewal++; return renewDue(); });
        t.mock.method(current.registry, 'client', (...args: Parameters<typeof client>) => { calls.downstreamClient++; return client(...args); });
        t.mock.method(current, 'close', async () => { calls.close++; await close(); });
        return gatewayTools(current);
      },
    });
    await unexpected.close();
    assert.fail('a failed startup unexpectedly succeeded');
  } catch (error) {
    failure = error;
  } finally {
    observed.restore();
  }
  assert.ok(failure instanceof Error);
  assert.equal((failure as NodeJS.ErrnoException).code, options.occupied ? 'EADDRINUSE' : 'config_invalid');
  assert.ok(services, 'startup constructed the real services before trying to reserve its listeners');
  const failedServices = services;
  assert.equal(calls.close, 1, 'failed startup closes its own services exactly once');
  assert.throws(() => failedServices.db.prepare('SELECT 1'), /closed|not open/i);
  assert.deepEqual({ ...calls, close: 0 }, { preflight: 0, renewal: 0, downstreamClient: 0, command: 0, close: 0 },
    'failed startup never invokes command probes, renewal, model discovery or job-engine downstream work');
  assert.deepEqual(h.fake.calls, downstreamCalls, 'the enrolled synthetic host received no startup traffic');
  const expectedBinds = options.occupied === 'mcp' ? 0 : options.occupied === 'dashboard' ? 1 : 2;
  assert.equal(observed.listeners.filter((entry) => entry.boundPort !== null).length, expectedBinds);
  for (const { server } of observed.listeners) {
    assert.equal(server.listening, false);
    assert.equal(server.address(), null, 'every listener owned by the failed startup is closed');
  }
  assert.deepEqual(h.snapshot(), h.before, 'route revision, immutable pending payload and attempts remain byte-for-byte unchanged');
  const status = await h.agent.call<{ state: string }>('work_status', { jobId: h.job.jobId });
  assert.equal(status.state, 'cancelled', 'the established gateway still serves authenticated MCP');
  const dashboard = await fetch(`http://127.0.0.1:${h.gw.gateway.dashboard!.port}/api/snapshot`, {
    headers: { 'x-t3fg-dashboard': '1' },
  });
  assert.equal(dashboard.status, 200, 'the established gateway still serves its dashboard');
  await dashboard.arrayBuffer();
  await h.gw.gateway.webhooks.tick();
  assert.equal(h.received.length, 1);
  assert.equal(h.received[0]!.path, '/original-recipient');
  assert.equal(h.received[0]!.body, h.pending.payload, 'the established sender still delivers its original committed bytes');
}

describe('webhook startup owns listeners before reconciling live subscriptions', () => {
  test('an occupied MCP listener preserves the running gateway route and pending deliveries', async (t) => {
    const h = await establishedGateway(t);
    await failedStartup(t, h, { occupied: 'mcp' });
  });

  test('an occupied dashboard listener closes the newly reserved MCP listener without changing routes or starting background work', async (t) => {
    const h = await establishedGateway(t);
    await failedStartup(t, h, { occupied: 'dashboard' });
  });

  for (const invalid of ['missing', 'empty']) {
    test(`${invalid} credentials close both reserved listeners and preserve the active gateway's delivery state`, async (t) => {
      const h = await establishedGateway(t);
      const secretFile = `${invalid}.key`;
      if (invalid === 'empty') writeFileSync(join(h.gw.dataDir, secretFile), '', { mode: 0o600 });
      await failedStartup(t, h, { secretFile });
    });
  }
});
