import { parseArgs } from 'node:util';
import { loadConfig, resolvePaths, type GatewayConfig, type Paths } from '../config.ts';
import { describeError, GatewayError, isGatewayError } from '../errors.ts';
import { openServices, openStorage, startGateway, type GatewayServices } from '../gateway.ts';
import { MAX_TITLE_CHARS } from '../jobs/service.ts';
import { TERMINAL_STATES } from '../jobs/states.ts';
import type { Job } from '../jobs/store.ts';
import { createLogger, isLogLevel, silentLogger, type Logger } from '../log.ts';
import { ApprovalCodes, DEFAULT_APPROVAL_CODE_TTL, MAX_APPROVAL_CODE_TTL, MAX_FAILURES_PER_HOUR } from '../oauth/approvalCodes.ts';
import { ClientStore, MAX_REGISTRATIONS_PER_HOUR } from '../oauth/clients.ts';
import { OPERATE_SCOPE, READ_SCOPE } from '../oauth/scopes.ts';
import { FATAL_SHUTDOWN_MS, guardProcess } from '../processErrors.ts';
import { MINUTE, parseDuration, systemClock } from '../time.ts';
import { GATEWAY_NAME, GATEWAY_VERSION } from '../version.ts';
import { runDoctor } from './doctor.ts';
import { relative, shortTime, table } from './format.ts';

export interface CliIo {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Resolves when the process is asked to stop (serve only). Receives the port the gateway listens on. */
  waitForShutdown?: (gateway: { port: number }) => Promise<void>;
  /** Listen on this port instead of the configured one; 0 lets the OS pick (tests). */
  listenPort?: number;
}

const USAGE = `Usage: ${GATEWAY_NAME} <command> [options]

Commands:
  serve                     Run the gateway (HTTP server and credential renewal)
  pair [--ttl 15m]          Mint a one-time approval code for connecting an agent
  clients list              List registered agent clients
  clients revoke <id>       Revoke a client and every token issued to it
  hosts enroll <id>         Obtain a T3 credential for a host via pairing-code approval
  hosts status              Show each host's credential and reachability
  throttle status           Show failed approvals and registrations counting toward their limits
  throttle reset            Clear the approval and registration throttles
  jobs adopt <project> <threadId> [--title <text>]
                            Register an existing T3 thread as a standing job agents can drive
  jobs list [--all]         List open jobs (--all: finished ones too)
  jobs release <jobId>      Stop following a standing job; the T3 thread is left as it is
  doctor                    Check config, permissions, database, hosts and public URL

Options:
  --config <path>           Config file (default: $T3FG_CONFIG or ~/.config/t3-fleet-gateway/config.json)
  --data-dir <path>         Data directory (default: $T3FG_DATA_DIR or ~/.local/share/t3-fleet-gateway)
  -h, --help                Show this help
  -v, --version             Show the version`;

class UsageError extends Error {}

function logLevelLogger(env: NodeJS.ProcessEnv, sink: (line: string) => void, fallback: 'info' | 'off'): Logger {
  const level = env.T3FG_LOG_LEVEL;
  if (level && isLogLevel(level)) return createLogger({ level, sink });
  return fallback === 'info' ? createLogger({ level: 'info', sink }) : silentLogger;
}

function withServices<T>(paths: Paths, logger: Logger, fn: (services: GatewayServices, config: GatewayConfig) => Promise<T>): Promise<T> {
  const config = loadConfig(paths.configPath);
  const services = openServices({ config, dataDir: paths.dataDir, logger });
  return fn(services, config).finally(() => services.close());
}

