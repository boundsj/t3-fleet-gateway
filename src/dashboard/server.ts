import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DashboardConfig } from '../config.ts';
import { readBody, sendJson } from '../http/io.ts';
import { createRouter, listen, type Route, type RunningServer } from '../http/server.ts';
import type { Logger } from '../log.ts';
import type { DashboardChecks } from './checks.ts';
import { buildSnapshot, type DashboardSources } from './snapshot.ts';

/**
 * The operator dashboard's own HTTP listener (docs/design.md, "Operator dashboard"). It is never the MCP listener and
 * serves nothing of the MCP or OAuth surface; the MCP listener serves nothing of this. Read-only: GET serves the page,
 * its assets and a snapshot built from the database; the one POST runs the manual checks, which only read.
 *
 * The trust boundary is the network: loopback, published by a tailnet-only proxy. The dashboard holds no session and
 * puts no secret in the browser. It refuses Host headers it was not configured for (DNS rebinding), requests that
 * Tailscale marks as Funnel traffic, and cross-site API requests; every response carries a strict CSP.
 */

/** API requests carry this header. Browsers cannot send it cross-origin without a CORS preflight, which is never granted. */
export const API_HEADER = 'x-t3fg-dashboard';
/** Tailscale sets this on requests that arrived through Funnel (the public internet). */
const FUNNEL_HEADER = 'tailscale-funnel-request';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

interface Asset {
  body: Buffer;
  type: string;
  etag: string;
}

const ASSET_TYPES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'mark.svg': 'image/svg+xml',
};

function loadAssets(): Map<string, Asset> {
  return new Map(Object.entries(ASSET_TYPES).map(([name, type]) => {
    const body = readFileSync(new URL(`./assets/${name}`, import.meta.url));
    return [name, { body, type, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"` }];
  }));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

function sendAsset(req: IncomingMessage, res: ServerResponse, asset: Asset, cache: string): void {
  if (req.headers['if-none-match'] === asset.etag) {
    res.writeHead(304, { etag: asset.etag, 'cache-control': cache });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': asset.type, 'content-length': asset.body.length, etag: asset.etag, 'cache-control': cache });
  res.end(asset.body);
}

export interface DashboardOptions {
  dashboard: DashboardConfig;
  sources: DashboardSources;
  checks: DashboardChecks;
  logger: Logger;
  /** Listen on this port instead of `dashboard.listen.port`; 0 lets the OS pick one (tests and the demo). */
  port?: number;
}

export interface RunningDashboard extends RunningServer {
  /** The page's path on this listener, with a trailing slash. */
  path: string;
}

/** Build the request handler. `port()` is the listener's actual port, known once it listens. */
export function dashboardHandler(options: DashboardOptions, port: () => number): (req: IncomingMessage, res: ServerResponse) => void {
  const { dashboard, sources, checks, logger } = options;
  const assets = loadAssets();
  const base = dashboard.basePath === '/' ? '' : dashboard.basePath;
  const allowedHosts = new Set(dashboard.allowedHosts.map((host) => host.toLowerCase()));
  const isAllowedHost = (host: string | undefined): boolean => {
    if (!host) return false;
    const value = host.toLowerCase();
    return allowedHosts.has(value) || [`127.0.0.1:${port()}`, `localhost:${port()}`, `[::1]:${port()}`].includes(value);
  };
  const refuse = (res: ServerResponse, status: number, reason: string, text: string) => {
    logger.warn('dashboard.request_refused', { reason, status });
    sendText(res, status, text);
  };
  /** API requests: our header, and nothing cross-site. Returns false after answering. */
  const apiRequest = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.headers[API_HEADER] !== '1') {
      refuse(res, 403, 'missing_api_header', 'Dashboard API requests come from the dashboard page.');
      return false;
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') {
      refuse(res, 403, 'cross_site', 'Cross-site requests are refused.');
      return false;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let host: string | undefined;
      try {
        const url = new URL(origin);
        if (url.protocol === 'http:' || url.protocol === 'https:') host = url.host;
      } catch {
        host = undefined;
      }
      if (!isAllowedHost(host)) {
        refuse(res, 403, 'origin_not_allowed', 'Requests from other origins are refused.');
        return false;
      }
    }
    return true;
  };
  const page = (name: string, cache: string): Route['methods'] => ({ GET: (req, res) => sendAsset(req, res, assets.get(name)!, cache) });
  const routes: Route[] = [
    { path: `${base}/`, methods: page('index.html', 'no-store') },
    { path: `${base}/assets/app.js`, methods: page('app.js', 'no-cache') },
    { path: `${base}/assets/app.css`, methods: page('app.css', 'no-cache') },
    { path: `${base}/assets/mark.svg`, methods: page('mark.svg', 'no-cache') },
    {
      path: `${base}/api/snapshot`,
      methods: {
        GET: (req, res) => {
          if (!apiRequest(req, res)) return;
          sendJson(res, 200, buildSnapshot(sources), { 'cache-control': 'no-store' });
        },
      },
    },
    {
      path: `${base}/api/checks`,
      methods: {
        POST: async (req, res) => {
          if (!apiRequest(req, res)) return;
          if ((req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
            refuse(res, 415, 'content_type', 'Expected application/json.');
            return;
          }
          await readBody(req, 1024);
          const run = await checks.run();
          sendJson(res, 200, { run, snapshot: buildSnapshot(sources) }, { 'cache-control': 'no-store' });
        },
      },
    },
  ];
  if (base !== '') {
    routes.push({ path: base, methods: { GET: (_req, res) => { res.writeHead(308, { location: `${base}/`, 'content-length': 0 }); res.end(); } } });
  }
  const router = createRouter(routes, logger.child({ listener: 'dashboard' }));
  return (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (req.headers[FUNNEL_HEADER] !== undefined) {
      refuse(res, 403, 'funnel', 'The dashboard is not served to the public internet.');
      return;
    }
    if (!isAllowedHost(req.headers.host)) {
      // 421 Misdirected Request: this listener does not serve that host name.
      refuse(res, 421, 'host_not_allowed', 'This host name is not allowed. Add it to dashboard.allowedHosts in the gateway config.');
      return;
    }
    router(req, res);
  };
}

/** Start the dashboard listener on its own loopback port. */
export async function startDashboard(options: DashboardOptions): Promise<RunningDashboard> {
  let actualPort = 0;
  const handler = dashboardHandler(options, () => actualPort);
  const server = await listen(handler, options.dashboard.listen.host, options.port ?? options.dashboard.listen.port);
  actualPort = server.port;
  const path = options.dashboard.basePath === '/' ? '/' : `${options.dashboard.basePath}/`;
  options.logger.info('dashboard.started', { listen: `${options.dashboard.listen.host}:${server.port}`, path });
  return { ...server, path };
}
