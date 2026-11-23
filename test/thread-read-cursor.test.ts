import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { legacyReadCursor } from '../src/t3/client.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { startJob, startJobHarness } from './helpers/jobs.ts';

// T3 PR #41378: a t3_thread_read with neither cursor returns the newest page to every caller. Forward scans
// must say "from the start" (afterPosition -1, accepted since T3 v0.1.10); v0.1.2 to v0.1.9 refuse -1 and
// read a cursorless request from the start. The fake models all three (`threadReadCursor`), plus a host whose
// afterPosition union accepts -1 (`union`) and a contradictory one with the legacy schema (`impostor`).
const MODES = ['newest', 'forward', 'legacy', 'union'] as const;
type Mode = (typeof MODES)[number] | 'impostor';

async function harness(t: TestContext, mode: Mode, budget = false) {
  const fake = await startFakeT3();
  t.after(() => fake.close());
  fake.threadReadCursor = mode;
  fake.budgetThreadReads = budget;
  return startJobHarness(t, { fake });
}

/** `count` finished exchanges, each with a long reply so a budgeted read returns fewer items than asked. */
function exchanges(fake: Awaited<ReturnType<typeof startFakeT3>>, threadId: string, count: number) {
  for (let i = 0; i < count; i++) {
    fake.userTurn(threadId, `Synthetic question ${i}`);
    fake.finishTurn(threadId, `Synthetic answer ${i} ${'x'.repeat(600)}`);
  }
}

for (const mode of MODES) {
  test(`${mode}: a read from the start returns the first items; state, item and forward reads are unchanged`, async (t) => {
    const { fake, gw, agent, tick } = await harness(t, mode);
    const job = await startJob(agent);
    await tick();
    const threadId = gw.services.jobs.store.require(job.jobId).threadId!;
    exchanges(fake, threadId, 80);
    const client = gw.services.registry.client('main');
    const before = fake.reads.length;

    const first = await client.readThread({ threadId, view: 'messages', afterPosition: null, limit: 100, maxCharsPerItem: 1 });
    assert.equal(first.items[0]?.position, 0);
    assert.equal(first.hasMore, true);
    const second = await client.readThread({ threadId, view: 'messages', afterPosition: first.nextPosition, limit: 100, maxCharsPerItem: 1 });
    assert.equal(second.items[0]?.position, first.nextPosition! + 1);
    const state = await client.readThread({ threadId, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 1 });
    const last = fake.threads.get(threadId)!.items.at(-1)!;
    // The premise of the fix: on current T3 a cursorless read is the newest page.
    assert.equal(state.items[0]?.position, mode === 'newest' || mode === 'union' ? last.position : 0);
    await client.readThread({ threadId, view: 'messages', itemId: last.itemId, textOffset: 1, maxCharsPerItem: 10 });

    assert.deepEqual(
      fake.reads.slice(before).map((read) => [read.afterPosition, read.itemId]),
      [[mode === 'legacy' ? undefined : -1, undefined], [first.nextPosition, undefined], [undefined, undefined], [undefined, last.itemId]],
    );
  });

  test(`${mode}: the watcher's first look pages forward through budgeted reads and finds an older still-running delegated task`, async (t) => {
    const { fake, gw, agent, tick, tickAfter } = await harness(t, mode, true);
    const job = await startJob(agent);
    await tick();
    const threadId = gw.services.jobs.store.require(job.jobId).threadId!;
    const stored = gw.services.jobs.store.require(job.jobId);
    assert.deepEqual([stored.readPosition, stored.activityPosition], [null, null], 'nothing observed yet');
    fake.delegate(threadId, 'Synthetic early task');
    fake.addActivity(threadId, 'reasoning', 150);
    exchanges(fake, threadId, 60);
    const before = fake.reads.length;
    await tick();
    const reads = fake.reads.slice(before);
    for (const view of ['messages', 'activity']) {
      assert.equal(reads.find((read) => read.view === view)?.afterPosition, mode === 'legacy' ? undefined : -1, `${view} starts at the first item`);
    }
    assert.ok(reads.filter((read) => read.view === 'messages').length > 1, 'budgeted messages pages');
    const status = await agent.call<{ waitingOnDelegatedWork: boolean; delegatedTasks: string[] }>('work_status', { jobId: job.jobId });
    assert.equal(status.waitingOnDelegatedWork, true);
    assert.deepEqual(status.delegatedTasks, ['Synthetic early task']);
    for (let i = 0; i < 5; i++) await tickAfter(60_001);
    const last = fake.threads.get(threadId)!.items.at(-1)!;
    assert.equal(gw.services.jobs.store.require(job.jobId).readPosition, last.position, 'messages caught up to the end');
    const latest = await agent.call<{ latestMessageExcerpt: string }>('work_status', { jobId: job.jobId });
    assert.match(latest.latestMessageExcerpt, /^Synthetic answer 59 /);
  });

  test(`${mode}: work_settle refuses a thread whose older delegated task is still running`, async (t) => {
    const { fake, gw, agent, tick } = await harness(t, mode);
    const job = await startJob(agent);
    await tick();
    const threadId = gw.services.jobs.store.require(job.jobId).threadId!;
    fake.finishTurn(threadId, 'Synthetic completion');
    await tick();
    // Out of the newest activity page; the watcher has not seen it.
    fake.delegate(threadId, 'Synthetic early task');
    fake.addActivity(threadId, 'reasoning', 150);
    const error = await agent.callError('work_settle', { jobId: job.jobId, requestId: 'settle-older-delegated' });
    assert.equal(error.code, 'job_state_conflict');
    assert.match(error.text, /delegated work/);
    assert.equal(fake.calls.includes('t3_thread_organize'), false);
  });
}

