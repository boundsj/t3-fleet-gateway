import { constants, accessSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HostConfig } from '../config.ts';
import { runCommand, type CommandOptions } from '../t3/pairing.ts';

export const PROBE_TIMEOUT_MS = 2_000;
export const PROBE_MAX_BYTES = 4_096;

export interface CommandCheck {
  level: 'ok' | 'warn' | 'fail';
  code: string;
  detail: string;
}

/** No paths, argv, output or exception messages enter diagnostics. */
function check(level: CommandCheck['level'], code: string, detail: string): CommandCheck {
  return { level, code, detail: `${code}: ${detail}` };
}

/** Match execFile's Unix lookup: explicit paths use cwd, otherwise PATH (or the OS default). */
export function resolveCommand(file: string, env: NodeJS.ProcessEnv): { path: string | null; check: CommandCheck } {
  const paths = file.includes('/') ? [resolve(file)] : (env.PATH ?? '/usr/bin:/bin').split(':').map((dir) => resolve(dir || '.', file));
  let notExecutable = false;
  let unverified = false;
  for (const path of paths) {
    try {
      if (!statSync(path).isFile()) {
        notExecutable = true;
        continue;
      }
      accessSync(path, constants.X_OK);
      return { path, check: check('ok', 'executable_resolved', 'mint executable resolves and is executable in this process environment.') };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') notExecutable = true;
      else if (code !== 'ENOENT' && code !== 'ENOTDIR') unverified = true;
    }
  }
  const result = notExecutable
    ? check('fail', 'executable_not_executable',
      'mint executable is not executable in this process environment; check its permissions and service PATH.')
    : unverified
      ? check('warn', 'resolution_unverified', 'could not verify mint executable resolution in this process environment.')
      : check('fail', 'executable_missing',
        'mint executable was not found in this process environment; check the configured command and service PATH.');
  return { path: null, check: result };
}

function pinned(path: string): boolean {
  // Inspect the selected path, not its realpath: a stable symlink may intentionally follow updates.
  return /(?:^|\/)runtime\/versions\/[^/]+(?:\/|$)/.test(path);
}

export function checkMintExecutable(host: HostConfig, env: NodeJS.ProcessEnv): CommandCheck[] {
  const resolved = resolveCommand(host.mintPairingCode[0]!, env);
  const checks = [resolved.check];
  if (pinned(resolved.path ?? host.mintPairingCode[0]!)) {
    checks.push(check('warn', 'version_pinned_path',
      'mint executable selects a T3 runtime version directory; updates or cleanup can break renewal. Use a stable entrypoint.'));
  }
  return checks;
}

export interface PreflightOptions {
  env?: NodeJS.ProcessEnv;
  runCommand?: (argv: readonly string[], options?: CommandOptions) => Promise<string>;
  signal?: AbortSignal;
  serverVersion?: string | null;
  /** Shorter deadlines for synthetic timeout tests. */
  timeoutMs?: number;
}

/** Execute only the explicitly configured non-mutating probe, never the mint command or guessed --version. */
export async function preflightCommand(host: HostConfig, options: PreflightOptions = {}): Promise<CommandCheck[]> {
  const env = options.env ?? process.env;
  const checks = checkMintExecutable(host, env);
  if (options.signal?.aborted) return checks;
  const probe = host.mintPairingCodeProbe;
  if (!probe) {
    checks.push(check('warn', 'probe_unverified',
      'no non-mutating mintPairingCodeProbe configured; wrappers, remote commands and CLI version are unverified. Minting was not attempted.'));
    return checks;
  }
  const executable = resolveCommand(probe[0]!, env);
  if (executable.check.level !== 'ok') {
    checks.push(check(executable.check.level, 'probe_' + executable.check.code,
      'probe executable could not be resolved as executable in this process environment.'));
    return checks;
  }
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('probe aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    // Absolute resolution prevents a second lookup from selecting a different executable.
    const argv = [executable.path!, ...probe.slice(1)];
    const output = await Promise.race([
      (options.runCommand ?? runCommand)(argv, { env, signal, timeoutMs, maxBuffer: PROBE_MAX_BYTES }), aborted,
    ]);
    if (Buffer.byteLength(output) > PROBE_MAX_BYTES) {
      checks.push(check('fail', 'probe_output_limit', 'probe output exceeded the 4096-byte limit.'));
      return checks;
    }
    checks.push(check('ok', 'probe_succeeded', 'configured non-mutating probe exited successfully; minting was not attempted.'));
    // Optional bounded bare or JSON version. No raw output (including a parsed version) is returned.
    let version: unknown = output.trim();
    try {
      version = (JSON.parse(output) as { version?: unknown } | null)?.version;
    } catch {
      // A bare version can be compared too; exit success is useful even without a version.
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version) || version.length > 100) {
      checks.push(check('warn', 'version_unverified',
        'probe provided no recognized version; use a bare x.y.z or {"version":"x.y.z"} to compare with T3.'));
    } else if (!options.serverVersion) {
      checks.push(check('warn', 'version_unverified', 'T3 server version is unavailable for comparison.'));
    } else if (version !== options.serverVersion) {
      checks.push(check('warn', 'version_disagreement',
        'probe and T3 server versions differ; diagnostic only, not an incompatibility verdict.'));
    } else {
      checks.push(check('ok', 'version_matches', 'probe and T3 server versions agree.'));
    }
  } catch {
    if (!options.signal?.aborted) {
      checks.push(check('fail', signal.aborted ? 'probe_timeout' : 'probe_failed',
        signal.aborted ? 'configured non-mutating probe timed out.' : 'configured non-mutating probe failed; check it by hand.'));
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  return checks;
}
