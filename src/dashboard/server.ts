import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DashboardConfig } from '../config.ts';
import { readBody, readJson, sendJson } from '../http/io.ts';
import { createRouter, listen, type Route, type RunningServer } from '../http/server.ts';
import type { Logger } from '../log.ts';
import { GatewayError } from '../errors.ts';
import type { JobService } from '../jobs/service.ts';
import { OPERATOR_CLIENT_ID } from '../jobs/store.ts';
import { OPERATE_SCOPE, THREAD_READ_SCOPE, THREAD_CONTROL_SCOPE } from '../oauth/scopes.ts';
import type { WebhookManagement } from '../webhooks/management.ts';
import type { DashboardChecks } from './checks.ts';
import { buildSnapshot, type DashboardSources } from './snapshot.ts';

/**
 * The operator dashboard's own HTTP listener (docs/design.md, "Operator dashboard"). It is never the MCP listener and
 * serves nothing of the MCP or OAuth surface; the MCP listener serves nothing of this. Monitoring reads the database;
 * private webhook management and job settlement can mutate state. Manual checks remain read-only.
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
  'threadId.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'mark.svg': 'image/svg+xml',
};

function loadAssets(): Map<string, Asset> {
  return new Map(Object.entries(ASSET_TYPES).map(([name, type]) => {
    const body = readFileSync(new URL(name === 'threadId.js' ? '../threadId.js' : `./assets/${name}`, import.meta.url));
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
  management?: WebhookManagement;
  jobs?: JobService;
  available?: () => boolean;
  /** Listen on this port instead of `dashboard.listen.port`; 0 lets the OS pick one (tests and the demo). */
  port?: number;
}

export interface RunningDashboard extends RunningServer {
  /** The page's path on this listener, with a trailing slash. */
  path: string;
}

/** Build the request handler. `port()` is the listener's actual port, known once it listens. */
export function dashboardHandler(
  options: DashboardOptions, port: () => number, settlements = new Set<Promise<unknown>>(),
): (req: IncomingMessage, res: ServerResponse) => void {
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
  const mutationRequest = (req: IncomingMessage, res: ServerResponse): boolean => {
    // Mutations require the exact request authority, not any other host on the allowlist.
    // Only literal loopback may use cleartext HTTP. A reverse proxy must present HTTPS Origin.
    let originMatches = false;
    try {
      const origin = new URL(req.headers.origin ?? '');
      originMatches = origin.origin === req.headers.origin && origin.host.toLowerCase() === req.headers.host?.toLowerCase() &&
        (origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname)));
    } catch { /* Missing, null and malformed Origins are refused without echoing their values. */ }
    if (!originMatches) {
      refuse(res, 403, 'origin_mismatch', 'A matching Origin is required.');
      return false;
    }
    return true;
  };
  const page = (name: string, cache: string): Route['methods'] => ({ GET: (req, res) => sendAsset(req, res, assets.get(name)!, cache) });
  const routes: Route[] = [
    { path: `${base}/`, methods: page('index.html', 'no-store') },
    { path: `${base}/assets/app.js`, methods: page('app.js', 'no-cache') },
    { path: `${base}/assets/threadId.js`, methods: page('threadId.js', 'no-cache') },
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
  if (options.jobs) {
    const jobs = options.jobs;
    routes.push({ path: `${base}/api/jobs/settle`, methods: { POST: async (req, res) => {
      res.setHeader('cache-control', 'no-store');
      if (!apiRequest(req, res) || !mutationRequest(req, res)) return;
      if (!options.available?.()) { sendJson(res, 503, { error: 'unavailable' }); return; }
      const body = await readJson(req, 1024) as Record<string, unknown> | null;
      if (!body || typeof body.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.jobId) ||
          typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.requestId) ||
          Object.keys(body).some((key) => !['jobId', 'requestId'].includes(key))) {
        sendJson(res, 400, { error: 'invalid_request' }); return;
      }
      if (!options.available?.()) { sendJson(res, 503, { error: 'unavailable' }); return; }
      try {
        const operation = jobs.settle({ clientId: OPERATOR_CLIENT_ID, scopes: [OPERATE_SCOPE, THREAD_READ_SCOPE, THREAD_CONTROL_SCOPE] },
          { jobId: body.jobId, requestId: body.requestId });
        settlements.add(operation);
        try { await operation; } finally { settlements.delete(operation); }
        sendJson(res, 200, { snapshot: buildSnapshot(sources) });
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        // Fixed descriptions only: downstream errors may contain private thread content.
        const detail = error.code === 'job_state_conflict'
          ? 'The thread is busy or its delegated work could not be checked within the scan limit. Check it in T3.'
          : 'Settlement was not confirmed. Check the thread in T3 before trying again.';
        sendJson(res, error.code === 'not_found' ? 404 : 409, { error: error.code, detail });
      }
    } } });
  }
  if (options.management) {
    const management = options.management;
    routes.push({ path: `${base}/api/webhooks`, methods: { GET: async (req, res) => {
      if (!apiRequest(req, res)) return;
      sendJson(res, 200, await management.discoverList(), { 'cache-control': 'no-store' });
    } } });
    for (const action of ['connect', 'replace', 'test', 'disconnect'] as const) {
      routes.push({ path: `${base}/api/webhooks/${action}`, methods: { POST: async (req, res) => {
        res.setHeader('cache-control', 'no-store');
        if (!apiRequest(req, res)) return;
        if (!mutationRequest(req, res)) return;
        if (!management.available) { sendJson(res, 503, { error: 'unavailable' }); return; }
        const result = await management.execute(action, await readJson(req, 16 * 1024));
        sendJson(res, result.status, result.body, { 'cache-control': 'no-store' });
      } } });
    }
  }
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
  const settlements = new Set<Promise<unknown>>();
  const handler = dashboardHandler(options, () => actualPort, settlements);
  const server = await listen(handler, options.dashboard.listen.host, options.port ?? options.dashboard.listen.port);
  actualPort = server.port;
  const path = options.dashboard.basePath === '/' ? '/' : `${options.dashboard.basePath}/`;
  options.logger.info('dashboard.started', { listen: `${options.dashboard.listen.host}:${server.port}`, path });
  return { ...server, path, close: async () => {
    await server.close();
    await Promise.allSettled(settlements);
  } };
}