// t3_thread_read's position fields as T3 advertises them over HTTP, rendered from upstream source with each
// release's Effect (4.0.5 to v0.1.6, 4.1.2 to v0.1.9, 4.1.3 to v0.1.11, 4.1.5 on main). v0.1.2 and v0.1.3 register
// toolkits with the full codec schema (Schema.toCodecJson through McpServer's toolJsonSchema): nullable branches.
// From v0.1.4, withAdvertisedSchemas advertises advertisedJsonSchema(tool) (McpHttpServer.ts, v0.1.4 lines
// 1010-1054), which drops safe-integer bounds and the null branch of optional properties: a compact schema.
const MAX = Number.MAX_SAFE_INTEGER;
/** v0.1.2 and v0.1.3. */
const NULLABLE_LEGACY = { anyOf: [{ type: 'integer', minimum: 0, maximum: MAX }, { type: 'null' }] };
/** v0.1.4 to v0.1.9. */
const COMPACT_LEGACY = { type: 'integer', minimum: 0 };
/** v0.1.10 and later. */
const COMPACT_CURRENT = { afterPosition: { type: 'integer', minimum: -1 }, beforePosition: { type: 'integer', minimum: 0 } };
/** The current contract in the full codec form, which no release advertises over HTTP (the fake's current modes do). */
const NULLABLE_CURRENT = {
  afterPosition: { anyOf: [{ type: 'integer', minimum: -1, maximum: MAX }, { type: 'null' }] },
  beforePosition: { anyOf: [{ type: 'integer', minimum: 0, maximum: MAX }, { type: 'null' }] },
};
const readSchema = (positions: Record<string, unknown>) =>
  ({ type: 'object', properties: { threadId: { type: 'string' }, ...positions }, required: ['threadId'] });

