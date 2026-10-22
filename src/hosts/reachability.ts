import { GatewayError } from '../errors.ts';
import { SECOND } from '../time.ts';
import type { HostRegistry } from './registry.ts';

export const REACHABILITY_START_DELAY_MS = 2 * SECOND;
export const REACHABILITY_JITTER_MS = SECOND;
export const REACHABILITY_TIMEOUT_MS = 5 * SECOND;

/** One timer and at most one in-flight probe per configured host. Never queues missed ticks or retries failures. */
export function startReachabilityLoop(registry: HostRegistry, intervalMs: number, random = Math.random): { stop(): Promise<void> } {
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const schedule = (id: string, delay: number): void => {
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped || running.has(id)) return;
      const controller = new AbortController();
      const deadline = setTimeout(() => {
        controller.abort(new GatewayError('t3_timeout', 'The host reachability probe timed out.'));
      }, REACHABILITY_TIMEOUT_MS);
      deadline.unref();
      const done = registry.probeReachability(id, controller.signal).catch(() => {
        // Isolate unexpected probe failures too; the next scheduled probe is the only retry.
      }).finally(() => {
        clearTimeout(deadline);
        running.delete(id);
        schedule(id, intervalMs);
      });
      running.set(id, { controller, done });
    }, delay + Math.floor(random() * REACHABILITY_JITTER_MS));
    timer.unref();
    timers.add(timer);
  };
  for (const host of registry.hosts) schedule(host.id, REACHABILITY_START_DELAY_MS);
  return {
    async stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const { controller } of running.values()) controller.abort();
      await Promise.all([...running.values()].map(({ done }) => done));
    },
  };
}
