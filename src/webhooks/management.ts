import { createHash, randomUUID } from 'node:crypto';
import { validateHeaderValue } from 'node:http';
import * as z from 'zod';
import type { GatewayConfig } from '../config.ts';
import type { Logger } from '../log.ts';
import type { Clock } from '../time.ts';
import { authHeaderAllowed, destinationAllowed, type WebhookRoute } from './config.ts';
import { ATTEMPT_TIMEOUT_MS, postWebhook } from './sender.ts';
import { WebhookConnectionError, type AttemptResult, type WebhookStore } from './store.ts';

const MAX_OPERATIONS = 128;
const MAX_IN_FLIGHT = 4;
const MAX_PROJECTS = 100;
const common = { session: z.uuid(), requestId: z.uuid() };
const target = { id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), revision: z.uuid() };
const destination = { url: z.string().min(1).max(4096), authHeader: z.string().min(1).max(8322) };
const inputs = {
  connect: z.strictObject({ ...common, ...destination, project: z.string().min(1).max(300) }),
  replace: z.strictObject({ ...common, ...target, ...destination, url: destination.url.optional() }),
  test: z.strictObject({ ...common, ...target }),
  disconnect: z.strictObject({ ...common, ...target }),
};
export type WebhookAction = keyof typeof inputs;
export interface ManagementOptions {
  /** Only injected by isolated tests/demo, never read from operator config. */
  allowLoopbackHttp?: boolean;
  loopbackOnly?: boolean;
  attemptTimeoutMs?: number;
}
export interface ManagementResult {
  status: number;
  body: { ok?: true; code?: string; error?: string; test?: AttemptResult };
}
const failure = (status: number, error: string, test?: AttemptResult): ManagementResult =>
  ({ status, body: { error, ...(test ? { test } : {}) } });

/** Split at the first colon: a receiver's key may itself contain colons. Never expose parser errors or input. */
export function parseDashboardRoute(urlInput: string, headerInput: string, options: ManagementOptions = {}): WebhookRoute | null {
  if (/[\u0000-\u001f\u007f]/.test(urlInput + headerInput)) return null;
  const url = urlInput.trim();
  const colon = headerInput.indexOf(':');
  if (colon < 1 || /\s/.test(url) || !destinationAllowed(url, options.allowLoopbackHttp === true)) return null;
  if (options.loopbackOnly && !['127.0.0.1', '[::1]'].includes(new URL(url).hostname)) return null;
  const header = headerInput.slice(0, colon).trim();
  const value = headerInput.slice(colon + 1).trim();
  if (header.length > 128 || value.length > 8192 || !value || !authHeaderAllowed(header)) return null;
  try { validateHeaderValue(header, value); } catch { return null; }
  return { url, header: header.toLowerCase(), value };
}

/** Private operator operations: parse, bounded deduplication, real ping, then a synchronous store CAS.
 * No async work holds a database transaction. Only safe results and request digests enter the replay cache.
 */
export class WebhookManagement {
  readonly #store: WebhookStore;
  readonly #config: GatewayConfig;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #wake: () => void;
  readonly #options: ManagementOptions;
  readonly #abort = new AbortController();
  readonly #operations = new Map<string, { digest: string; result: Promise<ManagementResult> }>();
  readonly #pending = new Set<Promise<ManagementResult>>();
  #session = randomUUID();
  #ready = false;
  #network = 0;

