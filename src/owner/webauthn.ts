import { createHash, createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { CborError, decodeCbor, decodeCborPrefix, type CborValue } from './cbor.ts';

/**
 * WebAuthn (Level 2) relying-party checks for the gateway owner's passkeys, with no attestation: the gateway asks for
 * `attestation: "none"` and ignores any attestation statement, because the trust in a new passkey comes from the one-time
 * enrollment code the owner minted on the gateway machine, not from the authenticator's maker. Everything else is
 * checked: the ceremony type, the single-use challenge, the exact origin, the relying party id hash, user presence and
 * user verification, the credential's public key (ES256, EdDSA or RS256 of at least 2048 bits) and, for sign-in, the
 * signature and a signature counter that must not go backwards.
 */

export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const;
const ES256 = -7;
const EDDSA = -8;
const RS256 = -257;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;
const MAX_CLIENT_DATA = 4096;
const MAX_CREDENTIAL_ID = 1023;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export interface RelyingParty {
  /** The host name the passkey is bound to. */
  id: string;
  /** The exact origin the browser must report. */
  origin: string;
}

export interface VerifiedRegistration {
  credentialId: string;
  /** SubjectPublicKeyInfo DER, base64url. */
  publicKey: string;
  algorithm: number;
  signCount: number;
}

export interface StoredPasskey {
  publicKey: string;
  algorithm: number;
  signCount: number;
}

/** A refused ceremony; `reason` is a fixed code safe to log. */
export class WebAuthnError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`WebAuthn check failed: ${reason}`);
    this.reason = reason;
  }
}

export function fromBase64Url(value: unknown, maxBytes: number, what: string): Buffer {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length > Math.ceil((maxBytes * 4) / 3)) throw new WebAuthnError(`${what}_invalid`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length === 0 || bytes.toString('base64url') !== value) throw new WebAuthnError(`${what}_invalid`);
  return bytes;
}

function checkClientData(raw: Buffer, type: string, challenge: string, rp: RelyingParty): void {
  if (raw.length > MAX_CLIENT_DATA) throw new WebAuthnError('client_data_invalid');
  let data: unknown;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new WebAuthnError('client_data_invalid');
  }
  if (typeof data !== 'object' || data === null) throw new WebAuthnError('client_data_invalid');
  const fields = data as Record<string, unknown>;
  if (fields.type !== type) throw new WebAuthnError('ceremony_type_mismatch');
  if (typeof fields.challenge !== 'string' || fields.challenge !== challenge) throw new WebAuthnError('challenge_mismatch');
  if (fields.origin !== rp.origin) throw new WebAuthnError('origin_mismatch');
  if (fields.crossOrigin === true) throw new WebAuthnError('cross_origin');
}

interface AuthenticatorData {
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  coseKey?: CborValue;
}

function parseAuthenticatorData(bytes: Buffer, rp: RelyingParty, expectCredential: boolean): AuthenticatorData {
  if (bytes.length < 37) throw new WebAuthnError('authenticator_data_invalid');
  const rpIdHash = createHash('sha256').update(rp.id).digest();
  if (!rpIdHash.equals(bytes.subarray(0, 32))) throw new WebAuthnError('rp_id_mismatch');
  const flags = bytes[32]!;
  if (!(flags & FLAG_UP)) throw new WebAuthnError('user_not_present');
  if (!(flags & FLAG_UV)) throw new WebAuthnError('user_not_verified');
  const signCount = bytes.readUInt32BE(33);
  let offset = 37;
  const result: AuthenticatorData = { flags, signCount };
  if (Boolean(flags & FLAG_AT) !== expectCredential) throw new WebAuthnError('authenticator_data_invalid');
  try {
    if (expectCredential) {
      if (bytes.length < offset + 18) throw new WebAuthnError('authenticator_data_invalid');
      offset += 16; // AAGUID: identifies the authenticator model; not used without attestation.
      const length = bytes.readUInt16BE(offset);
      offset += 2;
      if (length === 0 || length > MAX_CREDENTIAL_ID || offset + length > bytes.length) throw new WebAuthnError('authenticator_data_invalid');
      result.credentialId = Buffer.from(bytes.subarray(offset, offset + length));
      offset += length;
      const [key, end] = decodeCborPrefix(bytes, offset);
      result.coseKey = key;
      offset = end;
    }
    if (flags & FLAG_ED) {
      const [, end] = decodeCborPrefix(bytes, offset);
      offset = end;
    }
  } catch (error) {
    if (error instanceof CborError) throw new WebAuthnError('authenticator_data_invalid');
    throw error;
  }
  if (offset !== bytes.length) throw new WebAuthnError('authenticator_data_invalid');
  return result;
}

