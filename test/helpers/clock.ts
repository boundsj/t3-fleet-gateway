import type { Clock } from '../../src/time.ts';

export interface TestClock extends Clock {
  advance(ms: number): void;
}

/** A clock that only moves when told to. Starts at a fixed, realistic time. */
export function testClock(start = Date.UTC(2026, 0, 15, 12, 0, 0)): TestClock {
  let now = start;
  return Object.assign(() => now, {
    advance(ms: number) {
      now += ms;
    },
  });
}
