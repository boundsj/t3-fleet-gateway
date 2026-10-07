import type { IncomingMessage, ServerResponse } from 'node:http';

/** Thrown while reading a request; the router turns it into the given status. */
export class RequestError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, error: string, message: string) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.error = error;
  }
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new RequestError(413, 'payload_too_large', 'Request body is too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new RequestError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function mediaType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

export async function readForm(req: IncomingMessage, limit: number): Promise<URLSearchParams> {
  if (mediaType(req) !== 'application/x-www-form-urlencoded') {
    throw new RequestError(415, 'invalid_request', 'Expected application/x-www-form-urlencoded');
  }
  return new URLSearchParams((await readBody(req, limit)).toString('utf8'));
}

export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  if (mediaType(req) !== 'application/json') throw new RequestError(415, 'invalid_request', 'Expected application/json');
  try {
    return JSON.parse((await readBody(req, limit)).toString('utf8'));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'invalid_request', 'Body is not valid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

export function sendHtml(res: ServerResponse, status: number, page: { html: string; headers: Record<string, string> }): void {
  res.writeHead(status, { ...page.headers, 'content-length': Buffer.byteLength(page.html) });
  res.end(page.html);
}

export function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'content-length': 0 });
  res.end();
}
