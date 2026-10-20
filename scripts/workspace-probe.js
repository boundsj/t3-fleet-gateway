#!/usr/bin/env node
// Reference workspace probe for hosts[].workspaceProbeCommand (docs/configuration.md, "Workspace probe").
// Reads one JSON object on stdin: { root, baseRef?, startFromOrigin, requireGit }. Prints one JSON object:
// { kind: 'git' | 'root', root } where root is the canonical path. Exits nonzero (stderr is discarded) when the
// folder is unusable. Run it on the host that owns the folder (for example through ssh: exit 255 means ssh failed).
import { realpath, stat, lstat, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']) {
  delete gitEnv[name];
}
const git = async (root, args) => (await exec('git', ['-C', root, ...args], { timeout: 10000, maxBuffer: 16384, env: gitEnv })).stdout.trim();

export async function inspectWorkspace(input) {
  if (!input || typeof input.root !== 'string' || !input.root.startsWith('/') || typeof input.startFromOrigin !== 'boolean' || typeof input.requireGit !== 'boolean') {
    throw Error('bad request');
  }
  if (input.startFromOrigin && (typeof input.baseRef !== 'string' || input.baseRef === '')) throw Error('bad request');
  const root = await realpath(input.root);
  const info = await stat(root);
  if (!info.isDirectory()) throw Error('not a directory');
  await access(root, 5);
  await git(root, ['--version']);
  // A `.git` entry anywhere above the folder means it belongs to a repository, which must then be intact.
  let markerRoot;
  for (let current = root; ; current = dirname(current)) {
    try {
      await lstat(join(current, '.git'));
      markerRoot = current;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dirname(current) === current) break;
  }
  let kind = 'root';
  try {
    if ((await git(root, ['rev-parse', '--is-inside-work-tree'])) !== 'true') throw Error('not inside a work tree');
    const gitRoot = await realpath(await git(root, ['rev-parse', '--show-toplevel']));
    if (markerRoot && gitRoot !== markerRoot) throw Error('inconsistent repository');
    if (gitRoot === root) kind = 'git';
  } catch (error) {
    if (markerRoot || !String(error.stderr).includes('not a git repository')) throw error;
  }
  if (input.requireGit && kind !== 'git') throw Error('not a repository root');
  if (kind === 'git' && input.startFromOrigin) {
    await git(root, ['check-ref-format', `refs/heads/${input.baseRef}`]);
    if (!(await git(root, ['remote', 'get-url', 'origin']))) throw Error('no origin');
    const advertised = await git(root, ['ls-remote', '--exit-code', 'origin', `refs/heads/${input.baseRef}`]);
    if (!/^[a-f0-9]{40,64}\s+refs\/heads\//.test(advertised)) throw Error('remote branch missing');
  }
  return { kind, root };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let body = '';
    for await (const chunk of process.stdin) {
      body += chunk;
      if (body.length > 16384) throw Error('request too large');
    }
    process.stdout.write(JSON.stringify(await inspectWorkspace(JSON.parse(body))));
  } catch {
    process.stderr.write('Workspace inspection failed.\n');
    process.exitCode = 1;
  }
}
