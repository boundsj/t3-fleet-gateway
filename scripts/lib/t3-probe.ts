import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod';
import { GatewayError } from '../../src/errors.ts';
import { T3Client } from '../../src/t3/client.ts';
import { projectListSchema } from '../../src/t3/schemas.ts';
import { GATEWAY_VERSION } from '../../src/version.ts';
import { checkInputs, snapshotContract, type AdvertisedTool, type Contract } from './t3-contract.ts';

export interface ProbeCheck {
  tool: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  code: string;
}

export interface ProbeResult {
  serverVersion: string | null;
  contract: Contract | null;
  outputSchemas: number;
  checks: ProbeCheck[];
}

export class ProbeError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

const toolsPage = z.object({
  tools: z.array(z.object({
    name: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  })),
  nextCursor: z.string().optional(),
});

/** Explicit pagination: an incomplete discovery must never become a baseline. No SDK tool cache is populated. */
export async function collectTools(
  readPage: (cursor?: string) => Promise<unknown>,
  maxPages = 32,
): Promise<AdvertisedTool[]> {
  const tools: AdvertisedTool[] = [];
  const cursors = new Set<string>();
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = toolsPage.parse(await readPage(cursor));
    for (const tool of result.tools) {
      if (names.has(tool.name)) throw new ProbeError('duplicate_tool');
      names.add(tool.name);
      tools.push(tool);
    }
    if (result.nextCursor === undefined) return tools;
    if (cursors.has(result.nextCursor)) throw new ProbeError('repeated_cursor');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new ProbeError('discovery_page_limit');
}

function failureCode(error: unknown): string {
  // T3's error messages and validator messages can contain private content. Keep only our fixed codes.
  return error instanceof ProbeError || error instanceof GatewayError ? error.code : 'request_failed';
}

export async function probeHost(options: {
  hostId: string;
  t3Url: string;
  token: () => string | undefined;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const timeout = options.timeoutMs ?? 5_000;
  const result: ProbeResult = { serverVersion: null, contract: null, outputSchemas: 0, checks: [] };
  const smoke = new T3Client({ ...options, timeoutMs: timeout });
  const discovery = new Client({ name: 't3-fleet-gateway-compatibility', version: GATEWAY_VERSION });
  async function step<T>(tool: string, code: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      const value = await run();
      result.checks.push({ tool, status: 'pass', code });
      return value;
    } catch (error) {
      result.checks.push({ tool, status: 'fail', code: failureCode(error) });
      return undefined;
    }
  }
  const skip = (tool: string, code: string) => result.checks.push({ tool, status: 'skip', code });
  try {
    const token = options.token();
    if (!token) throw new ProbeError('credential_missing');
    const tools = await step('tools/list', 'discovery_complete', async () => {
      await discovery.connect(new StreamableHTTPClientTransport(new URL('/mcp', options.t3Url), {
        authProvider: { token: async () => token },
      }), { timeout });
      return collectTools((cursor) => discovery.request({
        method: 'tools/list', params: cursor === undefined ? {} : { cursor },
      }, toolsPage, { timeout }));
    });
    if (tools) {
      result.contract = snapshotContract(tools);
      result.outputSchemas = Object.values(result.contract).filter((tool) => tool.outputSchema !== undefined).length;
      result.checks.push(...checkInputs(tools));
    }

    // Separate client: smoke uses exactly the gateway's parsers, unaffected by discovery's output-schema cache.
    const environment = await step('t3_environment_read', 'environment_read', () => smoke.environmentRead());
    result.serverVersion = environment?.serverVersion ?? null;
    if (!environment) return result;
    const projects = await step('t3_project_list', 'projects_read', () => smoke.callTool(
      't3_project_list', { limit: 5 }, projectListSchema, { readOnly: true },
    ));
    let threadId: string | undefined;
    const candidates = projects?.projects.filter((project) => !project.deletedAt).slice(0, 3) ?? [];
    for (const project of candidates) {
      const page = await step('t3_thread_list', 'threads_read', () => smoke.listThreads({ projectId: project.id, limit: 1 }));
      threadId = page?.threads[0]?.threadId;
      if (page && !threadId) {
        const settled = await step('t3_thread_list', 'settled_threads_read', () => smoke.listThreads({
          projectId: project.id, settled: true, limit: 1,
        }));
        threadId = settled?.threads[0]?.threadId;
      }
      if (threadId) break;
    }
    if (candidates[0]) {
      await step('t3_thread_search', 'search_read', () => smoke.searchThreads({
        projectId: candidates[0]!.id, query: '__t3_fleet_compatibility_probe__', limit: 1,
      }));
    } else {
      skip('t3_thread_list', 'no_project_sample');
      skip('t3_thread_search', 'no_project_sample');
    }
    if (!threadId) {
      skip('t3_thread_read', 'no_thread_sample');
      skip('t3_pending_request_list', 'no_thread_sample');
      skip('t3_pending_request_read', 'no_thread_sample');
      return result;
    }
    for (const view of ['messages', 'activity'] as const) {
      await step('t3_thread_read', `${view}_read`, () => smoke.readThread({
        threadId, view, limit: 1, runLimit: 1, maxCharsPerItem: 1,
      }));
    }
    const requests = await step('t3_pending_request_list', 'pending_requests_read', () => smoke.listPendingRequests(threadId));
    if (requests?.[0]) {
      await step('t3_pending_request_read', 'pending_request_read', () => smoke.readPendingRequest(threadId, requests[0]!));
    } else {
      skip('t3_pending_request_read', requests ? 'no_pending_request_sample' : 'pending_request_list_failed');
    }
    return result;
  } catch (error) {
    result.checks.push({ tool: 'host', status: 'fail', code: failureCode(error) });
    return result;
  } finally {
    await Promise.allSettled([discovery.close(), smoke.close()]);
  }
}
