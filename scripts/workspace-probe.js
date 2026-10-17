#!/usr/bin/env node
import { realpath, stat, lstat, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const git = async (root, args) => (await exec('git', ['-C', root, ...args], { timeout: 10000, maxBuffer: 16384, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' } })).stdout.trim();
export async function inspectWorkspace(input) {
  if (!input || typeof input.root !== 'string' || !input.root.startsWith('/') || typeof input.baseRef !== 'string' || typeof input.startFromOrigin !== 'boolean') throw Error();
  const root = await realpath(input.root);
  const info = await stat(root);
  if (!info.isDirectory()) throw Error();
  await access(root, 5);
  await git(root, ['--version']);
  let marker = false;
  for (let current = root;; current = dirname(current)) {
    try { await lstat(join(current, '.git')); marker = true; break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
  let kind = 'root';
  try {
    if (await git(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') throw Error();
    kind = 'git';
  } catch (error) { if (marker || !String(error.stderr).includes('not a git repository')) throw error; }
  if (input.requireGit && kind !== 'git') throw Error();
  if (kind === 'git' && input.startFromOrigin) {
    await git(root, ['check-ref-format', `refs/heads/${input.baseRef}`]);
    const origin = await git(root, ['remote', 'get-url', 'origin']);
    if (!origin) throw Error();
    const advertised = await git(root, ['ls-remote', '--exit-code', 'origin', `refs/heads/${input.baseRef}`]);
    if (!new RegExp(`^[a-f0-9]{40,64}\\s+refs/heads/`).test(advertised)) throw Error();
  }
  return { kind, root, identity: `${info.dev}:${info.ino}` };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let body = '';
    for await (const chunk of process.stdin) { body += chunk; if (body.length > 16384) throw Error(); }
    process.stdout.write(JSON.stringify(await inspectWorkspace(JSON.parse(body))));
  } catch { process.stderr.write('Workspace inspection failed.\n'); process.exitCode = 1; }
}