test('only the known legacy forms omit the cursor; ambiguous and current schemas get -1', () => {
  // T3 v0.1.2 and v0.1.3 (nullable, either branch order), and v0.1.4 to v0.1.9 (compact).
  assert.equal(legacyReadCursor(readSchema({ afterPosition: NULLABLE_LEGACY })), true);
  assert.equal(legacyReadCursor(readSchema({ afterPosition: { anyOf: [{ type: 'null' }, NULLABLE_LEGACY.anyOf[0]] } })), true);
  assert.equal(legacyReadCursor(readSchema({ afterPosition: COMPACT_LEGACY })), true);
  // T3 v0.1.10 and later (compact, and the codec form), and either legacy cursor beside a beforePosition.
  assert.equal(legacyReadCursor(readSchema(COMPACT_CURRENT)), false);
  assert.equal(legacyReadCursor(readSchema(NULLABLE_CURRENT)), false);
  assert.equal(legacyReadCursor(readSchema({ afterPosition: NULLABLE_LEGACY, beforePosition: NULLABLE_CURRENT.beforePosition })), false);
  assert.equal(legacyReadCursor(readSchema({ afterPosition: COMPACT_LEGACY, beforePosition: COMPACT_CURRENT.beforePosition })), false);
  // Ambiguous: a branch that may take -1, a wider combinator or keyword, or nothing readable.
  const integer = NULLABLE_LEGACY.anyOf[0];
  for (const afterPosition of [
    { anyOf: [{ type: 'integer', minimum: 0 }, { const: -1 }] },
    { anyOf: [integer, { type: 'null' }, { const: -1 }] },
    { anyOf: [integer, { type: 'integer' }] },
    { anyOf: [integer, { type: 'integer', minimum: -1 }] },
    { anyOf: [integer, integer] },
    { anyOf: [integer, { type: 'null', const: -1 }] },
    { anyOf: [integer, { type: ['null', 'integer'] }] },
    { anyOf: [{ ...integer, exclusiveMinimum: -2 }, { type: 'null' }] },
    { anyOf: [{ ...integer, minimum: -1 }, { type: 'null' }] },
    { anyOf: [integer, { type: 'null' }], not: { const: 0 } },
    { anyOf: [integer] },
    { oneOf: [integer, { type: 'null' }] },
    { allOf: [integer, { type: 'null' }] },
    { type: 'integer', minimum: 0, enum: [-1, 0] },
    { type: ['integer', 'null'], minimum: 0 },
    { type: 'integer' },
    { type: 'number', minimum: 0 },
    { type: 'integer', minimum: -1 },
    [integer],
    true,
    undefined,
  ]) {
    assert.equal(legacyReadCursor(readSchema({ afterPosition })), false, JSON.stringify(afterPosition));
  }
  assert.equal(legacyReadCursor(undefined), false);
  assert.equal(legacyReadCursor({ type: 'object' }), false);
});

test('the fake advertises positions in the full codec form: v0.1.2 and v0.1.3 for legacy, the uncompacted contract otherwise', async (t) => {
  for (const [mode, expected] of [['legacy', { afterPosition: NULLABLE_LEGACY }], ['newest', NULLABLE_CURRENT], ['forward', NULLABLE_CURRENT]] as const) {
    const fake = await startFakeT3();
    fake.threadReadCursor = mode;
    fake.validTokens.add('synthetic-wire-token');
    const client = new Client({ name: 'wire-test', version: '0.0.0' });
    t.after(async () => { await client.close(); await fake.close(); });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', fake.url), { authProvider: { token: async () => 'synthetic-wire-token' } }));
    const read = (await client.listTools()).tools.find((tool) => tool.name === 't3_thread_read')!;
    const properties = read.inputSchema.properties as Record<string, unknown>;
    assert.deepEqual({ afterPosition: properties.afterPosition, beforePosition: properties.beforePosition },
      { beforePosition: undefined, ...expected }, mode);
  }
});

