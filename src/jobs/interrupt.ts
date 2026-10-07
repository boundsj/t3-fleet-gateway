import type { T3Client } from '../t3/client.ts';
import type { JobStore } from './store.ts';

/**
 * T3's retry key for interrupting one run of a job's thread. Re-delivering the interrupt for the same
 * run (after a send whose outcome is unknown) reuses the key, so T3 treats the repeat as one request.
 * A later run on the thread (a queued follow-up, or a person typing in T3) gets its own key: reusing
 * one key per job would make T3 answer from its record of the first interrupt and leave the new run
 * going.
 */
export function cancelRequestId(jobId: string, runId: string | null): string {
  return `t3fg-cancel-${jobId}-${runId ?? 'none'}`;
}

/**
 * Ask T3 to interrupt the run of a cancel_requested job's thread that is active (or, when none is,
 * the latest one). If T3 reports that nothing is running, the job is cancelled at once; if the
 * interrupt was accepted, the watcher confirms it later. T3 errors propagate to the caller.
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
