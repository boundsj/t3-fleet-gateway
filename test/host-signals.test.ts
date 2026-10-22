import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayError } from '../src/errors.ts';
import { HostSignals, SIGNAL_LABELS } from '../src/hosts/signals.ts';
import { testClock } from './helpers/clock.ts';

test('host signals retain bounded fixed text, counts, independent recovery and detached snapshots', () => {
  const clock = testClock();
  const signals = new HostSignals(clock);
  const first = clock();
  const secret = 'SYNTHETIC-SECRET\n\0'.repeat(1000);
  signals.record('models', new GatewayError('t3_invalid_response', secret));
  clock.advance(1000);
  signals.record('models', new GatewayError('catalog_limit', secret));
  signals.record('t3_environment_read');
  const model = signals.snapshot().find((entry) => entry.kind === 'models')!;
  assert.equal(model.code, 'catalog_limit');
  assert.deepEqual(model.problem, { firstSeen: first, lastSeen: clock(), count: 2 });
  assert.ok(model.message.length <= 300);
  assert.doesNotMatch(JSON.stringify(signals.snapshot()), /SYNTHETIC-SECRET/);
  model.problem!.count = 99;
  assert.equal(signals.snapshot()[0]!.problem!.count, 2);
  signals.record('models');
  assert.equal(signals.snapshot()[0]!.problem, null);
  clock.advance(1000);
  signals.record('models', new Error(secret));
  assert.equal(signals.snapshot()[0]!.code, 'internal_error');
  assert.deepEqual(signals.snapshot()[0]!.problem, { firstSeen: clock(), lastSeen: clock(), count: 1 });
  for (let i = 0; i < 1000; i++) signals.record('models', new Error(secret));
  assert.ok(signals.snapshot().length <= Object.keys(SIGNAL_LABELS).length);
});

test('unknown or hostile codes are replaced, never truncated into display text', () => {
  const signals = new HostSignals(testClock());
  signals.recordCode('dispatch', 'SYNTHETIC-SECRET'.repeat(500));
  assert.equal(signals.snapshot()[0]!.code, 'internal_error');
  assert.doesNotMatch(JSON.stringify(signals.snapshot()), /SYNTHETIC-SECRET/);
});

test('start caller errors and per-call application errors neither create nor clear problems', () => {
  const clock = testClock();
  const signals = new HostSignals(clock);
  const startIgnored = ['model_selection_invalid', 'project_not_found', 'not_found', 'project_not_configured', 'invalid_argument'];
  const callIgnored = ['not_found', 'invalid_argument', 't3_tool_failed', 'host_not_enrolled', 'internal_error'];
  for (const [kind, codes] of [['start', startIgnored], ['t3_thread_send', callIgnored]] as const) {
    for (const code of codes) signals.recordCode(kind, code);
    assert.equal(signals.snapshot().find((signal) => signal.kind === kind), undefined);
    signals.recordCode(kind, 't3_timeout');
    const before = signals.snapshot().find((signal) => signal.kind === kind);
    clock.advance(1000);
    for (const code of codes) signals.recordCode(kind, code);
    assert.deepEqual(signals.snapshot().find((signal) => signal.kind === kind), before);
    signals.record(kind);
    assert.equal(signals.snapshot().find((signal) => signal.kind === kind)!.problem, null);
  }
});
