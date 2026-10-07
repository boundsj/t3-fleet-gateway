import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { pkceChallenge, randomToken } from '../../src/crypto.ts';
import { readBody } from '../../src/http/io.ts';
import { sendWebResponse, toWebRequest } from '../../src/http/web.ts';

export interface FakeT3Options {
  serverVersion?: string;
  /** Lifetime of issued credentials, seconds. T3 uses 30 days. */
  tokenLifetimeSeconds?: number;
  projectCount?: number;
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  token: string;
}

/**
 * A stand-in for a T3 Code server: the pairing-code OAuth endpoints and a sessionful MCP endpoint
 * with t3_environment_read and t3_project_list. Synthetic data only. Supports failure injection.
 */
export class FakeT3 {
  readonly serverVersion: string;
  tokenLifetimeSeconds: number;
  readonly projects: { id: string; title: string; deletedAt: string | null }[];
  /** Tool name to a T3 failure returned instead of a result. */
  readonly failures = new Map<string, { code: string; message: string }>();
  readonly calls: string[] = [];
  readonly validTokens = new Set<string>();
  readonly issuedTokens: string[] = [];
  readonly registeredClientNames: string[] = [];
  readonly decisions: { access: string }[] = [];
  /** When set, the decision endpoint refuses every pairing code. */
  rejectDecisions = false;
  /** Delay before answering tool calls, milliseconds. */
  toolDelayMs = 0;
  #server: Server | undefined;
  #port = 0;
  readonly #pairingCodes = new Set<string>();
  readonly #authCodes = new Map<string, { clientId: string; redirectUri: string; challenge: string; access: string }>();
  readonly #sessions = new Map<string, Session>();

  constructor(options: FakeT3Options = {}) {
    this.serverVersion = options.serverVersion ?? '0.0.0-test';
    this.tokenLifetimeSeconds = options.tokenLifetimeSeconds ?? 30 * 86400;
    this.projects = Array.from({ length: options.projectCount ?? 3 }, (_, i) => ({
      id: `project-${i + 1}`,
      title: `Synthetic project ${i + 1}`,
      deletedAt: null,
    }));
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  /** argv for a mint command that asks this fake for a pairing code, like `t3 auth pairing create --json`. */
  mintCommand(): string[] {
    const script = `fetch(${JSON.stringify(`${this.url}/test/mint`)},{method:'POST'}).then(r=>r.text()).then(t=>process.stdout.write(t))`;
    return [process.execPath, '-e', script];
  }

  mintPairingCode(): string {
    const code = randomToken(12);
    this.#pairingCodes.add(code);
    return code;
  }

  revokeAllTokens(): void {
    this.validTokens.clear();
  }

  async start(port = 0): Promise<this> {
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(port, '127.0.0.1', resolve));
    this.#port = (this.#server.address() as AddressInfo).port;
    return this;
  }

