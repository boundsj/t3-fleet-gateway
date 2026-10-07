import { mcpResource, type GatewayConfig } from './config.ts';
import { openDataDir } from './dataDir.ts';
import { openDatabase, type Database } from './db/database.ts';
import { CredentialStore } from './hosts/credentials.ts';
import { HostRegistry, type HostRegistryOptions } from './hosts/registry.ts';
import { startRenewalLoop } from './hosts/renewal.ts';
import { createRouter, listen } from './http/server.ts';
import { JobEngine } from './jobs/engine.ts';
import { JobService } from './jobs/service.ts';
import { JobStore } from './jobs/store.ts';
import type { Logger } from './log.ts';
import { createMcpEndpoint } from './mcp/endpoint.ts';
import { fleetStatusTool } from './mcp/fleetStatus.ts';
import type { GatewayTool } from './mcp/tools.ts';
import { workTools } from './mcp/workTools.ts';
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
  jobs: JobService;
  close(): Promise<void>;
}

export interface ServiceOptions {
  config: GatewayConfig;
  dataDir: string;
  logger: Logger;
  clock?: Clock;
  runCommand?: HostRegistryOptions['runCommand'];
}

export interface Storage {
  db: Database;
  key: Buffer;
}

/** Open the data directory and database only: enough for commands that need no config. */
export function openStorage(dataDir: string): Storage {
  const data = openDataDir(dataDir);
  return { db: openDatabase(data.databasePath), key: data.key };
}

export function openServices(options: ServiceOptions): GatewayServices {
  const { config, logger } = options;
  const clock = options.clock ?? systemClock;
  const { db, key } = openStorage(options.dataDir);
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
    key,
    clock,
    logger,
    clients: new ClientStore(db, clock),
    approvals: new ApprovalCodes(db, key, clock),
    tokens: new TokenService(db, clock, { resource: mcpResource(config), ...config.tokens }, logTokenEvent(logger)),
    registry,
    jobs: new JobService({ config, store: new JobStore(db, clock, logger), registry, clock, logger }),
    async close() {
      await registry.close();
      db.close();
    },
  };
}

export function gatewayTools(services: GatewayServices): GatewayTool[] {
  return [fleetStatusTool(services), ...workTools(services.jobs)];
}

export interface RunningGateway {
  services: GatewayServices;
  /** The dispatcher and watcher. */
  engine: JobEngine;
  port: number;
  close(): Promise<void>;
}

export interface GatewayOptions extends ServiceOptions {
  tools?: (services: GatewayServices) => GatewayTool[];
  /** Tests drive the job engine by hand (`autoStart: false`) or with a short interval. */
  jobEngine?: { autoStart?: boolean; intervalMs?: number };
  /** Listen on this port instead of `config.listen.port`; 0 lets the OS pick one (tests). */
  port?: number;
}

/** Start the HTTP server (OAuth + MCP), the job engine and the credential renewal loop. */
export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
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
    server = await listen(router, config.listen.host, options.port ?? config.listen.port);
  } catch (error) {
    await services.close();
    throw error;
  }
  for (const host of config.hosts) {
    if (services.registry.credentialStatus(host.id).state === 'missing') logger.warn('host.not_enrolled', { hostId: host.id });
  }
  const renewal = startRenewalLoop(services.registry, config.renewal.checkEveryMinutes * MINUTE, logger);
  const engine = new JobEngine({
    config,
    store: services.jobs.store,
    registry: services.registry,
    clock: services.clock,
    logger,
    ...(options.jobEngine?.intervalMs === undefined ? {} : { intervalMs: options.jobEngine.intervalMs }),
  });
  services.jobs.wake = () => engine.wake();
  if (options.jobEngine?.autoStart !== false) engine.start();
  logger.info('gateway.started', { listen: `${config.listen.host}:${server.port}`, publicUrl: config.publicUrl, hosts: config.hosts.length });
  let closing: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    logger.info('gateway.stopping');
    await server.close();
    // The engine finishes its current tick; job state is already in the database.
    await engine.stop();
    await renewal.stop();
    await mcp.close();
    await services.close();
    logger.info('gateway.stopped');
  };
  return {
    services,
    engine,
    port: server.port,
    close: () => (closing ??= shutdown()),
  };
}
