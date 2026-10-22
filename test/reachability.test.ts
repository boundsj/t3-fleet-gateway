import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { startReachabilityLoop, REACHABILITY_TIMEOUT_MS } from '../src/hosts/reachability.ts';
import { CredentialStore } from '../src/hosts/credentials.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway } from './helpers/gateway.ts';
import type { HostRegistry } from '../src/hosts/registry.ts';
import { MINUTE } from '../src/time.ts';
import { startJobHarness } from './helpers/jobs.ts';

// Flush promise continuations without advancing the fake scheduler.
const flush = () => setImmediate();

test('startup, interval, jitter and shutdown use bounded unref timers, with no overlapping probes per host', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  const pending = new Map<string, () => void>();
  const signals: AbortSignal[] = [];
  const registry = {
    hosts: [{ id: 'host-a' }, { id: 'host-b' }],
    probeReachability(id: string, signal: AbortSignal) {
      calls.push(id);
      signals.push(signal);
      return new Promise<void>((resolve) => { pending.set(id, resolve); });
    },
  } as unknown as HostRegistry;
  const loop = startReachabilityLoop(registry, 5 * MINUTE, () => 0.5);
  t.after(() => loop.stop());
  t.mock.timers.tick(2499);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ['host-a', 'host-b']);
  pending.get('host-b')!();
  await flush();
  t.mock.timers.tick(5 * MINUTE + 500);
  assert.deepEqual(calls, ['host-a', 'host-b', 'host-b'], 'one slow host does not overlap or stall another');
  assert.equal(signals[0]!.aborted, true, 'the total probe deadline aborts a stalled call');
  pending.get('host-a')!();
  pending.get('host-b')!();
  await flush();
  await loop.stop();
  t.mock.timers.tick(60 * MINUTE);
  assert.equal(calls.length, 3, 'shutdown removes scheduled probes');
});

test('failed probes wait until the next interval; stop aborts and drains in-flight probes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let aborted = 0;
  const registry = {
    hosts: [{ id: 'host-a' }],
    probeReachability(_id: string, signal: AbortSignal) {
      calls++;
      if (calls === 1) return Promise.reject(new Error('synthetic failure'));
      return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
        aborted++;
        reject(signal.reason);
      }, { once: true }));
    },
  } as unknown as HostRegistry;
  const loop = startReachabilityLoop(registry, MINUTE, () => 0);
  t.after(() => loop.stop());
  t.mock.timers.tick(2000);
  await flush();
  t.mock.timers.tick(MINUTE - 1);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2);
  await loop.stop();
  assert.equal(aborted, 1);
  t.mock.timers.tick(10 * MINUTE);
  assert.equal(calls, 2);
});

test('successful non-probe catalog and project calls update reachability at completion; outage and auth recover', async (t) => {
  const { fake, gw } = await startJobHarness(t);
  const { registry, catalog } = gw.services;
  assert.equal(registry.lastHealth('main')?.reachable, true, 'enrollment verification is a successful contact');
  gw.clock.advance(1000);
  await registry.client('main').readCapabilities();
  assert.equal(registry.lastHealth('main')?.reachable, true);
  assert.equal(registry.lastHealth('main')?.checkedAt, gw.clock());
  await fake.stop();
  gw.clock.advance(1000);
  await assert.rejects(registry.client('main').listProjects());
  assert.equal(registry.lastHealth('main')?.reachable, false);
  assert.equal(registry.lastHealth('main')?.checkedAt, gw.clock());
  await fake.start();
  await registry.client('main').listProjects();
  assert.equal(registry.lastHealth('main')?.reachable, true);
  fake.revokeAllTokens();
  await assert.rejects(registry.client('main').readCapabilities(), { code: 't3_unauthorized' });
  assert.equal(registry.lastHealth('main')?.credentialRejected, true);
  await registry.enroll('main');
  // Full model catalog validation still owns the independent model health signal.
  await catalog.models('main', { refresh: true });
  assert.equal(registry.lastHealth('main')?.reachable, true);
  assert.equal(registry.lastHealth('main')?.credentialRejected, false);
});

