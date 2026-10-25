import { randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Logger } from '../log.ts';
import type { Clock } from '../time.ts';
import { loadRoute, type SubscriptionConfig, type WebhookRoute } from './config.ts';
import { WebhookStore, type AttemptResult } from './store.ts';

export const ATTEMPT_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 32 * 1024;
const CONCURRENCY = 4;
const TLS_ERRORS = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_REVOKED']);

/** A real HTTP(S) POST: no redirects, no body retention, one deadline covering DNS/TLS/headers/body. */
export function postWebhook(route: WebhookRoute, payload: string, timeoutMs = ATTEMPT_TIMEOUT_MS, signal?: AbortSignal): Promise<AttemptResult> {
  return new Promise((resolve) => {
    let request: ClientRequest | undefined;
    let statusCode: number | null = null;
    let done = false;
    const finish = (outcome: AttemptResult['outcome']) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      request?.destroy();
      resolve({ outcome, statusCode });
    };
    const abort = () => finish('stopped');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    if (signal?.aborted) { finish('stopped'); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const url = new URL(route.url);
      request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'POST', agent: false, maxHeaderSize: 16 * 1024,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), [route.header]: route.value },
      }, (response) => {
        statusCode = response.statusCode ?? null;
        if (statusCode !== null && statusCode >= 300 && statusCode < 400) { finish('redirect'); return; }
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) finish('response_too_large');
        });
        response.on('end', () => finish(statusCode !== null && statusCode >= 200 && statusCode < 300 ? 'delivered' : 'http_error'));
        response.on('error', () => finish('network_error'));
        response.on('aborted', () => finish('network_error'));
      });
      request.on('error', (error: NodeJS.ErrnoException) => finish(TLS_ERRORS.has(error.code ?? '') ? 'tls_error' : 'network_error'));
      request.end(payload);
    } catch { finish('network_error'); }
  });
}

export interface SenderOptions { autoStart?: boolean; attemptTimeoutMs?: number }

/** Independent bounded sender; never awaited by a state transition, watcher or MCP response. */
export class WebhookSender {
  readonly #store: WebhookStore;
  readonly #logger: Logger;
  readonly #timeout: number;
  readonly #abort = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #refill: NodeJS.Immediate | undefined;
  readonly #inFlight = new Set<Promise<void>>();
  constructor(store: WebhookStore, logger: Logger, options: SenderOptions = {}) {
    this.#store = store;
    this.#logger = logger;
    this.#timeout = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  }
  start(): void {
    if (this.#timer || this.#abort.signal.aborted) return;
    this.#timer = setInterval(() => this.#fill(), 1000);
    this.#fill();
  }

  /** Fill available slots and wait for just those attempts, or join current attempts if no slot was filled. */
  tick(): Promise<void> {
    if (this.#abort.signal.aborted) return Promise.resolve();
    const started = this.#fill();
    return Promise.all(started.length ? started : this.#inFlight).then(() => {});
  }

  #fill(): Promise<void>[] {
    if (this.#abort.signal.aborted || this.#inFlight.size >= CONCURRENCY) return [];
    try {
      const claims = this.#store.claim(CONCURRENCY - this.#inFlight.size, Math.max(30_000, 2 * this.#timeout + 5000));
      return claims.map((claim) => {
        // Admit each attempt synchronously, before another tick can calculate its free slots.
        const attempt = Promise.resolve().then(async () => {
          if (!this.#store.active(claim)) return;
          const result = await postWebhook(claim.route, claim.payload, this.#timeout, this.#abort.signal);
          this.#store.finish(claim, result);
        }).catch(() => this.#failed()).finally(() => {
          this.#inFlight.delete(attempt);
          // A completed fast receiver frees its own slot immediately. Yield to the event loop on
          // each refill so a large due queue cannot turn into an unbounded microtask drain.
          if (this.#timer && !this.#abort.signal.aborted && !this.#refill) {
            this.#refill = setImmediate(() => { this.#refill = undefined; this.#fill(); });
          }
        });
        this.#inFlight.add(attempt);
        return attempt;
      });
    } catch {
      this.#failed();
      return [];
    }
  }

  #failed(): void {
    // Never log raw network/SQLite errors: they can carry a URL or payload. Leases recover failed bookkeeping.
    this.#logger.error('webhooks.tick_failed');
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    clearImmediate(this.#refill);
    this.#refill = undefined;
    this.#abort.abort();
    await Promise.all(this.#inFlight);
  }

}

/** Ping never creates a job, reconciles routes, or includes worker content; it uses the exact production transport. */
export async function pingWebhook(subscription: SubscriptionConfig, dataDir: string, store: WebhookStore, clock: Clock): Promise<AttemptResult> {
  const route = loadRoute(subscription, dataDir);
  const eventId = randomUUID();
  const now = clock();
  const payload = JSON.stringify({ eventId, type: 'ping', timestamp: new Date(now).toISOString(), feedSequence: null, feedCursor: null });
  const result = await postWebhook(route, payload);
  store.recordPing(subscription.id, eventId, now, result);
  return result;
}

/** Dashboard-owned routes live only in the private database; the CLI never copies them into configuration. */
export async function pingStoredWebhook(id: string, revision: string, store: WebhookStore, clock: Clock): Promise<AttemptResult> {
  const route = store.route(id, revision);
  const eventId = randomUUID();
  const at = clock();
  const payload = JSON.stringify({ eventId, type: 'ping', timestamp: new Date(at).toISOString(), feedSequence: null, feedCursor: null });
  const result = await postWebhook(route, payload);
  store.testConnection(id, revision, { eventId, at, result });
  return result;
}