async function serve(paths: Paths, io: CliIo): Promise<number> {
  const logger = logLevelLogger(io.env, (line) => io.out(line), 'info');
  const config = loadConfig(paths.configPath);
  const guard = guardProcess(logger);
  try {
    const gateway = await startGateway({ config, dataDir: paths.dataDir, logger, ...(io.listenPort === undefined ? {} : { port: io.listenPort }) });
    const fatal = await Promise.race([(io.waitForShutdown ?? waitForSignal)(gateway).then(() => false), guard.fatal.then(() => true)]);
    if (!fatal) {
      await gateway.close();
      return 0;
    }
    // The process may be in a broken state: try to stop cleanly, but not for long. Job state is in the database.
    const timer = Promise.withResolvers<boolean>();
    const timeout = setTimeout(() => timer.resolve(false), FATAL_SHUTDOWN_MS);
    const closed = await Promise.race([gateway.close().then(() => true), timer.promise]);
    clearTimeout(timeout);
    if (!closed) logger.error('gateway.shutdown_timeout');
    return 1;
  } finally {
    guard.remove();
  }
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

function pair(paths: Paths, io: CliIo, ttlText: string | undefined): number {
  const ttl = ttlText === undefined ? DEFAULT_APPROVAL_CODE_TTL : parseDuration(ttlText);
  if (ttl === undefined || ttl < MINUTE || ttl > MAX_APPROVAL_CODE_TTL) throw new UsageError('--ttl must be a duration from 1m to 24h, for example 15m');
  const storage = openStorage(paths.dataDir);
  try {
    const { code, expiresAt, clearedLock } = new ApprovalCodes(storage.db, storage.key, systemClock).mint(ttl);
    if (clearedLock) {
      io.out(`Approvals were paused after ${MAX_FAILURES_PER_HOUR} failed attempts within an hour; minting this code lifted the pause.`);
    }
    io.out(`Approval code: ${code}`);
    io.out(`Expires ${shortTime(expiresAt)} (${relative(expiresAt - Date.now())}). It works once.`);
    io.out('Enter it on the approval page your agent opens, then choose Read or Operate.');
    return 0;
  } finally {
    storage.db.close();
  }
}

function clients(paths: Paths, io: CliIo, action: string | undefined, id: string | undefined): number {
  const storage = openStorage(paths.dataDir);
  try {
    const store = new ClientStore(storage.db, systemClock);
    if (action === 'list') {
      const list = store.list();
      if (list.length === 0) {
        io.out('No clients registered.');
        return 0;
      }
      const rows = list.map((client) => {
        const access = client.scopes.includes(OPERATE_SCOPE) ? 'operate' : client.scopes.includes(READ_SCOPE) ? 'read' : '-';
        const status = client.revokedAt !== null ? 'revoked' : client.activeFamilies > 0 ? 'active' : 'pending';
        const origins = [...new Set(client.redirectUris.map((uri) => new URL(uri).origin))].join(' ');
        return [client.id, client.name, access, status, shortTime(client.createdAt), shortTime(client.lastUsedAt), origins];
      });
      io.out(table(['ID', 'NAME', 'ACCESS', 'STATUS', 'CREATED', 'LAST USED', 'REDIRECTS TO'], rows));
      return 0;
    }
    if (action === 'revoke') {
      if (!id) throw new UsageError('clients revoke needs a client id (see clients list)');
      const result = store.revoke(id);
      if (!result) throw new GatewayError('not_found', `No client with id ${id}`);
      io.out(`Revoked client ${id} and ${result.families} active grant(s). Its tokens no longer work.`);
      return 0;
    }
    throw new UsageError('Use: clients list | clients revoke <id>');
  } finally {
    storage.db.close();
  }
}

function throttle(paths: Paths, io: CliIo, action: string | undefined): number {
  const storage = openStorage(paths.dataDir);
  try {
    const approvals = new ApprovalCodes(storage.db, storage.key, systemClock);
    const store = new ClientStore(storage.db, systemClock);
    if (action === 'status') {
      const failures = approvals.globalFailures();
      const registrations = store.registrationsCounted();
      const state = (count: number, limit: number) => (count >= limit ? 'LIMIT REACHED' : 'ok');
      io.out(`approvals:     ${failures}/${MAX_FAILURES_PER_HOUR} failed attempts in the last hour (${state(failures, MAX_FAILURES_PER_HOUR)})`);
      io.out(`registrations: ${registrations}/${MAX_REGISTRATIONS_PER_HOUR} counted in the last hour (${state(registrations, MAX_REGISTRATIONS_PER_HOUR)})`);
      return 0;
    }
    if (action === 'reset') {
      approvals.resetThrottles();
      store.resetRegistrationLimit();
      io.out('Cleared the failed approval attempts (locked approval pages included) and the registration limit.');
      return 0;
    }
    throw new UsageError('Use: throttle status | throttle reset');
  } finally {
    storage.db.close();
  }
}

async function hosts(paths: Paths, io: CliIo, action: string | undefined, id: string | undefined): Promise<number> {
  const logger = logLevelLogger(io.env, (line) => io.err(line), 'off');
  if (action === 'enroll') {
    if (!id) throw new UsageError('hosts enroll needs a host id from the config');
    return withServices(paths, logger, async ({ registry }) => {
      const host = registry.host(id);
      io.out(`Enrolling host ${id} at ${host.t3Url} with T3 access "${host.access}"; running: ${host.mintPairingCode.join(' ')}`);
      const result = await registry.enroll(id);
      io.out(`Enrolled ${id}: T3 ${result.t3Version}, credential expires ${shortTime(result.expiresAt)} (${relative(result.expiresAt - Date.now())}).`);
      return 0;
    });
  }
  if (action === 'status') {
    return withServices(paths, logger, async ({ registry }, config) => {
      for (const host of config.hosts) {
        const credential = registry.credentialStatus(host.id);
        const health = await registry.health(host.id, { fresh: true });
        io.out(`${host.id}${host.label ? ` (${host.label})` : ''}  ${host.t3Url}`);
        const reach = health.credentialRejected
          ? 'yes'
          : health.reachable
            ? `yes, T3 ${health.t3Version}`
            : `no (${health.error?.code}: ${health.error?.message})`;
        io.out(`  reachable:  ${reach}`);
        const expiry = credential.expiresAt === null ? '' : `, expires ${shortTime(credential.expiresAt)} (${relative(credential.expiresAt - Date.now())})`;
        io.out(`  credential: ${health.credentialRejected ? 'rejected by T3' : credential.state}${expiry}`);
        if (health.credentialRejected) io.out(`  error:      ${health.error?.code}: ${health.error?.message}`);
        if (credential.renewalError) {
          io.out(`  renewal:    failed ${shortTime(credential.renewalError.at)}: ${credential.renewalError.code}: ${credential.renewalError.message}`);
        }
      }
      return 0;
    });
  }
  throw new UsageError('Use: hosts enroll <id> | hosts status');
}

function describeJobLine(job: Job): string {
  return `${job.id}  ${job.projectAlias}  ${job.state}${job.standing ? '  standing' : ''}  ${job.title}${job.threadLink ? `  ${job.threadLink}` : ''}`;
}

const MAX_LISTED_JOBS = 1000;

interface JobsOptions {
  title?: string | undefined;
  all?: boolean | undefined;
}

async function jobs(paths: Paths, io: CliIo, action: string | undefined, args: string[], options: JobsOptions): Promise<number> {
  const logger = logLevelLogger(io.env, (line) => io.err(line), 'off');
  if (action === 'adopt') {
    const [project, threadId, ...extra] = args;
    if (!project || !threadId) throw new UsageError('jobs adopt needs a project alias and a T3 thread id');
    if (extra.length > 0) throw new UsageError(`Unexpected arguments: ${extra.join(' ')}`);
    const title = options.title?.trim();
    if (options.title !== undefined && (!title || title.length > MAX_TITLE_CHARS)) throw new UsageError(`--title must be 1 to ${MAX_TITLE_CHARS} characters`);
    return withServices(paths, logger, async (services) => {
      const { job, created } = await services.jobs.adopt({ project, threadId, title });
      io.out(created ? `Adopted thread ${job.threadId} as standing job ${job.id}.` : `Thread ${job.threadId} is already standing job ${job.id}.`);
      io.out(describeJobLine(job));
      io.out(`Agents send it work with work_continue and follow it with work_feed and work_status. Stop following it with: jobs release ${job.id}`);
      return 0;
    });
  }
  if (action === 'list') {
    if (args.length > 0) throw new UsageError(`Unexpected arguments: ${args.join(' ')}`);
    return withServices(paths, logger, async (services) => {
      const all = services.jobs.store.list({ limit: MAX_LISTED_JOBS });
      const shown = options.all ? all : all.filter((job) => !TERMINAL_STATES.includes(job.state));
      if (shown.length === 0) {
        io.out(options.all ? 'No jobs.' : 'No open jobs. (--all shows finished ones too.)');
        return 0;
      }
      const rows = shown.map((job) => [job.id, job.projectAlias, job.state, job.standing ? 'yes' : '-', job.title, job.threadLink ?? '-']);
      io.out(table(['ID', 'PROJECT', 'STATE', 'STANDING', 'TITLE', 'LINK'], rows));
      return 0;
    });
  }
  if (action === 'release') {
    const [jobId, ...extra] = args;
    if (!jobId) throw new UsageError('jobs release needs a job id (see jobs list)');
    if (extra.length > 0) throw new UsageError(`Unexpected arguments: ${extra.join(' ')}`);
    return withServices(paths, logger, async (services) => {
      const { job, released } = services.jobs.release(jobId);
      io.out(
        released
          ? `Released standing job ${job.id}; agents can no longer send it work. The T3 thread was not touched.`
          : `Job ${job.id} is already ${job.state}.`,
      );
      return 0;
    });
  }
  throw new UsageError('Use: jobs adopt <project> <threadId> [--title <text>] | jobs list [--all] | jobs release <jobId>');
}

async function doctor(paths: Paths, io: CliIo): Promise<number> {
  let config: GatewayConfig;
  try {
    config = loadConfig(paths.configPath);
  } catch (error) {
    io.out(`FAIL  config: ${describeError(error).message}`);
    return 1;
  }
  io.out(`config: ${paths.configPath}`);
  const services = openServices({ config, dataDir: paths.dataDir, logger: logLevelLogger(io.env, (line) => io.err(line), 'off') });
  try {
    const results = await runDoctor(services, paths.dataDir);
    for (const result of results) io.out(`${result.level.toUpperCase().padEnd(4)}  ${result.name}: ${result.detail}`);
    return results.some((result) => result.level === 'fail') ? 1 : 0;
  } finally {
    await services.close();
  }
}

/** Run the CLI and return the exit code: 0 success, 1 failure, 2 usage error. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'data-dir': { type: 'string' },
        ttl: { type: 'string' },
        title: { type: 'string' },
        all: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    if (values.version) {
      io.out(GATEWAY_VERSION);
      return 0;
    }
    const [command, action, ...args] = positionals;
    const id = args[0];
    if (values.help || command === undefined) {
      io.out(USAGE);
      return values.help ? 0 : 2;
    }
    // `jobs` checks its own arguments: `jobs adopt` takes two.
    if (command !== 'jobs' && args.length > 1) throw new UsageError(`Unexpected arguments: ${args.slice(1).join(' ')}`);
    // Each of these options belongs to one command; anywhere else it would be ignored silently.
    const optionCommands = [
      ['ttl', values.ttl, 'pair', command === 'pair'],
      ['title', values.title, 'jobs adopt', command === 'jobs' && action === 'adopt'],
      ['all', values.all, 'jobs list', command === 'jobs' && action === 'list'],
    ] as const;
    for (const [option, value, owner, allowed] of optionCommands) {
      if (value !== undefined && !allowed) throw new UsageError(`--${option} is only for ${owner}`);
    }
    const paths = resolvePaths(io.env, {
      ...(values.config ? { configPath: values.config } : {}),
      ...(values['data-dir'] ? { dataDir: values['data-dir'] } : {}),
    });
    switch (command) {
      case 'serve':
        return await serve(paths, io);
      case 'pair':
        return pair(paths, io, values.ttl);
      case 'clients':
        return clients(paths, io, action, id);
      case 'hosts':
        return await hosts(paths, io, action, id);
      case 'throttle':
        if (id !== undefined) throw new UsageError(`Unexpected arguments: ${id}`);
        return throttle(paths, io, action);
      case 'jobs':
        return await jobs(paths, io, action, args, { title: values.title, all: values.all });
      case 'doctor':
        return await doctor(paths, io);
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.err(`error: ${(error as Error).message}\nRun ${GATEWAY_NAME} --help for usage.`);
      return 2;
    }
    if (isGatewayError(error)) {
      io.err(`error (${error.code}): ${error.message}`);
      return 1;
    }
    io.err(`error: unexpected ${(error as Error).name ?? 'failure'}: ${(error as Error).message ?? ''}`);
    return 1;
  }
}
