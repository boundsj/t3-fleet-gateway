import { hmacBase64Url, randomId, randomToken, sha256Hex } from '../crypto.ts';
import { transaction, type Database } from '../db/database.ts';
import { generateCode, normalizeApprovalCode } from '../oauth/approvalCodes.ts';
import { DAY, HOUR, MINUTE, type Clock } from '../time.ts';
import type { VerifiedRegistration } from './webauthn.ts';

/**
 * The gateway owner's browser identity for browser approval (docs/design.md, "Browser approval"): passkeys, the sessions a
 * passkey sign-in opens, and the one-time enrollment codes the owner mints with the CLI to add a passkey (first setup and
 * recovery). Session tokens are stored only as SHA-256 hashes and enrollment codes as HMACs under the server key, as
 * approval codes are; a passkey's public key is not a secret.
 */

export const OWNER_SESSION_TTL = 12 * HOUR;
export const DEFAULT_ENROLLMENT_TTL = 15 * MINUTE;
export const MAX_ENROLLMENT_TTL = DAY;
export const MAX_ENROLLMENT_FAILURES_PER_HOUR = 10;
export const MAX_PASSKEYS = 10;
export const MAX_OWNER_SESSIONS = 20;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface OwnerPasskey {
  id: string;
  credentialId: string;
  publicKey: string;
  algorithm: number;
  signCount: number;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface PasskeyRow {
  id: string;
  credential_id: string;
  public_key: string;
  algorithm: number;
  sign_count: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const toPasskey = (row: PasskeyRow): OwnerPasskey => ({
  id: row.id,
  credentialId: row.credential_id,
  publicKey: row.public_key,
  algorithm: row.algorithm,
  signCount: row.sign_count,
  label: row.label,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
});

export type EnrollmentCheck = { kind: 'ok'; codeId: string } | { kind: 'invalid' } | { kind: 'throttled' };
export type AddPasskeyResult = { kind: 'ok'; passkey: OwnerPasskey } | { kind: 'code_spent' | 'duplicate' | 'limit' };

export class OwnerStore {
  readonly #db: Database;
  readonly #key: Buffer;
  readonly #clock: Clock;

  constructor(db: Database, key: Buffer, clock: Clock) {
    this.#db = db;
    this.#key = key;
    this.#clock = clock;
  }

  #codeHash(code: string): string {
    return hmacBase64Url(this.#key, `owner-enrollment:${normalizeApprovalCode(code)}`);
  }

  /** Mint an enrollment code (CLI only). Minting also clears the failure window, as `pair` does for approvals. */
  mintEnrollmentCode(ttlMs: number = DEFAULT_ENROLLMENT_TTL): { code: string; expiresAt: number } {
    if (!(ttlMs > 0 && ttlMs <= MAX_ENROLLMENT_TTL)) throw new RangeError('Enrollment code TTL must be between 1 ms and 24 hours');
    const now = this.#clock();
    const code = generateCode();
    transaction(this.#db, () => {
      this.#db.prepare('DELETE FROM owner_enrollment_codes WHERE expires_at < ?').run(now - DAY);
      this.#db.prepare('DELETE FROM owner_enrollment_failures').run();
      this.#db
        .prepare('INSERT INTO owner_enrollment_codes (id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(randomId(), this.#codeHash(code), now, now + ttlMs);
    });
    return { code, expiresAt: now + ttlMs };
  }

  enrollmentFailures(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM owner_enrollment_failures WHERE failed_at > ?').get(this.#clock() - HOUR) as { n: number }).n;
  }

  /** Check a typed enrollment code without spending it; a wrong one counts toward the hourly limit. */
  checkEnrollmentCode(code: string): EnrollmentCheck {
    const now = this.#clock();
    return transaction(this.#db, () => {
      if (this.enrollmentFailures() >= MAX_ENROLLMENT_FAILURES_PER_HOUR) return { kind: 'throttled' } as const;
      const row = this.#db
        .prepare('SELECT id FROM owner_enrollment_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
        .get(this.#codeHash(code), now) as { id: string } | undefined;
      if (row) return { kind: 'ok', codeId: row.id } as const;
      this.#db.prepare('INSERT INTO owner_enrollment_failures (failed_at) VALUES (?)').run(now);
      return { kind: 'invalid' } as const;
    });
  }

  /** Spend the enrollment code and store the passkey, atomically: one code adds one passkey. */
  addPasskey(codeId: string, registration: VerifiedRegistration, label: string): AddPasskeyResult {
    const now = this.#clock();
    return transaction(this.#db, (): AddPasskeyResult => {
      if (this.passkeys().length >= MAX_PASSKEYS) return { kind: 'limit' };
      if (this.#db.prepare('SELECT 1 FROM owner_passkeys WHERE credential_id = ?').get(registration.credentialId)) return { kind: 'duplicate' };
      const spent = this.#db
        .prepare('UPDATE owner_enrollment_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?')
        .run(now, codeId, now);
      if (spent.changes !== 1) return { kind: 'code_spent' };
      const id = randomId();
      this.#db
        .prepare(
          `INSERT INTO owner_passkeys (id, credential_id, public_key, algorithm, sign_count, label, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, registration.credentialId, registration.publicKey, registration.algorithm, registration.signCount, label, now);
      return { kind: 'ok', passkey: this.#passkey(id)! };
    });
  }

  #passkey(id: string): OwnerPasskey | undefined {
    const row = this.#db.prepare('SELECT * FROM owner_passkeys WHERE id = ?').get(id) as PasskeyRow | undefined;
    return row ? toPasskey(row) : undefined;
  }

  /** Usable passkeys, oldest first. */
  passkeys(): OwnerPasskey[] {
    return (this.#db.prepare('SELECT * FROM owner_passkeys WHERE revoked_at IS NULL ORDER BY created_at, id').all() as unknown as PasskeyRow[]).map(toPasskey);
  }

  /** Every passkey, revoked ones included (CLI). */
  allPasskeys(): OwnerPasskey[] {
    return (this.#db.prepare('SELECT * FROM owner_passkeys ORDER BY created_at, id').all() as unknown as PasskeyRow[]).map(toPasskey);
  }

  enrolled(): boolean {
    return this.#db.prepare('SELECT 1 FROM owner_passkeys WHERE revoked_at IS NULL LIMIT 1').get() !== undefined;
  }

  usablePasskeyByCredential(credentialId: string): OwnerPasskey | undefined {
    const row = this.#db.prepare('SELECT * FROM owner_passkeys WHERE credential_id = ? AND revoked_at IS NULL').get(credentialId) as PasskeyRow | undefined;
    return row ? toPasskey(row) : undefined;
  }

  /** Record a verified sign-in; refuses when another sign-in already moved the counter past this one. */
  recordSignIn(passkeyId: string, previousCount: number, signCount: number): boolean {
    const result = this.#db
      .prepare('UPDATE owner_passkeys SET sign_count = ?, last_used_at = ? WHERE id = ? AND sign_count = ? AND revoked_at IS NULL')
      .run(signCount, this.#clock(), passkeyId, previousCount);
    return result.changes === 1;
  }

  /** Revoke a passkey and every session it opened. */
  revokePasskey(id: string): boolean {
    const now = this.#clock();
    return transaction(this.#db, () => {
      const result = this.#db.prepare('UPDATE owner_passkeys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
      this.#db.prepare('UPDATE owner_sessions SET revoked_at = ? WHERE passkey_id = ? AND revoked_at IS NULL').run(now, id);
      return result.changes === 1;
    });
  }

  /** Open a session for a verified passkey. The token is returned once and stored only as a hash. */
  createSession(passkeyId: string): { token: string; expiresAt: number } {
    const now = this.#clock();
    const token = randomToken();
    const expiresAt = now + OWNER_SESSION_TTL;
    transaction(this.#db, () => {
      this.#db.prepare('DELETE FROM owner_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').run(now);
      // Keep the newest sessions only: an unbounded number of signed-in browsers is never needed.
      this.#db
        .prepare(
          `UPDATE owner_sessions SET revoked_at = ? WHERE token_hash IN (
             SELECT token_hash FROM owner_sessions WHERE revoked_at IS NULL ORDER BY created_at DESC, token_hash LIMIT -1 OFFSET ?)`,
        )
        .run(now, MAX_OWNER_SESSIONS - 1);
      this.#db
        .prepare('INSERT INTO owner_sessions (token_hash, passkey_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(sha256Hex(token), passkeyId, now, expiresAt);
    });
    return { token, expiresAt };
  }

  /** The live session for a cookie value: unexpired, unrevoked, and its passkey unrevoked. */
  session(token: string | undefined): { passkeyId: string; expiresAt: number } | undefined {
    if (token === undefined || !SESSION_TOKEN.test(token)) return undefined;
    const row = this.#db
      .prepare(
        `SELECT s.passkey_id, s.expires_at FROM owner_sessions s JOIN owner_passkeys p ON p.id = s.passkey_id
          WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND p.revoked_at IS NULL`,
      )
      .get(sha256Hex(token), this.#clock()) as { passkey_id: string; expires_at: number } | undefined;
    return row ? { passkeyId: row.passkey_id, expiresAt: row.expires_at } : undefined;
  }

  revokeSession(token: string | undefined): void {
    if (token === undefined || !SESSION_TOKEN.test(token)) return;
    this.#db.prepare('UPDATE owner_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(this.#clock(), sha256Hex(token));
  }

  /** Sign every browser out (CLI). Returns how many live sessions ended. */
  revokeAllSessions(): number {
    const now = this.#clock();
    return Number(this.#db.prepare('UPDATE owner_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at > ?').run(now, now).changes);
  }

  activeSessions(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM owner_sessions WHERE revoked_at IS NULL AND expires_at > ?').get(this.#clock()) as { n: number }).n;
  }
}
