import { mcpResource, type GatewayConfig } from './config.ts';
import { openDataDir } from './dataDir.ts';
import { openDatabase, type Database } from './db/database.ts';
import { CredentialStore } from './hosts/credentials.ts';
import { HostRegistry, type HostRegistryOptions } from './hosts/registry.ts';
import { startRenewalLoop } from './hosts/renewal.ts';
import { createRouter, listen } from './http/server.ts';
import type { Logger } from './log.ts';
import { createMcpEndpoint } from './mcp/endpoint.ts';
import { fleetStatusTool } from './mcp/fleetStatus.ts';
import type { GatewayTool } from './mcp/tools.ts';
import { ApprovalCodes } from './oauth/approvalCodes.ts';
import { ClientStore } from './oauth/clients.ts';
import { logTokenEvent, oauthRoutes } from './oauth/routes.ts';
import { TokenService } from './oauth/tokens.ts';
import { MINUTE, systemClock, type Clock } from './time.ts';

/** Everything that shares the database: used by the server and by CLI commands. */
export interface GatewayServices {
  config: GatewayConfig;
  db: Database;
  key: Buffer;
  clock: Clock;
  logger: Logger;
  clients: ClientStore;
  approvals: ApprovalCodes;
  tokens: TokenService;
  registry: HostRegistry;
  close(): Promise<void>;
}

export interface ServiceOptions {
  config: GatewayConfig;
  dataDir: string;
  logger: Logger;
  clock?: Clock;
  runCommand?: HostRegistryOptions['runCommand'];
}

export function openServices(options: ServiceOptions): GatewayServices {
  const { config, logger } = options;
  const clock = options.clock ?? systemClock;
  const data = openDataDir(options.dataDir);
  const db = openDatabase(data.databasePath);
  const registry = new HostRegistry({
    hosts: config.hosts,
    store: new CredentialStore(db),
    clock,
    logger,
    renewWhenDaysLeft: config.renewal.renewWhenDaysLeft,
    ...(options.runCommand ? { runCommand: options.runCommand } : {}),
  });
  return {
    config,
    db,
    key: data.key,
    clock,
    logger,
    clients: new ClientStore(db, clock),
    approvals: new ApprovalCodes(db, data.key, clock),
    tokens: new TokenService(db, clock, { resource: mcpResource(config), ...config.tokens }, logTokenEvent(logger)),
    registry,
    async close() {
      await registry.close();
      db.close();
    },
  };
}

export function gatewayTools(services: GatewayServices): GatewayTool[] {
  return [fleetStatusTool(services)];
}

export interface RunningGateway {
  services: GatewayServices;
  port: number;
  close(): Promise<void>;
}

/** Start the HTTP server (OAuth + MCP) and the credential renewal loop. */
export async function startGateway(options: ServiceOptions & { tools?: (services: GatewayServices) => GatewayTool[] }): Promise<RunningGateway> {
  const services = openServices(options);
  const { config, logger } = services;
  const mcp = createMcpEndpoint({
    publicUrl: config.publicUrl,
    allowedOrigins: config.allowedOrigins,
    tokens: services.tokens,
    clients: services.clients,
    tools: (options.tools ?? gatewayTools)(services),
    logger,
  });
  const router = createRouter([...oauthRoutes({ ...services, publicUrl: config.publicUrl }), mcp.route], logger);
  let server;
  try {
    server = await listen(router, config.listen.host, config.listen.port);
  } catch (error) {
    await services.close();
    throw error;
  }
  const renewal = startRenewalLoop(services.registry, config.renewal.checkEveryMinutes * MINUTE, logger);
  logger.info('gateway.started', { listen: `${config.listen.host}:${server.port}`, publicUrl: config.publicUrl, hosts: config.hosts.length });
  return {
    services,
    port: server.port,
    async close() {
      logger.info('gateway.stopping');
      await server.close();
      await renewal.stop();
      await mcp.close();
      await services.close();
      logger.info('gateway.stopped');
    },
  };
}
