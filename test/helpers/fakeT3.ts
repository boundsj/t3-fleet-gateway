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

export interface FakeQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; value?: string | null }[];
  multiSelect?: boolean | null;
}

export interface FakeRun {
  runId: string;
  ordinal: number;
  status: string;
  providerInstanceId: string;
  model: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface FakeItem {
  position: number;
  itemId: string;
  runId: string | null;
  messageId: string | null;
  createdBy: 'user' | 'agent' | 'system';
  creationSource: 'mcp' | 'provider' | 'web';
  type: string;
  status: string;
  text: string;
  updatedAt: string;
}

export interface FakeThread {
  threadId: string;
  projectId: string;
  title: string;
  link: string;
  status: string;
  runtimeMode: string;
  branch: string | null;
  runs: FakeRun[];
  items: FakeItem[];
  questions: Map<string, FakeQuestion[]>;
  approvalsPending: number;
  createdAt: string;
  updatedAt: string;
  launch: Record<string, unknown>;
}

const RUN_STATUSES = ['preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back'] as const;
const THREAD_STATUSES = ['idle', ...RUN_STATUSES] as const;
const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

/** Input schemas copied field-for-field from T3's tools, strict so a misspelled field fails the test. */
const launchInput = z.strictObject({
  projectId: nullable(z.string()),
  scratch: nullable(z.boolean()),
  title: z.string(),
  modelSelection: nullable(z.looseObject({ model: z.unknown() })),
  runtimeMode: nullable(z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access'])),
  interactionMode: nullable(z.enum(['default', 'plan'])),
  workspaceStrategy: nullable(
    z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('root'), branch: nullable(z.string()) }),
      z.strictObject({ type: z.literal('existing_worktree'), worktreePath: z.string(), branch: nullable(z.string()) }),
      z.strictObject({ type: z.literal('worktree'), baseRef: z.string(), branch: nullable(z.string()), startFromOrigin: nullable(z.boolean()) }),
    ]),
  ),
  message: nullable(z.string().max(120000)),
  attachments: nullable(z.array(z.unknown()).max(8)),
});
const readInput = z.strictObject({
  threadId: z.string(),
  itemId: nullable(z.string()),
  textOffset: nullable(z.int().min(0)),
  view: nullable(z.enum(['messages', 'activity'])),
  afterPosition: nullable(z.int().min(0)),
  limit: nullable(z.int().min(1).max(100)),
  runLimit: nullable(z.int().min(1).max(50)),
  maxCharsPerItem: nullable(z.int().min(1).max(50000)),
});
const listInput = z.strictObject({
  projectId: nullable(z.string()),
  statuses: nullable(z.array(z.enum(THREAD_STATUSES)).max(10)),
  titleContains: nullable(z.string()),
  settled: nullable(z.boolean()),
  snoozed: nullable(z.boolean()),
  includeSubagents: nullable(z.boolean()),
  cursor: nullable(z.int().min(0)),
  limit: nullable(z.int().min(1).max(100)),
});
const searchInput = z.strictObject({ query: z.string(), limit: z.int().min(1).max(50).optional(), projectId: nullable(z.string()) });
const sendInput = z.strictObject({
  threadId: z.string(),
  message: z.string(),
  mode: nullable(z.enum(['auto', 'queue', 'steer', 'restart'])),
  clientRequestId: nullable(z.string()),
});
const interruptInput = z.strictObject({
  threadId: z.string(),
  runId: nullable(z.string()),
  reason: nullable(z.string().max(2000)),
  clientRequestId: nullable(z.string()),
});
const pendingListInput = z.strictObject({ threadId: nullable(z.string()) });
const pendingReadInput = z.strictObject({ threadId: nullable(z.string()), requestId: z.string() });
const pendingRespondInput = z.strictObject({ threadId: nullable(z.string()), requestId: z.string(), answers: z.record(z.string(), z.unknown()) });

class FakeFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  token: string;
}

