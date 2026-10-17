import { mcpResource, type GatewayConfig } from '../config.ts';
import { checkDataDirPermissions } from '../dataDir.ts';
import { SCHEMA_VERSION, schemaVersion, type Database } from '../db/database.ts';
import { checkMintExecutable } from '../hosts/commandPreflight.ts';
import type { HostHealth, HostRegistry } from '../hosts/registry.ts';
import type { Logger } from '../log.ts';
import { probePublicUrl, type PublicUrlProbe } from '../oauth/metadata.ts';
import { SECOND, type Clock } from '../time.ts';
import { explainHostError, explainRenewalError, safeCode } from './explain.ts';
import { describeExposure, probeDashboardExposure } from './exposure.ts';

/**
 * The dashboard's manual checks, run only when the operator presses Run checks. They read and never change anything:
 * one fresh `t3_environment_read` per host (the same health check `fleet_status` and `doctor` use), the public URL's
 * resource metadata (as `doctor`), the database's quick check and schema version, the data directory's permissions and
 * the mint executable's resolution. No command is ever executed (not even an explicit `mintPairingCodeProbe`; doctor
 * runs that), nothing is enrolled or renewed, and results carry codes and fixed text only.
 */

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckItem {
  id: string;
  group: 'gateway' | 'host';
  hostId: string | null;
  name: string;
  level: CheckLevel;
  code: string;
  detail: string;
}

export interface CheckRun {
  startedAt: string;
  finishedAt: string;
  /** True when the answer is the previous run's, because it finished moments ago or is still running. */
  reused: boolean;
  results: CheckItem[];
}

/** A run that finished this recently is returned again rather than repeated (double clicks, several open tabs). */
export const CHECK_REUSE_MS = 5 * SECOND;
/**
 * Each host's check has this long in all. The health read's own timeout covers its call, but it may join a connection
 * that another caller (the engine, discovery) is still initializing with that caller's longer timeout.
 */
export const HOST_CHECK_DEADLINE_MS = 5 * SECOND;

export interface DashboardChecksOptions {
  config: GatewayConfig;
  db: Database;
  dataDir: string;
  registry: HostRegistry;
  clock: Clock;
  logger: Logger;
  commandEnv?: NodeJS.ProcessEnv;
  /** Overrides HOST_CHECK_DEADLINE_MS (tests). */
  hostDeadlineMs?: number;
}

