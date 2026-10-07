import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '../src/log.ts';

test('logger writes JSON lines, honours the level and redacts secret-bearing keys', () => {
  const lines: string[] = [];
  const logger = createLogger({ level: 'info', sink: (line) => lines.push(line), clock: () => 0 }).child({ component: 'test' });
  logger.debug('hidden');
  logger.info('visible', { clientId: 'c1', token: 'secret-1', access_token: 'secret-2', approvalCode: 'secret-3', message: 'task text', count: 2 });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.deepEqual(record, {
    time: '1970-01-01T00:00:00.000Z',
    level: 'info',
    event: 'visible',
    component: 'test',
    clientId: 'c1',
    token: '[redacted]',
    access_token: '[redacted]',
    approvalCode: '[redacted]',
    message: '[redacted]',
    count: 2,
  });
});
