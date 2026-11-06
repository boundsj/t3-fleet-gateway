/**
 * The CBOR subset WebAuthn uses (RFC 8949): unsigned and negative integers, byte and text strings, arrays, maps and the
 * simple values false, true and null, all with definite lengths. Anything else (indefinite lengths, tags, floats,
 * integers beyond 2^53, nesting deeper than eight levels, repeated map keys) is refused, so a crafted value fails instead
 * of being read loosely. Maps decode to `Map`, byte strings to `Buffer`.
 */

export type CborValue = number | string | boolean | null | Buffer | CborValue[] | Map<CborValue, CborValue>;

const MAX_DEPTH = 8;
const MAX_ITEMS = 256;

export class CborError extends Error {}

function readLength(bytes: Buffer, offset: number, info: number): [number, number] {
  if (info < 24) return [info, offset];
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (size === 0) throw new CborError('unsupported length encoding');
  if (offset + size > bytes.length) throw new CborError('truncated');
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + bytes[offset + index]!;
  if (!Number.isSafeInteger(value)) throw new CborError('integer too large');
  return [value, offset + size];
}

function decodeAt(bytes: Buffer, offset: number, depth: number): [CborValue, number] {
  if (depth > MAX_DEPTH) throw new CborError('nested too deeply');
  if (offset >= bytes.length) throw new CborError('truncated');
  const initial = bytes[offset]!;
  const major = initial >> 5;
  const info = initial & 31;
  if (major === 7) {
    if (info === 20) return [false, offset + 1];
    if (info === 21) return [true, offset + 1];
    if (info === 22) return [null, offset + 1];
    throw new CborError('unsupported simple value');
  }
  const [length, next] = readLength(bytes, offset + 1, info);
  if (major === 0) return [length, next];
  if (major === 1) return [-1 - length, next];
  if (major === 2 || major === 3) {
    if (next + length > bytes.length) throw new CborError('truncated');
    const slice = bytes.subarray(next, next + length);
    if (major === 2) return [Buffer.from(slice), next + length];
    const text = new TextDecoder('utf-8', { fatal: true }).decode(slice);
    return [text, next + length];
  }
  if (major === 4 || major === 5) {
    if (length > MAX_ITEMS) throw new CborError('too many items');
    let cursor = next;
    if (major === 4) {
      const items: CborValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const [item, end] = decodeAt(bytes, cursor, depth + 1);
        items.push(item);
        cursor = end;
      }
      return [items, cursor];
    }
    const map = new Map<CborValue, CborValue>();
    for (let index = 0; index < length; index += 1) {
      const [key, keyEnd] = decodeAt(bytes, cursor, depth + 1);
      if (typeof key !== 'number' && typeof key !== 'string') throw new CborError('unsupported map key');
      if (map.has(key)) throw new CborError('repeated map key');
      const [value, valueEnd] = decodeAt(bytes, keyEnd, depth + 1);
      map.set(key, value);
      cursor = valueEnd;
    }
    return [map, cursor];
  }
  throw new CborError('unsupported major type');
}

/** Decode one item starting at `offset`; returns it and the offset just past it. */
export function decodeCborPrefix(bytes: Buffer, offset = 0): [CborValue, number] {
  return decodeAt(bytes, offset, 0);
}

/** Decode a buffer that holds exactly one item. */
export function decodeCbor(bytes: Buffer): CborValue {
  const [value, end] = decodeAt(bytes, 0, 0);
  if (end !== bytes.length) throw new CborError('trailing bytes');
  return value;
}
