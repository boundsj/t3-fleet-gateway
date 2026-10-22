import { GatewayError } from '../errors.ts';
import type { Clock } from '../time.ts';
import { CATALOG_TTL_MS, MAX_CATALOG_CHARS, snapshotId, type Snapshot } from './catalog.ts';
import type { HostRegistry } from './registry.ts';

export const MAX_THREAD_PAGES = 20;
export const THREAD_PAGE_SIZE = 100;
/** Bound cache memory across projects too; eviction invalidates the affected cursors. */
const MAX_THREAD_SNAPSHOTS = 32;
export const MAX_THREAD_TITLE = 200;
export const cleanThreadTitle = (title: string) => title.replaceAll(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_THREAD_TITLE);

export interface CatalogThread {
  threadId: string;
  title: string;
  state: string;
  lastActivityAt: string | null;
  settled: boolean | null;
  settledAt: string | null;
  archived: boolean | null;
}

interface Entry {
  snapshot?: Snapshot<CatalogThread[]>;
  inflight?: Promise<Snapshot<CatalogThread[]>>;
}

/** Read on demand only. Authorization and project validation belong to the caller, before accessing this cache. */
export class ThreadCatalog {
  readonly #registry: HostRegistry;
  readonly #clock: Clock;
  readonly #entries = new Map<string, Entry>();

  constructor(registry: HostRegistry, clock: Clock) {
    this.#registry = registry;
    this.#clock = clock;
  }

  held(host: string, project: string): Snapshot<CatalogThread[]> | undefined {
    return this.#entries.get(JSON.stringify([host, project]))?.snapshot;
  }

  read(host: string, project: string, refresh = false): Promise<Snapshot<CatalogThread[]>> {
    const key = JSON.stringify([host, project]);
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= MAX_THREAD_SNAPSHOTS) {
        const oldest = [...this.#entries].find(([, value]) => !value.inflight)?.[0];
        if (oldest === undefined) throw new GatewayError('catalog_limit', 'Too many thread catalogs are being read. Try again later.');
        this.#entries.delete(oldest);
      }
      entry = {};
    }
    // Most recently requested project last, including cached reads.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (!refresh && entry.snapshot && this.#clock() - entry.snapshot.fetchedAt < CATALOG_TTL_MS) return Promise.resolve(entry.snapshot);
    if (entry.inflight) return entry.inflight;
    const current = entry;
    const pending = this.#fetch(host, project).then((value) => {
      const snapshot = { id: snapshotId(), fetchedAt: this.#clock(), value };
      current.snapshot = snapshot;
      return snapshot;
    }).finally(() => { if (current.inflight === pending) current.inflight = undefined; });
    current.inflight = pending;
    return pending;
  }

  async #fetch(host: string, project: string): Promise<CatalogThread[]> {
    const threads: CatalogThread[] = [];
    const ids = new Set<string>();
    let cursor = 0;
    let total: number | undefined;
    const limit = () => new GatewayError('catalog_limit', `Thread catalog exceeds ${MAX_THREAD_PAGES * THREAD_PAGE_SIZE} threads or its text budget; nothing was returned.`);
    for (let page = 0; ; page++) {
      if (page >= MAX_THREAD_PAGES) throw limit();
      const result = await this.#registry.client(host).listThreads({ projectId: project, includeSubagents: false, limit: THREAD_PAGE_SIZE, cursor });
      if (result.total > MAX_THREAD_PAGES * THREAD_PAGE_SIZE) throw limit();
      if (result.projectId !== project || result.total < 0 || (total !== undefined && result.total !== total) || result.threads.length > THREAD_PAGE_SIZE) {
        throw new GatewayError('t3_invalid_response', 'The thread catalog changed or returned an invalid page. Refresh it.');
      }
      total = result.total;
      for (const thread of result.threads) {
        if (ids.has(thread.threadId) || !/^[A-Za-z0-9_-]{1,256}$/.test(thread.threadId)) {
          throw new GatewayError('t3_invalid_response', 'The thread catalog contains duplicate or invalid ids. Refresh it.');
        }
        ids.add(thread.threadId);
        threads.push({ threadId: thread.threadId, title: cleanThreadTitle(thread.title), state: cleanThreadTitle(thread.status).slice(0, 80),
          lastActivityAt: isoDate(thread.updatedAt), settled: thread.settled ?? null, settledAt: isoDate(thread.settledAt), archived: thread.archived ?? null });
      }
      if (JSON.stringify(threads).length > MAX_CATALOG_CHARS) throw limit();
      if (result.nextCursor === null) {
        if (threads.length !== total) throw new GatewayError('t3_invalid_response', 'The thread catalog is incomplete. Refresh it.');
        return threads;
      }
      if (result.nextCursor !== cursor + result.threads.length || result.nextCursor <= cursor) {
        throw new GatewayError('t3_invalid_response', 'The thread catalog returned a cursor that does not advance.');
      }
      cursor = result.nextCursor;
    }
  }
}

function isoDate(value: string | null | undefined): string | null {
  const time = value == null ? NaN : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
