import { randomBytes } from 'node:crypto';
import { hmacBase64Url, randomId } from '../crypto.ts';
import { transaction, type Database } from '../db/database.ts';
import { DAY, HOUR, MINUTE, type Clock } from '../time.ts';

export const DEFAULT_APPROVAL_CODE_TTL = 15 * MINUTE;
export const MAX_APPROVAL_CODE_TTL = DAY;
export const MAX_FAILURES_PER_REQUEST = 5;
export const MAX_FAILURES_PER_HOUR = 20;

/** Crockford base32: no I, L, O or U, so codes survive being read aloud or retyped. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;

export type ThrottleState = 'ok' | 'request_locked' | 'global_locked';

export function normalizeApprovalCode(input: string): string {
  return input
    .toUpperCase()
    .replaceAll(/[^0-9A-Z]/g, '')
    .replaceAll(/[IL]/g, '1')
    .replaceAll('O', '0');
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte & 31];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * One-time approval codes the operator mints with the CLI and types into the approval page.
 * Stored only as keyed hashes. Failed attempts are throttled per authorization request and
 * globally; the global limit is a rolling one-hour window, which acts as the cool-down. Anyone who
 * can reach the approval page can exhaust the global limit, so minting a code (which only the
 * operator can do) starts a fresh global window; per-request locks stay.
 */
export class ApprovalCodes {
  readonly #db: Database;
  readonly #key: Buffer;
  readonly #clock: Clock;

  constructor(db: Database, key: Buffer, clock: Clock) {
    this.#db = db;
    this.#key = key;
    this.#clock = clock;
  }

  #hash(code: string): string {
    return hmacBase64Url(this.#key, `approval-code:${normalizeApprovalCode(code)}`);
  }

  /**
   * Mint a code. This also clears the global failure window; `clearedLock` reports whether
   * approvals were paused by it.
   */
  mint(ttlMs: number = DEFAULT_APPROVAL_CODE_TTL): { code: string; expiresAt: number; clearedLock: boolean } {
    if (!(ttlMs > 0 && ttlMs <= MAX_APPROVAL_CODE_TTL)) throw new RangeError('Approval code TTL must be between 1 ms and 24 hours');
    const now = this.#clock();
    const code = generateCode();
    const expiresAt = now + ttlMs;
    const clearedLock = transaction(this.#db, () => {
      this.#db.prepare('DELETE FROM approval_codes WHERE expires_at < ?').run(now - DAY);
      this.#db.prepare('DELETE FROM approval_failures WHERE failed_at < ?').run(now - DAY);
      this.#db
        .prepare('INSERT INTO approval_codes (id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(randomId(), this.#hash(code), now, expiresAt);
      const locked = this.globalFailures() >= MAX_FAILURES_PER_HOUR;
      this.#db.prepare('UPDATE approval_failures SET counts_globally = 0 WHERE counts_globally = 1').run();
      return locked;
    });
    return { code, expiresAt, clearedLock };
  }

  /** Failed attempts that count toward the global limit: the last hour, since the last code was minted. */
  globalFailures(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM approval_failures WHERE counts_globally = 1 AND failed_at > ?').get(this.#clock() - HOUR);
    return (row as { n: number }).n;
  }

  /** Clear every approval throttle, per-request locks included (operator command). */
  resetThrottles(): void {
    this.#db.prepare('DELETE FROM approval_failures').run();
  }

  throttleState(requestKey: string): ThrottleState {
    if (this.globalFailures() >= MAX_FAILURES_PER_HOUR) return 'global_locked';
    const perRequest = this.#db
      .prepare('SELECT COUNT(*) AS n FROM approval_failures WHERE request_key = ?')
      .get(requestKey) as { n: number };
    return perRequest.n >= MAX_FAILURES_PER_REQUEST ? 'request_locked' : 'ok';
  }

  /** Consume a valid, unexpired, unused code. Records a failure (for throttling) otherwise. */
  redeem(code: string, requestKey: string, clientId: string): boolean {
    const now = this.#clock();
    return transaction(this.#db, () => {
      const result = this.#db
        .prepare(
          `UPDATE approval_codes SET used_at = ?, used_by_client_id = ?
             WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
        )
        .run(now, clientId, this.#hash(code), now);
      if (result.changes === 1) return true;
      this.#db.prepare('INSERT INTO approval_failures (request_key, failed_at) VALUES (?, ?)').run(requestKey, now);
      return false;
    });
  }
}