/**
 * A stand-in for a T3 Code server: the pairing-code OAuth endpoints and a sessionful MCP endpoint
 * with the environment, project, thread and pending-request tools the gateway uses, backed by an
 * in-memory thread model that tests drive (finish a turn, ask a question, fail a run). Synthetic
 * data only. Supports failure injection: T3 tool failures, slow answers, lost responses, downtime.
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
  /** Tools whose next call runs but whose HTTP response is then dropped (connection destroyed). */
  readonly dropResponseOnce = new Set<string>();
  /** Tools whose next call is answered with this bare HTTP status instead of running. */
  readonly statusOnce = new Map<string, number>();
  /** When set, interrupts are accepted but take effect only on completeInterrupts(). */
  deferInterrupts = false;
  readonly threads = new Map<string, FakeThread>();
  readonly sends: { threadId: string; message: string; clientRequestId: string | null }[] = [];
  readonly responses: { threadId: string; requestId: string; answers: Record<string, unknown> }[] = [];
  #sequence = 0;
  readonly #sendResults = new Map<string, Record<string, unknown>>();
  readonly #interruptResults = new Map<string, Record<string, unknown>>();
  readonly #deferredInterrupts = new Set<string>();
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

  /** Every launch input, in order. */
  get launches(): Record<string, unknown>[] {
    return [...this.threads.values()].map((thread) => thread.launch);
  }

  /** The thread whose title carries `[job:<jobId>]`. */
  threadForJob(jobId: string): FakeThread {
    const thread = [...this.threads.values()].find((candidate) => candidate.title.includes(`[job:${jobId}]`));
    if (!thread) throw new Error(`no thread for job ${jobId}`);
    return thread;
  }

  /** The worker finishes its turn with a final assistant message. */
  finishTurn(threadId: string, text: string): void {
    const thread = this.#thread(threadId);
    this.#addItem(thread, { runId: this.#activeRun(thread)?.runId ?? null, createdBy: 'agent', creationSource: 'provider', type: 'assistant_message', text });
    this.endTurn(threadId);
  }

  /** The active run completes without a further message. */
  endTurn(threadId: string): void {
    const thread = this.#thread(threadId);
    const run = this.#activeRun(thread);
    if (run) this.#endRun(run, 'completed');
    thread.status = 'completed';
    this.#touch(thread);
  }

  /** A person types into the thread in T3, starting a new turn. */
  userTurn(threadId: string, text: string): void {
    const thread = this.#thread(threadId);
    const run = this.#startRun(thread);
    this.#addItem(thread, { runId: run.runId, createdBy: 'user', creationSource: 'web', type: 'user_message', text });
  }

  /** The worker streams part of a message: an assistant item that is still running. */
  streamAssistant(threadId: string, text: string): FakeItem {
    const thread = this.#thread(threadId);
    const item = this.#addItem(thread, {
      runId: this.#activeRun(thread)?.runId ?? null,
      createdBy: 'agent',
      creationSource: 'provider',
      type: 'assistant_message',
      text,
      status: 'running',
    });
    return item;
  }

  /** The worker asks the user a question. Returns the pending request id. */
  askQuestion(threadId: string, questions: FakeQuestion[]): string {
    const thread = this.#thread(threadId);
    const requestId = `request-${++this.#sequence}`;
    thread.questions.set(requestId, questions);
    this.#setWaiting(thread);
    return requestId;
  }

  /** The worker needs a permission approval, which T3 does not expose through its MCP tools. */
  requestApproval(threadId: string): void {
    const thread = this.#thread(threadId);
    thread.approvalsPending += 1;
    this.#setWaiting(thread);
  }

  /** The operator approves in T3's UI. */
  grantApprovals(threadId: string): void {
    const thread = this.#thread(threadId);
    thread.approvalsPending = 0;
    this.#resume(thread);
  }

  failRun(threadId: string): void {
    const thread = this.#thread(threadId);
    const run = this.#activeRun(thread);
    if (run) this.#endRun(run, 'failed');
    thread.status = 'failed';
    this.#touch(thread);
  }

  /** Create a thread as t3_thread_launch would, outside MCP: a launch the gateway never heard back from. */
  launchDirect(input: Record<string, unknown>): { threadId: string } {
    return this.#launch(launchInput.parse(input)) as { threadId: string };
  }

  /** Finish streaming an item started with streamAssistant. */
  settleItem(threadId: string, position: number, text: string): void {
    const item = this.#thread(threadId).items[position];
    if (!item) throw new Error(`no item ${position}`);
    item.text = text;
    item.status = 'completed';
    item.updatedAt = new Date().toISOString();
  }

  /** Apply interrupts accepted while deferInterrupts was set. */
  completeInterrupts(): void {
    for (const threadId of this.#deferredInterrupts) this.#interrupt(this.#thread(threadId));
    this.#deferredInterrupts.clear();
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
    const injected = toolName(body);
    const status = injected === undefined ? undefined : this.statusOnce.get(injected);
    if (injected !== undefined && status !== undefined) {
      this.statusOnce.delete(injected);
      res.writeHead(status).end();
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
    const response = await transport.handleRequest(toWebRequest(req, body, this.url));
    const tool = toolName(body);
    if (tool && this.dropResponseOnce.delete(tool)) {
      // The tool ran; the caller never hears back.
      req.socket.destroy();
      return;
    }
    await sendWebResponse(res, response);
  }

  #buildServer(): McpServer {
    const server = new McpServer({ name: 'T3 Code', version: this.serverVersion });
    const run = async (tool: string, produce: () => Record<string, unknown>) => {
      this.calls.push(tool);
      if (this.toolDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.toolDelayMs));
      const failure = this.failures.get(tool);
      const fail = (value: { code: string; message: string }) => ({
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ _tag: 'OrchestratorMcpFailure', ...value }) }],
      });
      if (failure) return fail(failure);
      try {
        const value = produce();
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        if (error instanceof FakeFailure) return fail({ code: error.code, message: error.message });
        throw error;
      }
    };
    const tool = <S extends z.ZodObject>(name: string, input: S, produce: (args: z.output<S>) => Record<string, unknown>) =>
      server.registerTool(name, { inputSchema: input as z.ZodObject }, (args: unknown) => run(name, () => produce(args as z.output<S>)));
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
    tool('t3_thread_launch', launchInput, (input) => this.#launch(input));
    tool('t3_thread_read', readInput, (input) => this.#read(input));
    tool('t3_thread_list', listInput, (input) => {
      const projectId = this.#target(input.projectId);
      const matching = [...this.threads.values()]
        .filter((thread) => thread.projectId === projectId && (!input.titleContains || thread.title.includes(input.titleContains)))
        .reverse();
      const start = input.cursor ?? 0;
      const size = input.limit ?? 50;
      return {
        projectId,
        currentThreadId: null,
        threads: matching.slice(start, start + size).map((thread) => this.#summary(thread)),
        nextCursor: start + size < matching.length ? start + size : null,
        total: matching.length,
      };
    });
    tool('t3_thread_search', searchInput, (input) => {
      const projectId = this.#target(input.projectId);
      const query = input.query.toLowerCase();
      const matches = [...this.threads.values()]
        .filter((thread) => thread.projectId === projectId)
        .flatMap((thread) => {
          const hit = [thread.title, ...thread.items.map((item) => item.text)].find((text) => text.toLowerCase().includes(query));
          return hit === undefined ? [] : [{ threadId: thread.threadId, projectId, source: 'user', snippet: hit.slice(0, 240), messageCreatedAt: null }];
        });
      return { matches: matches.slice(0, input.limit ?? 10) };
    });
    tool('t3_thread_send', sendInput, (input) => this.#send(input));
    tool('t3_thread_interrupt', interruptInput, (input) => {
      const key = input.clientRequestId ? `${input.threadId}:${input.clientRequestId}` : undefined;
      const previous = key ? this.#interruptResults.get(key) : undefined;
      if (previous) return previous;
      const thread = this.#thread(input.threadId);
      const run = this.#activeRun(thread);
      let result: Record<string, unknown>;
      if (!run) {
        result = { threadId: thread.threadId, runId: null, status: 'no_active_run' };
      } else {
        if (this.deferInterrupts) this.#deferredInterrupts.add(thread.threadId);
        else this.#interrupt(thread);
        result = { threadId: thread.threadId, runId: run.runId, status: 'interrupt_requested' };
      }
      if (key) this.#interruptResults.set(key, result);
      return result;
    });
    tool('t3_pending_request_list', pendingListInput, (input) => ({
      requestIds: [...this.#thread(this.#target(input.threadId, 'threadId')).questions.keys()],
    }));
    tool('t3_pending_request_read', pendingReadInput, (input) => {
      const questions = this.#thread(this.#target(input.threadId, 'threadId')).questions.get(input.requestId);
      if (!questions) throw new FakeFailure('not_found', 'No such pending request.');
      return { requestId: input.requestId, questions };
    });
    tool('t3_pending_request_respond', pendingRespondInput, (input) => {
      const thread = this.#thread(this.#target(input.threadId, 'threadId'));
      if (!thread.questions.delete(input.requestId)) throw new FakeFailure('not_found', 'No such pending request.');
      this.responses.push({ threadId: thread.threadId, requestId: input.requestId, answers: input.answers });
      if (thread.questions.size === 0 && thread.approvalsPending === 0) this.#resume(thread);
      return { sequence: ++this.#sequence };
    });
    return server;
  }

  #target(value: string | null | undefined, field = 'projectId'): string {
    if (!value) throw new FakeFailure('target_required', `Pass ${field}: this MCP client is not running inside a T3 thread.`);
    return value;
  }

  #thread(threadId: string): FakeThread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new FakeFailure('thread_not_found', 'No such thread.');
    return thread;
  }

  #activeRun(thread: FakeThread): FakeRun | undefined {
    return thread.runs.findLast((run) => ACTIVE.has(run.status));
  }

  #touch(thread: FakeThread): void {
    thread.updatedAt = new Date().toISOString();
  }

  #addItem(thread: FakeThread, item: Omit<FakeItem, 'position' | 'itemId' | 'messageId' | 'status' | 'updatedAt'> & { status?: string }): FakeItem {
    const position = thread.items.length;
    const created: FakeItem = {
      position,
      itemId: `${thread.threadId}-item-${position}`,
      messageId: `${thread.threadId}-message-${position}`,
      status: 'completed',
      updatedAt: new Date().toISOString(),
      ...item,
    };
    thread.items.push(created);
    this.#touch(thread);
    return created;
  }

  #startRun(thread: FakeThread): FakeRun {
    const now = new Date().toISOString();
    const run: FakeRun = {
      runId: `${thread.threadId}-run-${thread.runs.length + 1}`,
      ordinal: thread.runs.length + 1,
      status: 'running',
      providerInstanceId: 'synthetic-provider',
      model: 'synthetic-model',
      requestedAt: now,
      startedAt: now,
      completedAt: null,
    };
    thread.runs.push(run);
    thread.status = 'running';
    this.#touch(thread);
    return run;
  }

  #endRun(run: FakeRun, status: string): void {
    run.status = status;
    run.completedAt = new Date().toISOString();
  }

  #setWaiting(thread: FakeThread): void {
    const run = this.#activeRun(thread);
    if (run) run.status = 'waiting';
    thread.status = 'waiting';
    this.#touch(thread);
  }

  #resume(thread: FakeThread): void {
    const run = this.#activeRun(thread);
    if (run) run.status = 'running';
    thread.status = 'running';
    this.#touch(thread);
  }

  #interrupt(thread: FakeThread): void {
    const run = this.#activeRun(thread);
    if (run) this.#endRun(run, 'interrupted');
    thread.questions.clear();
    thread.approvalsPending = 0;
    thread.status = 'interrupted';
    this.#touch(thread);
  }

  #launch(input: z.output<typeof launchInput>): Record<string, unknown> {
    const projectId = this.#target(input.projectId);
    if (!this.projects.some((project) => project.id === projectId)) throw new FakeFailure('project_not_found', 'No such project.');
    const threadId = `thread-${this.threads.size + 1}`;
    const now = new Date().toISOString();
    const strategy = input.workspaceStrategy;
    const thread: FakeThread = {
      threadId,
      projectId,
      title: input.title,
      link: `${this.url}/threads/${threadId}`,
      status: 'idle',
      runtimeMode: input.runtimeMode ?? 'full-access',
      branch: strategy && 'branch' in strategy ? (strategy.branch ?? null) : null,
      runs: [],
      items: [],
      questions: new Map(),
      approvalsPending: 0,
      createdAt: now,
      updatedAt: now,
      launch: input,
    };
    this.threads.set(threadId, thread);
    let run: FakeRun | undefined;
    if (input.message) {
      run = this.#startRun(thread);
      this.#addItem(thread, { runId: run.runId, createdBy: 'agent', creationSource: 'mcp', type: 'user_message', text: input.message });
    }
    return {
      threadId,
      link: thread.link,
      projectId,
      modelSelection: input.modelSelection ?? { model: 'synthetic-model' },
      runId: run?.runId ?? null,
      status: run?.status ?? null,
    };
  }

  #send(input: z.output<typeof sendInput>): Record<string, unknown> {
    const key = input.clientRequestId ? `${input.threadId}:${input.clientRequestId}` : undefined;
    const previous = key ? this.#sendResults.get(key) : undefined;
    if (previous) return previous;
    const thread = this.#thread(input.threadId);
    this.sends.push({ threadId: thread.threadId, message: input.message, clientRequestId: input.clientRequestId ?? null });
    const active = this.#activeRun(thread);
    const run = active ?? this.#startRun(thread);
    this.#addItem(thread, { runId: run.runId, createdBy: 'agent', creationSource: 'mcp', type: 'user_message', text: input.message });
    const result = {
      threadId: thread.threadId,
      messageId: `${thread.threadId}-message-${thread.items.length - 1}`,
      runId: run.runId,
      status: run.status,
      delivery: active ? 'steered' : 'started',
    };
    if (key) this.#sendResults.set(key, result);
    return result;
  }

  #summary(thread: FakeThread): Record<string, unknown> {
    return {
      threadId: thread.threadId,
      link: thread.link,
      title: thread.title,
      createdBy: 'agent',
      creationSource: 'mcp',
      status: thread.status,
      latestRunId: thread.runs.at(-1)?.runId ?? null,
      providerInstanceId: 'synthetic-provider',
      model: 'synthetic-model',
      runtimeMode: thread.runtimeMode,
      interactionMode: 'default',
      linkedPullRequest: null,
      settled: false,
      settledAt: null,
      snoozed: false,
      snoozedUntil: null,
      parentThreadId: null,
      relationshipToParent: null,
      itemCount: thread.items.length,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }

  #read(input: z.output<typeof readInput>): Record<string, unknown> {
    const thread = this.#thread(input.threadId);
    const after = input.afterPosition ?? -1;
    const limit = input.limit ?? 50;
    const remaining = thread.items.filter((item) => item.position > after);
    const page = remaining.slice(0, limit);
    const maxChars = input.maxCharsPerItem ?? 4000;
    const active = this.#activeRun(thread);
    return {
      thread: {
        ...this.#summary(thread),
        projectId: thread.projectId,
        activeRunId: active?.runId ?? null,
        titleRegeneration: null,
        branch: thread.branch,
        worktreePath: null,
        runCount: thread.runs.length,
        pendingRequestCount: thread.questions.size + thread.approvalsPending,
        archived: false,
      },
      recentRuns: thread.runs.slice(-(input.runLimit ?? 10)).reverse(),
      items: page.map((item) => ({
        ...item,
        visibility: 'local',
        sourceThreadId: thread.threadId,
        title: null,
        text: item.text.slice(0, maxChars),
        textTruncated: item.text.length > maxChars,
        nextTextOffset: item.text.length > maxChars ? maxChars : null,
      })),
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: remaining.length > page.length,
    };
  }
}

function toolName(body: Buffer | undefined): string | undefined {
  try {
    const message = JSON.parse(body?.toString() ?? '') as { method?: unknown; params?: { name?: unknown } };
    return message.method === 'tools/call' && typeof message.params?.name === 'string' ? message.params.name : undefined;
  } catch {
    return undefined;
  }
}

export async function startFakeT3(options: FakeT3Options = {}): Promise<FakeT3> {
  return new FakeT3(options).start();
}
