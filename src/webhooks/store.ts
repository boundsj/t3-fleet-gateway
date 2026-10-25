import { threadLink } from '../threadId.js';
import { createHash, randomUUID } from 'node:crypto';
import { transaction, type Database } from '../db/database.ts';
import { GatewayError } from '../errors.ts';
import { displayPullRequests } from '../jobs/pullRequests.ts';
import type { Job, JobEvent } from '../jobs/store.ts';
import type { Clock } from '../time.ts';
import { DEFAULT_WEBHOOK_EVENTS, loadRoute, type SubscriptionConfig, type WebhookEventType, type WebhookRoute, type WebhooksConfig } from './config.ts';

export const RETRY_WINDOW_MS = 60 * 60_000;
export const MAX_PENDING_PER_SUBSCRIPTION = 10_000;
export const MAX_ATTEMPTS_PER_SUBSCRIPTION = 100;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_SUBSCRIPTIONS = 32;
const MAX_HISTORY = 1000;
export type AttemptOutcome = 'in_progress' | 'delivered' | 'http_error' | 'redirect' | 'network_error' | 'tls_error' |
  'timeout' | 'response_too_large' | 'stopped' | 'abandoned' | 'expired' | 'cancelled';
export interface AttemptResult { outcome: AttemptOutcome; statusCode: number | null }
export interface DashboardTest { eventId: string; at: number; result: AttemptResult }
export interface WebhookConnection {
  id: string;
  revision: string;
  source: 'config' | 'dashboard';
  projects: string[];
  hosts: string[];
  targets: { host: string; projectId: string }[];
  lastTest: { at: string; outcome: AttemptOutcome; statusCode: number | null } | null;
}
export type WebhookConnectionErrorCode = 'not_found' | 'connection_conflict' | 'file_managed' | 'connection_limit' | 'test_failed';
/** Fixed codes only: neither callers nor logs should receive private route material in an error. */
export class WebhookConnectionError extends Error {
  readonly code: WebhookConnectionErrorCode;
  constructor(code: WebhookConnectionErrorCode) {
    super(code);
    this.name = 'WebhookConnectionError';
    this.code = code;
  }
}
export interface WebhookPayload {
  eventId: string;
  type: WebhookEventType;
  timestamp: string;
  feedSequence: number;
  feedCursor: string;
  jobId: string;
  projectAlias: string;
  host: string;
  projectId: string | null;
  title: string;
  state: string;
  previousState: string | null;
  threadId: string | null;
  link: string | null;
  standing: boolean;
  waitingOnDelegatedWork: boolean;
  turnInitiator: { kind: 'gateway' | 'unknown'; clientId: string | null };
  /** At most MAX_PULL_REQUESTS of the PRs the job follows (`displayPullRequests`), so ordinary links keep the payload inside MAX_PAYLOAD_BYTES. */
  pullRequests?: { number: number; state: 'open' | 'closed' | 'merged' | null; url: string }[];
  excerpt?: string | null;
  excerptTruncated?: boolean;
}
type SubscriptionSettings = Pick<SubscriptionConfig, 'events' | 'projects' | 'hosts' | 'targets' | 'excerptChars'>;
interface SubscriptionRow {
  id: string; revision: string; identity: string; settings: string; route: string; source: WebhookConnection['source'];
  last_test_at: number | null; last_test_outcome: AttemptOutcome | null; last_test_status_code: number | null;
}
interface DeliveryRow {
  id: number; subscription_id: string; revision: string; event_id: string; payload: string;
  created_at: number; expires_at: number; attempt_count: number; lease: string; lease_until: number;
}
export interface ClaimedDelivery {
  id: number; subscriptionId: string; eventId: string; revision: string; payload: string;
  lease: string; attempt: number; expiresAt: number; route: WebhookRoute;
}
function eventType(event: JobEvent): WebhookEventType | undefined {
  if ((event.type === 'state_changed' || event.type === 'turn_finished') && event.detail?.reason === 'run_failed') return 'failed';
  if (event.type === 'pull_request_opened' || event.type === 'pull_request_merged') return event.type;
  if (event.type === 'delegated_work_ended') return 'delegated_work_ended';
  if (event.type === 'turn_finished') return 'idle';
  if (event.type === 'state_changed' && ['idle', 'needs_input', 'failed', 'cancelled', 'running'].includes(event.toState ?? '')) {
    return event.toState as WebhookEventType;
  }
  return undefined;
}
function excerpt(text: string | null, max: number): string | null {
  if (text === null) return null;
  let end = Math.min(text.length, max);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return text.slice(0, end);
}
function connection(row: SubscriptionRow): WebhookConnection {
  const settings = JSON.parse(row.settings) as SubscriptionSettings;
  return {
    id: row.id, revision: row.revision, source: row.source, projects: settings.projects ?? [], hosts: settings.hosts ?? [], targets: settings.targets ?? [],
    lastTest: row.last_test_at === null || row.last_test_outcome === null ? null
      : { at: new Date(row.last_test_at).toISOString(), outcome: row.last_test_outcome, statusCode: row.last_test_status_code },
  };
}
function identityFor(settings: SubscriptionSettings, route: WebhookRoute): string {
  return createHash('sha256').update(JSON.stringify({ settings, route })).digest('hex');
}

