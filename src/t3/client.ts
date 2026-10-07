import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import type * as z from 'zod';
import { GatewayError, type ErrorCode } from '../errors.ts';
import { isTypeOfServiceRace } from '../processErrors.ts';
import { GATEWAY_NAME, GATEWAY_VERSION } from '../version.ts';
import { parseToolResult } from './results.ts';
import {
  environmentSchema,
  interruptResultSchema,
  launchResultSchema,
  pendingRequestListSchema,
  pendingRequestSchema,
  projectListSchema,
  respondResultSchema,
  sendResultSchema,
  threadListSchema,
  threadReadSchema,
  threadSearchSchema,
  type InterruptResult,
  type LaunchResult,
  type LaunchThreadInput,
  type PendingRequest,
  type SendResult,
  type T3Environment,
  type T3Project,
  type ThreadList,
  type ThreadRead,
  type ThreadSearch,
} from './schemas.ts';

export const DEFAULT_T3_TIMEOUT_MS = 15_000;
const MAX_PROJECT_PAGES = 20;

export interface T3ClientOptions {
  hostId: string;
  t3Url: string;
  /** Current bearer credential for this host, read before every request so renewals apply at once. */
  token: () => string | undefined;
  timeoutMs?: number;
}

export interface CallOptions {
  timeoutMs?: number;
  /** The tool does not change T3 state, so a call lost in transit may be repeated. */
  readOnly?: boolean;
}

function httpStatus(error: unknown): number | undefined {
  return error instanceof SdkHttpError ? error.status : undefined;
}

/**
 * Whether T3 may have received a call that failed in transport. `not_delivered`: the request never
 * reached T3's tool handler (no connection, refused, rejected before handling), so nothing happened.
 * `unknown`: it may have run (timeout after sending, connection reset, 5xx), so a state-changing
 * call has an unknown outcome.
 */
export type Delivery = 'not_delivered' | 'unknown';

/** A transport-level failure talking to T3, with what is known about delivery. */
export class T3TransportError extends GatewayError {
  readonly delivery: Delivery;

  constructor(code: ErrorCode, message: string, delivery: Delivery, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = 'T3TransportError';
    this.delivery = delivery;
  }
}

/** Socket errors that mean the request was never sent: nothing accepted the connection. */
const CONNECT_FAILURES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT']);

function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECT_FAILURES.has(code)) return code;
    // Thrown before the request was written to a connection the peer had already reset.
    if (isTypeOfServiceRace(current)) return 'EINVAL';
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Whether a failed call means the MCP session itself is unusable, so the connection must be
 * replaced. A request timeout or a 5xx answer is a failure of that one request: the session stays,
 * and so do the other calls in flight on it.
 */
function sessionFailed(error: unknown, sent: boolean): boolean {
  if (!sent) return true;
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return false;
  const status = httpStatus(error);
  return status === undefined || status < 500;
}

interface Connection {
  client: Promise<Client>;
  token: string;
  /** Increases with every new connection, so a late failure on an old one cannot close a newer one. */
  generation: number;
}

/**
 * MCP client for one T3 Code server. Connects lazily, keeps the session, and reconnects after
 * session-level failures (connection errors, a forgotten session, a rejected credential) or a
 * credential change. Failures surface as GatewayError with stable codes.
 */
export class T3Client {
  readonly hostId: string;
  readonly #url: URL;
  readonly #token: () => string | undefined;
  readonly #timeoutMs: number;
  #connection: Connection | undefined;
  #generation = 0;

  constructor(options: T3ClientOptions) {
    this.hostId = options.hostId;
    this.#url = new URL('/mcp', options.t3Url);
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_T3_TIMEOUT_MS;
  }

