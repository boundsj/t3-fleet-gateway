import type { T3Client } from '../t3/client.ts';
import type { ThreadItem } from '../t3/schemas.ts';
import { isUnsettled, isWorkerMessage } from './derive.ts';

/**
 * A job's worker messages read live from T3, in full up to T3's bound per item, for `work_messages`.
 * Nothing is stored: the job keeps only its bounded excerpt. Worker messages are the thread's own
 * replies (isWorkerMessage), never the messages sent to it, so this returns no task text or follow-up,
 * and it reads the messages view only, so tool activity and delegated work summaries never appear.
 *
 * T3 pages a thread forward only (`afterPosition`), so messages before a position are found by a scan
 * back in windows of WINDOW positions, one read each, with one character per item: positions are
 * unique integers, so a window holds at most WINDOW items and one read of WINDOW items returns all of
 * them. The texts are then read one message at a time by `itemId` (T3 returns that item, or no item
 * when it has none).
 */

/** T3's largest `maxCharsPerItem`: the most text returned per message. */
export const MAX_MESSAGE_TEXT_CHARS = 50_000;
/** Messages returned per call, at most. */
export const MAX_MESSAGES = 10;
/** Positions per scan read: T3's largest page, so one read covers its window. */
const WINDOW = 100;
/** Scan reads per call in each direction (2,000 positions back, 2,000 messages forward). */
const MAX_SCAN_READS = 20;

export interface WorkerMessage {
  position: number;
  itemId: string;
  type: string;
  status: string;
  updatedAt: string;
  text: string;
  textTruncated: boolean;
  /** The message's length when `text` is all of it; null when T3 cut it (T3 does not report the full length). */
  length: number | null;
}

export interface MessageQuery {
  /** Messages before this position (exclusive). Neither this nor `after`: the latest messages. */
  before?: number | undefined;
  /** Messages after this position (exclusive). */
  after?: number | undefined;
  limit: number;
  maxChars: number;
}

export interface MessagePage {
  /** Oldest first. */
  messages: WorkerMessage[];
  /** `before` for the messages older than these; null when there are none. */
  earlier: number | null;
  /** `after` for the messages newer than these: never past a message still being written. */
  later: number | null;
  /** More messages wait in the direction read: older ones (before, latest) or newer ones (after). */
  hasMore: boolean;
}

function scanRead(client: T3Client, threadId: string, afterPosition: number | null) {
  return client.readThread({ threadId, view: 'messages', afterPosition, limit: WINDOW, runLimit: 1, maxCharsPerItem: 1 });
}

const workerCount = (items: readonly ThreadItem[]) => items.filter(isWorkerMessage).length;

/** Messages-view items after `after`, until more than `want` worker messages are seen or the thread ends. */
async function scanForward(client: T3Client, threadId: string, after: number | null, want: number): Promise<{ items: ThreadItem[]; complete: boolean }> {
  const items: ThreadItem[] = [];
  let position = after;
  for (let reads = 0; reads < MAX_SCAN_READS; reads++) {
    const read = await scanRead(client, threadId, position);
    items.push(...read.items);
    if (!read.hasMore || read.nextPosition === null || read.nextPosition === position) return { items, complete: true };
    if (workerCount(items) > want) return { items, complete: false };
    position = read.nextPosition;
  }
  return { items, complete: false };
}

/**
 * Messages-view items before `before`, newest windows first, until more than `want` worker messages are
 * seen or the start is reached. `lowest`: the scan covered every position from it up to `before`.
 */
async function scanBack(client: T3Client, threadId: string, before: number, want: number): Promise<{ items: ThreadItem[]; lowest: number }> {
  const items: ThreadItem[] = [];
  let upper = before;
  for (let reads = 0; reads < MAX_SCAN_READS && upper > 0 && workerCount(items) <= want; reads++) {
    const lower = Math.max(0, upper - WINDOW);
    const read = await scanRead(client, threadId, lower > 0 ? lower - 1 : null);
    items.unshift(...read.items.filter((item) => item.position >= lower && item.position < upper));
    upper = lower;
  }
  return { items, lowest: upper };
}

/** The full text of each message, read by item id. A message T3 no longer has is left out. */
async function withText(client: T3Client, threadId: string, chosen: readonly ThreadItem[], maxChars: number): Promise<WorkerMessage[]> {
  const read = await Promise.all(
    chosen.map(async (item) => {
      const { items } = await client.readThread({ threadId, view: 'messages', itemId: item.itemId, runLimit: 1, maxCharsPerItem: maxChars });
      return items.find((candidate) => candidate.itemId === item.itemId && isWorkerMessage(candidate));
    }),
  );
  return read
    .filter((item): item is ThreadItem => item !== undefined)
    .map((item) => {
      const text = item.text ?? '';
      return {
        position: item.position,
        itemId: item.itemId,
        type: item.type,
        status: item.status,
        updatedAt: item.updatedAt,
        text,
        textTruncated: item.textTruncated,
        length: item.textTruncated ? null : text.length,
      };
    });
}

/** `after` for what follows `chosen`: before the first message still being written, so it is read again. */
function laterThan(chosen: readonly ThreadItem[], fallback: number | null): number | null {
  const unsettled = chosen.find((item) => isWorkerMessage(item) && isUnsettled(item));
  if (unsettled) return unsettled.position > 0 ? unsettled.position - 1 : null;
  return chosen.at(-1)?.position ?? fallback;
}

/**
 * One page of the thread's worker messages. The latest are found from `readPosition` (the job's
 * messages-view position, which the watcher keeps near the end): forward to the end, then back.
 */
export async function readWorkerMessages(client: T3Client, threadId: string, readPosition: number | null, query: MessageQuery): Promise<MessagePage> {
  const { limit, maxChars } = query;
  if (query.after !== undefined) {
    const { items, complete } = await scanForward(client, threadId, query.after, limit);
    const workers = items.filter(isWorkerMessage);
    const chosen = workers.slice(0, limit);
    const later = laterThan(chosen, items.at(-1)?.position ?? query.after);
    return {
      messages: await withText(client, threadId, chosen, maxChars),
      earlier: chosen[0]?.position ?? query.after + 1,
      later,
      hasMore: workers.length > limit || !complete || chosen.some(isUnsettled),
    };
  }
  let tail: ThreadItem[] = [];
  let before: number;
  if (query.before !== undefined) {
    before = query.before;
  } else {
    tail = (await scanForward(client, threadId, readPosition, Infinity)).items;
    before = readPosition === null ? 0 : readPosition + 1;
  }
  const back = await scanBack(client, threadId, before, limit - workerCount(tail));
  const items = [...back.items, ...tail];
  const workers = items.filter(isWorkerMessage);
  const chosen = workers.slice(-limit);
  const older = workers.length > limit || back.lowest > 0;
  return {
    messages: await withText(client, threadId, chosen, maxChars),
    earlier: older ? (chosen[0]?.position ?? back.lowest) : null,
    later: laterThan(chosen, items.at(-1)?.position ?? null),
    hasMore: older,
  };
}
