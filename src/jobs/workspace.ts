import { spawn } from 'node:child_process';
import * as z from 'zod';
import type { HostConfig } from '../config.ts';
import { GatewayError } from '../errors.ts';
import type { HostRegistry } from '../hosts/registry.ts';

export const workspaceSelectionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('auto') }),
  z.strictObject({ type: z.literal('root') }),
  z.strictObject({ type: z.literal('worktree'), baseRef: z.string().min(1).max(200).optional(), startFromOrigin: z.boolean().optional() }),
]);
export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;
export const inspectionSchema = z.strictObject({ kind: z.enum(['root', 'git']), root: z.string().startsWith('/').max(4096), identity: z.string().min(1).max(200) });
export type WorkspaceInspection = z.infer<typeof inspectionSchema>;

export async function probeWorkspace(host: HostConfig, registry: HostRegistry, projectId: string, selection: WorkspaceSelection, revalidation?: { expectedInspection: WorkspaceInspection }): Promise<WorkspaceInspection> {
  const command = host.workspaceProbeCommand;
  if (!command) throw new GatewayError('invalid_argument', `Host ${host.id} needs an operator-configured workspaceProbeCommand for named project launches.`);
  const project = (await registry.client(host.id).listProjects()).find((item) => item.id === projectId);
  const root = project?.workspaceRoot;
  if (typeof root !== 'string' || !root.startsWith('/') || root.length > 4096) throw new GatewayError('t3_invalid_response', 'The project has no valid workspace root.');
  const request = {
    root,
    baseRef: selection.type === 'worktree' ? selection.baseRef ?? 'main' : 'main',
    startFromOrigin: (!revalidation || revalidation.expectedInspection.kind === 'git') && selection.type !== 'root' && (selection.type === 'auto' || selection.startFromOrigin !== false),
    requireGit: !revalidation && selection.type === 'worktree',
    ...(revalidation ? { expectedInspection: revalidation.expectedInspection } : {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let output = '';
    let failed = false;
    let stdinFailed = false;
    const fail = (code: 'invalid_argument' | 'workspace_probe_unavailable' = 'invalid_argument') => {
      failed = true; clearTimeout(timer); child.kill('SIGKILL');
      reject(new GatewayError(code, 'Workspace probe failed. Check destination access, Git, origin/main and workspaceProbeCommand.'));
    };
    const timer = setTimeout(() => fail('workspace_probe_unavailable'), 15000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 16384) fail(); });
    child.stderr.on('data', () => {});
    child.on('error', () => fail());
    child.stdin.on('error', () => { stdinFailed = true; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) { fail(code === 255 ? 'workspace_probe_unavailable' : 'invalid_argument'); return; }
      if (stdinFailed) { fail(); return; }
      const parsed = inspectionSchema.safeParse((() => { try { return JSON.parse(output); } catch { return null; } })());
      if (!parsed.success || (request.requireGit && parsed.data.kind !== 'git')) { fail(); return; }
      resolve(parsed.data);
    });
    child.stdin.end(JSON.stringify(request));
  });
}
