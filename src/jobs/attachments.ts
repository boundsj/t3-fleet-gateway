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

const boundedAttachmentSchema = z.array(z.strictObject({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/).optional(),
  mimeType: z.enum(ATTACHMENT_MIME_TYPES),
  data: z.string().max(4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3)),
})).max(MAX_ATTACHMENTS);

// Advertise structural types; validate semantic bounds in the service to return safe invalid_argument errors.
export const attachmentsSchema = z.array(z.looseObject({
  name: z.string().optional()
    .describe('Optional display filename, 1–128 ASCII letters, digits, spaces, dot, underscore or hyphen; starts with a letter or digit. No paths.'),
  mimeType: z.string().describe(`Allowed MIME types: ${ATTACHMENT_MIME_TYPES.join(', ')}.`),
  data: z.string().describe('Nonempty standard padded base64 bytes, without a data URL prefix. At most 5 MiB decoded.'),
})).describe(
  'Optional files: base64 only, no URLs or host paths. At most 8, 5 MiB each and 10 MiB total decoded bytes. ' +
  'Images go to T3 as native image input; other files use T3 host attachment storage outside the repository. Provider support varies. ' +
  'Keep the same attachments on retries. An uncertain attachment follow-up cannot be resent automatically.',
);
export type AttachmentInput = z.infer<typeof attachmentsSchema>[number];

export function validateAttachments(input: readonly AttachmentInput[] | undefined): AttachmentInput[] {
  if (input === undefined) return [];
  const parsed = boundedAttachmentSchema.safeParse(input);
  if (!parsed.success) throw new GatewayError('invalid_argument', 'Invalid attachments: use at most 8 files, supported MIME types, safe filenames and base64 data of at most 5 MiB per file.');
  let total = 0;
  return parsed.data.map((item, index) => {
    const data = item.data;
    if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new GatewayError('invalid_argument', 'Attachment data must be nonempty standard padded base64 (no whitespace or data URL prefix).');
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data) throw new GatewayError('invalid_argument', 'Attachment data must use canonical base64 encoding.');
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new GatewayError('invalid_argument', 'Each attachment must be at most 5 MiB decoded.');
    total += bytes.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new GatewayError('invalid_argument', 'Attachments must total at most 10 MiB decoded.');
    // Check signatures, without claiming to decode or fully validate image contents.
    const matches = item.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : item.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : item.mimeType === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
      : item.mimeType === 'image/webp' ? bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      : true;
    if (!matches) throw new GatewayError('invalid_argument', 'Attachment image signature does not match its MIME type.');
    return { ...item, name: item.name ?? `attachment-${index + 1}.${extensions[item.mimeType] ?? 'bin'}` };
  });
}

/** Only bounded metadata and content hashes participate in the request hash; never the base64 payload. */
export function attachmentHashes(items: readonly AttachmentInput[]): unknown[] {
  return items.map(({ name, mimeType, data }) => ({ name, mimeType, sha256: createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex') }));
}
