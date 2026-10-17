import { createHash, randomUUID } from 'node:crypto';
import { transaction, type Database } from '../db/database.ts';
import type { Job, JobEvent } from '../jobs/store.ts';
import type { Clock } from '../time.ts';
import { loadRoute, type SubscriptionConfig, type WebhookEventType, type WebhookRoute, type WebhooksConfig } from './config.ts';

export const RETRY_WINDOW_MS = 60 * 60_000;
export const MAX_PENDING_PER_SUBSCRIPTION = 10_000;
export const MAX_ATTEMPTS_PER_SUBSCRIPTION = 100;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_HISTORY = 1000;
export type AttemptOutcome = 'in_progress' | 'delivered' | 'http_error' | 'redirect' | 'network_error' | 'tls_error' |
  'timeout' | 'response_too_large' | 'stopped' | 'abandoned' | 'expired' | 'cancelled';
export interface AttemptResult { outcome: AttemptOutcome; statusCode: number | null }
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
  excerpt?: string | null;
  excerptTruncated?: boolean;
}
interface SubscriptionRow { id: string; revision: string; identity: string; settings: string; route: string }
interface DeliveryRow {
  id: number; subscription_id: string; revision: string; event_id: string; payload: string;
  created_at: number; expires_at: number; attempt_count: number; lease: string; lease_until: number;
}
export interface ClaimedDelivery {
  id: number; subscriptionId: string; eventId: string; revision: string; payload: string;
  lease: string; attempt: number; expiresAt: number; route: WebhookRoute;
}
function eventType(event: JobEvent): WebhookEventType | undefined {
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
      const identity = createHash('sha256').update(JSON.stringify({ settings, route })).digest('hex');
      return { settings, route, identity };
    });
    transaction(this.#db, () => {
      const old = this.#db.prepare('SELECT * FROM webhook_subscriptions').all() as unknown as SubscriptionRow[];
      for (const row of old) {
        if (enabled.some((s) => s.settings.id === row.id && s.identity === row.identity)) continue;
        this.#db.prepare("UPDATE webhook_attempts SET outcome = 'cancelled', lease = NULL WHERE delivery_id IN " +
          "(SELECT id FROM webhook_deliveries WHERE subscription_id = ? AND state = 'sending') AND outcome = 'in_progress'").run(row.id);
        this.#db.prepare("UPDATE webhook_deliveries SET state = 'cancelled', payload = NULL, lease = NULL, lease_until = NULL " +
          "WHERE subscription_id = ? AND state IN ('pending', 'sending')").run(row.id);
        this.#db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(row.id);
      }
      for (const { settings, route, identity } of enabled) {
        this.#db.prepare('INSERT OR IGNORE INTO webhook_subscriptions (id, revision, identity, settings, route) VALUES (?, ?, ?, ?, ?)')
          .run(settings.id, randomUUID(), identity, JSON.stringify(settings), JSON.stringify(route));
      }
      this.#prune();
    });
  }

  /** Called synchronously inside the JobStore event transaction, with the event-time job snapshot. */
  capture(event: JobEvent, job: Job, turnRunId: string | null = job.lastRunId): void {
    const type = eventType(event);
    if (!type) return;
    const rows = this.#db.prepare('SELECT * FROM webhook_subscriptions').all() as unknown as SubscriptionRow[];
    const matches = rows.filter((row) => {
      const s = JSON.parse(row.settings) as SubscriptionConfig;
      return s.events.includes(type) && (!s.projects || s.projects.includes(job.projectAlias)) && (!s.hosts || s.hosts.includes(job.hostId));
    });
    if (!matches.length) return;
    const turn = turnRunId === null ? undefined : this.#db.prepare('SELECT client_id FROM job_turns WHERE job_id = ? AND run_id = ?')
      .get(job.id, turnRunId) as { client_id: string } | undefined;
    const payload: WebhookPayload = {
      eventId: randomUUID(), type, timestamp: new Date(event.createdAt).toISOString(), feedSequence: event.id, feedCursor: String(event.id),
      jobId: job.id, projectAlias: job.projectAlias, host: job.hostId, projectId: job.t3ProjectId, title: job.title,
      state: job.state, previousState: event.fromState, threadId: job.threadId,
      // Canonical T3 link, never a legacy HTTP URL that may itself contain sensitive query parameters.
      link: job.threadId === null ? null : `t3-thread://v1/${job.threadId}`,
      standing: job.standing, waitingOnDelegatedWork: job.delegatedWork.length > 0 || job.delegatedUntracked > 0,
      turnInitiator: turn ? { kind: 'gateway', clientId: turn.client_id } : { kind: 'unknown', clientId: null },
    };
    for (const row of matches) {
      const s = JSON.parse(row.settings) as SubscriptionConfig;
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
    const subscriptions = this.#db.prepare(`SELECT id, overflow_count, overflow_sequence, overflow_at, overflow_reason FROM webhook_subscriptions
      ${id === undefined ? '' : 'WHERE id = ?'} ORDER BY id`).all(...(id === undefined ? [] : [id]));
    const deliveries = this.#db.prepare(`SELECT subscription_id, state, COUNT(*) AS count FROM webhook_deliveries
      ${id === undefined ? '' : 'WHERE subscription_id = ?'} GROUP BY subscription_id, state ORDER BY subscription_id, state`)
      .all(...(id === undefined ? [] : [id]));
    const attempts = this.#db.prepare(`SELECT subscription_id, event_id, attempted_at, status_code, outcome FROM webhook_attempts
      ${id === undefined ? '' : 'WHERE subscription_id = ?'} ORDER BY id DESC LIMIT ?`).all(...(id === undefined ? [] : [id]), bounded);
    return { subscriptions, deliveries, attempts };
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
