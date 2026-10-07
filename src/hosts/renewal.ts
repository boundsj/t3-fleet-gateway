import type { Logger } from '../log.ts';
import type { HostRegistry } from './registry.ts';

export interface RenewalLoop {
  stop(): Promise<void>;
}

/** Check credentials at startup and then on a fixed interval, renewing any that are due. */
export function startRenewalLoop(registry: HostRegistry, intervalMs: number, logger: Logger): RenewalLoop {
  let running: Promise<void> = Promise.resolve();
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    running = running.then(() => registry.renewDue()).catch(() => logger.error('host.renewal_loop_error'));
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