  /**
   * Call a T3 tool. A 404 (T3 forgot the session, so it never handled the call) is retried once on
   * a new session. Other transport failures are retried once only for calls marked `readOnly`:
   * for anything that changes state, a lost response is ambiguous and the caller must decide.
   * Transport failures are thrown as T3TransportError, whose `delivery` tells the two cases apart.
   * Only session-level failures replace the connection; a timeout leaves other calls on it running.
   */
  async callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>, options: CallOptions = {}): Promise<T> {
    const timeout = options.timeoutMs ?? this.#timeoutMs;
    for (let attempt = 0; ; attempt++) {
      let sent = false;
      let connection: Connection | undefined;
      try {
        connection = this.#connect(timeout);
        const client = await connection.client;
        sent = true;
        const result = await client.callTool({ name, arguments: args }, { timeout });
        return parseToolResult(name, result, schema);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        if (connection && sessionFailed(error, sent)) await this.#reset(connection.generation);
        const translated = this.#translate(error, sent);
        const retryable =
          httpStatus(error) === 404 || (options.readOnly === true && (translated.code === 'host_unreachable' || translated.code === 't3_response_lost'));
        if (retryable && attempt === 0) continue;
        throw translated;
      }
    }
  }

  environmentRead(options: { timeoutMs?: number } = {}): Promise<T3Environment> {
    return this.callTool('t3_environment_read', {}, environmentSchema, { ...options, readOnly: true });
  }

  async listProjects(): Promise<T3Project[]> {
    const projects: T3Project[] = [];
    let cursor: number | null | undefined = null;
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const result: z.infer<typeof projectListSchema> = await this.callTool(
        't3_project_list',
        cursor === null ? { limit: 100 } : { limit: 100, cursor },
        projectListSchema,
        { readOnly: true },
      );
      projects.push(...result.projects);
      cursor = result.nextCursor;
      if (cursor === null || cursor === undefined) break;
    }
    return projects.filter((project) => !project.deletedAt);
  }

  /** Create a thread. Not retried: T3 has no retry key for launches, so a lost response is ambiguous. */
  launchThread(input: LaunchThreadInput, options: { timeoutMs?: number } = {}): Promise<LaunchResult> {
    return this.callTool('t3_thread_launch', { ...input }, launchResultSchema, options);
  }

  /**
   * One page of a thread's state and timeline. `afterPosition` continues from a previous `nextPosition`.
   * Callers name the view: `messages` returns user and assistant messages and proposed plans only,
   * `activity` every timeline item (delegated work, reasoning, tools, checkpoints); positions are shared.
   */
  readThread(input: {
    threadId: string;
    view: 'messages' | 'activity';
    afterPosition?: number | null;
    limit?: number;
    runLimit?: number;
    maxCharsPerItem?: number;
  }): Promise<ThreadRead> {
    return this.callTool('t3_thread_read', withoutNulls(input), threadReadSchema, { readOnly: true });
  }

  /** Threads in a project, newest first: unsettled ones, or settled ones with `settled: true`. Outside clients must pass `projectId`. */
  listThreads(input: { projectId: string; titleContains?: string; settled?: boolean; limit?: number; cursor?: number }): Promise<ThreadList> {
    return this.callTool('t3_thread_list', withoutNulls(input), threadListSchema, { readOnly: true });
  }

  searchThreads(input: { projectId: string; query: string; limit?: number }): Promise<ThreadSearch> {
    return this.callTool('t3_thread_search', withoutNulls(input), threadSearchSchema, { readOnly: true });
  }

  /** Send a message. `clientRequestId` makes T3 deduplicate retries, so callers may repeat it with the same id. */
  sendToThread(input: { threadId: string; message: string; mode?: 'auto' | 'queue' | 'steer'; clientRequestId: string }): Promise<SendResult> {
    return this.callTool('t3_thread_send', withoutNulls(input), sendResultSchema);
  }

  /** Request an interrupt of the thread's active turn. Idempotent per `clientRequestId`. */
  interruptThread(input: { threadId: string; clientRequestId: string; reason?: string }): Promise<InterruptResult> {
    return this.callTool('t3_thread_interrupt', withoutNulls(input), interruptResultSchema);
  }

  /** Ids of the thread's pending user questions. T3 does not include permission approvals here. */
  async listPendingRequests(threadId: string): Promise<string[]> {
    return (await this.callTool('t3_pending_request_list', { threadId }, pendingRequestListSchema, { readOnly: true })).requestIds;
  }

  readPendingRequest(threadId: string, requestId: string, options: { timeoutMs?: number } = {}): Promise<PendingRequest> {
    return this.callTool('t3_pending_request_read', { threadId, requestId }, pendingRequestSchema, { ...options, readOnly: true });
  }

  /** Answer a pending user question. `answers` is passed through as T3 expects it. */
  async respondToPendingRequest(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<number> {
    return (await this.callTool('t3_pending_request_respond', { threadId, requestId, answers }, respondResultSchema)).sequence;
  }

  async close(): Promise<void> {
    await this.#reset();
  }

  #connect(timeout: number): Connection {
    const token = this.#token();
    if (!token) {
      throw new GatewayError('host_not_enrolled', `Host ${this.hostId} has no T3 credential. Run: t3-fleet-gateway hosts enroll ${this.hostId}`);
    }
    if (this.#connection && this.#connection.token !== token) void this.#reset(this.#connection.generation);
    if (!this.#connection) {
      const client = new Client({ name: GATEWAY_NAME, version: GATEWAY_VERSION });
      const transport = new StreamableHTTPClientTransport(this.#url, { authProvider: { token: async () => token } });
      const connecting = client.connect(transport, { timeout }).then(() => client);
      this.#connection = { client: connecting, token, generation: ++this.#generation };
    }
    return this.#connection;
  }

  /** Close the connection of the given generation, or the current one; a newer connection is left alone. */
  async #reset(generation?: number): Promise<void> {
    const connection = this.#connection;
    if (!connection || (generation !== undefined && connection.generation !== generation)) return;
    this.#connection = undefined;
    try {
      await (await connection.client).close();
    } catch {
      // The connection already failed; nothing to close.
    }
  }

  /**
   * Map a transport failure to a stable code and a delivery verdict. Anything before the call was
   * sent (connecting, initializing), a refused connection, and HTTP 4xx answers mean T3 never ran
   * the tool. Timeouts, resets and 5xx answers after sending leave the outcome unknown.
   */
  #translate(error: unknown, sent: boolean): T3TransportError {
    const status = httpStatus(error);
    if (error instanceof UnauthorizedError || status === 401 || status === 403) {
      return new T3TransportError(
        't3_unauthorized',
        `T3 on host ${this.hostId} rejected the gateway's credential. Run: t3-fleet-gateway hosts enroll ${this.hostId}`,
        'not_delivered',
        { cause: error },
      );
    }
    const delivery: Delivery = !sent || causeCode(error) !== undefined || (status !== undefined && status < 500) ? 'not_delivered' : 'unknown';
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
      return new T3TransportError('t3_timeout', `T3 on host ${this.hostId} did not answer in time`, delivery, { cause: error });
    }
    const detail = status === undefined ? '' : ` (HTTP ${status})`;
    if (delivery === 'unknown') {
      return new T3TransportError('t3_response_lost', `Lost the response from T3 on host ${this.hostId}${detail}`, delivery, { cause: error });
    }
    return new T3TransportError('host_unreachable', `Cannot reach T3 on host ${this.hostId}${detail}`, delivery, { cause: error });
  }
}

/** Drop null and undefined fields so optional T3 inputs are omitted rather than sent as null. */
function withoutNulls<T extends object>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}
