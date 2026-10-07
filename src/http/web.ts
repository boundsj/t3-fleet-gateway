import type { IncomingMessage, ServerResponse } from 'node:http';

/** Build a web-standard Request from a Node request whose body has already been read. */
export function toWebRequest(req: IncomingMessage, body: Buffer | undefined, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD' && body !== undefined;
  return new Request(new URL(req.url ?? '/', origin), { method, headers, ...(hasBody ? { body: new Uint8Array(body) } : {}) });
}

/** Write a web-standard Response to a Node response, streaming the body (SSE included). */
export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}
