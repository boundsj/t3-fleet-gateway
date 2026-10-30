import type { T3Client } from '../t3/client.ts';
import type { JobStore } from './store.ts';

/**
 * Retries reuse the key for one run. Later runs need a new key or T3 would replay the earlier
 * interrupt's result and leave the new run active.
 */
export function cancelRequestId(jobId: string, runId: string | null): string {
  return `t3fg-cancel-${jobId}-${runId ?? 'none'}`;
}

/**
 * Interrupt a cancel_requested job's active or latest run. Cancel immediately if it is stopped;
 * otherwise the watcher confirms the interrupt. T3 errors propagate.
 */
export async function deliverInterrupt(
  store: JobStore,
  client: T3Client,
  jobId: string,
  thread: { threadId: string; runId: string | null },
): Promise<'requested' | 'stopped'> {
  const result = await client.interruptThread({
    threadId: thread.threadId,
    clientRequestId: cancelRequestId(jobId, thread.runId),
    reason: 'Cancelled through t3-fleet-gateway',
  });
  if (result.status === 'interrupt_requested') return 'requested';
  store.transition(jobId, { from: ['cancel_requested'], to: 'cancelled', detail: { reason: result.status } });
  return 'stopped';
}
