import { isValidPkceVerifier, pkceChallenge, randomId, randomToken, safeEqual, sha256Hex } from '../crypto.ts';
import { transaction, type Database } from '../db/database.ts';
import { DAY, MINUTE, SECOND, type Clock } from '../time.ts';
import { OAuthError } from './errors.ts';
import { formatScope, parseScope, type Scope } from './scopes.ts';

export const AUTHORIZATION_CODE_TTL = 60 * SECOND;
/**
 * A rotated refresh token presented again within this window is a client retry (a lost response, or
 * concurrent requests refreshing with the same token): it gets another pair alongside the first.
 */
export const REFRESH_GRACE = 2 * MINUTE;
/** `expiresAt` of an operator token that does not expire (`clients token --ttl never`): later than any clock reading. */
export const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

export interface TokenSettings {
  /** Canonical resource (audience) that every token is bound to. */
  resource: string;
  accessTtlSeconds: number;
  refreshIdleTtlDays: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface VerifiedAccessToken {
  clientId: string;
  familyId: string;
  scopes: Scope[];
  /** Unix milliseconds. */
  expiresAt: number;
  resource: string;
}

export type TokenEvent =
  | { type: 'issued'; clientId: string; familyId: string; grant: 'authorization_code' | 'refresh_token' }
  | { type: 'refresh_retry'; clientId: string; familyId: string }
  | { type: 'family_revoked'; clientId: string; familyId: string; reason: 'refresh_token_reuse' | 'authorization_code_reuse' };

interface RefreshRow {
  token_hash: string;
  family_id: string;
  scope: string;
  expires_at: number;
  parent_hash: string | null;
  rotated_at: number | null;
  superseded_at: number | null;
  client_id: string;
  resource: string;
  family_revoked_at: number | null;
  client_revoked_at: number | null;
}

const hashToken = (token: string): string => sha256Hex(token);

function resourceMatches(candidate: string, resource: string): boolean {
  return candidate.replace(/\/$/, '') === resource.replace(/\/$/, '');
}

/**
 * Authorization codes, access tokens and rotating refresh tokens. Only SHA-256 hashes of codes and
 * tokens are stored. Refresh tokens rotate on every use and remember the token they were issued
 * from (`parent_hash`). Presenting a rotated token again within the grace window issues another pair
 * from it, a sibling of the first; siblings stay valid side by side, because a client that refreshed
 * twice concurrently keeps whichever pair it saved last. The first time any sibling is rotated, the
 * client has settled on it: the other siblings are superseded and the parent can no longer be
 * retried. Presenting a superseded token, or a rotated one after the grace window or after one of
 * its children was rotated, revokes the whole family.
 */
export class TokenService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #settings: TokenSettings;
  readonly #onEvent: (event: TokenEvent) => void;

  constructor(db: Database, clock: Clock, settings: TokenSettings, onEvent: (event: TokenEvent) => void = () => {}) {
    this.#db = db;
    this.#clock = clock;
    this.#settings = settings;
    this.#onEvent = onEvent;
  }

  get resource(): string {
    return this.#settings.resource;
  }

