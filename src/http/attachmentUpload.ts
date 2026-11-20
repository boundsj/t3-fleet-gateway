import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_ATTACHMENT_BYTES, signatureMatches } from '../jobs/attachments.ts';
import type { StagedAttachments } from '../jobs/stagedAttachments.ts';
import type { Logger } from '../log.ts';
import { readBody, RequestError, sendJson } from './io.ts';
import type { Route } from './server.ts';

export interface AttachmentUploadDependencies {
  staged: StagedAttachments;
  publicUrl: string;
  allowedOrigins: readonly string[];
  logger: Logger;
}

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * POST /attachments?token=…: the raw bytes of one file prepared with work_attachment_prepare. The single-use token is the
 * only credential (no bearer token, no cookie, no CORS) and rides in the query string, which the router never logs. Any
 * request presenting a live token spends it; a rejected upload also frees its slot, so the agent prepares again.
 * Origin follows /mcp: absent is fine, a browser Origin must be the gateway's own or an allowed one.
 */
export function attachmentUploadRoute(deps: AttachmentUploadDependencies): Route {
  const allowedOrigins = new Set([deps.publicUrl, ...deps.allowedOrigins]);
  const reject = (res: ServerResponse, status: number, error: string, description: string, reason: string, close = false): void => {
    deps.logger.info('attachment.upload_rejected', { reason });
    // A body left unread must not be parsed as the next request on a kept-alive connection.
    sendJson(res, status, { error, error_description: description }, close ? { ...NO_STORE, connection: 'close' } : NO_STORE);
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
      reject(res, status, error, `${description} The upload token is spent; call work_attachment_prepare again.`, reason, true);
    };
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== slot.mimeType) {
      fail(415, 'invalid_request', `Content-Type must be ${slot.mimeType}, as prepared.`, 'content_type');
      return;
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) !== slot.sizeBytes) {
      fail(Number(declared) > slot.sizeBytes ? 413 : 400, 'invalid_request', `The body must be exactly ${slot.sizeBytes} bytes, as prepared.`, 'size');
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, Math.min(slot.sizeBytes, MAX_ATTACHMENT_BYTES));
    } catch (error) {
      if (error instanceof RequestError) {
        fail(error.status, 'invalid_request', `The body must be exactly ${slot.sizeBytes} bytes, as prepared.`, 'size');
        return;
      }
      deps.staged.abandonUpload(slot);
      throw error;
    }
    if (body.length !== slot.sizeBytes) {
      fail(400, 'invalid_request', `The body must be exactly ${slot.sizeBytes} bytes, as prepared.`, 'size');
      return;
    }
    if (!signatureMatches(slot.mimeType, body)) {
      fail(400, 'invalid_request', `The file does not look like ${slot.mimeType}: its signature does not match.`, 'signature');
      return;
    }
    if (!deps.staged.completeUpload(slot, body)) {
      fail(401, 'invalid_token', 'The upload expired while it was sent.', 'expired');
      return;
    }
    sendJson(res, 201, { attachmentId: slot.attachmentId, mimeType: slot.mimeType, sizeBytes: slot.sizeBytes, status: 'uploaded' }, NO_STORE);
  };
  return { path: '/attachments', methods: { POST: handle } };
}
