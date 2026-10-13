import type { Database } from '../db/database.ts';
import type { Clock } from '../time.ts';
import { ClientStore, isTokenClient } from './clients.ts';
import { accessIsUsable, refreshIsReplay, resourceMatches } from './tokens.ts';

type GrantState = 'usable' | 'grace_retry' | 'expired' | 'revoked' | 'superseded' | 'replay' | 'wrong_resource';
export interface GrantSummary {
  state: GrantState;
  count: number;
  earliestExpiresAt: number;
  latestExpiresAt: number;
}
export interface FamilyDiagnostic {
  id: string;
  /** The scope the grant was approved with (narrowed refreshes may carry less). */
  scope: string;
  revokedAt: number | null;
  revocationReason: string | null;
  usableAccess: boolean;
  usableRefresh: boolean;
  access: GrantSummary[];
  refresh: GrantSummary[];
}
export interface ClientDiagnostic {
  id: string;
  kind: 'oauth' | 'bearer';
  state: 'pending' | 'revoked' | 'active' | 'refreshable' | 'unusable';
  checkedAt: number;
  revokedAt: number | null;
  usableAccess: boolean;
  usableRefresh: boolean;
  lastMcpSuccessAt: number | null;
  lastRefreshSuccessAt: number | null;
  families: FamilyDiagnostic[];
}

function summarize(rows: { state: GrantState; expires_at: number }[]): GrantSummary[] {
  const groups = new Map<GrantState, GrantSummary>();
  for (const row of rows) {
    const group = groups.get(row.state);
    if (group) {
      group.count++;
      group.earliestExpiresAt = Math.min(group.earliestExpiresAt, row.expires_at);
      group.latestExpiresAt = Math.max(group.latestExpiresAt, row.expires_at);
    } else groups.set(row.state, { state: row.state, count: 1, earliestExpiresAt: row.expires_at, latestExpiresAt: row.expires_at });
  }
  return [...groups.values()];
}

/** Read-only server capability, never a claim about the particular token/sibling a connector saved. No hashes leave this function. */
export function diagnoseClient(db: Database, clock: Clock, resource: string, id: string): ClientDiagnostic | undefined {
  const client = new ClientStore(db, clock).get(id);
  if (!client) return undefined;
  const now = clock();
  const times = db.prepare('SELECT last_mcp_success_at, last_refresh_success_at FROM oauth_clients WHERE id = ?').get(id) as {
    last_mcp_success_at: number | null; last_refresh_success_at: number | null;
  };
  const families = (db.prepare('SELECT id, scope, resource, revoked_at, revoked_reason FROM token_families WHERE client_id = ? ORDER BY created_at, id')
    .all(id) as { id: string; scope: string; resource: string; revoked_at: number | null; revoked_reason: string | null }[]).map((family): FamilyDiagnostic => {
    const access = summarize((db.prepare('SELECT expires_at, revoked_at FROM access_tokens WHERE family_id = ? ORDER BY created_at, rowid')
      .all(family.id) as { expires_at: number; revoked_at: number | null }[]).map((row) => {
      const state: GrantState = accessIsUsable({ ...row, resource: family.resource,
        family_revoked_at: family.revoked_at, client_revoked_at: client.revokedAt }, now, resource) ? 'usable'
        : row.revoked_at !== null || family.revoked_at !== null || client.revokedAt !== null ? 'revoked'
        : row.expires_at <= now ? 'expired' : 'wrong_resource';
      return { state, expires_at: row.expires_at };
    }));
    const refresh = summarize((db.prepare(`SELECT r.expires_at, r.rotated_at, r.superseded_at,
        EXISTS(SELECT 1 FROM refresh_tokens child WHERE child.parent_hash = r.token_hash AND child.rotated_at IS NOT NULL) AS child_rotated
        FROM refresh_tokens r WHERE r.family_id = ? ORDER BY r.created_at, r.rowid`).all(family.id) as {
      expires_at: number; rotated_at: number | null; superseded_at: number | null; child_rotated: number;
    }[]).map((row) => {
      // Same precedence as TokenService.refresh: replay is rejected before expiry/resource checks.
      const state: GrantState = family.revoked_at !== null || client.revokedAt !== null ? 'revoked'
        : row.superseded_at !== null ? 'superseded'
        : refreshIsReplay(row, now, row.child_rotated !== 0) ? 'replay'
        : row.expires_at <= now ? 'expired'
        : !resourceMatches(family.resource, resource) ? 'wrong_resource'
        : row.rotated_at !== null ? 'grace_retry' : 'usable';
      return { state, expires_at: row.expires_at };
    }));
    return { id: family.id, scope: family.scope, revokedAt: family.revoked_at, revocationReason: family.revoked_reason,
      usableAccess: access.some((grant) => grant.state === 'usable'),
      usableRefresh: refresh.some((grant) => grant.state === 'usable' || grant.state === 'grace_retry'), access, refresh };
  });
  const usableAccess = families.some((family) => family.usableAccess);
  const usableRefresh = families.some((family) => family.usableRefresh);
  return { id, kind: isTokenClient(client) ? 'bearer' : 'oauth', checkedAt: now, revokedAt: client.revokedAt,
    state: client.revokedAt !== null ? 'revoked' : families.length === 0 ? 'pending'
      : usableAccess ? 'active' : usableRefresh ? 'refreshable' : 'unusable',
    usableAccess, usableRefresh, lastMcpSuccessAt: times.last_mcp_success_at, lastRefreshSuccessAt: times.last_refresh_success_at, families };
}