test('probe uses only environment read and records success and timeout', async (t) => {
  const { fake, gw } = await startJobHarness(t);
  const { registry } = gw.services;
  const before = fake.calls.length;
  await registry.probeReachability('main', new AbortController().signal);
  assert.deepEqual(fake.calls.slice(before), ['t3_environment_read']);
  assert.equal(registry.lastHealth('main')?.reachable, true);
  assert.equal(registry.lastHealth('main')?.t3Version, fake.serverVersion);
  fake.holdResponses.add('t3_environment_read');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loop = startReachabilityLoop(registry, MINUTE, () => 0);
  t.after(() => loop.stop());
  t.mock.timers.tick(2000);
  await fake.whenHeld('t3_environment_read');
  gw.clock.advance(REACHABILITY_TIMEOUT_MS);
  t.mock.timers.tick(REACHABILITY_TIMEOUT_MS);
  await flush();
  assert.equal(registry.lastHealth('main')?.reachable, false);
  assert.equal(registry.lastHealth('main')?.error?.code, 't3_timeout');
  await loop.stop();
  fake.releaseHeld();
});

test('shutdown during initialization aborts promptly without replacing the last host observation', async (t) => {
  const { fake, gw } = await startJobHarness(t);
  const { registry } = gw.services;
  await registry.client('main').listProjects();
  const previous = registry.lastHealth('main');
  fake.holdResponses.add('initialize');
  const controller = new AbortController();
  const pending = registry.probeReachability('main', controller.signal);
  await fake.whenHeld('initialize');
  controller.abort();
  await pending;
  assert.deepEqual(registry.lastHealth('main'), previous);
  fake.releaseHeld();
});


test('gateway startup schedules probes, skips missing credentials and stops probing on close', async (t) => {
  const fake = await startFakeT3();
  t.after(() => fake.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gw = await startTestGateway(t, {
    reachability: { autoStart: true },
    config: { hosts: [{ id: 'host-a', t3Url: fake.url }, { id: 'host-b', t3Url: fake.url }] },
    jobEngine: { autoStart: false },
  });
  const token = 'synthetic-probe-token';
  fake.validTokens.add(token);
  new CredentialStore(gw.services.db).save({
    hostId: 'host-a', t3ClientId: 'synthetic-client', scope: 'mcp', issuedAt: gw.clock(), accessToken: token, expiresAt: gw.clock() + 60 * MINUTE, verifiedAt: gw.clock(), access: 'auto',
  });
  assert.equal(gw.services.registry.lastHealth('host-a'), null);
  fake.holdResponses.add('t3_environment_read');
  t.mock.timers.tick(3000);
  await fake.whenHeld('t3_environment_read');
  fake.releaseHeld();
  fake.holdResponses.delete('t3_environment_read');
  // Join via another call only after the startup request has completed.
  for (let i = 0; i < 100 && gw.services.registry.lastHealth('host-a') === null; i++) await flush();
  assert.equal(gw.services.registry.lastHealth('host-a')?.reachable, true);
  assert.equal(gw.services.registry.lastHealth('host-b'), null, 'unenrolled hosts do not contact T3');
  assert.deepEqual(fake.calls, ['t3_environment_read']);
  await gw.gateway.close();
  const count = fake.calls.length;
  t.mock.timers.tick(60 * MINUTE);
  await flush();
  assert.equal(fake.calls.length, count);
});


test('the total deadline aborts a stalled initialized notification and shutdown drains it', async (t) => {
  const { fake, gw } = await startJobHarness(t);
  const { registry } = gw.services;
  fake.holdResponses.add('notifications/initialized');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loop = startReachabilityLoop(registry, MINUTE, () => 0);
  t.after(() => loop.stop());
  t.mock.timers.tick(2000);
  await fake.whenHeld('notifications/initialized');
  t.mock.timers.tick(REACHABILITY_TIMEOUT_MS);
  await loop.stop();
  assert.equal(registry.lastHealth('main')?.error?.code, 't3_timeout');
  assert.equal(registry.lastHealth('main')?.reachable, false);
  fake.releaseHeld();
});

test('shutdown cancels a stalled initialized notification without recording a failure', async (t) => {
  const { fake, gw } = await startJobHarness(t);
  const { registry } = gw.services;
  const previous = registry.lastHealth('main');
  fake.holdResponses.add('notifications/initialized');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loop = startReachabilityLoop(registry, MINUTE, () => 0);
  t.after(() => loop.stop());
  t.mock.timers.tick(2000);
  await fake.whenHeld('notifications/initialized');
  await loop.stop();
  assert.deepEqual(registry.lastHealth('main'), previous);
  fake.releaseHeld();
});
