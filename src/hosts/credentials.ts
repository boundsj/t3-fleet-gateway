import type { T3Access } from '../config.ts';
import type { Database } from '../db/database.ts';
import type { ObtainedCredential } from '../t3/pairing.ts';

export interface StoredCredential extends ObtainedCredential {
  hostId: string;
  verifiedAt: number;
}

export interface RenewalRecord {
  attemptedAt: number;
  succeededAt: number | null;
  failedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * T3 credentials per host. These are bearer tokens the gateway must present, so they are stored
 * as-is in the private database; they never leave the gateway or appear in logs and tool output.
 */
export class CredentialStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get(hostId: string): StoredCredential | undefined {
    const row = this.#db.prepare('SELECT * FROM host_credentials WHERE host_id = ?').get(hostId) as
      | {
          host_id: string;
          t3_client_id: string;
          access_token: string;
          scope: string;
          access: T3Access;
          issued_at: number;
          expires_at: number;
          verified_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      hostId: row.host_id,
      t3ClientId: row.t3_client_id,
      accessToken: row.access_token,
      scope: row.scope,
      access: row.access,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      verifiedAt: row.verified_at,
    };
  }

  /** Replace the host's credential. Only call with a credential that has been verified against T3. */
  save(credential: StoredCredential): void {
    this.#db
      .prepare(
        `INSERT INTO host_credentials (host_id, t3_client_id, access_token, scope, access, issued_at, expires_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (host_id) DO UPDATE SET t3_client_id = excluded.t3_client_id, access_token = excluded.access_token,
           scope = excluded.scope, access = excluded.access, issued_at = excluded.issued_at,
           expires_at = excluded.expires_at, verified_at = excluded.verified_at`,
      )
      .run(
        credential.hostId,
        credential.t3ClientId,
        credential.accessToken,
        credential.scope,
        credential.access,
        credential.issuedAt,
        credential.expiresAt,
        credential.verifiedAt,
      );
  }

  renewal(hostId: string): RenewalRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM host_renewals WHERE host_id = ?').get(hostId) as
      | { attempted_at: number; succeeded_at: number | null; failed_at: number | null; error_code: string | null; error_message: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      attemptedAt: row.attempted_at,
      succeededAt: row.succeeded_at,
      failedAt: row.failed_at,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    };
  }

  recordRenewal(hostId: string, now: number, outcome: { ok: true } | { ok: false; code: string; message: string }): void {
    this.#db
      .prepare(
        `INSERT INTO host_renewals (host_id, attempted_at, succeeded_at, failed_at, error_code, error_message)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (host_id) DO UPDATE SET attempted_at = excluded.attempted_at,
           succeeded_at = COALESCE(excluded.succeeded_at, host_renewals.succeeded_at),
           failed_at = excluded.failed_at, error_code = excluded.error_code, error_message = excluded.error_message`,
      )
      .run(
        hostId,
        now,
        outcome.ok ? now : null,
        outcome.ok ? null : now,
        outcome.ok ? null : outcome.code,
        outcome.ok ? null : outcome.message,
      );
  }
}
