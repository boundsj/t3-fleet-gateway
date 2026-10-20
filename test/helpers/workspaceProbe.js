// A synthetic workspace probe for tests (hosts[].workspaceProbeCommand). argv[2] is a state directory: every request is
// appended to requests.jsonl, and the folder name in the request decides the answer:
//   .../plain  a folder that is not a repository root      .../fail   exit 1        .../bad-json  output that is not JSON
//   .../ssh    exit 255 until the file `ok` exists          .../huge   20 KB of output
//   .../slow   never answers (its pid goes to slow.pid)     anything else: a Git repository root
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const state = process.argv[2];
let text = '';
for await (const chunk of process.stdin) text += chunk;
const request = JSON.parse(text);
appendFileSync(join(state, 'requests.jsonl'), `${text}\n`);
const root = request.root;
if (root.includes('/slow')) {
  writeFileSync(join(state, 'slow.pid'), String(process.pid));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (root.includes('/fail')) process.exit(1);
if (root.includes('/ssh') && !existsSync(join(state, 'ok'))) process.exit(255);
if (root.includes('/bad-json')) {
  process.stdout.write('not json');
  process.exit(0);
}
if (root.includes('/huge')) {
  process.stdout.write('x'.repeat(20_000));
  process.exit(0);
}
const kind = root.includes('/plain') ? 'root' : 'git';
if (request.requireGit && kind !== 'git') process.exit(1);
process.stdout.write(JSON.stringify({ kind, root }));
