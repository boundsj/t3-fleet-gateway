import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { parseConfig } from '../src/config.ts';
import { openDataDir } from '../src/dataDir.ts';
import { openDatabase } from '../src/db/database.ts';
import { JobStore } from '../src/jobs/store.ts';
import { silentLogger } from '../src/log.ts';
import { WebhookManagement } from '../src/webhooks/management.ts';
import { WebhookStore } from '../src/webhooks/store.ts';
import { tempDir } from './helpers/tmp.ts';

test('CLI lists, inspects and pings dashboard-owned connections without a secret file or offline route changes', async (t) => {
  const received: { path: string | undefined; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const privatePath = '/synthetic-private-routine?key=synthetic-private-query';
  const privateKey = 'Bearer synthetic-dashboard-only-key';
  const privateResponse = 'synthetic-private-receiver-response';
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ path: request.url, authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
    response.writeHead(200).end(privateResponse);
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}${privatePath}`;
  const dataDir = join(tempDir(t), 'data');
  const db = openDatabase(openDataDir(dataDir).databasePath);
  t.after(() => db.close());
  const config = parseConfig({ publicUrl: 'https://gateway.example.com', hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9' }],
    projects: [{ alias: 'pilot', host: 'main', t3ProjectId: 'synthetic-project', runtimeMode: 'auto' }] });
  const configPath = join(dataDir, 'synthetic-config.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(config.webhooks.subscriptions, []);
  const store = new WebhookStore(db, Date.now);
  const management = new WebhookManagement(store, config, Date.now, silentLogger, () => {},
    { allowLoopbackHttp: true, loopbackOnly: true, attemptTimeoutMs: 500 });
  t.after(() => management.stop());
  management.ready();
  const connected = await management.execute('connect', { session: management.list().session, requestId: randomUUID(),
    project: 'pilot', url, authHeader: `Authorization: ${privateKey}` });
  assert.equal(connected.status, 200);
  assert.equal(received.length, 1, 'setup performed a real synthetic ping');
  const connection = store.listConnections()[0]!;
  const jobs = new JobStore(db, Date.now, silentLogger);
  const job = jobs.create({ id: 'synthetic01', clientId: 'synthetic-client', requestId: 'synthetic-request', inputHash: 'synthetic-hash',
    projectAlias: 'pilot', hostId: 'main', task: 'Synthetic private task', title: 'Synthetic job', branch: 'fleet/synthetic', runtimeMode: 'auto' }).job;
  jobs.transition(job.id, { from: ['queued'], to: 'cancelled' });
  const snapshot = () => ({ connections: db.prepare('SELECT * FROM webhook_subscriptions').all(),
    deliveries: db.prepare('SELECT * FROM webhook_deliveries').all(), attempts: db.prepare('SELECT * FROM webhook_attempts').all() });
  const before = snapshot();
  const outputs: string[] = [];
  const cli = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['webhooks', ...args], {
      env: { ...process.env, T3FG_CONFIG: configPath, T3FG_DATA_DIR: dataDir }, out: (line) => out.push(line), err: (line) => err.push(line),
    });
    outputs.push(...out, ...err);
    assert.equal(err.join(''), '');
    assert.equal(code, 0);
    return JSON.parse(out.join('\n'));
  };
  const listed = await cli(['list']);
  assert.deepEqual(listed.configured, []);
  assert.deepEqual(listed.subscriptions.map((row: { id: string; source: string }) => ({ id: row.id, source: row.source })),
    [{ id: connection.id, source: 'dashboard' }]);
  const firstAttempts = await cli(['attempts', connection.id, '--limit', '1']);
  assert.equal(firstAttempts.attempts.length, 1);
  assert.equal(firstAttempts.attempts[0].outcome, 'delivered');
  assert.deepEqual(snapshot(), before, 'offline list and attempts do not reconcile, rewrite routes, or touch queued payloads');
  assert.equal(received.length, 1, 'offline commands never contact the receiver');
  assert.deepEqual(await cli(['ping', connection.id]), { outcome: 'delivered', statusCode: 200 });
  assert.equal(received.length, 2);
  for (const request of received) {
    assert.equal(request.path, privatePath);
    assert.equal(request.authorization, privateKey);
    assert.equal(request.body.type, 'ping');
    assert.equal(request.body.feedSequence, null);
    assert.equal(request.body.feedCursor, null);
    assert.equal('jobId' in request.body, false);
  }
  assert.notEqual(received[0]!.body.eventId, received[1]!.body.eventId);
  assert.deepEqual(store.route(connection.id, connection.revision), { url, header: 'authorization', value: privateKey });
  assert.deepEqual(snapshot().deliveries, before.deliveries, 'an explicit CLI ping preserves the pending queue and route revision');
  const afterPing = snapshot();
  const attempts = await cli(['attempts', connection.id, '--limit', '2']);
  assert.equal(attempts.attempts.length, 2);
  assert.equal(attempts.attempts[0].event_id, received[1]!.body.eventId);
  await cli(['list']);
  assert.deepEqual(snapshot(), afterPing);
  assert.deepEqual(readdirSync(dataDir).sort(), ['gateway.db', 'gateway.db-shm', 'gateway.db-wal', 'gateway.key', 'synthetic-config.json'],
    'UI authentication requires no extra secret file');
  for (const secret of [url, privatePath, privateKey, privateResponse, 'Synthetic private task']) {
    assert.equal(outputs.join('\n').includes(secret), false, 'CLI output contains only safe diagnostics');
  }
});