  issueAuthorizationCode(grant: { clientId: string; redirectUri: string; codeChallenge: string; scopes: Scope[] }): string {
    const code = randomToken();
    const now = this.#clock();
    this.#db.prepare('DELETE FROM authorization_codes WHERE expires_at < ?').run(now - DAY);
    this.#db
      .prepare(
        `INSERT INTO authorization_codes (code_hash, client_id, redirect_uri, code_challenge, resource, scope, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashToken(code),
        grant.clientId,
        grant.redirectUri,
        grant.codeChallenge,
        this.#settings.resource,
        formatScope(grant.scopes),
        now,
        now + AUTHORIZATION_CODE_TTL,
      );
    return code;
  }

  /** Whether a code can still be exchanged: known, unused and unexpired. */
  authorizationCodePending(code: string): boolean {
    const row = this.#db.prepare('SELECT used_at, expires_at FROM authorization_codes WHERE code_hash = ?').get(hashToken(code)) as
      | { used_at: number | null; expires_at: number }
      | undefined;
    return row !== undefined && row.used_at === null && row.expires_at > this.#clock();
  }

  exchangeAuthorizationCode(request: {
    code: string;
    clientId: string;
    redirectUri: string | undefined;
    codeVerifier: string | undefined;
    resource: string | undefined;
  }): TokenResponse {
    const now = this.#clock();
    const outcome = transaction(this.#db, () => {
      const row = this.#db
        .prepare(
          `SELECT a.*, c.revoked_at AS client_revoked_at FROM authorization_codes a
             JOIN oauth_clients c ON c.id = a.client_id WHERE a.code_hash = ?`,
        )
        .get(hashToken(request.code)) as
        | {
            client_id: string;
            redirect_uri: string;
            code_challenge: string;
            resource: string;
            scope: string;
            expires_at: number;
            used_at: number | null;
            family_id: string | null;
            client_revoked_at: number | null;
          }
        | undefined;
      if (!row) return { error: new OAuthError('invalid_grant', 'Unknown authorization code') };
      if (row.used_at !== null) {
        // A replayed code means it leaked; revoke what it produced (RFC 6749 section 4.1.2).
        if (row.family_id) this.#revokeFamily(row.family_id, 'authorization_code_reuse', now);
        return {
          error: new OAuthError('invalid_grant', 'Authorization code was already used'),
          event: row.family_id
            ? ({ type: 'family_revoked', clientId: row.client_id, familyId: row.family_id, reason: 'authorization_code_reuse' } as const)
            : undefined,
        };
      }
      if (row.client_id !== request.clientId) return { error: new OAuthError('invalid_grant', 'Code was issued to another client') };
      if (row.client_revoked_at !== null) return { error: new OAuthError('invalid_grant', 'Client has been revoked') };
      if (row.expires_at <= now) return { error: new OAuthError('invalid_grant', 'Authorization code expired') };
      if (request.redirectUri !== row.redirect_uri) return { error: new OAuthError('invalid_grant', 'redirect_uri does not match') };
      if (!request.codeVerifier || !isValidPkceVerifier(request.codeVerifier)) {
        return { error: new OAuthError('invalid_grant', 'A valid code_verifier is required') };
      }
      if (!safeEqual(pkceChallenge(request.codeVerifier), row.code_challenge)) {
        return { error: new OAuthError('invalid_grant', 'PKCE verification failed') };
      }
      if (request.resource !== undefined && !resourceMatches(request.resource, row.resource)) {
        return { error: new OAuthError('invalid_target', 'resource does not match this server') };
      }
      const familyId = randomId(12);
      this.#db
        .prepare('INSERT INTO token_families (id, client_id, scope, resource, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(familyId, row.client_id, row.scope, row.resource, now);
      this.#db
        .prepare('UPDATE authorization_codes SET used_at = ?, family_id = ? WHERE code_hash = ?')
        .run(now, familyId, hashToken(request.code));
      return {
        response: this.#issuePair(familyId, row.scope, now),
        event: { type: 'issued', clientId: row.client_id, familyId, grant: 'authorization_code' } as const,
      };
    });
    if (outcome.event) this.#onEvent(outcome.event);
    if ('error' in outcome) throw outcome.error;
    return outcome.response;
  }

  refresh(request: { refreshToken: string; clientId: string; scope: string | undefined; resource: string | undefined }): TokenResponse {
    const now = this.#clock();
    const outcome = transaction(this.#db, () => {
      const row = this.#db
        .prepare(
          `SELECT r.*, f.client_id, f.resource, f.revoked_at AS family_revoked_at, c.revoked_at AS client_revoked_at
             FROM refresh_tokens r JOIN token_families f ON f.id = r.family_id JOIN oauth_clients c ON c.id = f.client_id
             WHERE r.token_hash = ?`,
        )
        .get(hashToken(request.refreshToken)) as RefreshRow | undefined;
      if (!row || row.client_id !== request.clientId) return { error: new OAuthError('invalid_grant', 'Unknown refresh token') };
      if (row.family_revoked_at !== null || row.client_revoked_at !== null) {
        return { error: new OAuthError('invalid_grant', 'Refresh token has been revoked') };
      }
      const replay =
        row.superseded_at !== null ||
        (row.rotated_at !== null && (now - row.rotated_at > REFRESH_GRACE || this.#childWasRotated(row.token_hash)));
      if (replay) {
        this.#revokeFamily(row.family_id, 'refresh_token_reuse', now);
        return {
          error: new OAuthError('invalid_grant', 'Refresh token was already used; all tokens for this grant are revoked'),
          event: { type: 'family_revoked', clientId: row.client_id, familyId: row.family_id, reason: 'refresh_token_reuse' } as const,
        };
      }
      if (row.expires_at <= now) return { error: new OAuthError('invalid_grant', 'Refresh token expired after inactivity') };
      if (request.resource !== undefined && !resourceMatches(request.resource, row.resource)) {
        return { error: new OAuthError('invalid_target', 'resource does not match this server') };
      }
      let scope = row.scope;
      if (request.scope !== undefined) {
        const requested = parseScope(request.scope);
        const granted = row.scope.split(' ');
        if (!requested || requested.length === 0 || !requested.every((item) => granted.includes(item))) {
          return { error: new OAuthError('invalid_scope', 'Requested scope exceeds the original grant') };
        }
        scope = formatScope(requested);
      }
      // A retry leaves the pairs already issued from this token alone: the client may have kept any of them.
      const isRetry = row.rotated_at !== null;
      if (!isRetry) {
        this.#db.prepare('UPDATE access_tokens SET revoked_at = ? WHERE refresh_token_hash = ? AND revoked_at IS NULL').run(now, row.token_hash);
        this.#db.prepare('UPDATE refresh_tokens SET rotated_at = ? WHERE token_hash = ?').run(now, row.token_hash);
        if (row.parent_hash !== null) {
          // The client settled on this token, so its siblings will not be used again.
          this.#db
            .prepare(
              `UPDATE refresh_tokens SET superseded_at = ?
                 WHERE parent_hash = ? AND token_hash != ? AND rotated_at IS NULL AND superseded_at IS NULL`,
            )
            .run(now, row.parent_hash, row.token_hash);
        }
      }
      const response = this.#issuePair(row.family_id, scope, now, row.token_hash);
      const event: TokenEvent = isRetry
        ? { type: 'refresh_retry', clientId: row.client_id, familyId: row.family_id }
        : { type: 'issued', clientId: row.client_id, familyId: row.family_id, grant: 'refresh_token' };
      return { response, event };
    });
    if (outcome.event) this.#onEvent(outcome.event);
    if ('error' in outcome) throw outcome.error;
    return outcome.response;
  }

  /**
   * A bearer token the operator mints for an agent that cannot sign in with OAuth (`clients token`). It gets
   * a client of its own (no redirect URIs, so it can never complete an authorization; not counted toward the
   * registration limit) with one grant and one access token, and no refresh token: it works until it expires
   * or the client is revoked.
   */
  issueOperatorToken(input: { name: string; scopes: Scope[]; expiresAt: number }): { clientId: string; token: string } {
    const token = randomToken();
    const clientId = randomId(12);
    const familyId = randomId(12);
    const scope = formatScope(input.scopes);
    const now = this.#clock();
    transaction(this.#db, () => {
      this.#db
        .prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at, counts_toward_limit) VALUES (?, ?, '[]', ?, 0)")
        .run(clientId, input.name, now);
      this.#db
        .prepare('INSERT INTO token_families (id, client_id, scope, resource, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(familyId, clientId, scope, this.#settings.resource, now);
      // refresh_token_hash cannot be NULL; an empty one matches no refresh token, so nothing ever rotates it.
      this.#db
        .prepare(
          `INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
           VALUES (?, ?, '', ?, ?, ?)`,
        )
        .run(hashToken(token), familyId, scope, now, input.expiresAt);
    });
    return { clientId, token };
  }

  /** Returns the token's grant, or undefined when it is unknown, expired, revoked or for another resource. */
  verifyAccessToken(token: string): VerifiedAccessToken | undefined {
    const row = this.#db
      .prepare(
        `SELECT a.scope, a.expires_at, a.revoked_at, a.family_id, f.client_id, f.resource,
                f.revoked_at AS family_revoked_at, c.revoked_at AS client_revoked_at
           FROM access_tokens a JOIN token_families f ON f.id = a.family_id JOIN oauth_clients c ON c.id = f.client_id
           WHERE a.token_hash = ?`,
      )
      .get(hashToken(token)) as
      | {
          scope: string;
          expires_at: number;
          revoked_at: number | null;
          family_id: string;
          client_id: string;
          resource: string;
          family_revoked_at: number | null;
          client_revoked_at: number | null;
        }
      | undefined;
    if (!row) return undefined;
    if (row.revoked_at !== null || row.family_revoked_at !== null || row.client_revoked_at !== null) return undefined;
    if (row.expires_at <= this.#clock() || !resourceMatches(row.resource, this.#settings.resource)) return undefined;
    return {
      clientId: row.client_id,
      familyId: row.family_id,
      scopes: parseScope(row.scope) ?? [],
      expiresAt: row.expires_at,
      resource: row.resource,
    };
  }

  #childWasRotated(tokenHash: string): boolean {
    return this.#db.prepare('SELECT 1 AS present FROM refresh_tokens WHERE parent_hash = ? AND rotated_at IS NOT NULL LIMIT 1').get(tokenHash) !== undefined;
  }

  #issuePair(familyId: string, scope: string, now: number, parentHash: string | null = null): TokenResponse {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessTtlMs = this.#settings.accessTtlSeconds * SECOND;
    this.#db
      .prepare('INSERT INTO refresh_tokens (token_hash, family_id, parent_hash, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hashToken(refreshToken), familyId, parentHash, scope, now, now + this.#settings.refreshIdleTtlDays * DAY);
    this.#db
      .prepare(
        `INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(hashToken(accessToken), familyId, hashToken(refreshToken), scope, now, now + accessTtlMs);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.#settings.accessTtlSeconds,
      refresh_token: refreshToken,
      scope,
    };
  }

  #revokeFamily(familyId: string, reason: string, now: number): void {
    this.#db
      .prepare('UPDATE token_families SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, reason, familyId);
  }
}