  /** Simulate the host going away, keeping the port for a later restart. */
  async stop(): Promise<void> {
    await this.forgetSessions();
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Drop every MCP session, as T3 does when it restarts, while keeping connections open. */
  async forgetSessions(): Promise<void> {
    for (const session of this.#sessions.values()) await session.transport.close();
    this.#sessions.clear();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', this.url).pathname;
    const body = req.method === 'POST' ? await readBody(req, 1024 * 1024) : undefined;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    };
    if (path === '/test/mint') return json(200, { credential: this.mintPairingCode(), expiresAt: new Date().toISOString() });
    if (path === '/oauth/mcp/register') {
      const input = JSON.parse(body?.toString() ?? '{}') as { client_name: string; redirect_uris: string[] };
      this.registeredClientNames.push(input.client_name);
      return json(201, {
        client_id: randomUUID(),
        client_name: input.client_name,
        redirect_uris: input.redirect_uris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    }
    if (path === '/oauth/mcp/decision') {
      const input = JSON.parse(body?.toString() ?? '{}') as {
        authorization: { client_id: string; redirect_uri: string; code_challenge: string; state: string; resource: string };
        decision: { _tag: string; access: string; code: string };
      };
      if (this.rejectDecisions || input.decision._tag !== 'pairing-code' || !this.#pairingCodes.delete(input.decision.code)) {
        return json(400, { _tag: 'AuthMcpApprovalError', message: 'The pairing code is invalid or expired.' });
      }
      if (input.authorization.resource !== `${this.url}/mcp`) return json(400, { message: 'wrong resource' });
      this.decisions.push({ access: input.decision.access });
      const code = randomToken();
      this.#authCodes.set(code, {
        clientId: input.authorization.client_id,
        redirectUri: input.authorization.redirect_uri,
        challenge: input.authorization.code_challenge,
        access: input.decision.access,
      });
      const redirect = new URL(input.authorization.redirect_uri);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', input.authorization.state);
      return json(200, { redirectTo: redirect.href });
    }
    if (path === '/oauth/mcp/token') {
      const form = new URLSearchParams(body?.toString() ?? '');
      const grant = this.#authCodes.get(form.get('code') ?? '');
      this.#authCodes.delete(form.get('code') ?? '');
      if (
        !grant ||
        grant.clientId !== form.get('client_id') ||
        grant.redirectUri !== form.get('redirect_uri') ||
        grant.challenge !== pkceChallenge(form.get('code_verifier') ?? '')
      ) {
        return json(400, { error: 'invalid_grant' });
      }
      const token = randomToken();
      this.validTokens.add(token);
      this.issuedTokens.push(token);
      const scope = grant.access === 'read-only' ? 'orchestration:read' : 'orchestration:read orchestration:operate';
      return json(200, { access_token: token, expires_in: this.tokenLifetimeSeconds, scope, token_type: 'Bearer' });
    }
    if (path === '/mcp') return this.#handleMcp(req, res, body);
    json(404, { error: 'not_found' });
  }

  async #handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer | undefined): Promise<void> {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !this.validTokens.has(token)) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${this.url}/.well-known/oauth-protected-resource"` }).end();
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    let transport: WebStandardStreamableHTTPServerTransport;
    if (typeof sessionId === 'string') {
      const session = this.#sessions.get(sessionId);
      if (!session || session.token !== token) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      transport = session.transport;
    } else {
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          this.#sessions.set(id, { transport, token });
        },
      });
      await this.#buildServer().connect(transport);
    }
    await sendWebResponse(res, await transport.handleRequest(toWebRequest(req, body, this.url)));
  }

  #buildServer(): McpServer {
    const server = new McpServer({ name: 'T3 Code', version: this.serverVersion });
    const run = async (tool: string, produce: () => Record<string, unknown>) => {
      this.calls.push(tool);
      if (this.toolDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.toolDelayMs));
      const failure = this.failures.get(tool);
      if (failure) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ _tag: 'OrchestratorMcpFailure', ...failure }) }],
        };
      }
      const value = produce();
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
    };
    server.registerTool('t3_environment_read', { inputSchema: z.object({}).loose() }, () =>
      run('t3_environment_read', () => ({
        environmentId: 'env-synthetic',
        label: 'Synthetic host',
        serverVersion: this.serverVersion,
        platform: { os: 'linux', arch: 'x64' },
        preferences: { backgroundActivity: { profile: 'balanced' } },
      })),
    );
    server.registerTool(
      't3_project_list',
      { inputSchema: z.object({ cursor: z.number().int().nullable().optional(), limit: z.number().int().nullable().optional() }).loose() },
      ({ cursor, limit }) =>
        run('t3_project_list', () => {
          const start = cursor ?? 0;
          const size = limit ?? 50;
          const page = this.projects.slice(start, start + size);
          return { projects: page, nextCursor: start + size < this.projects.length ? start + size : null };
        }),
    );
    return server;
  }
}

export async function startFakeT3(options: FakeT3Options = {}): Promise<FakeT3> {
  return new FakeT3(options).start();
}
