import { randomToken, sha256Hex } from '../crypto.ts';
import type { Logger } from '../log.ts';
import type { OwnerStore } from '../owner/store.ts';
import type { Clock } from '../time.ts';
import type { ApprovalHost } from './approvalPage.ts';
import { ApprovedRequests } from './approvedRequests.ts';
import { APPROVAL_PAGE_TTL, authorizationRedirect, type AuthorizationRequest } from './authorizationRequest.ts';
import type { ClientStore } from './clients.ts';
import {
  formatScope,
  isHostScope,
  OPERATE_SCOPE,
  parseHostScope,
  permits,
  permitsAny,
  READ_SCOPE,
  scopesForGrant,
  withinRequest,
  type AccessChoice,
  type HostChoice,
} from './scopes.ts';
import { AUTHORIZATION_CODE_TTL, type TokenService } from './tokens.ts';

/**
 * Browser approval (docs/design.md, "Browser approval"): an authorization request the MCP listener validated is held here,
 * server side, under an opaque single-use handle, until the signed-in owner allows or denies it on the dashboard listener.
 * Both listeners run in this process, so the store is memory: bounded, expiring with the approval form (10 minutes) and
 * forgotten on restart, when the agent simply starts again. The handle grants nothing by itself: viewing and deciding need
 * an owner session, and an allowed request's code goes only to the redirect URI validated when the request was made, bound
 * to its client, PKCE challenge and resource exactly as a code from the approval-code form.
 */

export const MAX_PENDING_PER_CLIENT = 5;
export const MAX_PENDING = 500;
const HANDLE = /^[A-Za-z0-9_-]{43}$/;

interface Pending {
  request: AuthorizationRequest;
  /** The approval form's signature for the same request, so the two paths answer it once between them. */
  signature: string;
  expiresAt: number;
  createdAt: number;
}

/** What the owner reviews; only text the approval page also shows. */
export interface PendingView {
  clientName: string;
  returnOrigin: string;
  requested: string;
  allowOperate: boolean;
  allowAll: boolean;
  access: AccessChoice;
  machines: 'all' | 'selected';
  hosts: { id: string; label: string | null; allowed: boolean; selected: boolean }[];
  expiresAt: string;
}

export interface OwnerDecision {
  decision: 'allow' | 'deny';
  access?: unknown;
  hostsMode?: unknown;
  hosts?: unknown;
}

export type DecisionResult =
  | { kind: 'answered'; responseUrl: string; returnOrigin: string; approved: boolean }
  /** The choice was refused; the request stays pending so the owner can correct it. */
  | { kind: 'refused'; message: string }
  /** Unknown, already answered, expired, or its client is gone: the agent must start again. */
  | { kind: 'gone' };

/**
 * The machines chosen: `all` is the fleet-wide grant; selected needs at least one ticked, configured host. Anything
 * ambiguous or malformed is refused, never taken for all. A form from before host selection sends neither and means all.
 */
export function hostSelection(modes: readonly string[], picked: readonly string[], hosts: readonly ApprovalHost[]): { hosts: HostChoice } | { error: string } {
  if (modes.length > 1) return { error: 'Choose All machines or Selected machines, then approve.' };
  const mode = modes[0];
  if (mode === undefined || mode === 'all') {
    if (picked.length === 0) return { hosts: 'all' };
    return { error: 'Machines are ticked but All machines is chosen. Choose Selected machines to limit access to them, or untick them.' };
  }
  if (mode !== 'selected') return { error: 'Choose All machines or Selected machines, then approve.' };
  if (picked.length === 0) return { error: 'Tick at least one machine for Selected machines, or choose All machines.' };
  if (picked.some((id) => !hosts.some((host) => host.id === id))) return { error: 'A ticked machine is not configured on this gateway. Reload the page.' };
  return { hosts: [...new Set(picked)] };
}

/** The grant an approval chooses, checked against the request's ceiling. Shared by the code form and the dashboard. */
export function chooseGrant(
  request: AuthorizationRequest,
  access: unknown,
  modes: readonly string[],
  picked: readonly string[],
  hosts: readonly ApprovalHost[],
): { scopes: ReturnType<typeof scopesForGrant> } | { error: string } {
  if (access !== 'read' && access !== 'operate') return { error: 'Choose Read or Operate, then approve.' };
  const selection = hostSelection(modes, picked, hosts);
  if ('error' in selection) return selection;
  const scopes = scopesForGrant(access, selection.hosts);
  if (!withinRequest(request.requestedScopes, scopes)) {
    return { error: 'That is more access than the agent asked for. Choose only the machines and access it requested.' };
  }
  return { scopes };
}

export interface BrowserApprovalOptions {
  publicUrl: string;
  /** The page on the dashboard listener where the owner answers, for example https://gateway.example.ts.net/fleet/owner. */
  ownerPageUrl: string;
  clock: Clock;
  logger: Logger;
  clients: ClientStore;
  tokens: TokenService;
  owner: OwnerStore;
  hosts: readonly ApprovalHost[];
}

export class BrowserApprovals {
  /** Approved and denied requests by form signature, shared with the approval-code form. */
  readonly approved: ApprovedRequests;
  readonly #options: BrowserApprovalOptions;
  readonly #pending = new Map<string, Pending>();

  constructor(options: BrowserApprovalOptions) {
    this.#options = options;
    this.approved = new ApprovedRequests(options.clock);
  }

  /** Browser approval is offered only once the owner has a usable passkey: unconfigured, it fails closed. */
  available(): boolean {
    return this.#options.owner.enrolled();
  }