function bytesField(map: Map<CborValue, CborValue>, key: number, length?: number): string {
  const value = map.get(key);
  if (!Buffer.isBuffer(value) || (length !== undefined && value.length !== length)) throw new WebAuthnError('public_key_invalid');
  return value.toString('base64url');
}

/** A COSE_Key (RFC 9053) for one of the supported algorithms, as a Node public key. */
function coseToKey(cose: CborValue | undefined): { key: KeyObject; algorithm: number } {
  if (!(cose instanceof Map)) throw new WebAuthnError('public_key_invalid');
  const kty = cose.get(1);
  const algorithm = cose.get(3);
  let jwk: JsonWebKey;
  if (algorithm === ES256 && kty === 2 && cose.get(-1) === 1) {
    jwk = { kty: 'EC', crv: 'P-256', x: bytesField(cose, -2, 32), y: bytesField(cose, -3, 32) };
  } else if (algorithm === EDDSA && kty === 1 && cose.get(-1) === 6) {
    jwk = { kty: 'OKP', crv: 'Ed25519', x: bytesField(cose, -2, 32) };
  } else if (algorithm === RS256 && kty === 3) {
    jwk = { kty: 'RSA', n: bytesField(cose, -1), e: bytesField(cose, -2) };
  } else {
    throw new WebAuthnError('algorithm_unsupported');
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new WebAuthnError('public_key_invalid');
  }
  if (algorithm === RS256 && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new WebAuthnError('public_key_invalid');
  return { key, algorithm };
}

/** Check a `navigator.credentials.create()` answer for the challenge this gateway issued. */
export function verifyRegistration(
  rp: RelyingParty,
  challenge: string,
  input: { clientDataJSON: unknown; attestationObject: unknown },
): VerifiedRegistration {
  const clientData = fromBase64Url(input.clientDataJSON, MAX_CLIENT_DATA, 'client_data');
  checkClientData(clientData, 'webauthn.create', challenge, rp);
  const attestation = fromBase64Url(input.attestationObject, 8192, 'attestation');
  let decoded: CborValue;
  try {
    decoded = decodeCbor(attestation);
  } catch {
    throw new WebAuthnError('attestation_invalid');
  }
  if (!(decoded instanceof Map) || typeof decoded.get('fmt') !== 'string' || !Buffer.isBuffer(decoded.get('authData'))) {
    throw new WebAuthnError('attestation_invalid');
  }
  const authData = parseAuthenticatorData(decoded.get('authData') as Buffer, rp, true);
  const { key, algorithm } = coseToKey(authData.coseKey);
  return {
    credentialId: authData.credentialId!.toString('base64url'),
    publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64url'),
    algorithm,
    signCount: authData.signCount,
  };
}

/** Check a `navigator.credentials.get()` answer against a stored passkey; returns the new signature counter. */
export function verifyAssertion(
  rp: RelyingParty,
  challenge: string,
  stored: StoredPasskey,
  input: { clientDataJSON: unknown; authenticatorData: unknown; signature: unknown },
): { signCount: number } {
  const clientData = fromBase64Url(input.clientDataJSON, MAX_CLIENT_DATA, 'client_data');
  checkClientData(clientData, 'webauthn.get', challenge, rp);
  const authenticatorData = fromBase64Url(input.authenticatorData, 4096, 'authenticator_data');
  const parsed = parseAuthenticatorData(authenticatorData, rp, false);
  const signature = fromBase64Url(input.signature, 1024, 'signature');
  const key = createPublicKey({ key: Buffer.from(stored.publicKey, 'base64url'), format: 'der', type: 'spki' });
  const signed = Buffer.concat([authenticatorData, createHash('sha256').update(clientData).digest()]);
  let valid = false;
  try {
    if (stored.algorithm === ES256) valid = verify('sha256', signed, { key, dsaEncoding: 'der' }, signature);
    else if (stored.algorithm === RS256) valid = verify('sha256', signed, key, signature);
    else if (stored.algorithm === EDDSA) valid = verify(null, signed, key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new WebAuthnError('signature_invalid');
  // A counter that does not grow (when the authenticator keeps one) suggests a cloned authenticator.
  if ((parsed.signCount !== 0 || stored.signCount !== 0) && parsed.signCount <= stored.signCount) throw new WebAuthnError('counter_regressed');
  return { signCount: parsed.signCount };
}
