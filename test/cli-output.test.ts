import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { lineWriter } from '../src/cli/output.ts';
import { tempDir } from './helpers/tmp.ts';

const LAUNCHER = join(import.meta.dirname, '..', 'bin', 't3-fleet-gateway.js');

/** A stream whose errors the test raises by hand. */
function fakeStream() {
  const stream = Object.assign(new EventEmitter(), { written: [] as string[], write: (text: string) => stream.written.push(text) });
  return stream;
}

const errno = (code: string) => Object.assign(new Error(code), { code });

/** Run the launcher with its stdout closed before it writes anything, as `… | head -0` would. */
function runWithClosedStdout(t: TestContext, args: string[]): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [LAUNCHER, ...args], {
    env: { PATH: process.env.PATH, T3FG_DATA_DIR: join(tempDir(t), 'data'), T3FG_CONFIG: join(tempDir(t), 'missing.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

describe('cli output', () => {
  test('a closed reader stops output quietly; other stream errors still throw', () => {
    const stream = fakeStream();
    const write = lineWriter(stream);
    write('first');
    assert.deepEqual(stream.written, ['first\n']);
    stream.emit('error', errno('EPIPE'));
    write('second');
    assert.deepEqual(stream.written, ['first\n'], 'nothing is written after EPIPE');
    stream.emit('error', errno('ERR_STREAM_DESTROYED'));

    const other = fakeStream();
    lineWriter(other);
    assert.throws(() => other.emit('error', errno('EIO')), /EIO/);
    assert.throws(() => other.emit('error', errno('ERR_STREAM_DESTROYED')), /ERR_STREAM_DESTROYED/, 'only after EPIPE');
  });

  test('pair into a closed pipe exits with its own code and no stack trace', async (t) => {
    const paired = await runWithClosedStdout(t, ['pair']);
    assert.equal(paired.stderr, '');
    assert.equal(paired.code, 0);
    const failed = await runWithClosedStdout(t, ['hosts', 'status']);
    assert.equal(failed.code, 1, 'a failing command keeps its exit code');
    assert.match(failed.stderr, /^error \(config_not_found\)/);
  });
});
