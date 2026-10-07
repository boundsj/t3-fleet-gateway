import type { T3Client } from '../t3/client.ts';
import type { JobStore } from './store.ts';

/** The same key for every interrupt of a job, so T3 treats repeats (retries, re-delivery) as one request. */
export function cancelRequestId(jobId: string): string {
  return `t3fg-cancel-${jobId}`;
}

/**
 * Ask T3 to interrupt a cancel_requested job's thread. If T3 reports that nothing is running, the
 * job is cancelled at once; if the interrupt was accepted, the watcher confirms it later. T3 errors
 * propagate to the caller.
 */
export async function deliverInterrupt(store: JobStore, client: T3Client, jobId: string, threadId: string): Promise<'requested' | 'stopped'> {
  const result = await client.interruptThread({ threadId, clientRequestId: cancelRequestId(jobId), reason: 'Cancelled through t3-fleet-gateway' });
  if (result.status === 'interrupt_requested') return 'requested';
  store.transition(jobId, { from: ['cancel_requested'], to: 'cancelled', detail: { reason: result.status } });
  return 'stopped';
}
