import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describeError } from '../errors.ts';
import type { Logger } from '../log.ts';
import { RequestError, sendJson } from './io.ts';

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

export interface Route {
  path: string;
  methods: Partial<Record<'GET' | 'POST' | 'DELETE' | 'OPTIONS', RouteHandler>>;
}

/** Route by exact path and method. Logs one line per request without query strings or headers. */
export function createRouter(routes: readonly Route[], logger: Logger): (req: IncomingMessage, res: ServerResponse) => void {
  const table = new Map(routes.map((route) => [route.path, route]));
  return (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://gateway.invalid');
    res.setHeader('x-content-type-options', 'nosniff');
    res.on('finish', () => {
      logger.info('http.request', {
        method: req.method,
        path: table.has(url.pathname) ? url.pathname : '(unmatched)',
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
      });
    });
    const route = table.get(url.pathname);
    if (!route) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const handler = route.methods[req.method as keyof Route['methods']];
    if (!handler) {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: Object.keys(route.methods).join(', ') });
      return;
    }
    Promise.resolve()
      .then(() => handler(req, res, url))
      .catch((error: unknown) => {
        if (error instanceof RequestError) {
          if (!res.headersSent) sendJson(res, error.status, { error: error.error, error_description: error.message });
          return;
        }
        logger.error('http.unhandled_error', { path: url.pathname, errorCode: describeError(error).code });
        if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
        else res.destroy();
      });
  };
}

export interface RunningServer {
  server: Server;
  port: number;
  close(graceMs?: number): Promise<void>;
}

/** Listen and return a handle whose close() stops accepting, drains in-flight requests, then forces. */
export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  host: string,
  port: number,
): Promise<RunningServer> {
  const server = createServer({ headersTimeout: 15_000, requestTimeout: 60_000 }, handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: (graceMs = 10_000) =>
      new Promise<void>((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), graceMs);
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      }),
  };
}
