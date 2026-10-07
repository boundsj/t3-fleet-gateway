import { runCli } from './cli/main.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
// The command is done. Whatever it left open (a connection stuck after `serve` stopped on a fatal
// error) must not keep the process alive, or its supervisor would never restart it.
setTimeout(() => process.exit(), 5_000).unref();
