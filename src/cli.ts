import { runCli } from './cli/main.ts';
import { lineWriter } from './cli/output.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  out: lineWriter(process.stdout),
  err: lineWriter(process.stderr),
});
// The command is done. Whatever it left open (a connection stuck after `serve` stopped on a fatal
// error) must not keep the process alive, or its supervisor would never restart it.
setTimeout(() => process.exit(), 5_000).unref();
