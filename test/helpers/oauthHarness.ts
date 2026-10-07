import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { openDataDir } from '../../src/dataDir.ts';
import { openDatabase, type Database } from '../../src/db/database.ts';
import { createRouter, listen } from '../../src/http/server.ts';
import { createLogger } from '../../src/log.ts';
import { ApprovalCodes } from '../../src/oauth/approvalCodes.ts';
import { ClientStore } from '../../src/oauth/clients.ts';
import { logTokenEvent, oauthRoutes } from '../../src/oauth/routes.ts';
import { TokenService } from '../../src/oauth/tokens.ts';
import { testClock, type TestClock } from './clock.ts';
import { tempDir } from './tmp.ts';

export interface OAuthHarness {
  baseUrl: string;
  resource: string;
  db: Database;
  clock: TestClock;
  logs: string[];
  clients: ClientStore;
  approvals: ApprovalCodes;
  tokens: TokenService;
}

/** The OAuth routes alone, on a loopback port, with a controllable clock and captured logs. */
export async function startOAuthHarness(t: TestContext, settings = { accessTtlSeconds: 3600, refreshIdleTtlDays: 30 }): Promise<OAuthHarness> {
  const data = openDataDir(join(tempDir(t), 'data'));
  const db = openDatabase(data.databasePath);
  const clock = testClock();
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (line) => logs.push(line), clock });
  let route: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) | undefined;
  const server = await listen((req, res) => route?.(req, res), '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const resource = `${baseUrl}/mcp`;
  const clients = new ClientStore(db, clock);
  const approvals = new ApprovalCodes(db, data.key, clock);
  const tokens = new TokenService(db, clock, { resource, ...settings }, logTokenEvent(logger));
  route = createRouter(oauthRoutes({ publicUrl: baseUrl, key: data.key, clock, logger, clients, approvals, tokens }), logger);
  t.after(async () => {
    await server.close(100);
    db.close();
  });
  return { baseUrl, resource, db, clock, logs, clients, approvals, tokens };
}
