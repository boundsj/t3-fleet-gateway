import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, test, type TestContext } from 'node:test';
import { runCompatibilityCheck, type CompatibilityReport } from '../scripts/check-t3-compatibility.ts';
import { collectTools } from '../scripts/lib/t3-probe.ts';
import { openStorage } from '../src/gateway.ts';
import { CredentialStore } from '../src/hosts/credentials.ts';
import { T3Client } from '../src/t3/client.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { tempDir } from './helpers/tmp.ts';

describe('complete MCP discovery', () => {
  const tool = (name: string) => ({ name, inputSchema: { type: 'object' } });
  test('reads later pages, including tools absent from the first page', async () => {
    const cursors: (string | undefined)[] = [];
    const tools = await collectTools(async (cursor) => {
      cursors.push(cursor);
      return cursor === undefined ? { tools: [tool('first')], nextCursor: 'next' } : { tools: [tool('last')] };
    });
    assert.deepEqual(cursors, [undefined, 'next']);
    assert.deepEqual(tools.map((item) => item.name), ['first', 'last']);
  });
  test('rejects repeated cursors instead of accepting an incomplete catalog', async () => {
    await assert.rejects(collectTools(async () => ({ tools: [], nextCursor: 'again' })), { code: 'repeated_cursor' });
  });
  test('rejects a nonconverging catalog and duplicate tool names', async () => {
    let pages = 0;
    await assert.rejects(collectTools(async () => ({ tools: [], nextCursor: String(++pages) }), 2), {
      code: 'discovery_page_limit',
    });
    await assert.rejects(collectTools(async (cursor) => ({ tools: [tool('duplicate')], ...(cursor ? {} : { nextCursor: 'next' }) })), {
      code: 'duplicate_tool',
    });
  });
});

const SECRET_TOKEN = 'synthetic-token-never-in-report';
const PRIVATE_TEXT = 'PRIVATE_WORKER_QUESTION_AND_RESPONSE';

async function setup(t: TestContext, withThread = true) {
  const fake = await startFakeT3();
  t.after(() => fake.close());
  fake.validTokens.add(SECRET_TOKEN);
  const dir = tempDir(t);
  const dataDir = join(dir, 'data');
  const stateDir = join(dir, 'compatibility');
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    publicUrl: fake.url,
    hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: ['/never/run/this'] }],
  }), { mode: 0o600 });
  const storage = openStorage(dataDir);
  new CredentialStore(storage.db).save({
    hostId: 'main', t3ClientId: 'synthetic-client', accessToken: SECRET_TOKEN, scope: 'orchestration', access: 'full-access',
    issuedAt: Date.now(), expiresAt: Date.now() + 86_400_000, verifiedAt: Date.now(),
  });
  storage.db.close();
  let threadId = '';
  if (withThread) {
    const seed = new T3Client({ hostId: 'main', t3Url: fake.url, token: () => SECRET_TOKEN });
    try {
      threadId = (await seed.launchThread({
        projectId: 'project-1', title: PRIVATE_TEXT, message: PRIVATE_TEXT, runtimeMode: 'auto',
        workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: 'synthetic/compatibility', startFromOrigin: false },
      })).threadId;
      fake.finishTurn(threadId, PRIVATE_TEXT);
    } finally { await seed.close(); }
  }
  fake.calls.length = 0;
  const env = { T3FG_CONFIG: configPath, T3FG_DATA_DIR: dataDir, T3FG_COMPAT_STATE_DIR: stateDir };
  const statePath = join(stateDir, 'state.json');
  const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));
  async function run(args: string[] = []) {
    const out: string[] = [];
    const err: string[] = [];
    const exitCode = await runCompatibilityCheck(['--json', ...args], { env, out: (text) => out.push(text), err: (text) => err.push(text) });
    assert.deepEqual(err, []);
    assert.equal(out.length, 1);
    return { exitCode, report: JSON.parse(out[0]!) as CompatibilityReport, text: out[0]! };
  }
  return { fake, dataDir, stateDir, statePath, readState, run, threadId, env };
}

