import { randomId } from '../crypto.ts';
import { transaction, type Database } from '../db/database.ts';
import { DAY, HOUR, MINUTE, type Clock } from '../time.ts';
import { OAuthError } from './errors.ts';
import { MAX_REDIRECT_URIS, redirectUriProblem } from './redirectUris.ts';

export const MAX_CLIENT_NAME_LENGTH = 80;
/** Registration is unauthenticated, so bound how fast clients can be created. */
export const MAX_REGISTRATIONS_PER_HOUR = 30;
/**
 * A client without a completed authorization stops counting toward the registration limit after
 * this long, so registrations nobody approves cannot hold the limit for a whole hour.
 */
export const PENDING_REGISTRATION_WINDOW = 10 * MINUTE;
/** Clients that never completed an approval are removed after this long. */
const UNAPPROVED_CLIENT_TTL = DAY;

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface ClientSummary extends OAuthClient {
  activeFamilies: number;
  scopes: string[];
}

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function fromRow(row: ClientRow): OAuthClient {
  return {
    id: row.id,
    name: row.name,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function cleanName(value: unknown): string {
  if (value === undefined) return 'Unnamed client';
  if (typeof value !== 'string') throw new OAuthError('invalid_client_metadata', 'client_name must be a string');
  const name = value.replaceAll(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0) return 'Unnamed client';
  if (name.length > MAX_CLIENT_NAME_LENGTH) {
    throw new OAuthError('invalid_client_metadata', `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`);
  }
  return name;
}

function checkOptionalList(metadata: Record<string, unknown>, field: string, allowed: readonly string[], required?: string): void {
  const value = metadata[field];
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && allowed.includes(item))) {
    throw new OAuthError('invalid_client_metadata', `${field} may only contain ${allowed.join(', ')}`);
  }
  if (required && !value.includes(required)) {
    throw new OAuthError('invalid_client_metadata', `${field} must include ${required}`);
  }
}

/** Validate RFC 7591 registration metadata for a public client. Unknown fields are ignored. */
function validateMetadata(input: unknown): { name: string; redirectUris: string[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OAuthError('invalid_client_metadata', 'Registration body must be a JSON object');
  }
  const metadata = input as Record<string, unknown>;
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array');
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError('invalid_redirect_uri', `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed`);
  }
  for (const uri of uris) {
    if (typeof uri !== 'string') throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be strings');
    const problem = redirectUriProblem(uri);
    if (problem) throw new OAuthError('invalid_redirect_uri', `Redirect URI ${problem}`);
  }
  const method = metadata.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') {
    throw new OAuthError('invalid_client_metadata', 'Only public clients are supported (token_endpoint_auth_method "none")');
  }
  checkOptionalList(metadata, 'grant_types', ['authorization_code', 'refresh_token'], 'authorization_code');
  checkOptionalList(metadata, 'response_types', ['code']);
  return { name: cleanName(metadata.client_name), redirectUris: [...new Set(uris as string[])] };
}

export class ClientStore {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  register(input: unknown): OAuthClient {
    const { name, redirectUris } = validateMetadata(input);
    const now = this.#clock();
    return transaction(this.#db, () => {
      this.#db
        .prepare(
          `DELETE FROM oauth_clients WHERE created_at < ? AND revoked_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM token_families f WHERE f.client_id = oauth_clients.id)`,
        )
        .run(now - UNAPPROVED_CLIENT_TTL);
      if (this.registrationsCounted() >= MAX_REGISTRATIONS_PER_HOUR) {
        throw new OAuthError('temporarily_unavailable', 'Too many client registrations; try again later', 429);
      }
      const client: OAuthClient = { id: randomId(12), name, redirectUris, createdAt: now, lastUsedAt: null, revokedAt: null };
      this.#db
        .prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
        .run(client.id, client.name, JSON.stringify(client.redirectUris), client.createdAt);
      return client;
    });
  }

  /**
   * Registrations that count toward the hourly limit: clients created in the last hour, and not
   * since cleared by the operator, that completed an authorization or are younger than the pending window.
   */
  registrationsCounted(): number {
    const now = this.#clock();
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM oauth_clients c WHERE c.counts_toward_limit = 1 AND c.created_at > ?
           AND (c.created_at > ? OR EXISTS (SELECT 1 FROM token_families f WHERE f.client_id = c.id))`,
      )
      .get(now - HOUR, now - PENDING_REGISTRATION_WINDOW) as { n: number };
    return row.n;
  }

  /** Stop counting every existing registration toward the limit (operator command). */
  resetRegistrationLimit(): void {
    this.#db.prepare('UPDATE oauth_clients SET counts_toward_limit = 0 WHERE counts_toward_limit = 1').run();
  }

  get(id: string): OAuthClient | undefined {
    const row = this.#db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id) as ClientRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Clients that are usable: registered and not revoked. */
  getActive(id: string): OAuthClient | undefined {
    const client = this.get(id);
    return client && client.revokedAt === null ? client : undefined;
  }

  list(): ClientSummary[] {
    const rows = this.#db.prepare('SELECT * FROM oauth_clients ORDER BY created_at').all() as unknown as ClientRow[];
    const families = this.#db.prepare(
      'SELECT scope FROM token_families WHERE client_id = ? AND revoked_at IS NULL',
    );
    return rows.map((row) => {
      const active = families.all(row.id) as { scope: string }[];
      const scopes = [...new Set(active.flatMap((family) => family.scope.split(' ')))];
      return { ...fromRow(row), activeFamilies: active.length, scopes };
    });
  }

  /** Revoke the client and every token issued to it. Returns undefined for an unknown client. */
  revoke(id: string, reason = 'client_revoked'): { families: number } | undefined {
    const now = this.#clock();
    return transaction(this.#db, () => {
      if (!this.get(id)) return undefined;
      this.#db.prepare('UPDATE oauth_clients SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now, id);
      const result = this.#db
        .prepare('UPDATE token_families SET revoked_at = ?, revoked_reason = ? WHERE client_id = ? AND revoked_at IS NULL')
        .run(now, reason, id);
      return { families: Number(result.changes) };
    });
  }

  /** Record use, at most once a minute per client to keep writes off the hot path. */
  touch(id: string): void {
    const now = this.#clock();
    this.#db
      .prepare('UPDATE oauth_clients SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
      .run(now, id, now - MINUTE);
  }
}
