/** Run the real serve CLI in a child, with an OS-selected listener behind the smoke harness's stable front door. */
import { runCli } from '../../src/cli/main.ts';

process.exitCode = await runCli(['serve'], {
  env: process.env,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  listenPort: 0,
});
