import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomToken } from '../crypto.ts';
import { readJson, sendJson } from '../http/io.ts';
import type { Route } from '../http/server.ts';
import type { Logger } from '../log.ts';
import type { BrowserApprovals } from '../oauth/browserApproval.ts';
import { MAX_PASSKEYS, OWNER_SESSION_TTL, type OwnerStore } from '../owner/store.ts';
import { PASSKEY_ALGORITHMS, verifyAssertion, verifyRegistration, WebAuthnError, type RelyingParty } from '../owner/webauthn.ts';
import { MINUTE, type Clock } from '../time.ts';

/**
 * Owner sign-in and browser approval on the dashboard listener (docs/design.md, "Browser approval"). Only here, never on the
 * MCP listener. Network reach does not make anyone the owner: viewing or answering an authorization request needs a session
 * opened by a passkey sign-in, and a passkey can be added only with a one-time enrollment code minted by the CLI on the
 * gateway machine. Every request also passes the dashboard's own guards (Host allowlist, Funnel refusal, API header,
 * fetch metadata) and, for every POST here, an Origin equal to the configured browser approval origin and a Host to match.
 */

const CEREMONY_TTL = 2 * MINUTE;
const MAX_CEREMONIES = 32;
const BODY_LIMIT = 16 * 1024;
const CEREMONY_ID = /^[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,1400}$/;

interface Ceremony {
  kind: 'enroll' | 'signin';
  challenge: string;
  expiresAt: number;
  codeId?: string;
}