function publicUrlCheck(probe: PublicUrlProbe): CheckItem {
  const base = { id: 'public_url', group: 'gateway' as const, hostId: null, name: 'Public MCP URL' };
  switch (probe.outcome) {
    case 'ok':
      return { ...base, level: 'ok', code: 'metadata_ok', detail: "The public URL serves this gateway's protected resource metadata, from this machine. The route a cloud connector takes is not tested." };
    case 'http_error':
      return { ...base, level: 'fail', code: 'http_error', detail: `The public URL answered HTTP ${probe.status}. Is the tunnel forwarding to the gateway's MCP listener?` };
    case 'wrong_resource':
      return { ...base, level: 'fail', code: 'wrong_resource', detail: 'The public URL names a different MCP resource than this gateway. Check publicUrl in the config.' };
    case 'different_server':
      return { ...base, level: 'fail', code: 'different_server', detail: "The public URL serves another server's metadata for this resource (another proxy in front of it?)." };
    case 'unreachable':
      return { ...base, level: 'fail', code: 'unreachable', detail: 'The public URL did not answer from this machine within five seconds. Is the tunnel up?' };
  }
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export class DashboardChecks {
  readonly #options: DashboardChecksOptions;
  #last: CheckRun | null = null;
  #running: Promise<CheckRun> | null = null;

  constructor(options: DashboardChecksOptions) {
    this.#options = options;
  }

  get last(): CheckRun | null {
    return this.#last;
  }

  /** Run every check, or join the run in progress, or return a run that finished within CHECK_REUSE_MS. Never throws. */
  run(): Promise<CheckRun> {
    if (this.#running) return this.#running.then((run) => ({ ...run, reused: true }));
    const last = this.#last;
    if (last && this.#options.clock() - Date.parse(last.finishedAt) < CHECK_REUSE_MS) return Promise.resolve({ ...last, reused: true });
    const running = this.#run().finally(() => {
      this.#running = null;
    });
    this.#running = running;
    return running;
  }

  async #run(): Promise<CheckRun> {
    const { config, db, dataDir, registry, clock, logger } = this.#options;
    const startedAt = new Date(clock()).toISOString();
    const results: CheckItem[] = [];
    const gateway = (id: string, name: string, level: CheckLevel, code: string, detail: string): CheckItem =>
      ({ id, group: 'gateway', hostId: null, name, level, code, detail });
    try {
      const integrity = (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
      const version = schemaVersion(db);
      results.push(integrity === 'ok' && version === SCHEMA_VERSION
        ? gateway('database', 'Database', 'ok', 'database_ok', `Quick integrity check passed; schema version ${version}.`)
        : gateway('database', 'Database', 'fail', 'database_problem', `Integrity or schema version is not as expected (schema ${version}, expected ${SCHEMA_VERSION}). Run doctor.`));
    } catch {
      results.push(gateway('database', 'Database', 'fail', 'database_error', 'The database could not be checked. Run doctor.'));
    }
    try {
      checkDataDirPermissions(dataDir);
      results.push(gateway('data_dir', 'Data directory', 'ok', 'data_dir_private', 'The data directory and its files are private to this user.'));
    } catch {
      results.push(gateway('data_dir', 'Data directory', 'fail', 'data_dir_insecure', 'The data directory or a file in it is readable by others. Run doctor for the path.'));
    }
    // The network checks, in parallel, each with a five-second deadline: the two probes through their fetch timeouts, each
    // host through #health. (The database and directory checks above are synchronous and have no deadline.)
    const publicUrl = probePublicUrl(config.publicUrl, mcpResource(config));
    const exposure = probeDashboardExposure(config.publicUrl, config.dashboard.basePath);
    const hosts = await Promise.all(config.hosts.map(async (host) => ({ host, health: await this.#health(host.id) })));
    results.push(publicUrlCheck(await publicUrl));
    const isolation = describeExposure(await exposure);
    results.push(gateway('dashboard_exposure', 'Dashboard stays private', isolation.level, isolation.code, isolation.detail));
    for (const { host, health } of hosts) {
      const item = (suffix: string, name: string, level: CheckLevel, code: string, detail: string): CheckItem =>
        ({ id: `host:${host.id}:${suffix}`, group: 'host', hostId: host.id, name, level, code, detail });
      const credential = registry.credentialStatus(host.id);
      if (credential.state === 'missing') {
        results.push(item('t3', 'T3 answers', 'fail', 'host_not_enrolled', explainHostError('host_not_enrolled')));
      } else if (health === null) {
        results.push(item('t3', 'T3 answers', 'fail', 't3_timeout', `${explainHostError('t3_timeout')} A late answer is shown on Hosts with its own time.`));
      } else if (health.credentialRejected) {
        results.push(item('t3', 'T3 answers', 'fail', 't3_unauthorized', explainHostError('t3_unauthorized')));
      } else if (health.reachable === true) {
        results.push(item('t3', 'T3 answers', 'ok', 'reachable', 'T3 answered an authenticated read with the stored credential.'));
      } else {
        const code = safeCode(health.error?.code ?? null) ?? 'host_unreachable';
        results.push(item('t3', 'T3 answers', 'fail', code, explainHostError(code)));
      }
      if (credential.state === 'expired') results.push(item('credential', 'Credential', 'fail', 'credential_expired', 'The stored T3 credential has expired. Enroll the host again.'));
      else if (credential.state === 'renewal_due') results.push(item('credential', 'Credential', 'warn', 'renewal_due', `The credential expires in ${credential.daysLeft} day(s); renewal is due and runs automatically.`));
      else if (credential.state === 'active') results.push(item('credential', 'Credential', 'ok', 'credential_active', `The credential is valid for ${credential.daysLeft} more day(s).`));
      if (credential.renewalError) {
        const code = safeCode(credential.renewalError.code);
        results.push(item('renewal', 'Last renewal', 'warn', code ?? 'renewal_failed', explainRenewalError(code)));
      }
      // Resolution only, in this process's environment; never executed.
      for (const check of checkMintExecutable(host, this.#options.commandEnv ?? process.env)) {
        results.push(item(`mint:${check.code}`, 'Renewal command', check.level, check.code, sentence(check.detail.replace(/^[a-z_]+: /, ''))));
      }
    }
    const run: CheckRun = { startedAt, finishedAt: new Date(clock()).toISOString(), reused: false, results };
    this.#last = run;
    const failed = results.filter((result) => result.level === 'fail').length;
    logger.info('dashboard.checks_run', { results: results.length, failed });
    return run;
  }

  /**
   * A fresh health read, or null when it has not settled by the deadline. The read itself is left to finish (it may share
   * its connection with other callers' calls, which a cancellation must not touch) and records its result as usual.
   */
  async #health(hostId: string): Promise<HostHealth | null> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, this.#options.hostDeadlineMs ?? HOST_CHECK_DEADLINE_MS, null);
    });
    try {
      return await Promise.race([this.#options.registry.health(hostId, { fresh: true }), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
