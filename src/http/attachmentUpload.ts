import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_ATTACHMENT_BYTES, signatureMatches } from '../jobs/attachments.ts';
import type { StagedAttachments } from '../jobs/stagedAttachments.ts';
import type { Logger } from '../log.ts';
import { sendJson } from './io.ts';
import type { Route } from './server.ts';

export interface AttachmentUploadDependencies {
  staged: StagedAttachments;
  publicUrl: string;
  allowedOrigins: readonly string[];
  logger: Logger;
}

const NO_STORE = { 'cache-control': 'no-store' };

type BodyResult = { kind: 'ok'; body: Buffer } | { kind: 'too_large' } | { kind: 'expired' } | { kind: 'aborted' };

/**
 * Read exactly up to `limit` bytes, stopping (without destroying the socket, so a reply can still be sent) once the body
 * is larger or the upload deadline passes. The caller answers with Connection: close, so nothing unread is parsed later.
 */
function readBounded(req: IncomingMessage, limit: number, deadlineMs: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: BodyResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData).off('end', onEnd).off('error', onAbort).off('aborted', onAbort).off('close', onClose);
      if (result.kind !== 'ok') req.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) finish({ kind: 'too_large' });
      else chunks.push(chunk);
    };
    const onEnd = (): void => finish({ kind: 'ok', body: Buffer.concat(chunks) });
    const onAbort = (): void => finish({ kind: 'aborted' });
    const onClose = (): void => { if (!req.complete) finish({ kind: 'aborted' }); };
    const timer = setTimeout(() => finish({ kind: 'expired' }), deadlineMs);
    timer.unref();
    req.on('data', onData).on('end', onEnd).on('error', onAbort).on('aborted', onAbort).on('close', onClose);
  });
}

/**
 * POST /attachments?token=…: the raw bytes of one file prepared with work_attachment_prepare. The single-use token is the
 * only credential (no bearer token, no cookie, no CORS) and rides in the query string, which the router never logs. Any
 * request presenting a live token spends it; a rejected upload also frees its slot, so the agent prepares again. The
 * upload must finish before the token's deadline. Origin follows /mcp: absent is fine, a browser Origin must be the
 * gateway's own or an allowed one. Every refusal closes the connection, so an unread body is never drained or reparsed.
 */
export function attachmentUploadRoute(deps: AttachmentUploadDependencies): Route {
  const allowedOrigins = new Set([deps.publicUrl, ...deps.allowedOrigins]);
  const reject = (res: ServerResponse, status: number, error: string, description: string, reason: string): void => {
    deps.logger.info('attachment.upload_rejected', { reason });
    sendJson(res, status, { error, error_description: description }, { ...NO_STORE, connection: 'close' });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      reject(res, 403, 'forbidden', 'Origin not allowed', 'origin');
      return;
    }
    const tokens = url.searchParams.getAll('token');
    const slot = tokens.length === 1 ? deps.staged.beginUpload(tokens[0]!) : undefined;
    if (!slot) {
      reject(res, 401, 'invalid_token', 'The upload token is missing, invalid, expired or already used. Call work_attachment_prepare again.', 'token');
      return;
    }
    const fail = (status: number, error: string, description: string, reason: string): void => {
      deps.staged.abandonUpload(slot);
      reject(res, status, error, `${description} The upload token is spent; call work_attachment_prepare again.`, reason);
    };
    const sizeMessage = `The body must be exactly ${slot.sizeBytes} bytes, as prepared.`;
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== slot.mimeType) {
      fail(415, 'invalid_request', `Content-Type must be ${slot.mimeType}, as prepared.`, 'content_type');
      return;
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) !== slot.sizeBytes) {
      fail(Number(declared) > slot.sizeBytes ? 413 : 400, 'invalid_request', sizeMessage, 'size');
      return;
    }
    const read = await readBounded(req, Math.min(slot.sizeBytes, MAX_ATTACHMENT_BYTES), deps.staged.remainingMs(slot));
    if (read.kind === 'aborted') {
      deps.staged.abandonUpload(slot);
      deps.logger.info('attachment.upload_rejected', { reason: 'aborted' });
      res.destroy();
      return;
    }
    if (read.kind === 'expired') {
      fail(401, 'invalid_token', 'The upload did not finish before its deadline.', 'expired');
      return;
    }
    if (read.kind === 'too_large') {
      fail(413, 'invalid_request', sizeMessage, 'size');
      return;
    }
    if (read.body.length !== slot.sizeBytes) {
      fail(400, 'invalid_request', sizeMessage, 'size');
      return;
    }
    if (!signatureMatches(slot.mimeType, read.body)) {
      fail(400, 'invalid_request', `The file does not look like ${slot.mimeType}: its signature does not match.`, 'signature');
      return;
    }
    if (!deps.staged.completeUpload(slot, read.body)) {
      fail(401, 'invalid_token', 'The upload expired while it was sent.', 'expired');
      return;
    }
    sendJson(res, 201, { attachmentId: slot.attachmentId, mimeType: slot.mimeType, sizeBytes: slot.sizeBytes, status: 'uploaded' }, NO_STORE);
  };
  return { path: '/attachments', methods: { POST: handle } };
}
