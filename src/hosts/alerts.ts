import { randomUUID } from 'node:crypto';
import type { GatewayConfig } from '../config.ts';
import { transaction, type Database } from '../db/database.ts';
import { DAY, type Clock } from '../time.ts';
import type { CredentialStatus } from './registry.ts';
import type { WebhookStore } from '../webhooks/store.ts';

export interface CredentialAlert {
  kind: string;
  raisedAt: number;
  resolvedAt: number | null;
  expiresAt: number | null;
}
export interface CredentialAlertPayload {
  eventId: string;
  type: 'credential_alert' | 'credential_resolved';
  timestamp: string;
  feedSequence: null;
  feedCursor: null;
  host: string;
  reason: 'renewal_failed' | 'expiry';
  thresholdDays: number | null;
  expiresAt: string | null;
  alertId: string;
}

/** Persistent edge detection and atomic outbox capture; never stores error text or pairing material. */
export class CredentialAlerts {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly config: GatewayConfig;
  private readonly webhooks: WebhookStore;
  constructor(db: Database, clock: Clock, config: GatewayConfig, webhooks: WebhookStore) {
    this.db = db;
    this.clock = clock;
    this.config = config;
    this.webhooks = webhooks;
  }

  list(host: string): CredentialAlert[] {
    return this.db.prepare('SELECT * FROM credential_alerts WHERE host_id = ? ORDER BY kind LIMIT 9').all(host).map((row) => ({
      kind: String(row.kind), raisedAt: Number(row.raised_at), resolvedAt: row.resolved_at as number | null,
      expiresAt: row.expires_at as number | null,
    }));
  }

  update(host: string, status: CredentialStatus, inTransaction = false): void {
    const update = () => {
      const now = this.clock();
      const wanted = new Set<string>();
      if (status.renewalError) wanted.add('renewal_failed');
      if (status.expiresAt !== null && status.renewalError) {
        for (const days of new Set(this.config.renewal.alertDaysLeft)) {
          if (status.expiresAt - now <= days * DAY) wanted.add(`expiry_${days}`);
        }
      }
      const old = this.list(host);
      for (const kind of new Set([...old.map((alert) => alert.kind), ...wanted])) {
        const previous = old.find((alert) => alert.kind === kind);
        const active = wanted.has(kind);
        // A new verified credential starts a new expiry episode, even with an unusually short lifetime.
        const sameEpisode = previous?.expiresAt === status.expiresAt;
        if (previous && previous.resolvedAt === null && (!active || !sameEpisode)) {
          this.db.prepare('UPDATE credential_alerts SET resolved_at = ? WHERE host_id = ? AND kind = ?').run(now, host, kind);
          this.capture(host, kind, previous.raisedAt, previous.expiresAt, now, true);
        }
        if (active && (!previous || previous.resolvedAt !== null || !sameEpisode)) {
          this.db.prepare(`INSERT INTO credential_alerts (host_id, kind, expires_at, raised_at, resolved_at) VALUES (?, ?, ?, ?, NULL)
            ON CONFLICT(host_id, kind) DO UPDATE SET expires_at = excluded.expires_at, raised_at = excluded.raised_at, resolved_at = NULL`)
            .run(host, kind, status.expiresAt, now);
          this.capture(host, kind, now, status.expiresAt, now, false);
        }
      }
      // Removed thresholds retain no unbounded history; delivery attempts retain their normal bounds.
      for (const alert of old) {
        if (alert.kind !== 'renewal_failed' && !this.config.renewal.alertDaysLeft.includes(Number(alert.kind.slice(7)))) {
          this.db.prepare('DELETE FROM credential_alerts WHERE host_id = ? AND kind = ?').run(host, alert.kind);
        }
      }
    };
    if (inTransaction) update();
    else transaction(this.db, update);
  }

  private capture(host: string, kind: string, raised: number, expiry: number | null, now: number, resolved: boolean): void {
    const payload: CredentialAlertPayload = {
      eventId: randomUUID(), type: resolved ? 'credential_resolved' : 'credential_alert', timestamp: new Date(now).toISOString(),
      feedSequence: null, feedCursor: null, host, reason: kind === 'renewal_failed' ? 'renewal_failed' : 'expiry',
      thresholdDays: kind === 'renewal_failed' ? null : Number(kind.slice(7)),
      expiresAt: expiry === null ? null : new Date(expiry).toISOString(), alertId: `${host}:${kind}:${raised}`,
    };
    this.webhooks.captureCredential(payload, this.config.projects);
  }
}