// Exact tools/list pages: the two legacy forms against a host that refuses -1, the others against hosts that take
// -1 and answer a cursorless read with the newest page.
for (const [name, positions, legacy] of [
  ['T3 v0.1.2 and v0.1.3 (nullable legacy cursor)', { afterPosition: NULLABLE_LEGACY }, true],
  ['T3 v0.1.4 to v0.1.9 (compact legacy cursor)', { afterPosition: COMPACT_LEGACY }, true],
  ['T3 v0.1.10 and later (compact cursors)', COMPACT_CURRENT, false],
  ['a cursor union that takes -1', { afterPosition: { anyOf: [NULLABLE_LEGACY.anyOf[0], { type: 'null' }, { const: -1 }] } }, false],
] as const) {
  test(`wire-level discovery of ${name}: ${legacy ? 'the cursor is omitted' : '-1 is sent'} and the read starts at the first item`, async (t) => {
    const fake = await startFakeT3();
    t.after(() => fake.close());
    // A legacy host refuses -1 and reads a cursorless request from the start; the others would skip items
    // if the cursor were omitted.
    fake.threadReadCursor = legacy ? 'legacy' : 'union';
    const gw = (await startJobHarness(t, { fake })).gw;
    const { threadId } = fake.launchDirect({ projectId: 'project-1', title: 'Synthetic wire thread', message: 'Synthetic first message' });
    exchanges(fake, threadId, 3);
    fake.toolsListPages.set('', { tools: [{ name: 't3_thread_read', inputSchema: readSchema(positions) }] });
    const before = fake.reads.length;
    const listed = fake.toolsListCalls;
    const read = await gw.services.registry.client('main').readThread({ threadId, view: 'messages', afterPosition: null, limit: 100, maxCharsPerItem: 1 });
    assert.equal(fake.toolsListCalls, listed + 1, 'the injected tools/list page is what the client classified');
    assert.equal(read.items[0]?.position, 0);
    assert.deepEqual(fake.reads.slice(before).map((input) => input.afterPosition), [legacy ? undefined : -1]);
  });
}

test('a read from the start fails closed when T3 answers with a later page: a failed Thread read signal, and work_settle sends nothing', async (t) => {
  const { fake, gw, agent, tick } = await harness(t, 'impostor');
  const job = await startJob(agent);
  await tick();
  const threadId = gw.services.jobs.store.require(job.jobId).threadId!;
  fake.finishTurn(threadId, 'Synthetic completion');
  await tick(); // A thread that fits one page has nothing earlier: an honest answer either way.
  assert.equal(gw.services.jobs.store.require(job.jobId).state, 'idle');
  fake.delegate(threadId, 'Synthetic early task');
  fake.addActivity(threadId, 'reasoning', 150);
  const before = fake.reads.length;
  const signal = () => gw.services.registry.signals('main').snapshot().find((entry) => entry.kind === 't3_thread_read');
  const error = await agent.callError('work_settle', { jobId: job.jobId, requestId: 'settle-impostor' });
  assert.equal(error.code, 't3_invalid_response');
  assert.equal(signal()?.code, 't3_invalid_response', 'the host Thread read signal records the refused answer, not a success');
  assert.deepEqual(fake.reads.slice(before).filter((read) => read.view === 'activity').map((read) => read.afterPosition), [undefined],
    'the exact legacy schema omits the cursor, and the newest page it got is refused');
  assert.equal(fake.calls.includes('t3_thread_organize'), false);

  // A watcher's first look keeps its positions rather than skipping to the newest page.
  const other = await startJob(agent);
  await tick();
  const otherThread = gw.services.jobs.store.require(other.jobId).threadId!;
  fake.delegate(otherThread, 'Synthetic early task');
  fake.addActivity(otherThread, 'reasoning', 150);
  exchanges(fake, otherThread, 60);
  await tick();
  const stored = gw.services.jobs.store.require(other.jobId);
  assert.deepEqual([stored.readPosition, stored.activityPosition, stored.lastErrorCode], [null, null, 't3_invalid_response']);
  assert.equal(signal()?.code, 't3_invalid_response');
  assert.equal(fake.calls.includes('t3_thread_organize'), false);
});

test('a read from the start of a thread whose first items are gone is not taken for a later page', async (t) => {
  const { fake, gw, agent, tick } = await harness(t, 'newest');
  const job = await startJob(agent);
  await tick();
  const threadId = gw.services.jobs.store.require(job.jobId).threadId!;
  exchanges(fake, threadId, 60);
  fake.threads.get(threadId)!.items.splice(0, 5);
  const read = await gw.services.registry.client('main').readThread({ threadId, view: 'messages', afterPosition: null, limit: 100, maxCharsPerItem: 1 });
  assert.equal(read.items[0]?.position, 5);
  assert.equal(read.hasMore, true);
  assert.equal(read.earlierPosition, null);
});