  #prune(): number {
    const now = this.#options.clock();
    for (const [key, entry] of this.#pending) if (entry.expiresAt <= now) this.#pending.delete(key);
    return now;
  }

  /**
   * Hold a validated request for the owner and return the dashboard link for it, or undefined when browser approval is not
   * available or the store is full (the approval-code form still works). A client's oldest request gives way to its sixth.
   */
  offer(request: AuthorizationRequest, signature: string, issuedAt: number): string | undefined {
    if (!this.available() || this.approved.lookup(signature)) return undefined;
    this.#prune();
    const mine = [...this.#pending].filter(([, entry]) => entry.request.client.id === request.client.id);
    if (mine.length >= MAX_PENDING_PER_CLIENT) this.#pending.delete(mine[0]![0]);
    if (this.#pending.size >= MAX_PENDING) {
      this.#options.logger.warn('oauth.browser_approval_full', { clientId: request.client.id });
      return undefined;
    }
    const handle = randomToken();
    this.#pending.set(sha256Hex(handle), { request, signature, createdAt: issuedAt, expiresAt: issuedAt + APPROVAL_PAGE_TTL });
    this.#options.logger.info('oauth.browser_approval_offered', { clientId: request.client.id });
    return `${this.#options.ownerPageUrl}#/approve/${handle}`;
  }

  #lookup(handle: unknown): [string, Pending] | undefined {
    if (typeof handle !== 'string' || !HANDLE.test(handle)) return undefined;
    this.#prune();
    const key = sha256Hex(handle);
    const entry = this.#pending.get(key);
    if (!entry || this.approved.lookup(entry.signature) || !this.#options.clients.getActive(entry.request.client.id)) return undefined;
    return [key, entry];
  }

  /** The request behind a handle, for the signed-in owner to review. */
  view(handle: unknown): PendingView | undefined {
    const found = this.#lookup(handle);
    if (!found) return undefined;
    const { request, expiresAt } = found[1];
    const scopes = request.requestedScopes;
    const hostSpecific = scopes.some(isHostScope);
    const preferOperate = permitsAny(scopes, 'operate');
    const requestedHosts = scopes.map((scope) => parseHostScope(scope)?.hostId).filter((id) => id !== undefined);
    return {
      clientName: request.client.name,
      returnOrigin: new URL(request.redirectUri).origin,
      requested: scopes.length > 0 ? formatScope(scopes) : 'not specified',
      allowOperate: !hostSpecific || preferOperate,
      allowAll: !hostSpecific || scopes.includes(READ_SCOPE) || scopes.includes(OPERATE_SCOPE),
      access: preferOperate ? 'operate' : 'read',
      machines: hostSpecific ? 'selected' : 'all',
      hosts: this.#options.hosts.map((host) => {
        const allowed = !hostSpecific || permits(scopes, 'read', host.id) || permits(scopes, 'operate', host.id);
        return { id: host.id, label: host.label ?? null, allowed, selected: allowed && requestedHosts.includes(host.id) };
      }),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * The owner's explicit answer to exactly this request. The handle is spent before a code exists, so of two concurrent
   * answers (two tabs, a double click, the code form) exactly one takes effect; a refused choice spends nothing.
   */
  decide(handle: unknown, choice: OwnerDecision, passkeyId: string): DecisionResult {
    const found = this.#lookup(handle);
    if (!found) return { kind: 'gone' };
    const [, { request, signature }] = found;
    const { publicUrl, logger } = this.#options;
    const clientId = request.client.id;
    const returnOrigin = new URL(request.redirectUri).origin;
    if (choice.decision === 'deny') {
      this.settle(signature);
      this.approved.rememberDenied(signature);
      logger.info('oauth.browser_approval_denied', { clientId, passkeyId });
      const responseUrl = authorizationRedirect(request.redirectUri, { error: 'access_denied', state: request.state, iss: publicUrl });
      return { kind: 'answered', responseUrl, returnOrigin, approved: false };
    }
    const modes = typeof choice.hostsMode === 'string' ? [choice.hostsMode] : [];
    const picked = Array.isArray(choice.hosts) && choice.hosts.length <= 64 && choice.hosts.every((id) => typeof id === 'string') ? choice.hosts as string[] : null;
    if (picked === null) return { kind: 'refused', message: 'Tick machines from the list, then approve.' };
    const grant = chooseGrant(request, choice.access, modes, picked, this.#options.hosts);
    if ('error' in grant) return { kind: 'refused', message: grant.error };
    this.settle(signature);
    const issuedAt = this.#options.clock();
    const code = this.#options.tokens.issueAuthorizationCode({
      clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes: grant.scopes,
    });
    const responseUrl = authorizationRedirect(request.redirectUri, { code, state: request.state, iss: publicUrl });
    this.approved.remember(signature, { url: responseUrl, code, expiresAt: issuedAt + AUTHORIZATION_CODE_TTL });
    logger.info('oauth.browser_approval_granted', { clientId, passkeyId, scope: formatScope(grant.scopes) });
    return { kind: 'answered', responseUrl, returnOrigin, approved: true };
  }

  /** The approval-code form answered this request: its dashboard handle is spent too. */
  settle(signature: string): void {
    for (const [key, entry] of this.#pending) if (entry.signature === signature) this.#pending.delete(key);
  }

  /** Pending requests held now (tests and diagnostics; never their contents). */
  get size(): number {
    this.#prune();
    return this.#pending.size;
  }
}
