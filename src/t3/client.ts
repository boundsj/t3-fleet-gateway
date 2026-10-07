import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import type * as z from 'zod';
import { GatewayError } from '../errors.ts';
import { GATEWAY_NAME, GATEWAY_VERSION } from '../version.ts';
import { parseToolResult } from './results.ts';
import { environmentSchema, projectListSchema, type T3Environment, type T3Project } from './schemas.ts';

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
 * MCP client for one T3 Code server. Connects lazily, keeps the session, and reconnects after
 * transport failures or a credential change. Failures surface as GatewayError with stable codes.
 */
export class T3Client {
  readonly hostId: string;
  readonly #url: URL;
  readonly #token: () => string | undefined;
  readonly #timeoutMs: number;
  #connection: { client: Promise<Client>; token: string } | undefined;

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
   */
  async callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>, options: CallOptions = {}): Promise<T> {
    const timeout = options.timeoutMs ?? this.#timeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.#client(timeout);
        const result = await client.callTool({ name, arguments: args }, { timeout });
        return parseToolResult(name, result, schema);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        await this.#reset();
        const translated = this.#translate(error);
        const retryable = httpStatus(error) === 404 || (options.readOnly === true && translated.code === 'host_unreachable');
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

  async close(): Promise<void> {
    await this.#reset();
  }

  #client(timeout: number): Promise<Client> {
    const token = this.#token();
    if (!token) {
      return Promise.reject(new GatewayError('host_not_enrolled', `Host ${this.hostId} has no T3 credential. Run: t3-fleet-gateway hosts enroll ${this.hostId}`));
    }
    if (this.#connection && this.#connection.token !== token) void this.#reset();
    if (!this.#connection) {
      const client = new Client({ name: GATEWAY_NAME, version: GATEWAY_VERSION });
      const transport = new StreamableHTTPClientTransport(this.#url, { authProvider: { token: async () => token } });
      const connecting = client.connect(transport, { timeout }).then(() => client);
      this.#connection = { client: connecting, token };
    }
    return this.#connection.client;
  }

  async #reset(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    if (!connection) return;
    try {
      await (await connection.client).close();
    } catch {
      // The connection already failed; nothing to close.
    }
  }

  #translate(error: unknown): GatewayError {
    const status = httpStatus(error);
    if (error instanceof UnauthorizedError || status === 401 || status === 403) {
      return new GatewayError('t3_unauthorized', `T3 on host ${this.hostId} rejected the gateway's credential. Run: t3-fleet-gateway hosts enroll ${this.hostId}`, { cause: error });
    }
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
      return new GatewayError('t3_timeout', `T3 on host ${this.hostId} did not answer in time`, { cause: error });
    }
    const detail = status === undefined ? '' : ` (HTTP ${status})`;
    return new GatewayError('host_unreachable', `Cannot reach T3 on host ${this.hostId}${detail}`, { cause: error });
  }
}
