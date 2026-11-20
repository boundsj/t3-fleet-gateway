import { createHash } from 'node:crypto';
import * as z from 'zod';
import { GatewayError } from '../errors.ts';

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf', 'application/octet-stream',
] as const;
const extensions: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json', 'application/pdf': 'pdf',
};

const nameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/);
/** Staged attachment ids from work_attachment_prepare: opaque, random and owned by the client that prepared them. */
export const STAGED_ATTACHMENT_ID = /^att_[A-Za-z0-9_-]{24}$/;
const inlineItemSchema = z.strictObject({
  name: nameSchema.optional(),
  mimeType: z.enum(ATTACHMENT_MIME_TYPES),
  data: z.string().max(4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3)),
});
const stagedItemSchema = z.strictObject({
  attachmentId: z.string().regex(STAGED_ATTACHMENT_ID),
  name: nameSchema.optional(),
});
const boundedAttachmentSchema = z.array(inlineItemSchema).max(MAX_ATTACHMENTS);
const boundedItemSchema = z.array(z.union([inlineItemSchema, stagedItemSchema])).max(MAX_ATTACHMENTS);

const nameDescription = 'Optional display filename, 1–128 ASCII letters, digits, spaces, dot, underscore or hyphen; starts with a letter or digit. No paths.';
// Advertise structural types; validate semantic bounds in the service to return safe invalid_argument errors.
export const attachmentsSchema = z.array(z.union([
  z.looseObject({
    name: z.string().optional().describe(nameDescription),
    mimeType: z.string().describe(`Allowed MIME types: ${ATTACHMENT_MIME_TYPES.join(', ')}.`),
    data: z.string().describe('Nonempty standard padded base64 bytes, without a data URL prefix. At most 5 MiB decoded.'),
  }).describe('Inline file: base64 bytes in the call. Fine for small files.'),
  z.looseObject({
    attachmentId: z.string().describe('An attachmentId from work_attachment_prepare whose bytes you uploaded to its uploadUrl. Usable once.'),
    name: z.string().optional().describe(`${nameDescription} Overrides the name given to work_attachment_prepare.`),
  }).describe('Staged file: uploaded beforehand with work_attachment_prepare and an HTTP POST. Use this for screenshots and anything large.'),
])).describe(
  'Optional files, either inline base64 or staged ({ attachmentId } from work_attachment_prepare, then POST the raw bytes to its uploadUrl); ' +
  'no URLs or host paths. At most 8, 5 MiB each and 10 MiB total decoded bytes; the two kinds can be mixed. ' +
  'Images go to T3 as native image input; other files use T3 host attachment storage outside the repository. Provider support varies. ' +
  'Keep the same attachments on retries. An uncertain attachment follow-up cannot be resent automatically.',
);

/** An inline attachment, and the form every staged one is resolved to before it is queued or sent. */
export interface AttachmentInput {
  name?: string | undefined;
  mimeType: string;
  data: string;
}
export interface StagedAttachmentRef {
  attachmentId: string;
  name?: string | undefined;
}
/** What a tool call may pass: inline bytes or a reference to staged ones. */
export type AttachmentItem = AttachmentInput | StagedAttachmentRef;

export function isStagedRef(item: AttachmentItem): item is StagedAttachmentRef {
  return 'attachmentId' in item;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Check image signatures, without claiming to decode or fully validate image contents. Other types always match. */
export function signatureMatches(mimeType: string, bytes: Buffer): boolean {
  return mimeType === 'image/png' ? bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    : mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mimeType === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    : mimeType === 'image/webp' ? bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    : true;
}

export function defaultAttachmentName(index: number, mimeType: string): string {
  return `attachment-${index + 1}.${extensions[mimeType] ?? 'bin'}`;
}

/** Inline attachments only (the queued launch ledger and resolved staged files): bytes, bounds, signatures and names. */
export function validateAttachments(input: readonly AttachmentInput[] | undefined): AttachmentInput[] {
  if (input === undefined) return [];
  const parsed = boundedAttachmentSchema.safeParse(input);
  if (!parsed.success) throw new GatewayError('invalid_argument', 'Invalid attachments: use at most 8 files, supported MIME types, safe filenames and base64 data of at most 5 MiB per file.');
  let total = 0;
  return parsed.data.map((item, index) => {
    const bytes = decodeInline(item.data);
    total += bytes.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new GatewayError('invalid_argument', 'Attachments must total at most 10 MiB decoded.');
    if (!signatureMatches(item.mimeType, bytes)) throw new GatewayError('invalid_argument', 'Attachment image signature does not match its MIME type.');
    return { ...item, name: item.name ?? defaultAttachmentName(index, item.mimeType) };
  });
}

function decodeInline(data: string): Buffer {
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new GatewayError('invalid_argument', 'Attachment data must be nonempty standard padded base64 (no whitespace or data URL prefix).');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new GatewayError('invalid_argument', 'Attachment data must use canonical base64 encoding.');
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new GatewayError('invalid_argument', 'Each attachment must be at most 5 MiB decoded.');
  return bytes;
}

/**
 * A tool call's attachments, inline or staged, checked as far as the call alone allows: count, shapes, and every inline
 * file in full (with its default name, so an inline-only list validates and hashes exactly as before staged files existed).
 * Staged references are resolved later, against the caller's own uploads (stagedAttachments.ts).
 */
export function validateAttachmentItems(input: readonly AttachmentItem[] | undefined): AttachmentItem[] {
  if (input === undefined) return [];
  const parsed = boundedItemSchema.safeParse(input);
  if (!parsed.success) {
    throw new GatewayError('invalid_argument', 'Invalid attachments: use at most 8 files, each either { name?, mimeType, data } with a supported MIME type, a safe filename and base64 data of at most 5 MiB, or { attachmentId, name? } from work_attachment_prepare.');
  }
  let total = 0;
  return parsed.data.map((item, index) => {
    if (isStagedRef(item)) return item;
    const bytes = decodeInline(item.data);
    total += bytes.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new GatewayError('invalid_argument', 'Attachments must total at most 10 MiB decoded.');
    if (!signatureMatches(item.mimeType, bytes)) throw new GatewayError('invalid_argument', 'Attachment image signature does not match its MIME type.');
    return { ...item, name: item.name ?? defaultAttachmentName(index, item.mimeType) };
  });
}

/**
 * Only bounded metadata, content hashes and staged ids participate in the request hash; never the base64 payload. A staged
 * id names immutable bytes its owner uploaded once, so hashing the id (and any name override) lets a retry replay after the
 * staged row is claimed or swept. Inline items hash exactly as before.
 */
export function attachmentHashes(items: readonly AttachmentItem[]): unknown[] {
  return items.map((item) => isStagedRef(item)
    ? { attachmentId: item.attachmentId, name: item.name ?? null }
    : { name: item.name, mimeType: item.mimeType, sha256: createHash('sha256').update(Buffer.from(item.data, 'base64')).digest('hex') });
}
