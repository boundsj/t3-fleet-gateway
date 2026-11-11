import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { request } from 'node:http';

/**
 * A software passkey authenticator and an owner-browser client for browser approval tests. Keys are generated per test
 * run; nothing here is a real credential. The authenticator answers `navigator.credentials.create/get` the way a
 * platform authenticator does (attestation "none", user present and verified, P-256 ES256).
 */

export const OWNER_HOST = 'gateway.example.test';
export const OWNER_ORIGIN = `https://${OWNER_HOST}`;
export const OWNER_BASE = '/fleet';

/** Minimal CBOR encoder for test fixtures: integers, byte strings, text, arrays and maps. */
export function cbor(value: unknown): Buffer {
  const head = (major: number, length: number): Buffer => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    if (length < 65536) return Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
    const out = Buffer.alloc(5);
    out[0] = (major << 5) | 26;
    out.writeUInt32BE(length, 1);
    return out;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error('unsupported fixture value');
}

const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();

export interface ClientDataOverrides { type?: string; origin?: string; challenge?: string; crossOrigin?: boolean }

export class SoftwarePasskey {
  readonly credentialId = randomBytes(32);
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  counter = 0;
  rpId: string;
  flags = 0x05; // user present + user verified

  constructor(rpId = OWNER_HOST) {
    this.rpId = rpId;
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#privateKey = pair.privateKey;
    this.#publicKey = pair.publicKey;
  }

  get id(): string {
    return this.credentialId.toString('base64url');
  }

  #clientData(type: string, challenge: string, origin: string, overrides: ClientDataOverrides): Buffer {
    return Buffer.from(JSON.stringify({ type: overrides.type ?? type, challenge: overrides.challenge ?? challenge, origin: overrides.origin ?? origin,
      ...(overrides.crossOrigin === undefined ? {} : { crossOrigin: overrides.crossOrigin }) }));
  }

  #authData(attested: boolean): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const base = Buffer.concat([sha256(this.rpId), Buffer.from([this.flags | (attested ? 0x40 : 0)]), counter]);
    if (!attested) return base;
    const jwk = this.#publicKey.export({ format: 'jwk' });
    const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([base, Buffer.alloc(16), length, this.credentialId, cbor(cose)]);
  }

  /** The base64url fields a browser sends after `navigator.credentials.create()`. */
  register(challenge: string, origin = OWNER_ORIGIN, overrides: ClientDataOverrides = {}): { clientDataJSON: string; attestationObject: string } {
    const clientData = this.#clientData('webauthn.create', challenge, origin, overrides);
    const attestation = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.#authData(true)]]));
    return { clientDataJSON: clientData.toString('base64url'), attestationObject: attestation.toString('base64url') };
  }

  /** The base64url fields a browser sends after `navigator.credentials.get()`; the counter moves first. */
  assert(challenge: string, origin = OWNER_ORIGIN, overrides: ClientDataOverrides = {}): { id: string; clientDataJSON: string; authenticatorData: string; signature: string } {
    this.counter += 1;
    const clientData = this.#clientData('webauthn.get', challenge, origin, overrides);
    const authData = this.#authData(false);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.#privateKey);
    return { id: this.id, clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') };
  }
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: Record<string, unknown>;
}

/** A request to a listener with full control of every header (fetch cannot set Host). */
export function rawRequest(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(body) as Record<string, unknown>; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

/**
 * The owner's browser on the dashboard origin: same-origin API requests with the page's header, its exact Origin and Host,
 * and a cookie jar that keeps what the dashboard sets.
 */
export class OwnerBrowser {
  readonly port: number;
  cookie: string | undefined;
  readonly cookies: string[] = [];
  headers: Record<string, string> = {};

  constructor(port: number) {
    this.port = port;
  }

  async call(path: string, body?: unknown, extra: Record<string, string> = {}): Promise<RawResponse> {
    const headers: Record<string, string> = {
      host: OWNER_HOST,
      'x-t3fg-dashboard': '1',
      'sec-fetch-site': 'same-origin',
      ...(body === undefined ? {} : { origin: OWNER_ORIGIN, 'content-type': 'application/json' }),
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...this.headers,
      ...extra,
    };
    const response = await rawRequest(this.port, { method: body === undefined ? 'GET' : 'POST', path: `${OWNER_BASE}/${path}`, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = response.headers['set-cookie'];
    for (const line of Array.isArray(set) ? set : set ? [set] : []) {
      this.cookies.push(line);
      const [pair] = line.split(';');
      this.cookie = /=$/.test(pair!) ? undefined : pair;
    }
    return response;
  }

  async enroll(passkey: SoftwarePasskey, code: string, label?: string): Promise<RawResponse> {
    const begin = await this.call('api/owner/enroll/begin', { code });
    if (begin.status !== 200) return begin;
    const options = begin.json.publicKey as { challenge: string };
    return this.call('api/owner/enroll/finish', { ceremonyId: begin.json.ceremonyId, ...(label ? { label } : {}), credential: passkey.register(options.challenge) });
  }

  async signIn(passkey: SoftwarePasskey): Promise<RawResponse> {
    const begin = await this.call('api/owner/signin/begin', {});
    if (begin.status !== 200) return begin;
    const options = begin.json.publicKey as { challenge: string };
    return this.call('api/owner/signin/finish', { ceremonyId: begin.json.ceremonyId, credential: passkey.assert(options.challenge) });
  }
}

/** The opaque handle in an approval page's dashboard link, after checking the link's exact target. */
export function browserLinkHandle(html: string): string | undefined {
  const match = /<a class="primary" href="([^"]+)">Review in the gateway dashboard<\/a>/.exec(html);
  if (!match) return undefined;
  const url = new URL(match[1]!.replaceAll('&amp;', '&'));
  if (url.origin !== OWNER_ORIGIN || url.pathname !== `${OWNER_BASE}/owner` || url.search !== '') throw new Error(`unexpected dashboard link ${url.href}`);
  const handle = /^#\/approve\/([A-Za-z0-9_-]{43})$/.exec(url.hash)?.[1];
  if (!handle) throw new Error('unexpected dashboard link fragment');
  return handle;
}
