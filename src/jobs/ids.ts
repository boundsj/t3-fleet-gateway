import { randomBytes } from 'node:crypto';

/** Lowercase Crockford base32: safe in branch names, thread titles and search queries. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** A short random job id, 10 characters (50 bits). Not a secret; unique enough to find by marker. */
export function newJobId(): string {
  const bytes = randomBytes(10);
  let id = '';
  for (const byte of bytes) id += ALPHABET[byte & 31];
  return id;
}
