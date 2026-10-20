import { spawn } from 'node:child_process';
import * as z from 'zod';
import { sha256Hex } from '../crypto.ts';
import { GatewayError } from '../errors.ts';
import { SECOND } from '../time.ts';

/**
 * Where a named project's work runs, as an agent may ask for it (`work_start.workspace`):
 * `auto` lets the operator's probe decide (a Git repository root gets a fresh worktree from the freshly fetched remote
 * base, anything else runs in the folder itself), `root` runs in the project's own folder, and `worktree` insists on a
 * fresh worktree (`baseRef` defaults to the project's configured baseRef, `startFromOrigin` to true).
 */
export const workspaceSelectionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('auto') }),
  z.strictObject({ type: z.literal('root') }),
  z.strictObject({
    type: z.literal('worktree'),
    baseRef: z.string().min(1).max(200).optional(),
    startFromOrigin: z.boolean().optional(),
  }),
]);
export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;

/**
 * What a job asked for, recorded with its launch spec (the only place the intent lives): the selection with the
 * project's configured default base ref filled in at acceptance, so a later config change cannot move the job. The
 * folder it resolves to is not part of it: that is read from the host at dispatch (`ResolvedWorkspace`).
 */
export const workspaceIntentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('auto'), baseRef: z.string().min(1) }),
  z.strictObject({ type: z.literal('root') }),
  z.strictObject({ type: z.literal('worktree'), baseRef: z.string().min(1), startFromOrigin: z.boolean() }),
]);
export type WorkspaceIntent = z.infer<typeof workspaceIntentSchema>;

export function workspaceIntent(selection: WorkspaceSelection | undefined, defaultBaseRef: string): WorkspaceIntent {
  if (selection?.type === 'root') return { type: 'root' };
  if (selection?.type === 'worktree') {
    return { type: 'worktree', baseRef: selection.baseRef ?? defaultBaseRef, startFromOrigin: selection.startFromOrigin ?? true };
  }
  return { type: 'auto', baseRef: defaultBaseRef };
}

/** What the probe reports about a project's folder: a Git repository root, or any other folder (including a subdirectory of a repository). */
export const inspectionSchema = z.strictObject({
  kind: z.enum(['git', 'root']),
  /** The folder's canonical absolute path on its host. */
  root: z.string().startsWith('/').max(4096).refine((root) => !root.includes('\0')),
});
export type WorkspaceInspection = z.infer<typeof inspectionSchema>;

/** What the dispatcher launches into, decided from the intent and the inspection. */
export type ResolvedWorkspace =
  | { kind: 'root'; rootKey: string }
  | { kind: 'worktree'; baseRef: string; startFromOrigin: boolean };

/** The key two jobs share when they run in the same folder of the same host, however their projects or aliases name it. Holds no path. */
export function rootKey(hostId: string, root: string): string {
  return sha256Hex(`${hostId}\0${root}`);
}

/** The probe's one JSON input object. */
export interface ProbeRequest {
  root: string;
  baseRef?: string;
  startFromOrigin: boolean;
  requireGit: boolean;
}

/** What to check for an intent: an explicit worktree needs a repository; a fresh remote base needs the remote's branch. */
export function probeRequest(intent: WorkspaceIntent, root: string): ProbeRequest {
  if (intent.type === 'root') return { root, startFromOrigin: false, requireGit: false };
  return {
    root,
    baseRef: intent.baseRef,
    startFromOrigin: intent.type === 'auto' ? true : intent.startFromOrigin,
    requireGit: intent.type === 'worktree',
  };
}

export function resolveWorkspace(hostId: string, intent: WorkspaceIntent, inspection: WorkspaceInspection): ResolvedWorkspace {
  if (intent.type === 'root' || (intent.type === 'auto' && inspection.kind === 'root')) {
    return { kind: 'root', rootKey: rootKey(hostId, inspection.root) };
  }
  return { kind: 'worktree', baseRef: intent.baseRef, startFromOrigin: intent.type === 'auto' ? true : intent.startFromOrigin };
}

/** Bounds on one probe run. */
export const PROBE_TIMEOUT_MS = 15 * SECOND;
export const PROBE_MAX_OUTPUT_BYTES = 16 * 1024;
const FAILED = 'Workspace probe failed. Check the project folder, Git, the remote base branch and the host\'s workspaceProbeCommand.';
const UNAVAILABLE = 'Workspace probe could not reach the host (timeout or exit 255). It is tried again shortly.';
/** The exit code of ssh when it cannot connect: the one nonzero exit that says the host, not the project, is the problem. */
const SSH_FAILED = 255;

/**
 * Run the operator's probe: the configured argv, no shell, one JSON object on stdin, one JSON object on stdout.
 * Output beyond 16 KiB, a missing executable, any other nonzero exit or an answer in the wrong shape is
 * `workspace_probe_failed` (the project is the problem, or the probe); a timeout or exit 255 (ssh could not connect) is
 * `workspace_probe_unavailable`, which the engine retries for that job alone. stderr is discarded. Neither the argv, the
 * request, the path nor any output is kept in an error. `signal` (shutdown) kills the child and rejects with `internal_error`.
 */
export function runWorkspaceProbe(
  command: readonly string[],
  request: ProbeRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<WorkspaceInspection> {
  const [file, ...args] = command;
  const { signal } = options;
  if (!file) return Promise.reject(new GatewayError('workspace_probe_failed', FAILED));
  if (signal?.aborted) return Promise.reject(new GatewayError('internal_error', 'Workspace probe cancelled.'));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: GatewayError | undefined, inspection?: WorkspaceInspection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(inspection!);
    };
    const failed = () => finish(new GatewayError('workspace_probe_failed', FAILED));
    const onAbort = () => finish(new GatewayError('internal_error', 'Workspace probe cancelled.'));
    const timer = setTimeout(() => finish(new GatewayError('workspace_probe_unavailable', UNAVAILABLE)), options.timeoutMs ?? PROBE_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > PROBE_MAX_OUTPUT_BYTES) failed();
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.on('error', failed);
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      if (settled) return;
      if (code === SSH_FAILED) return finish(new GatewayError('workspace_probe_unavailable', UNAVAILABLE));
      if (code !== 0) return failed();
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return failed();
      }
      const parsed = inspectionSchema.safeParse(value);
      if (parsed.success) finish(undefined, parsed.data);
      else failed();
    });
    child.stdin.end(JSON.stringify(request));
  });
}
