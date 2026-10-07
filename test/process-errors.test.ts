import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { tempDir } from './helpers/tmp.ts';

const CHILD = join(import.meta.dirname, 'helpers', 'serveChild.ts');

/** Start `serve` in its own process; `raise()` makes it raise the next error in `raises`. */
function serveChild(t: TestContext, raises: string[]) {
  const dir = tempDir(t);
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ publicUrl: 'https://gateway.example.com', hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9', mintPairingCode: ['false'] }] }),
  );
  const child = spawn(process.execPath, [CHILD], {
    env: { PATH: process.env.PATH, T3FG_CONFIG: configPath, T3FG_DATA_DIR: join(dir, 'data'), T3FG_TEST_RAISE: raises.join(',') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  const waiters: (() => void)[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    for (const waiter of waiters.splice(0)) waiter();
  });
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const count = (event: string) => out.split('\n').filter((line) => line.includes(`"event":"${event}"`)).length;
  const until = async (event: string, times = 1) => {
    while (count(event) < times) await new Promise<void>((resolve) => waiters.push(resolve));
  };
  return {
    output: () => out,
    count,
    until,
    exited,
    raise: () => child.kill('SIGUSR2'),
    stop: () => child.kill('SIGTERM'),
  };
}

function events(output: string, event: string): Record<string, unknown>[] {
  return output
    .split('\n')
    .filter((line) => line.includes(`"event":"${event}"`))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('serve process errors', () => {
  test("Node 26.0's setTypeOfService EINVAL is logged and serve keeps running", async (t) => {
    const serve = serveChild(t, ['race-throw', 'race-reject']);
    await serve.until('gateway.started');
    serve.raise();
    await serve.until('process.transient_socket_error');
    serve.raise();
    await serve.until('process.transient_socket_error', 2);
    serve.stop();
    assert.equal(await serve.exited, 0);
    const output = serve.output();
    assert.deepEqual(
      events(output, 'process.transient_socket_error').map(({ level, origin, syscall, errorCode }) => ({ level, origin, syscall, errorCode })),
      [
        { level: 'warn', origin: 'uncaughtException', syscall: 'setTypeOfService', errorCode: 'EINVAL' },
        { level: 'warn', origin: 'unhandledRejection', syscall: 'setTypeOfService', errorCode: 'EINVAL' },
      ],
    );
    assert.equal(serve.count('process.fatal'), 0);
    assert.equal(serve.count('gateway.stopped'), 1);
  });

  for (const [kind, origin] of [
    ['other-throw', 'uncaughtException'],
    ['other-reject', 'unhandledRejection'],
  ] as const) {
    test(`any other ${origin} stops serve gracefully and exits non-zero`, async (t) => {
      const serve = serveChild(t, [kind]);
      await serve.until('gateway.started');
      serve.raise();
      assert.equal(await serve.exited, 1);
      const output = serve.output();
      assert.deepEqual(
        events(output, 'process.fatal').map(({ level, origin, errorName, errorCode }) => ({ level, origin, errorName, errorCode })),
        [{ level: 'error', origin, errorName: 'Error', errorCode: 'ESYNTHETIC' }],
      );
      assert.equal(serve.count('gateway.stopped'), 1, 'the gateway shut down cleanly');
      assert.doesNotMatch(output, /private detail/, 'the error message is not logged');
    });
  }
});
