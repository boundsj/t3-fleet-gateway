/** Developer-only, on-demand MCP contract and read-only smoke check. See docs/operations.md. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { loadConfig, resolvePaths } from '../src/config.ts';
import { checkDataDirPermissions, DATABASE_FILE } from '../src/dataDir.ts';
import { GatewayError } from '../src/errors.ts';
import { CredentialStore } from '../src/hosts/credentials.ts';
import { compareContracts, type Contract } from './lib/t3-contract.ts';
import { probeHost, ProbeError, type ProbeCheck } from './lib/t3-probe.ts';

const HELP = `Usage: node scripts/check-t3-compatibility.ts [options]

Compare T3's advertised MCP schemas and exercise existing gateway read parsers.
Only local developer reports are written; no T3 work or gateway records are changed.

  --config <path>       Gateway config (also T3FG_CONFIG)
  --data-dir <path>     Existing gateway credential database (also T3FG_DATA_DIR)
  --state-dir <path>    Private developer baseline/report directory
                       (also T3FG_COMPAT_STATE_DIR; default ~/.local/state/t3-fleet-gateway-compatibility)
  --host <id>          Check one configured host (default: all)
  --accept             Accept the observed schemas after successful checks; use after reviewing drift
  --json               Print a JSON report for future automation
  --help               Show help

Exit codes: 0 PASS, 1 FAIL, 2 WARN (review needed), 3 invocation/state error.
No scheduler is installed. Every invocation performs fresh discovery and sampled reads.`;

type Status = 'PASS' | 'WARN' | 'FAIL';
export interface HostReport {
  host: string;
  serverVersion: string | null;
  previousVersion: string | null;
  versionChanged: boolean;
  status: Status;
  changedSinceLastCheck: boolean;
  baseline: 'missing' | 'retained' | 'accepted';
  changes: ReturnType<typeof compareContracts>;
  outputSchemas: number;
  checks: ProbeCheck[];
}
export interface CompatibilityReport {
  formatVersion: 1;
  checkedAt: string;
  status: Status;
  hosts: HostReport[];
}

const contractSchema = z.record(z.string(), z.object({
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
}));
const hostStateSchema = z.object({
  baseline: contractSchema.nullable(),
  baselineVersion: z.string().nullable(),
  lastVersion: z.string().nullable(),
  lastFingerprint: z.string(),
});
const stateSchema = z.object({
  formatVersion: z.literal(1),
  hosts: z.record(z.string(), hostStateSchema),
  // Report contents are never used as input to future probes or printed by the tool.
  lastReport: z.unknown().optional(),
});
type State = z.infer<typeof stateSchema>;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function ensurePrivate(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new ProbeError('state_permissions');
  }
}

function readState(path: string): State {
  try {
    ensurePrivate(path, false);
    return stateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { formatVersion: 1, hosts: {} };
    throw new ProbeError(error instanceof ProbeError ? error.code : 'invalid_state');
  }
}

function writeState(path: string, state: State): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function statusOf(checks: ProbeCheck[], reviewNeeded: boolean): Status {
  return checks.some((check) => check.status === 'fail') ? 'FAIL'
    : reviewNeeded || checks.some((check) => check.status === 'warn') ? 'WARN' : 'PASS';
}

function summary(report: CompatibilityReport): string {
  const lines = [`${report.status} T3 compatibility — ${report.checkedAt}`];
  for (const host of report.hosts) {
    lines.push(`${host.status} ${host.host}: T3 ${host.serverVersion ?? 'unknown'}; baseline ${host.baseline}; ` +
      `${host.changedSinceLastCheck ? 'new observation' : 'unchanged'}${host.versionChanged ? ' (version changed)' : ''}`);
    for (const change of host.changes) lines.push(`  ${change.kind} ${change.tool}: ${change.paths.join(', ')}`);
    for (const check of host.checks) lines.push(`  ${check.status.toUpperCase()} ${check.tool}: ${check.code}`);
    lines.push(`  Output schemas advertised for ${host.outputSchemas}/11 consumed tools; unadvertised schemas remain unverified.`);
  }
  lines.push('Read coverage is sampled. Launch/send/respond/interrupt inputs are checked locally; their behavior is not exercised.');
  if (report.hosts.some((host) => host.baseline === 'missing' || host.changes.length > 0 && host.baseline !== 'accepted')) {
    lines.push('Review the differences, then rerun with --accept to update the baseline after checks pass.');
  }
  return lines.join('\n');
}

export async function runCompatibilityCheck(argv: string[], io: {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
}): Promise<number> {
  let json = argv.includes('--json');
  let db: DatabaseSync | undefined;
  let lock: string | undefined;
  try {
    let args;
    try {
      args = parseArgs({ args: argv, strict: true, options: {
        config: { type: 'string' }, 'data-dir': { type: 'string' }, 'state-dir': { type: 'string' },
        host: { type: 'string' }, accept: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' },
      } }).values;
    } catch { throw new ProbeError('invalid_arguments'); }
    json = args.json ?? false;
    if (args.help) { io.out(HELP); return 0; }
    const paths = resolvePaths(io.env, {
      ...(args.config ? { configPath: args.config } : {}), ...(args['data-dir'] ? { dataDir: args['data-dir'] } : {}),
    });
    const config = loadConfig(paths.configPath);
    const hosts = config.hosts.filter((host) => args.host === undefined || host.id === args.host);
    if (hosts.length === 0) throw new ProbeError('unknown_host');
    checkDataDirPermissions(paths.dataDir);
    // Deliberately bypass openServices/openDatabase: even a newer developer checkout must never migrate the running gateway.
    db = new DatabaseSync(join(paths.dataDir, DATABASE_FILE), { readOnly: true, timeout: 5_000 });
    const credentials = new CredentialStore(db);
    const stateDir = resolve(args['state-dir'] ?? io.env.T3FG_COMPAT_STATE_DIR ??
      join(homedir(), '.local', 'state', 't3-fleet-gateway-compatibility'));
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    ensurePrivate(stateDir, true);
    const lockPath = join(stateDir, 'check.lock');
    try { mkdirSync(lockPath, { mode: 0o700 }); }
    catch { throw new ProbeError('check_in_progress'); }
    lock = lockPath;
    const statePath = join(stateDir, 'state.json');
    const state = readState(statePath);
    const report: CompatibilityReport = { formatVersion: 1, checkedAt: new Date().toISOString(), status: 'PASS', hosts: [] };
    for (const host of hosts) {
      // Host ids can be reused against different installations; never compare those baselines accidentally.
      const key = digest({ host: host.id, url: host.t3Url });
      const previous = state.hosts[key];
      const probe = await probeHost({ hostId: host.id, t3Url: host.t3Url, token: () => credentials.get(host.id)?.accessToken });
      const changes = previous?.baseline && probe.contract ? compareContracts(previous.baseline, probe.contract) : [];
      const canAccept = probe.contract !== null && probe.serverVersion !== null &&
        !probe.checks.some((check) => check.status === 'fail' || check.status === 'warn');
      const accepted = args.accept === true && canAccept;
      const baseline: Contract | null = accepted ? probe.contract : previous?.baseline ?? null;
      const status = statusOf(probe.checks, !accepted && (baseline === null || changes.length > 0));
      const fingerprint = digest({
        version: probe.serverVersion, contract: probe.contract, status,
        // Coverage can vary as threads/questions come and go; only problems affect change detection.
        problems: probe.checks.filter((check) => check.status === 'fail' || check.status === 'warn'),
      });
      report.hosts.push({
        host: host.id, serverVersion: probe.serverVersion, previousVersion: previous?.lastVersion ?? null,
        versionChanged: previous?.lastVersion != null && probe.serverVersion != null && previous.lastVersion !== probe.serverVersion,
        status, changedSinceLastCheck: previous?.lastFingerprint !== fingerprint,
        baseline: accepted ? 'accepted' : baseline === null ? 'missing' : 'retained',
        changes, outputSchemas: probe.outputSchemas, checks: probe.checks,
      });
      state.hosts[key] = {
        baseline, baselineVersion: accepted ? probe.serverVersion : previous?.baselineVersion ?? null,
        lastVersion: probe.serverVersion ?? previous?.lastVersion ?? null, lastFingerprint: fingerprint,
      };
    }
    report.status = report.hosts.some((host) => host.status === 'FAIL') ? 'FAIL'
      : report.hosts.some((host) => host.status === 'WARN') ? 'WARN' : 'PASS';
    state.lastReport = report;
    writeState(statePath, state);
    io.out(json ? JSON.stringify(report) : summary(report));
    return report.status === 'FAIL' ? 1 : report.status === 'WARN' ? 2 : 0;
  } catch (error) {
    // Never print raw config, SQL, MCP, schema-validation or filesystem exceptions.
    const code = error instanceof ProbeError || error instanceof GatewayError ? error.code : 'check_unavailable';
    if (json) io.out(JSON.stringify({ formatVersion: 1, status: 'FAIL', error: code, hosts: [] }));
    else io.err(`FAIL T3 compatibility: ${code}`);
    return 3;
  } finally {
    db?.close();
    if (lock) rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runCompatibilityCheck(process.argv.slice(2), {
    env: process.env, out: (line) => process.stdout.write(line + '\n'), err: (line) => process.stderr.write(line + '\n'),
  });
}
