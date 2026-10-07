import { createServer } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { parseConfig } from '../../src/config.ts';
import { startGateway, type GatewayServices, type RunningGateway } from '../../src/gateway.ts';
import { createLogger } from '../../src/log.ts';
import type { GatewayTool } from '../../src/mcp/tools.ts';
import { testClock, type TestClock } from './clock.ts';
import { tempDir } from './tmp.ts';

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface TestGateway {
  baseUrl: string;
  gateway: RunningGateway;
  services: GatewayServices;
  clock: TestClock;
  logs: string[];
  dataDir: string;
  mintApprovalCode(): string;
}

/** A full gateway on a loopback port whose publicUrl is that port. Config fields can be overridden. */
export async function startTestGateway(
  t: TestContext,
  options: { config?: Record<string, unknown>; tools?: (services: GatewayServices) => GatewayTool[] } = {},
): Promise<TestGateway> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = parseConfig({
    publicUrl: baseUrl,
    listen: { host: '127.0.0.1', port },
    hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9' }],
    ...options.config,
  });
  const dataDir = join(tempDir(t), 'data');
  const clock = testClock(Date.now());
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (line) => logs.push(line), clock });
  const gateway = await startGateway({ config, dataDir, logger, clock, ...(options.tools ? { tools: options.tools } : {}) });
  t.after(() => gateway.close());
  return {
    baseUrl,
    gateway,
    services: gateway.services,
    clock,
    logs,
    dataDir,
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
