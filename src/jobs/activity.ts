import type { T3Client } from '../t3/client.ts';
import type { ThreadItem } from '../t3/schemas.ts';
import { isDelegatedWorkActive, type ActivityRead, type DelegatedTask } from './derive.ts';

/**
 * Delegated work lives in T3's activity view. It shares positions with the messages view, which
 * supplies replies, state and `readPosition`. A separate `activityPosition` keeps tool/reasoning
 * traffic from delaying message reads. Only subagent metadata is used; task text and summaries
 * are ignored, so each item requests the minimum text budget.
 */

const PAGE_SIZE = 100;
/** Text characters per item: the least T3 accepts. */
const ITEM_CHARS = 1;
/** Activity pages read per job per tick: a burst of activity longer than this is caught up over ticks. */
export const MAX_ACTIVITY_PAGES = 10;
/** Pages read by the scan at adoption, the tail first; each further page goes PAGE_SIZE positions back. */
export const SCAN_PAGES = 20;
/** Of SCAN_PAGES, the most the forward tail may use: the rest (at least 5) look back from the anchor. */
export const SCAN_TAIL_PAGES = 15;
/** Pages read per tick to re-read followed tasks the activity position has moved past. */
const MAX_REFRESH_PAGES = 5;

function readPage(client: T3Client, threadId: string, afterPosition: number | null) {
  return client.readThread({ threadId, view: 'activity', afterPosition, limit: PAGE_SIZE, runLimit: 1, maxCharsPerItem: ITEM_CHARS });
}

/**
 * Read forward up to MAX_ACTIVITY_PAGES. Active tasks do not hold the cursor back;
 * refreshDelegated follows them by item id.
 */
export async function readActivity(client: T3Client, threadId: string, afterPosition: number | null): Promise<ActivityRead> {
  const items: ThreadItem[] = [];
  let position = afterPosition;
  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    const read = await readPage(client, threadId, position);
    items.push(...read.items);
    position = read.nextPosition ?? read.items.at(-1)?.position ?? position;
    if (!read.hasMore || read.nextPosition === null) break;
  }
  return { items, nextPosition: position };
}

/**
 * At adoption, scan forward from the last messages position, then look back for active delegated
 * work in PAGE_SIZE-position windows. SCAN_TAIL_PAGES caps forward reads, reserving at least five
 * of SCAN_PAGES for lookback. Older tasks can be missed; an unfinished tail is caught up by the watcher.
 */
export async function scanActivity(client: T3Client, threadId: string, anchor: number | null): Promise<ActivityRead> {
  const items: ThreadItem[] = [];
  let pages = 0;
  let position = anchor;
  while (pages < SCAN_TAIL_PAGES) {
    const read = await readPage(client, threadId, position);
    pages++;
    items.push(...read.items);
    position = read.nextPosition ?? read.items.at(-1)?.position ?? position;
    if (!read.hasMore || read.nextPosition === null) break;
  }
  // Backwards, from the anchor: each chunk covers the positions (start, end], read forward.
  let end = anchor;
  while (end !== null && end >= 0 && pages < SCAN_PAGES) {
    const start = end - PAGE_SIZE;
    let after: number | null = start < 0 ? null : start;
    while (pages < SCAN_PAGES) {
      const read = await readPage(client, threadId, after);
      pages++;
      const chunkEnd = end;
      items.push(...read.items.filter((item) => item.position <= chunkEnd && isDelegatedWorkActive(item)));
      const last = read.items.at(-1)?.position;
      if (!read.hasMore || last === undefined || last >= end) break;
      after = last;
    }
    end = start < 0 ? null : start;
  }
  return { items, nextPosition: position };
}

/**
 * Refresh followed tasks absent from this tick's activity, earliest first, matching by item id.
 * Nearby tasks share a read. Missing items become null; tasks beyond MAX_REFRESH_PAGES stay unchanged.
 */
export async function refreshDelegated(
  client: T3Client,
  threadId: string,
  tasks: readonly DelegatedTask[],
  read: readonly ThreadItem[],
): Promise<Map<string, ThreadItem | null>> {
  const found = new Map<string, ThreadItem | null>();
  const seen = new Set(read.map((item) => item.itemId));
  let wanted = tasks.filter((task) => !seen.has(task.itemId)).sort((a, b) => a.position - b.position);
  for (let page = 0; page < MAX_REFRESH_PAGES && wanted[0] !== undefined; page++) {
    const first = wanted[0];
    const result = await readPage(client, threadId, first.position > 0 ? first.position - 1 : null);
    for (const item of result.items) if (wanted.some((task) => task.itemId === item.itemId)) found.set(item.itemId, item);
    // A task the page covered without returning its item is gone. The page always covers the first.
    const last = result.items.at(-1)?.position ?? first.position;
    for (const task of wanted) if (!found.has(task.itemId) && (task.position <= last || !result.hasMore)) found.set(task.itemId, null);
    wanted = wanted.filter((task) => !found.has(task.itemId));
  }
  return found;
}