/** Owns private routes, immutable pending payloads, leases and code-only delivery diagnostics. */
export class WebhookStore {
  readonly #db: Database;
  readonly #clock: Clock;
  constructor(db: Database, clock: Clock) { this.#db = db; this.#clock = clock; }

  /** Only the serving gateway applies config. Opening CLI services must never call this. */
  reconcile(config: WebhooksConfig, dataDir: string): void {
    // Read and validate every enabled secret before changing anything. A missing secret fails closed.
    const enabled = config.subscriptions.filter((s) => s.enabled).map((settings) => {
      const route = loadRoute(settings, dataDir);
      const identity = identityFor(settings, route);
      return { settings, route, identity };
    });
    transaction(this.#db, () => {
      const old = this.#db.prepare('SELECT * FROM webhook_subscriptions').all() as unknown as SubscriptionRow[];
      const dashboard = old.filter((row) => row.source === 'dashboard');
      // Disabled entries reserve their IDs too: a file must never silently take ownership of a UI connection.
      if (dashboard.some((row) => config.subscriptions.some((s) => s.id === row.id))) {
        throw new GatewayError('config_invalid', 'Webhook subscription ID is already managed by the dashboard.');
      }
      if (dashboard.length + enabled.length > MAX_SUBSCRIPTIONS) {
        throw new GatewayError('config_invalid', 'Webhook subscription limit exceeded.');
      }
      for (const row of old.filter((row) => row.source === 'config')) {
        if (enabled.some((s) => s.settings.id === row.id && s.identity === row.identity)) continue;
        this.#cancel(row.id);
        this.#db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(row.id);
      }
      for (const { settings, route, identity } of enabled) {
        this.#db.prepare('INSERT OR IGNORE INTO webhook_subscriptions (id, revision, identity, settings, route) VALUES (?, ?, ?, ?, ?)')
          .run(settings.id, randomUUID(), identity, JSON.stringify(settings), JSON.stringify(route));
      }
      this.#prune();
    });
  }

  /** Bounded, credential-free rows for the private dashboard and offline CLI. */
  listConnections(): WebhookConnection[] {
    const rows = this.#db.prepare('SELECT * FROM webhook_subscriptions ORDER BY id LIMIT ?').all(MAX_SUBSCRIPTIONS) as unknown as SubscriptionRow[];
    return rows.map(connection);
  }

