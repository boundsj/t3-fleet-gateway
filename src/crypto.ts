import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A random 256-bit value, base64url encoded. Used for tokens, codes and ids that must be unguessable. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A short random id for display and correlation (not a secret). Never starts with `-`, which a command line would read as an option. */
export function randomId(bytes = 9): string {
  const id = randomBytes(bytes).toString('base64url');
  return id.startsWith('-') ? `_${id.slice(1)}` : id;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacBase64Url(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** RFC 7636 S256 code challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidPkceVerifier(verifier: string): boolean {
  return PKCE_VERIFIER.test(verifier);
}
