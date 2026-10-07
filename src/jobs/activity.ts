import type { T3Client } from '../t3/client.ts';
import type { ThreadItem } from '../t3/schemas.ts';
import { isDelegatedWorkActive, type ActivityRead, type DelegatedTask } from './derive.ts';

/**
 * Reads of a thread's activity view, where delegated work shows. T3's `t3_thread_read` has two views
 * over the same positions: `messages` (the default) returns only user messages, assistant messages and
 * proposed plans; `activity` returns every timeline item, including `subagent` items (work delegated to
 * other threads), reasoning, tool calls, commands and checkpoints. The excerpt, the job's state and its
 * `readPosition` come from the messages view; the activity view is read only for `subagent` items, with
 * its own cursor (`activityPosition`) so a busy coordinator's reasoning and tool items never slow the
 * messages read, and with one character per item: a `subagent` item's title is a field of its own, and
 * its text (the child's task prompt while it runs, its summary once done) is never used.
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
 * The activity after `afterPosition`, at most MAX_ACTIVITY_PAGES pages. Nothing holds the position
 * back: delegated work still running is followed by item id (refreshDelegated), not re-read in place.
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
 * The activity at adoption: the position where the thread's activity ends now (reached from `anchor`,
 * the last position the messages view returned, so the read is short), and the delegated work still
 * running, from a bounded scan backwards from `anchor`, PAGE_SIZE positions per page, while SCAN_PAGES
 * last. The tail reads at most SCAN_TAIL_PAGES, so the work just before the anchor (where a coordinator
 * waiting on delegated work has it) is always looked at. Positions are shared by both views, so any
 * position is a valid place to start reading. Delegated work further back is not found; a tail longer
 * than SCAN_TAIL_PAGES leaves the position short of the end, and the watcher catches up from there
 * (delegated work in the rest of the tail is found then).
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
 * The current version of each followed task that `read` (this tick's activity) did not return, because
 * the activity position has moved past it, or null when T3 no longer has it. Read in the activity view
 * from the earliest such item on, matched by item id, so tasks near each other cost one read; at most
 * MAX_REFRESH_PAGES reads, and tasks not reached are kept as they were.
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