  /** Private transport input; never serialize this value into a response or log. */
  route(id: string, expectedRevision: string): WebhookRoute {
    return JSON.parse(this.#current(id, expectedRevision).route) as WebhookRoute;
  }

  dashboardRoute(id: string, expectedRevision: string): WebhookRoute {
    return JSON.parse(this.#dashboard(id, expectedRevision).route) as WebhookRoute;
  }

  /** Call only after the synthetic ping finishes; no network operation belongs inside these transactions. */
  connectDashboard(id: string, project: string, host: string, route: WebhookRoute, test: DashboardTest, projectId?: string): WebhookConnection {
    return transaction(this.#db, () => {
      const existing = this.#db.prepare('SELECT source FROM webhook_subscriptions WHERE id = ?').get(id);
      if (existing) throw new WebhookConnectionError(existing.source === 'config' ? 'file_managed' : 'connection_conflict');
      const count = this.#db.prepare('SELECT COUNT(*) AS n FROM webhook_subscriptions').get() as { n: number };
      if (count.n >= MAX_SUBSCRIPTIONS) throw new WebhookConnectionError('connection_limit');
      this.#requireSuccessfulTest(test);
      const settings: SubscriptionSettings = {
        ...(projectId ? { targets: [{ host, projectId }] } : { projects: [project], hosts: [host] }),
        events: [...DEFAULT_WEBHOOK_EVENTS], excerptChars: 0,
      };
      this.#db.prepare(`INSERT INTO webhook_subscriptions (id, revision, identity, settings, route, source)
        VALUES (?, ?, ?, ?, ?, 'dashboard')`)
        .run(id, randomUUID(), identityFor(settings, route), JSON.stringify(settings), JSON.stringify(route));
      this.#recordTest(id, test);
      return connection(this.#row(id)!);
    });
  }

  replaceDashboard(id: string, expectedRevision: string, route: WebhookRoute, test: DashboardTest): WebhookConnection {
    return transaction(this.#db, () => {
      const row = this.#dashboard(id, expectedRevision);
      this.#requireSuccessfulTest(test);
      const settings = JSON.parse(row.settings) as SubscriptionSettings;
      this.#cancel(id);
      this.#db.prepare(`UPDATE webhook_subscriptions SET revision = ?, identity = ?, route = ?,
        overflow_count = 0, overflow_sequence = NULL, overflow_at = NULL, overflow_reason = NULL,
        last_test_at = NULL, last_test_outcome = NULL, last_test_status_code = NULL WHERE id = ?`)
        .run(randomUUID(), identityFor(settings, route), JSON.stringify(route), id);
      this.#recordTest(id, test);
      return connection(this.#row(id)!);
    });
  }

  disconnectDashboard(id: string, expectedRevision: string): void {
    transaction(this.#db, () => {
      this.#dashboard(id, expectedRevision);
      this.#cancel(id);
      this.#db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(id);
      this.#prune();
    });
  }

  /** A test of a saved route changes only safe diagnostics, never its revision or queued deliveries. */
  testConnection(id: string, expectedRevision: string, test: DashboardTest): WebhookConnection {
    return transaction(this.#db, () => {
      this.#current(id, expectedRevision);
      this.#recordTest(id, test);
      return connection(this.#row(id)!);
    });
  }

  /** Called synchronously inside the JobStore event transaction, with the event-time job snapshot. */
  capture(event: JobEvent, job: Job, turnRunId: string | null = job.lastRunId): void {
    const type = eventType(event);
    if (!type) return;
    const rows = this.#db.prepare('SELECT * FROM webhook_subscriptions').all() as unknown as SubscriptionRow[];
    const matches = rows.filter((row) => {
      const s = JSON.parse(row.settings) as SubscriptionSettings;
      return (!s.targets || s.targets.some((t) => t.host === job.hostId && t.projectId === job.t3ProjectId)) &&
        s.events.includes(type) && (!s.projects || s.projects.includes(job.projectAlias)) && (!s.hosts || s.hosts.includes(job.hostId));
    });
    if (!matches.length) return;
    const turn = turnRunId === null ? undefined : this.#db.prepare('SELECT client_id FROM job_turns WHERE job_id = ? AND run_id = ?')
      .get(job.id, turnRunId) as { client_id: string } | undefined;
    const payload: WebhookPayload = {
      eventId: randomUUID(), type, timestamp: new Date(event.createdAt).toISOString(), feedSequence: event.id, feedCursor: String(event.id),
      jobId: job.id, projectAlias: job.projectAlias, host: job.hostId, projectId: job.t3ProjectId, title: job.title,
      state: job.state, previousState: event.fromState, threadId: job.threadId,
      // Canonical T3 link, never a legacy HTTP URL that may itself contain sensitive query parameters.
      link: threadLink(job.threadId),
      standing: job.standing, waitingOnDelegatedWork: job.delegatedWork.length > 0 || job.delegatedUntracked > 0,
      turnInitiator: turn ? { kind: 'gateway', clientId: turn.client_id } : { kind: 'unknown', clientId: null },
    };
    if (type === 'pull_request_opened' || type === 'pull_request_merged') {
      payload.pullRequests = displayPullRequests(job.pullRequests ?? []).map(({ number, state, url }) => ({ number, state, url }));
    }
    for (const row of matches) {
      const s = JSON.parse(row.settings) as SubscriptionSettings;
      const body = { ...payload };
      if (s.excerptChars > 0) {
        body.excerpt = excerpt(job.latestMessageExcerpt, s.excerptChars);
        body.excerptTruncated = job.latestMessageTruncated || (body.excerpt?.length ?? 0) < (job.latestMessageExcerpt?.length ?? 0);
      }
      const json = JSON.stringify(body);
      const pending = this.#db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE subscription_id = ? AND state IN ('pending', 'sending')")
        .get(row.id) as { n: number };
      const overflow = Buffer.byteLength(json) > MAX_PAYLOAD_BYTES ? 'payload_limit'
        : pending.n >= MAX_PENDING_PER_SUBSCRIPTION ? 'backlog' : null;
      if (overflow !== null) {
        // Never evict committed active deliveries, truncate opaque IDs, or block a job transition.
        this.#db.prepare(`UPDATE webhook_subscriptions SET overflow_count = overflow_count + 1,
          overflow_sequence = ?, overflow_at = ?, overflow_reason = ? WHERE id = ?`).run(event.id, event.createdAt, overflow, row.id);
        continue;
      }
      this.#db.prepare(`INSERT INTO webhook_deliveries
        (subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(row.id, row.revision, payload.eventId, event.id, json, event.createdAt, event.createdAt + RETRY_WINDOW_MS, event.createdAt);
    }
  }

  claim(limit: number, leaseMs: number): ClaimedDelivery[] {
    return transaction(this.#db, () => {
      const now = this.#clock();
      this.#db.prepare("UPDATE webhook_attempts SET outcome = 'abandoned', lease = NULL WHERE outcome = 'in_progress' AND delivery_id IN " +
        "(SELECT id FROM webhook_deliveries WHERE state = 'sending' AND lease_until <= ?)").run(now);
      this.#db.prepare("UPDATE webhook_deliveries SET state = 'pending', lease = NULL, lease_until = NULL WHERE state = 'sending' AND lease_until <= ?").run(now);
      this.#db.prepare("UPDATE webhook_deliveries SET state = 'expired', payload = NULL WHERE state = 'pending' AND expires_at <= ?").run(now);
      // One in-flight request per subscription, enforced across DB connections. A failed receiver
      // cannot occupy all sender slots while other subscriptions have work ready.
      const next = this.#db.prepare(`SELECT d.*, s.route FROM webhook_deliveries d JOIN webhook_subscriptions s
        ON s.id = d.subscription_id AND s.revision = d.revision
        WHERE d.state = 'pending' AND d.next_attempt_at <= ? AND NOT EXISTS
          (SELECT 1 FROM webhook_deliveries busy WHERE busy.subscription_id = d.subscription_id AND busy.state = 'sending')
        ORDER BY d.next_attempt_at, d.id LIMIT 1`);
      const claims: ClaimedDelivery[] = [];
      for (let n = 0; n < limit; n++) {
        const row = next.get(now) as (DeliveryRow & { route: string }) | undefined;
        if (!row) break;
        const lease = randomUUID();
        this.#db.prepare("UPDATE webhook_deliveries SET state = 'sending', lease = ?, lease_until = ?, attempt_count = attempt_count + 1 WHERE id = ?")
          .run(lease, now + leaseMs, row.id);
        this.#db.prepare(`INSERT INTO webhook_attempts (subscription_id, delivery_id, event_id, attempted_at, outcome, lease)
          VALUES (?, ?, ?, ?, 'in_progress', ?)`).run(row.subscription_id, row.id, row.event_id, now, lease);
        claims.push({ id: row.id, subscriptionId: row.subscription_id, revision: row.revision, eventId: row.event_id, payload: row.payload,
          lease, attempt: row.attempt_count + 1, expiresAt: row.expires_at, route: JSON.parse(row.route) as WebhookRoute });
      }
      this.#prune();
      return claims;
    });
  }

  active(claim: ClaimedDelivery): boolean {
    return !!this.#db.prepare(`SELECT 1 FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id AND s.revision = d.revision
      WHERE d.id = ? AND d.lease = ? AND d.state = 'sending'`).get(claim.id, claim.lease);
  }

  finish(claim: ClaimedDelivery, result: AttemptResult): void {
    transaction(this.#db, () => {
      if (!this.active(claim)) return;
      const now = this.#clock();
      const state = result.outcome === 'delivered' ? 'delivered' : now >= claim.expiresAt ? 'expired' : 'pending';
      const delay = result.outcome === 'stopped' ? 0 : Math.min(300_000, 5000 * 2 ** Math.min(claim.attempt - 1, 10));
      this.#db.prepare('UPDATE webhook_attempts SET status_code = ?, outcome = ?, lease = NULL WHERE lease = ?')
        .run(result.statusCode, result.outcome, claim.lease);
      this.#db.prepare(`UPDATE webhook_deliveries SET state = ?, next_attempt_at = ?, lease = NULL, lease_until = NULL,
        payload = CASE WHEN ? = 'pending' THEN payload ELSE NULL END WHERE id = ? AND lease = ?`)
        .run(state, Math.min(now + delay, claim.expiresAt), state, claim.id, claim.lease);
      this.#prune();
    });
  }

  recordPing(subscriptionId: string, eventId: string, at: number, result: AttemptResult): void {
    transaction(this.#db, () => {
      this.#db.prepare('INSERT INTO webhook_attempts (subscription_id, event_id, attempted_at, status_code, outcome) VALUES (?, ?, ?, ?, ?)')
        .run(subscriptionId, eventId, at, result.statusCode, result.outcome);
      this.#prune();
    });
  }

  diagnostics(id?: string, limit = 20) {
    const bounded = Math.max(1, Math.min(MAX_ATTEMPTS_PER_SUBSCRIPTION, Math.trunc(limit) || 20));
    const subscriptions = this.#db.prepare(`SELECT id, source, overflow_count, overflow_sequence, overflow_at, overflow_reason FROM webhook_subscriptions
      ${id === undefined ? '' : 'WHERE id = ?'} ORDER BY id`).all(...(id === undefined ? [] : [id]));
    const deliveries = this.#db.prepare(`SELECT subscription_id, state, COUNT(*) AS count FROM webhook_deliveries
      ${id === undefined ? '' : 'WHERE subscription_id = ?'} GROUP BY subscription_id, state ORDER BY subscription_id, state`)
      .all(...(id === undefined ? [] : [id]));
    const attempts = this.#db.prepare(`SELECT subscription_id, event_id, attempted_at, status_code, outcome FROM webhook_attempts
      ${id === undefined ? '' : 'WHERE subscription_id = ?'} ORDER BY id DESC LIMIT ?`).all(...(id === undefined ? [] : [id]), bounded);
    return { subscriptions, deliveries, attempts };
  }

  #row(id: string): SubscriptionRow | undefined {
    return this.#db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?').get(id) as SubscriptionRow | undefined;
  }

  #current(id: string, expectedRevision: string): SubscriptionRow {
    const row = this.#row(id);
    if (!row) throw new WebhookConnectionError('not_found');
    if (row.revision !== expectedRevision) throw new WebhookConnectionError('connection_conflict');
    return row;
  }

  #dashboard(id: string, expectedRevision: string): SubscriptionRow {
    const row = this.#current(id, expectedRevision);
    if (row.source !== 'dashboard') throw new WebhookConnectionError('file_managed');
    return row;
  }

  #requireSuccessfulTest(test: DashboardTest): void {
    if (test.result.outcome !== 'delivered') throw new WebhookConnectionError('test_failed');
  }

  #recordTest(id: string, test: DashboardTest): void {
    // Completion order must not let an older, slower test replace a newer test's diagnostic.
    this.#db.prepare(`UPDATE webhook_subscriptions SET last_test_at = ?, last_test_outcome = ?, last_test_status_code = ?
      WHERE id = ? AND (last_test_at IS NULL OR last_test_at <= ?)`)
      .run(test.at, test.result.outcome, test.result.statusCode, id, test.at);
    this.#db.prepare('INSERT INTO webhook_attempts (subscription_id, event_id, attempted_at, status_code, outcome) VALUES (?, ?, ?, ?, ?)')
      .run(id, test.eventId, test.at, test.result.statusCode, test.result.outcome);
    this.#prune();
  }

  #cancel(id: string): void {
    this.#db.prepare("UPDATE webhook_attempts SET outcome = 'cancelled', lease = NULL WHERE delivery_id IN " +
      "(SELECT id FROM webhook_deliveries WHERE subscription_id = ? AND state = 'sending') AND outcome = 'in_progress'").run(id);
    this.#db.prepare("UPDATE webhook_deliveries SET state = 'cancelled', payload = NULL, lease = NULL, lease_until = NULL " +
      "WHERE subscription_id = ? AND state IN ('pending', 'sending')").run(id);
  }

  #prune(): void {
    // Payloads are cleared on completion; only the bounded pending queue retains content. No active row is pruned.
    this.#db.exec(`DELETE FROM webhook_deliveries WHERE state NOT IN ('pending', 'sending') AND id NOT IN
      (SELECT id FROM webhook_deliveries WHERE state NOT IN ('pending', 'sending') ORDER BY id DESC LIMIT ${MAX_HISTORY});
      DELETE FROM webhook_attempts WHERE outcome <> 'in_progress' AND id NOT IN
      (SELECT id FROM webhook_attempts ORDER BY id DESC LIMIT ${MAX_HISTORY});
      DELETE FROM webhook_attempts WHERE outcome <> 'in_progress' AND id IN
      (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY subscription_id ORDER BY id DESC) AS n FROM webhook_attempts) WHERE n > ${MAX_ATTEMPTS_PER_SUBSCRIPTION});`);
  }
}
