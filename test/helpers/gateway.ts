import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { parseConfig } from '../../src/config.ts';
import { startGateway, type GatewayOptions, type GatewayServices, type RunningGateway } from '../../src/gateway.ts';
import { createLogger } from '../../src/log.ts';
import type { GatewayTool } from '../../src/mcp/tools.ts';
import { testClock, type TestClock } from './clock.ts';
import { openFrontDoor, type FrontDoor } from './frontDoor.ts';
import { tempDir } from './tmp.ts';

export interface TestGateway {
  baseUrl: string;
  gateway: RunningGateway;
  services: GatewayServices;
  clock: TestClock;
  logs: string[];
  dataDir: string;
  /** Holds the public URL's port; pass it to a second gateway to restart on the same URL. */
  door: FrontDoor;
  mintApprovalCode(): string;
}

/**
 * A full gateway behind a front door on a loopback port; publicUrl is the front door. Config fields
 * can be overridden.
 */
export async function startTestGateway(
  t: TestContext,
  options: {
    config?: Record<string, unknown>;
    tools?: (services: GatewayServices) => GatewayTool[];
    /** Reuse a data directory (restart tests). */
    dataDir?: string;
    /** Reuse a front door, so publicUrl and issued tokens stay valid across a restart. */
    door?: FrontDoor;
    clock?: TestClock;
    jobEngine?: GatewayOptions['jobEngine'];
  } = {},
): Promise<TestGateway> {
  const door = options.door ?? (await openFrontDoor(t));
  const baseUrl = door.url;
  const config = parseConfig({
    publicUrl: baseUrl,
    listen: { host: '127.0.0.1', port: door.port },
    hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9' }],
    ...options.config,
  });
  const dataDir = options.dataDir ?? join(tempDir(t), 'data');
  const clock = options.clock ?? testClock(Date.now());
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (line) => logs.push(line), clock });
  const started = await startGateway({
    config,
    dataDir,
    logger,
    clock,
    port: 0,
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.jobEngine ? { jobEngine: options.jobEngine } : {}),
  });
  door.target = started.port;
  const gateway: RunningGateway = {
    ...started,
    async close() {
      // Stop forwarding first: the port this gateway releases may be taken by another process.
      if (door.target === started.port) door.target = undefined;
      await started.close();
    },
  };
  t.after(() => gateway.close());
  return {
    baseUrl,
    gateway,
    services: gateway.services,
    clock,
    logs,
    dataDir,
    door,
    mintApprovalCode: () => gateway.services.approvals.mint().code,
  };
}

/** POST a JSON-RPC message to /mcp with the headers a typical client sends. */
export async function mcpPost(baseUrl: string, token: string | undefined, message: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(message),
  });
}

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '0' } },
};