  constructor(store: WebhookStore, config: GatewayConfig, clock: Clock, logger: Logger, wake: () => void, options: ManagementOptions = {}) {
    this.#store = store; this.#config = config; this.#clock = clock; this.#logger = logger; this.#wake = wake; this.#options = options;
  }
  ready(): void { if (!this.#abort.signal.aborted) this.#ready = true; }
  get available(): boolean { return this.#ready && !this.#abort.signal.aborted; }

  list() {
    // Never evict a request and then accept its id again in the same session. A fresh GET after a full
    // bounded batch rotates the session, so late retries fail closed instead of recreating a disconnect.
    if (this.#operations.size >= MAX_OPERATIONS && !this.#pending.size) {
      this.#session = randomUUID();
      this.#operations.clear();
    }
    return {
      session: this.#session,
      projects: this.#config.projects.slice(0, MAX_PROJECTS).map(({ alias, host }) => ({ alias, host })),
      connections: this.#store.listConnections(),
    };
  }

  execute(action: WebhookAction, input: unknown): Promise<ManagementResult> {
    if (!this.available) return Promise.resolve(failure(503, 'unavailable'));
    const parsed = inputs[action].safeParse(input);
    if (!parsed.success) return Promise.resolve(failure(400, 'invalid_request'));
    const data = parsed.data;
    if (data.session !== this.#session) return Promise.resolve(failure(409, 'session_expired'));
    const digest = createHash('sha256').update(JSON.stringify({ action, data })).digest('hex');
    const old = this.#operations.get(data.requestId);
    if (old) return old.digest === digest ? old.result : Promise.resolve(failure(409, 'request_conflict'));
    if (this.#operations.size >= MAX_OPERATIONS) return Promise.resolve(failure(429, 'request_limit'));
    if (action !== 'disconnect' && this.#network >= MAX_IN_FLIGHT) return Promise.resolve(failure(429, 'busy'));
    if (action !== 'disconnect') this.#network++;
    const result = Promise.resolve().then(() => this.#perform(action, data)).catch((error: unknown) => {
      if (error instanceof WebhookConnectionError) {
        const codes = { not_found: 'not_found', connection_conflict: 'conflict', file_managed: 'file_managed',
          connection_limit: 'subscription_limit', test_failed: 'ping_failed' };
        return failure(error.code === 'not_found' ? 404 : 409, codes[error.code]);
      }
      // Database/network exceptions may contain secrets. Log only a fixed code, and never their message.
      this.#logger.error('webhooks.management_failed');
      return failure(500, 'unavailable');
    }).then((value) => {
      this.#logger.info('webhooks.management', { action, result: value.body.error ?? value.body.code });
      return value;
    }).finally(() => {
      if (action !== 'disconnect') this.#network--;
      this.#pending.delete(result);
    });
    this.#operations.set(data.requestId, { digest, result });
    this.#pending.add(result);
    return result;
  }

  async #perform(action: WebhookAction, data: z.output<(typeof inputs)[WebhookAction]>): Promise<ManagementResult> {
    if (!this.available) return failure(503, 'unavailable');
    if (action === 'disconnect' && 'id' in data) {
      this.#store.disconnectDashboard(data.id, data.revision);
      return { status: 200, body: { ok: true, code: 'disconnected' } };
    }
    let route: WebhookRoute;
    let project: { alias: string; host: string } | undefined;
    let id: string;
    if (action === 'connect' && 'project' in data) {
      project = this.#config.projects.slice(0, MAX_PROJECTS).find((p) => p.alias === data.project);
      if (!project) return failure(400, 'project_not_found');
      id = `ui-${data.requestId}`;
      if (this.#config.webhooks.subscriptions.some((s) => s.id === id)) return failure(409, 'file_managed');
      if (this.#store.listConnections().length >= 32) return failure(409, 'subscription_limit');
      const parsed = parseDashboardRoute(data.url, data.authHeader, this.#options);
      if (!parsed) return failure(400, 'invalid_route');
      route = parsed;
    } else if ('id' in data) {
      id = data.id;
      const saved = action === 'replace' ? this.#store.dashboardRoute(id, data.revision) : this.#store.route(id, data.revision);
      if (action === 'replace' && 'authHeader' in data) {
        const parsed = parseDashboardRoute(data.url ?? saved.url, data.authHeader, this.#options);
        if (!parsed) return failure(400, 'invalid_route');
        route = parsed;
      } else route = saved;
    } else return failure(400, 'invalid_request');
    const eventId = randomUUID();
    const at = this.#clock();
    const payload = JSON.stringify({ eventId, type: 'ping', timestamp: new Date(at).toISOString(), feedSequence: null, feedCursor: null });
    const test = await postWebhook(route, payload, this.#options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS, this.#abort.signal);
    if (!this.available) return failure(503, 'unavailable');
    const record = { eventId, at, result: test };
    if (action === 'test' && 'revision' in data) {
      this.#store.testConnection(id, data.revision, record);
    } else if (test.outcome !== 'delivered') {
      // Preserve the existing route and its revision; a failed replacement is never activated.
      return failure(502, 'ping_failed', test);
    } else if (action === 'connect' && project) {
      this.#store.connectDashboard(id, project.alias, project.host, route, record);
      this.#wake();
    } else if (action === 'replace' && 'revision' in data) {
      this.#store.replaceDashboard(id, data.revision, route, record);
      this.#wake();
    }
    if (test.outcome !== 'delivered') return failure(502, 'ping_failed', test);
    return { status: 200, body: { ok: true, code: action === 'connect' ? 'connected' : action === 'replace' ? 'replaced' : 'tested', test } };
  }

  /** Gate new operations synchronously, abort HTTP(S), and drain store-using continuations before SQLite closes. */
  async stop(): Promise<void> {
    this.#ready = false;
    this.#abort.abort();
    await Promise.allSettled(this.#pending);
    this.#operations.clear();
  }
}