describe('on-demand developer compatibility tool', () => {
  test('checks both thread views without writes, accepts a baseline, and suppresses timestamp/content noise', async (t) => {
    const f = await setup(t);
    const before = Object.fromEntries(['gateway.db', 'gateway.key'].map((name) => [name, readFileSync(join(f.dataDir, name))]));
    const first = await f.run();
    assert.equal(first.exitCode, 2, 'first run requires deliberate baseline acceptance');
    assert.equal(first.report.hosts[0]!.baseline, 'missing');
    const accepted = await f.run(['--accept']);
    assert.equal(accepted.exitCode, 0);
    assert.equal(accepted.report.hosts[0]!.baseline, 'accepted');
    const repeat = await f.run();
    assert.equal(repeat.exitCode, 0);
    assert.equal(repeat.report.hosts[0]!.changedSinceLastCheck, false);
    assert.ok(f.fake.reads.some((read) => read.view === 'messages'));
    assert.ok(f.fake.reads.some((read) => read.view === 'activity'));
    assert.ok(f.fake.calls.length > 0);
    const reads = new Set(['t3_environment_read', 't3_project_list', 'orchestrator_capabilities', 't3_thread_list', 't3_thread_read',
      't3_thread_search', 't3_pending_request_list', 't3_pending_request_read']);
    assert.ok(f.fake.calls.includes('orchestrator_capabilities'), 'the capabilities catalog is smoke-read');
    assert.ok(f.fake.calls.every((call) => reads.has(call)), 'only known read-only tools were invoked');
    for (const [name, bytes] of Object.entries(before)) assert.deepEqual(readFileSync(join(f.dataDir, name)), bytes);
    assert.equal(statSync(f.stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(f.statePath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(f.stateDir), ['state.json'], 'temporary state and lock are removed');
    for (const text of [first.text, accepted.text, repeat.text, readFileSync(f.statePath, 'utf8')]) {
      assert.ok(!text.includes(PRIVATE_TEXT));
      assert.ok(!text.includes(SECRET_TOKEN));
    }
  });

  test('reports drift until accepted and failed smoke cannot replace the baseline', async (t) => {
    const f = await setup(t);
    assert.equal((await f.run(['--accept'])).exitCode, 0);
    const old = f.readState();
    const key = Object.keys(old.hosts)[0]!;
    // Model a baseline from a T3 release that still advertised thread.link.
    old.hosts[key].baseline.t3_thread_read.outputSchema = {
      type: 'object', properties: { link: { type: 'string' } }, required: ['link'],
    };
    writeFileSync(f.statePath, JSON.stringify(old));
    const changed = await f.run();
    assert.equal(changed.exitCode, 2);
    assert.ok(changed.report.hosts[0]!.changes.some((change) => change.tool === 't3_thread_read'));
    assert.equal((await f.run()).report.hosts[0]!.changedSinceLastCheck, false);
    f.fake.brokenReads.add(f.threadId);
    const failed = await f.run(['--accept']);
    assert.equal(failed.exitCode, 1);
    assert.ok(failed.report.hosts[0]!.checks.some((check) => check.code === 't3_invalid_response'));
    assert.deepEqual(f.readState().hosts[key].baseline, old.hosts[key].baseline);
    f.fake.brokenReads.delete(f.threadId);
    assert.equal((await f.run(['--accept'])).exitCode, 0);
    assert.deepEqual((await f.run()).report.hosts[0]!.changes, []);
  });

  test('reads a pending question without answering or storing its text', async (t) => {
    const f = await setup(t);
    const requestId = f.fake.askQuestion(f.threadId, [{
      id: 'q', header: PRIVATE_TEXT, question: PRIVATE_TEXT, options: [{ label: PRIVATE_TEXT, description: PRIVATE_TEXT }],
    }]);
    const result = await f.run(['--accept']);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.hosts[0]!.checks.some((check) => check.tool === 't3_pending_request_read' && check.code === 'pending_request_read'));
    assert.ok(f.fake.threads.get(f.threadId)!.questions.has(requestId));
    assert.equal(f.fake.responses.length, 0);
    assert.ok(!readFileSync(f.statePath, 'utf8').includes(PRIVATE_TEXT));
  });

  test('marks unavailable thread and question samples as skipped coverage', async (t) => {
    const f = await setup(t, false);
    const result = await f.run(['--accept']);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.hosts[0]!.checks.some((check) => check.tool === 't3_thread_read' && check.status === 'skip'));
    assert.equal(f.fake.threads.size, 0, 'the checker never launches a sample job');
  });

  test('redacts host errors and continues to retain the accepted baseline', async (t) => {
    const f = await setup(t);
    await f.run(['--accept']);
    const baseline = f.readState().hosts;
    f.fake.failures.set('t3_environment_read', { code: 'bad_response', message: PRIVATE_TEXT + SECRET_TOKEN });
    const result = await f.run();
    assert.equal(result.exitCode, 1);
    assert.ok(result.report.hosts[0]!.checks.some((check) => check.code === 't3_tool_failed'));
    assert.ok(!result.text.includes(PRIVATE_TEXT));
    assert.ok(!result.text.includes(SECRET_TOKEN));
    const key = Object.keys(baseline)[0]!;
    assert.deepEqual(f.readState().hosts[key].baseline, baseline[key].baseline);
  });

  test('CLI runs from outside the checkout and emits one parseable JSON report', async (t) => {
    const f = await setup(t);
    const { stdout } = await promisify(execFile)(process.execPath,
      [resolve('scripts/check-t3-compatibility.ts'), '--accept', '--json'], { env: { ...process.env, ...f.env }, cwd: dirname(f.stateDir) });
    assert.equal(JSON.parse(stdout).status, 'PASS');
  });
});
