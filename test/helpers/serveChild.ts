// Runs `serve` as its own process for test/process-errors.test.ts. Each SIGUSR2 raises the next error
// named in T3FG_TEST_RAISE (comma-separated): `race` or `other`, thrown (`-throw`) or rejected (`-reject`).
import { runCli } from '../../src/cli/main.ts';

const raises = (process.env.T3FG_TEST_RAISE ?? '').split(',');
const race = () => Object.assign(new Error('setTypeOfService EINVAL'), { errno: -22, code: 'EINVAL', syscall: 'setTypeOfService' });
const other = () => Object.assign(new Error('synthetic failure with private detail'), { code: 'ESYNTHETIC' });

process.on('SIGUSR2', () => {
  const kind = raises.shift() ?? '';
  const error = kind.startsWith('race') ? race() : other();
  if (kind.endsWith('reject')) void Promise.reject(error);
  else
    setImmediate(() => {
      throw error;
    });
});

process.exitCode = await runCli(['serve'], {
  env: process.env,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  listenPort: 0,
});
