import type { T3Client } from '../t3/client.ts';
import type { MonitoringThread } from '../t3/schemas.ts';
import { MINUTE, type Clock } from '../time.ts';
import type { Job, JobStore } from './store.ts';

const SCAN_INTERVAL = MINUTE;
const FALLBACK_INTERVAL = 15 * MINUTE;
const PAGES_PER_TICK = 4;
const MAX_SCAN_PAGES = 20;
const FALLBACKS_PER_TICK = 4;
const QUIET = new Set(['idle', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);
export const quietThread = (status: string): boolean => QUIET.has(status);

interface Observation { thread: MonitoringThread; at: number }
interface Scan {
  nextAt: number;
  cursor: number;
  pages: number;
  observations: Map<string, Observation>;
  fallbackAttempts: Map<string, number>;
}

/**
 * Only ledger-owned threads affect monitoring. No discovery cache, adoption, titles or messages.
 * Offset pages are not a snapshot: presence is evidence; absence never means settled/deleted.
 * Omitted, hidden, unsupported and starved rows get fair bounded direct checks as a backstop.
 */
export class SettledJobMonitor {
  readonly #scans = new Map<string, Scan>();
  readonly #clock: Clock;
  readonly #store: JobStore;

  constructor(store: JobStore, clock: Clock) { this.#store = store; this.#clock = clock; }

  async inspect(hostId: string, client: T3Client, jobs: readonly Job[]): Promise<Set<string>> {
    const wake = new Set<string>();
    const settled = jobs.filter((job) => job.state === 'idle' && job.monitoringSettledAt !== null && job.threadId !== null);
    if (!settled.length) { this.#scans.delete(hostId); return wake; }
    const known = new Set(settled.map((job) => job.threadId!));
    let scan = this.#scans.get(hostId);
    if (!scan) {
      scan = { nextAt: 0, cursor: 0, pages: 0, observations: new Map(), fallbackAttempts: new Map() };
      this.#scans.set(hostId, scan);
    }
    for (const id of scan.observations.keys()) if (!known.has(id)) scan.observations.delete(id);
    const ids = new Set(settled.map((job) => job.id));
    for (const id of scan.fallbackAttempts.keys()) if (!ids.has(id)) scan.fallbackAttempts.delete(id);
    if (this.#clock() >= scan.nextAt) {
      try {
        for (let page = 0; page < PAGES_PER_TICK; page++) {
          // Timestamp before the read: a later local resume cannot be overwritten by this result.
          const at = this.#clock();
          const result = await client.monitoringThreads(scan.cursor);
          for (const thread of result.threads) if (known.has(thread.threadId)) scan.observations.set(thread.threadId, { thread, at });
          scan.pages++;
          if (result.nextCursor === null || result.nextCursor <= scan.cursor || scan.pages >= MAX_SCAN_PAGES) {
            scan.cursor = 0; scan.pages = 0; scan.nextAt = this.#clock() + SCAN_INTERVAL;
            break;
          }
          scan.cursor = result.nextCursor;
        }
      } catch {
        // Unsupported catalogs do not stop ordinary work. Direct reads retain the existing host-failure handling.
        scan.cursor = 0; scan.pages = 0; scan.nextAt = this.#clock() + 5 * MINUTE;
      }
    }
    let fallbacks = FALLBACKS_PER_TICK;
    const lastChecked = (job: Job) => Math.max(job.monitoringCheckedAt ?? 0, scan.fallbackAttempts.get(job.id) ?? 0);
    settled.sort((a, b) => lastChecked(a) - lastChecked(b));
    for (const original of settled) {
      const observation = scan.observations.get(original.threadId!);
      const fresh = observation && observation.at > (original.monitoringCheckedAt ?? -Infinity);
      const fallback = fallbacks > 0 && this.#clock() - lastChecked(original) >= FALLBACK_INTERVAL;
      if (!fresh && !fallback) continue;
      const job = this.#store.get(original.id);
      if (!job || job.monitoringGeneration !== original.monitoringGeneration || job.monitoringSettledAt === null || job.state !== 'idle') continue;
      if (observation && observation.at > (job.monitoringCheckedAt ?? -Infinity)) {
        if (unchanged(job, observation.thread)) this.#store.confirmMonitoring(job, observation.at);
        else { this.#store.wakeMonitoring(job.id); wake.add(job.id); }
      } else if (fallback && this.#clock() - lastChecked(job) >= FALLBACK_INTERVAL) {
        fallbacks--;
        scan.fallbackAttempts.set(job.id, this.#clock());
        // Keep confirmed history until a successful observation changes it; a host outage isn't reopened work.
        wake.add(job.id);
      }
    }
    return wake;
  }
}

function unchanged(job: Job, thread: MonitoringThread): boolean {
  return thread.settled && quietThread(thread.status) && thread.latestRunId === job.lastRunId && thread.updatedAt === job.monitoringUpdatedAt;
}
