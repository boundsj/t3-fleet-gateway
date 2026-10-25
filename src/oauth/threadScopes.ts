import { transaction, type Database } from '../db/database.ts';
import { GatewayError } from '../errors.ts';
import type { Clock } from '../time.ts';
import { THREAD_SCOPES, type Scope, type ThreadScope } from './scopes.ts';

/** Client-level opt-ins are read afresh on every MCP authentication; token and refresh hashes stay untouched. */
export function clientThreadScopes(db: Database, clientId: string): ThreadScope[] {
  return (db.prepare('SELECT scope FROM client_thread_scopes WHERE client_id = ? ORDER BY scope').all(clientId) as { scope: ThreadScope }[])
    .map((row) => row.scope);
}

export function effectiveScopes(db: Database, clientId: string, granted: readonly Scope[]): Scope[] {
  // Only the operator's current selection confers external-thread access, never a historic token or approval request.
  return [...granted.filter((scope) => !THREAD_SCOPES.includes(scope as ThreadScope)), ...clientThreadScopes(db, clientId)];
}

/** Persist both changes and idempotent retries, without touching any grant, token, hash, expiry or host restriction. */
export function changeThreadScopes(db: Database, clock: Clock, clientId: string, action: 'grant' | 'revoke', scopes: readonly string[]): {
  scopes: ThreadScope[]; changed: boolean;
} {
  if (scopes.length === 0 || scopes.some((scope) => !THREAD_SCOPES.includes(scope as ThreadScope))) {
    throw new GatewayError('invalid_argument', `--scope must name ${THREAD_SCOPES.join(' or ')} (repeat it for both).`);
  }
  return transaction(db, () => {
    const client = db.prepare('SELECT revoked_at FROM oauth_clients WHERE id = ?').get(clientId) as { revoked_at: number | null } | undefined;
    if (!client) throw new GatewayError('not_found', 'No client with that id. Use clients list.');
    if (action === 'grant' && client.revoked_at !== null) throw new GatewayError('invalid_argument', 'A revoked client cannot receive scopes.');
    let changed = false;
    for (const scope of new Set(scopes)) {
      const result = action === 'grant'
        ? db.prepare('INSERT OR IGNORE INTO client_thread_scopes (client_id, scope) VALUES (?, ?)').run(clientId, scope)
        : db.prepare('DELETE FROM client_thread_scopes WHERE client_id = ? AND scope = ?').run(clientId, scope);
      const didChange = Number(result.changes) > 0;
      changed ||= didChange;
      db.prepare('INSERT INTO operator_scope_events (client_id, action, scope, changed, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(clientId, action, scope, didChange ? 1 : 0, clock());
    }
    return { scopes: clientThreadScopes(db, clientId), changed };
  });
}