export interface OwnerRouteOptions {
  /** The dashboard's base path without a trailing slash ('' for "/"). */
  base: string;
  /** The configured browser approval origin. */
  origin: string;
  owner: OwnerStore;
  approvals: BrowserApprovals;
  clock: Clock;
  logger: Logger;
  /** The dashboard's API and same-origin mutation guards; false after answering. */
  apiRequest: (req: IncomingMessage, res: ServerResponse) => boolean;
  refuse: (res: ServerResponse, status: number, reason: string, text: string) => void;
  available: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

export function ownerRoutes(options: OwnerRouteOptions): Route[] {
  const { base, origin, owner, approvals, clock, logger } = options;
  const rp: RelyingParty = { id: new URL(origin).hostname, origin };
  const secure = origin.startsWith('https:');
  // __Secure- needs the Secure attribute; a localhost origin over http cannot carry it.
  const cookieName = secure ? '__Secure-t3fg-owner' : 't3fg-owner';
  const cookiePath = base === '' ? '/' : base;
  const ceremonies = new Map<string, Ceremony>();

  const setSession = (res: ServerResponse, token: string): void => {
    res.setHeader('set-cookie', `${cookieName}=${token}; Path=${cookiePath}; Max-Age=${OWNER_SESSION_TTL / 1000}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
  };
  const clearSession = (res: ServerResponse): void => {
    res.setHeader('set-cookie', `${cookieName}=; Path=${cookiePath}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
  };
  /** The session cookie's value; more than one cookie of that name counts as none. */
  const sessionToken = (req: IncomingMessage): string | undefined => {
    const values = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
    return values.length === 1 ? values[0]!.slice(cookieName.length + 1) : undefined;
  };

  /** Owner POSTs: the dashboard's guards, the exact configured Origin, readiness and a bounded JSON object. */
  const ownerPost = async (req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> => {
    res.setHeader('cache-control', 'no-store');
    if (!options.apiRequest(req, res)) return undefined;
    // Stricter than the dashboard's other writes: exactly the configured origin, arriving under its own host name.
    if (req.headers.origin !== origin || req.headers.host?.toLowerCase() !== new URL(origin).host) {
      options.refuse(res, 403, 'owner_origin_mismatch', 'Owner requests come from the configured dashboard origin only.');
      return undefined;
    }
    if (!options.available()) {
      sendJson(res, 503, { error: 'unavailable' });
      return undefined;
    }
    const body = await readJson(req, BODY_LIMIT);
    if (!isRecord(body)) {
      sendJson(res, 400, { error: 'invalid_request' });
      return undefined;
    }
    return body;
  };

  const startCeremony = (res: ServerResponse, ceremony: Omit<Ceremony, 'expiresAt' | 'challenge'>): { id: string; challenge: string } | undefined => {
    const now = clock();
    for (const [id, entry] of ceremonies) if (entry.expiresAt <= now) ceremonies.delete(id);
    if (ceremonies.size >= MAX_CEREMONIES) {
      sendJson(res, 429, { error: 'busy' });
      return undefined;
    }
    const id = randomToken();
    const challenge = randomToken();
    ceremonies.set(id, { ...ceremony, challenge, expiresAt: now + CEREMONY_TTL });
    return { id, challenge };
  };
  /** Take a ceremony once: a second answer to the same challenge always fails. */
  const takeCeremony = (id: unknown, kind: Ceremony['kind']): Ceremony | undefined => {
    if (typeof id !== 'string' || !CEREMONY_ID.test(id)) return undefined;
    const ceremony = ceremonies.get(id);
    ceremonies.delete(id);
    return ceremony && ceremony.kind === kind && ceremony.expiresAt > clock() ? ceremony : undefined;
  };
  const passkeyRejected = (res: ServerResponse, event: string, reason: string): void => {
    logger.warn(event, { reason });
    sendJson(res, 400, { error: 'passkey_rejected' });
  };
  /** Open a fresh session (never reusing a cookie the browser brought) and answer with it. */
  const signIn = (req: IncomingMessage, res: ServerResponse, passkeyId: string): void => {
    owner.revokeSession(sessionToken(req));
    const session = owner.createSession(passkeyId);
    setSession(res, session.token);
    sendJson(res, 200, { signedIn: true, expiresAt: new Date(session.expiresAt).toISOString() });
  };
  /** The signed-in owner's passkey id, or undefined after answering 401. */
  const requireOwner = (req: IncomingMessage, res: ServerResponse): string | undefined => {
    const session = owner.session(sessionToken(req));
    if (session) return session.passkeyId;
    sendJson(res, 401, { error: 'signin_required' });
    return undefined;
  };

  const status = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader('cache-control', 'no-store');
    if (!options.apiRequest(req, res)) return;
    const session = owner.session(sessionToken(req));
    sendJson(res, 200, {
      enrolled: owner.enrolled(),
      signedIn: session !== undefined,
      expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
    });
  };

  const enrollBegin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await ownerPost(req, res);
    if (!body) return;
    if (!onlyKeys(body, ['code']) || typeof body.code !== 'string' || body.code.length > 32) {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    if (owner.passkeys().length >= MAX_PASSKEYS) {
      sendJson(res, 409, { error: 'passkey_limit' });
      return;
    }
    const check = owner.checkEnrollmentCode(body.code);
    if (check.kind === 'throttled') {
      logger.warn('owner.enrollment_throttled');
      sendJson(res, 429, { error: 'throttled' });
      return;
    }
    if (check.kind === 'invalid') {
      logger.warn('owner.enrollment_failed', { reason: 'code_not_accepted' });
      sendJson(res, 400, { error: 'code_not_accepted' });
      return;
    }
    const ceremony = startCeremony(res, { kind: 'enroll', codeId: check.codeId });
    if (!ceremony) return;
    sendJson(res, 200, {
      ceremonyId: ceremony.id,
      publicKey: {
        challenge: ceremony.challenge,
        rp: { id: rp.id, name: 't3-fleet-gateway' },
        user: { id: randomToken(16), name: 'owner', displayName: 'Gateway owner' },
        pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
        timeout: CEREMONY_TTL,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        excludeCredentials: owner.passkeys().map((passkey) => ({ type: 'public-key', id: passkey.credentialId })),
      },
    });
  };

  const enrollFinish = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await ownerPost(req, res);
    if (!body) return;
    const credential = body.credential;
    const label = body.label === undefined ? 'Passkey' : body.label;
    if (!onlyKeys(body, ['ceremonyId', 'credential', 'label']) || !isRecord(credential) || typeof label !== 'string' ||
        !/^[\p{L}\p{N} ._'-]{1,60}$/u.test(label)) {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    const ceremony = takeCeremony(body.ceremonyId, 'enroll');
    if (!ceremony) {
      sendJson(res, 409, { error: 'ceremony_expired' });
      return;
    }
    let registration;
    try {
      registration = verifyRegistration(rp, ceremony.challenge, { clientDataJSON: credential.clientDataJSON, attestationObject: credential.attestationObject });
    } catch (error) {
      if (error instanceof WebAuthnError) return passkeyRejected(res, 'owner.enrollment_failed', error.reason);
      throw error;
    }
    const added = owner.addPasskey(ceremony.codeId!, registration, label);
    if (added.kind !== 'ok') {
      logger.warn('owner.enrollment_failed', { reason: added.kind });
      sendJson(res, 409, { error: added.kind === 'code_spent' ? 'code_not_accepted' : added.kind === 'limit' ? 'passkey_limit' : 'passkey_exists' });
      return;
    }
    logger.info('owner.passkey_enrolled', { passkeyId: added.passkey.id });
    signIn(req, res, added.passkey.id);
  };

  const signinBegin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await ownerPost(req, res);
    if (!body) return;
    if (!onlyKeys(body, [])) {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    const passkeys = owner.passkeys();
    if (passkeys.length === 0) {
      sendJson(res, 409, { error: 'not_enrolled' });
      return;
    }
    const ceremony = startCeremony(res, { kind: 'signin' });
    if (!ceremony) return;
    sendJson(res, 200, {
      ceremonyId: ceremony.id,
      publicKey: {
        challenge: ceremony.challenge,
        rpId: rp.id,
        allowCredentials: passkeys.map((passkey) => ({ type: 'public-key', id: passkey.credentialId })),
        userVerification: 'required',
        timeout: CEREMONY_TTL,
      },
    });
  };

  const signinFinish = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await ownerPost(req, res);
    if (!body) return;
    const credential = body.credential;
    if (!onlyKeys(body, ['ceremonyId', 'credential']) || !isRecord(credential) || typeof credential.id !== 'string' || !CREDENTIAL_ID.test(credential.id)) {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    const ceremony = takeCeremony(body.ceremonyId, 'signin');
    if (!ceremony) {
      sendJson(res, 409, { error: 'ceremony_expired' });
      return;
    }
    const passkey = owner.usablePasskeyByCredential(credential.id);
    if (!passkey) return passkeyRejected(res, 'owner.signin_failed', 'unknown_passkey');
    let verified;
    try {
      verified = verifyAssertion(rp, ceremony.challenge, passkey, {
        clientDataJSON: credential.clientDataJSON,
        authenticatorData: credential.authenticatorData,
        signature: credential.signature,
      });
    } catch (error) {
      if (error instanceof WebAuthnError) return passkeyRejected(res, 'owner.signin_failed', error.reason);
      throw error;
    }
    if (!owner.recordSignIn(passkey.id, passkey.signCount, verified.signCount)) return passkeyRejected(res, 'owner.signin_failed', 'counter_regressed');
    logger.info('owner.signed_in', { passkeyId: passkey.id });
    signIn(req, res, passkey.id);
  };

  const signout = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await ownerPost(req, res);
    if (!body) return;
    owner.revokeSession(sessionToken(req));
    clearSession(res);
    logger.info('owner.signed_out');
    sendJson(res, 200, { signedIn: false });
  };

  const view = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await ownerPost(req, res);
    if (!body) return;
    if (!onlyKeys(body, ['handle'])) {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    if (requireOwner(req, res) === undefined) return;
    const pending = approvals.view(body.handle);
    if (!pending) {
      sendJson(res, 404, { error: 'gone' });
      return;
    }
    sendJson(res, 200, pending);
  };

  const decide = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await ownerPost(req, res);
    if (!body) return;
    if (!onlyKeys(body, ['handle', 'decision', 'access', 'hostsMode', 'hosts']) || (body.decision !== 'allow' && body.decision !== 'deny')) {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    const passkeyId = requireOwner(req, res);
    if (passkeyId === undefined) return;
    const result = approvals.decide(body.handle, {
      decision: body.decision,
      access: body.access,
      hostsMode: body.hostsMode,
      hosts: body.hosts ?? [],
    }, passkeyId);
    if (result.kind === 'gone') sendJson(res, 404, { error: 'gone' });
    else if (result.kind === 'refused') sendJson(res, 400, { error: 'refused', detail: result.message });
    else sendJson(res, 200, { approved: result.approved, responseUrl: result.responseUrl, returnOrigin: result.returnOrigin });
  };

  return [
    { path: `${base}/api/owner/status`, methods: { GET: status } },
    { path: `${base}/api/owner/enroll/begin`, methods: { POST: enrollBegin } },
    { path: `${base}/api/owner/enroll/finish`, methods: { POST: enrollFinish } },
    { path: `${base}/api/owner/signin/begin`, methods: { POST: signinBegin } },
    { path: `${base}/api/owner/signin/finish`, methods: { POST: signinFinish } },
    { path: `${base}/api/owner/signout`, methods: { POST: signout } },
    { path: `${base}/api/authorizations/view`, methods: { POST: view } },
    { path: `${base}/api/authorizations/decide`, methods: { POST: decide } },
  ];
}
