import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { runCli } from '../src/cli/main.ts';
import { parseConfig } from '../src/config.ts';
import { openServices } from '../src/gateway.ts';
import { silentLogger } from '../src/log.ts';
import { HOUR, MINUTE } from '../src/time.ts';
import { MAX_PAYLOAD_BYTES } from '../src/webhooks/store.ts';
import { testClock, type TestClock } from './helpers/clock.ts';
import { startFakeT3, type FakeT3 } from './helpers/fakeT3.ts';
import type { FrontDoor } from './helpers/frontDoor.ts';
import { startTestGateway } from './helpers/gateway.ts';
import { assertNotLogged, connectAgent, startJob, type Agent } from './helpers/jobs.ts';
import { tempDir } from './helpers/tmp.ts';

interface Payload {
  eventId: string;
  type: string;
  timestamp: string;
  feedSequence: number;
  feedCursor: string;
  jobId: string;
  projectAlias: string;
  host: string;
  projectId: string | null;
  title: string;
  state: string;
  previousState: string | null;
  threadId: string | null;
  link: string | null;
  standing: boolean;
  waitingOnDelegatedWork: boolean;
  turnInitiator: { kind: 'gateway' | 'unknown'; clientId: string | null };
  excerpt?: string | null;
  excerptTruncated?: boolean;
}

interface Received {
  body: string;
  payload: Payload;
  headers: IncomingHttpHeaders;
  method: string | undefined;
  path: string | undefined;
}

interface FeedPage {
  nextCursor: string;
  hasMore: boolean;
  events: { cursor: string; jobId: string; type: string; fromState: string | null; toState: string | null }[];
}

/** Real HTTP, including the response path; no sender, fetch or job-store mocks. */
async function receiver(t: TestContext) {
  const received: Received[] = [];
  let respond = (_entry: Received, res: ServerResponse) => { res.writeHead(204).end(); };
  const waiters: { count: number; resolve: () => void }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const entry = { body, payload: JSON.parse(body) as Payload, headers: req.headers, method: req.method, path: req.url };
    received.push(entry);
    for (const waiter of waiters) if (received.length >= waiter.count) waiter.resolve();
    respond(entry, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/synthetic-private-routine?key=synthetic-url-key`,
    received,
    respond(fn: typeof respond) { respond = fn; },
    whenReceived(count: number): Promise<void> {
      return received.length >= count ? Promise.resolve() : new Promise((resolve) => waiters.push({ count, resolve }));
    },
  };
}

/** A failure deadline, not a clock/sleep driving gateway state. Always release held responses in finally. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Expected progress before an unrelated held response completed')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

const HEADER_VALUE = 'synthetic-private-sender-key';

function subscription(url: string, extra: Record<string, unknown> = {}) {
  return { id: 'routine', enabled: true, url, auth: { header: 'X-Synthetic-Sender-Key', secretFile: 'grok.key' }, allowLoopbackHttp: true, ...extra };
}

async function harness(t: TestContext, subscriptions: Record<string, unknown>[], options: {
  fake?: FakeT3; dataDir?: string; door?: FrontDoor; clock?: TestClock; attemptTimeoutMs?: number;
  /** Extra fields for the host's config entry, and extra projects beside pilot and docs. */
  host?: Record<string, unknown>; projects?: Record<string, unknown>[];
} = {}) {
  const fake = options.fake ?? await startFakeT3();
  if (!options.fake) t.after(() => fake.close());
  const dataDir = options.dataDir ?? join(tempDir(t), 'data');
  if (!options.dataDir) {
    mkdirSync(dataDir, { mode: 0o700 });
    writeFileSync(join(dataDir, 'grok.key'), `${HEADER_VALUE}\n`, { mode: 0o600 });
  }
  const gw = await startTestGateway(t, {
    config: {
      hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand(), maxConcurrentJobs: 5, ...options.host }],
      projects: [
        { alias: 'pilot', host: 'main', t3ProjectId: 'project-1', runtimeMode: 'auto' },
        { alias: 'docs', host: 'main', t3ProjectId: 'project-2', runtimeMode: 'auto' },
        ...(options.projects ?? []),
      ],
      webhooks: { subscriptions },
    },
    dataDir,
    ...(options.door ? { door: options.door } : {}),
    clock: options.clock ?? testClock(Date.now()),
    jobEngine: { autoStart: false },
    webhookSender: { autoStart: false, attemptTimeoutMs: options.attemptTimeoutMs ?? 500 },
  });
  if (gw.services.registry.credentialStatus('main').state === 'missing') await gw.services.registry.enroll('main');
  const issued = gw.services.tokens.issueOperatorToken({ name: 'Synthetic webhook agent', scopes: ['fleet:read', 'fleet:operate'], expiresAt: gw.clock() + 24 * HOUR });
  const client = new Client({ name: 'synthetic-webhook-agent', version: '0' });
  // A real bearer grant and MCP transport. Close each connection so deliberate gateway restarts do not race a stale pooled socket.
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gw.baseUrl}/mcp`), {
    authProvider: { token: async () => issued.token }, requestInit: { headers: { connection: 'close' } },
  }));
  t.after(() => client.close());
  const agent: Agent = {
    clientId: issued.clientId, client,
    async call<T>(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
      return result.structuredContent as T;
    },
    async callError(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      const text = (result.content as { text: string }[])[0]!.text;
      return { code: text.split(':')[0]!, text };
    },
  };
  return {
    fake, gw, agent, token: issued.token, tick: () => gw.gateway.engine.tick(),
    // Each tick starts at most four requests, one per subscription; drain small fixtures without a timer.
    async deliver() { for (let batch = 0; batch < 4; batch++) await gw.gateway.webhooks.tick(); },
  };
}

async function cli(h: Awaited<ReturnType<typeof harness>>, args: string[], config = h.gw.services.config) {
  const configPath = join(h.gw.dataDir, 'synthetic-config.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, {
    env: { ...process.env, T3FG_CONFIG: configPath, T3FG_DATA_DIR: h.gw.dataDir },
    out: (line) => out.push(line), err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('outbound job webhooks through MCP, watcher and HTTP', () => {
  test('idle, needs_input and failed each emit once with the source feed sequence and event-time metadata', async (t) => {
    const sink = await receiver(t);
    const h = await harness(t, [subscription(sink.url)]);
    const jobs = await Promise.all(['Finished', 'Question', 'Failure'].map((title) => startJob(h.agent, 'Synthetic task never sent to a webhook', { title })));
    await h.tick();
    const [idle, input, failed] = jobs;
    assert.ok(idle && input && failed);
    h.fake.finishTurn(h.fake.threadForJob(idle.jobId).threadId, 'Synthetic confidential worker message');
    h.fake.askQuestion(h.fake.threadForJob(input.jobId).threadId, [{
      id: 'q1', header: 'Synthetic secret question header', question: 'Synthetic private question?',
      options: [{ label: 'Synthetic secret option', description: 'Synthetic option description' }],
    }]);
    h.fake.failRun(h.fake.threadForJob(failed.jobId).threadId);
    await h.tick();
    assert.equal(sink.received.length, 0, 'job transitions commit without awaiting a receiver');
    await h.deliver();
    assert.equal(sink.received.length, 3);
    const feed = await h.agent.call<FeedPage>('work_feed');
    for (const [job, type] of [[idle, 'idle'], [input, 'needs_input'], [failed, 'failed']] as const) {
      const entries = sink.received.filter((entry) => entry.payload.jobId === job.jobId);
      assert.equal(entries.length, 1);
      const entry = entries[0]!;
      const payload = entry.payload;
      const thread = h.fake.threadForJob(job.jobId);
      const event = feed.events.find((event) => event.jobId === job.jobId && event.toState === (type === 'failed' ? 'idle' : type));
      assert.ok(event);
      assert.deepEqual({
        type: payload.type, state: payload.state, previousState: payload.previousState, feedSequence: payload.feedSequence,
        feedCursor: payload.feedCursor, projectAlias: payload.projectAlias, host: payload.host, projectId: payload.projectId,
        title: payload.title, threadId: payload.threadId, link: payload.link, standing: payload.standing,
        waitingOnDelegatedWork: payload.waitingOnDelegatedWork, turnInitiator: payload.turnInitiator,
      }, {
        type, state: type === 'failed' ? 'idle' : type, previousState: 'running', feedSequence: Number(event.cursor), feedCursor: event.cursor,
        projectAlias: 'pilot', host: 'main', projectId: 'project-1', title: job.title, threadId: thread.threadId,
        link: `t3-thread://v1/${thread.threadId}`, standing: false, waitingOnDelegatedWork: false,
        turnInitiator: { kind: 'gateway', clientId: h.agent.clientId },
      });
      assert.ok(payload.eventId.length >= 16);
      assert.equal(payload.timestamp, new Date(h.gw.clock()).toISOString());
      assert.equal(entry.method, 'POST');
      assert.equal(entry.headers['x-synthetic-sender-key'], HEADER_VALUE);
      assert.match(String(entry.headers['content-type']), /^application\/json/);
      assert.equal('excerpt' in payload, false);
      assert.equal('excerptTruncated' in payload, false);
    }
    assert.equal(new Set(sink.received.map((entry) => entry.payload.eventId)).size, 3);
    await h.tick();
    await h.deliver();
    assert.equal(sink.received.length, 3, 'unchanged observations do not produce another event');
    const serialized = JSON.stringify(sink.received.map((entry) => entry.payload));
    for (const secret of ['never sent to a webhook', 'confidential worker', 'private question', 'secret option', HEADER_VALUE]) {
      assert.equal(serialized.includes(secret), false);
    }
    assertNotLogged(h.gw, [sink.url, HEADER_VALUE, 'confidential worker', 'private question']);
  });

  test('cancelled events include honest null thread fields for a queued cancellation', async (t) => {
    const sink = await receiver(t);
    const h = await harness(t, [subscription(sink.url)]);
    const queued = await startJob(h.agent, 'Synthetic task', { title: 'Synthetic cancelled queue' });
    await h.agent.call('work_cancel', { jobId: queued.jobId });
    const active = await startJob(h.agent);
    await h.tick();
    await h.agent.call('work_cancel', { jobId: active.jobId });
    await h.tick();
    await h.deliver();
    assert.equal(sink.received.length, 2);
    const early = sink.received.find((entry) => entry.payload.jobId === queued.jobId)!.payload;
    assert.deepEqual([early.type, early.previousState, early.threadId, early.link, early.projectId, early.turnInitiator],
      ['cancelled', 'queued', null, null, null, { kind: 'unknown', clientId: null }]);
    const running = sink.received.find((entry) => entry.payload.jobId === active.jobId)!.payload;
    assert.deepEqual([running.type, running.state, running.previousState], ['cancelled', 'cancelled', 'cancel_requested']);
    await h.deliver();
    assert.equal(sink.received.length, 2);
  });

  test('a scratch job is captured and delivered like any job: scratch alias, host and project id, no branch, launch attribution', async (t) => {
    const scratchSink = await receiver(t);
    const worktreeSink = await receiver(t);
    const events = ['running', 'idle', 'cancelled'];
    const h = await harness(t, [
      subscription(scratchSink.url, { id: 'scratch', projects: ['scratch'], hosts: ['main'], events }),
      subscription(worktreeSink.url, { id: 'worktrees', projects: ['pilot'], events }),
    ], {
      host: { discovery: { enabled: true }, defaultProject: 'scratch' },
      projects: [{ alias: 'scratch', host: 'main', t3ProjectId: 'project-3', workspaceMode: 'scratch', runtimeMode: 'auto' }],
    });
    h.fake.scratchProjectId = 'project-3';
    type Started = { job: { jobId: string; title: string; project: string; projectId: string; branch: string; workspaceMode: string } };
    const start = (requestId: string, title: string) => h.agent.call<Started>('work_start', {
      target: { host: 'main' }, task: 'Synthetic scratch task never sent to a webhook', title, requestId,
    });
    const { job } = await start('scratch-run', 'Synthetic scratch job');
    const { job: queued } = await start('scratch-cancelled', 'Synthetic cancelled scratch job');
    assert.deepEqual([job.project, job.projectId, job.branch, job.workspaceMode], ['scratch', 'project-3', '', 'scratch']);
    await h.agent.call('work_cancel', { jobId: queued.jobId });
    await h.tick();
    const thread = h.fake.threadForJob(job.jobId);
    assert.equal(thread.launch.scratch, true);
    assert.equal(thread.projectId, 'project-3');
    // The launch recorded who started the first run, as it does for a worktree launch.
    const turns = h.gw.services.db.prepare('SELECT run_id, client_id FROM job_turns WHERE job_id = ?').all(job.jobId).map((row) => ({ ...row }));
    assert.deepEqual(turns, [{ run_id: thread.runs[0]!.runId, client_id: h.agent.clientId }]);
    h.fake.finishTurn(thread.threadId, 'Synthetic confidential scratch result');
    await h.tick();
    assert.equal(scratchSink.received.length, 0, 'job transitions commit without awaiting a receiver');
    await h.deliver();

    assert.deepEqual(scratchSink.received.map((entry) => [entry.payload.jobId, entry.payload.type]),
      [[queued.jobId, 'cancelled'], [job.jobId, 'running'], [job.jobId, 'idle']]);
    const feed = await h.agent.call<FeedPage>('work_feed');
    const common = { projectAlias: 'scratch', host: 'main', projectId: 'project-3', standing: false, waitingOnDelegatedWork: false };
    const launched = { threadId: thread.threadId, link: `t3-thread://v1/${thread.threadId}`, turnInitiator: { kind: 'gateway', clientId: h.agent.clientId } };
    const expected = [
      { jobId: queued.jobId, title: queued.title, type: 'cancelled', state: 'cancelled', previousState: 'queued', ...common,
        threadId: null, link: null, turnInitiator: { kind: 'unknown', clientId: null } },
      { jobId: job.jobId, title: job.title, type: 'running', state: 'running', previousState: 'dispatching', ...common, ...launched },
      { jobId: job.jobId, title: job.title, type: 'idle', state: 'idle', previousState: 'running', ...common, ...launched },
    ];
    scratchSink.received.forEach(({ payload }, index) => {
      const event = feed.events.find((candidate) => candidate.cursor === payload.feedCursor);
      assert.ok(event, 'every delivery names a feed event');
      assert.deepEqual([event.jobId, event.toState], [payload.jobId, payload.state]);
      assert.deepEqual({
        jobId: payload.jobId, title: payload.title, type: payload.type, state: payload.state, previousState: payload.previousState,
        projectAlias: payload.projectAlias, host: payload.host, projectId: payload.projectId, standing: payload.standing,
        waitingOnDelegatedWork: payload.waitingOnDelegatedWork, threadId: payload.threadId, link: payload.link, turnInitiator: payload.turnInitiator,
      }, expected[index]);
      assert.equal(payload.feedSequence, Number(event.cursor));
      assert.equal('branch' in payload, false, 'a webhook never carries a branch');
    });
    assert.equal(worktreeSink.received.length, 0, 'the project filter matches the scratch alias, not the pilot worktree project');
    const serialized = JSON.stringify(scratchSink.received.map((entry) => entry.payload));
    for (const secret of ['never sent to a webhook', 'confidential scratch result', HEADER_VALUE]) assert.equal(serialized.includes(secret), false);
    assertNotLogged(h.gw, [scratchSink.url, HEADER_VALUE, 'confidential scratch result']);
  });

  test('delegated_work_ended and an entire unseen turn each produce one snapshot with unknown attribution', async (t) => {
    const sink = await receiver(t);
    const h = await harness(t, [subscription(sink.url)]);
    const threadId = h.fake.launchDirect({ projectId: 'project-1', title: 'Synthetic coordinator' }).threadId;
    const adopted = await h.gw.services.jobs.adopt({ project: 'pilot', threadId });
    await h.agent.call('work_continue', { jobId: adopted.job.id, message: 'Synthetic delegate task', requestId: 'delegate-1' });
    const child = h.fake.delegate(threadId, 'Synthetic private child task');
    h.fake.finishTurn(threadId, 'Synthetic waiting on child');
    await h.tick();
    await h.deliver();
    assert.deepEqual([sink.received[0]!.payload.type, sink.received[0]!.payload.waitingOnDelegatedWork, sink.received[0]!.payload.standing],
      ['idle', true, true]);
    h.fake.settleDelegated(child.childThreadId, 'failed');
    h.gw.clock.advance(2 * MINUTE);
    await h.tick();
    await h.deliver();
    const ended = sink.received.at(-1)!.payload;
    assert.deepEqual([ended.type, ended.state, ended.previousState, ended.waitingOnDelegatedWork], ['delegated_work_ended', 'idle', 'idle', false]);
    h.fake.userTurn(threadId, 'Synthetic user text');
    h.fake.finishTurn(threadId, 'Synthetic unseen turn complete');
    h.gw.clock.advance(2 * MINUTE);
    await h.tick();
    await h.deliver();
    const unseen = sink.received.at(-1)!.payload;
    assert.deepEqual([unseen.type, unseen.previousState, unseen.state, unseen.turnInitiator],
      ['idle', 'idle', 'idle', { kind: 'unknown', clientId: null }]);
    const feed = await h.agent.call<FeedPage>('work_feed');
    assert.equal(feed.events.find((event) => event.cursor === unseen.feedCursor)?.type, 'turn_finished');
    assert.equal(feed.events.find((event) => event.cursor === ended.feedCursor)?.type, 'delegated_work_ended');
    h.gw.clock.advance(2 * MINUTE);
    await h.tick();
    await h.deliver();
    assert.equal(sink.received.length, 3);
  });

  test('steering by another gateway caller does not rewrite run attribution; a new started turn does', async (t) => {
    const sink = await receiver(t);
    const h = await harness(t, [subscription(sink.url, { events: ['idle', 'running', 'needs_input'] })]);
    const other = await connectAgent(t, h.gw);
    const job = await startJob(h.agent);
    await h.tick();
    const threadId = h.fake.threadForJob(job.jobId).threadId;
    await other.call('work_continue', { jobId: job.jobId, message: 'Synthetic steer', requestId: 'steer' });
    h.fake.finishTurn(threadId, 'Synthetic first result');
    await h.tick();
    await h.deliver();
    assert.deepEqual(sink.received.at(-1)!.payload.turnInitiator, { kind: 'gateway', clientId: h.agent.clientId });
    await other.call('work_continue', { jobId: job.jobId, message: 'Synthetic new turn', requestId: 'next' });
    h.fake.finishTurn(threadId, 'Synthetic next result');
    await h.tick();
    await h.deliver();
    assert.deepEqual(sink.received.at(-1)!.payload.turnInitiator, { kind: 'gateway', clientId: other.clientId });
    h.fake.userTurn(threadId, 'Synthetic new unknown turn');
    h.gw.clock.advance(2 * MINUTE);
    await h.tick();
    await h.deliver();
    assert.deepEqual([sink.received.at(-1)!.payload.type, sink.received.at(-1)!.payload.turnInitiator],
      ['running', { kind: 'unknown', clientId: null }]);
    h.fake.requestApproval(threadId);
    await h.tick();
    await h.deliver();
    assert.deepEqual([sink.received.at(-1)!.payload.type, sink.received.at(-1)!.payload.turnInitiator],
      ['needs_input', { kind: 'unknown', clientId: null }]);
    h.fake.grantApprovals(threadId);
    await h.tick();
    await other.call('work_continue', { jobId: job.jobId, message: 'Synthetic steer of unknown', requestId: 'steer-unknown' });
    h.fake.finishTurn(threadId, 'Synthetic unknown finished');
    await h.tick();
    await h.deliver();
    assert.deepEqual(sink.received.at(-1)!.payload.turnInitiator, { kind: 'unknown', clientId: null });
  });

  test('subscription project, host and event filters intersect, disabled routes stay silent, and matching routes share event IDs', async (t) => {
    const sinks = await Promise.all(Array.from({ length: 6 }, () => receiver(t)));
    const h = await harness(t, [
      subscription(sinks[0]!.url, { id: 'pilot', projects: ['pilot'], hosts: ['main'], events: ['idle'] }),
      subscription(sinks[1]!.url, { id: 'docs', projects: ['docs'], events: ['idle'] }),
      subscription(sinks[2]!.url, { id: 'other-host', hosts: ['secondary'], events: ['idle'] }),
      subscription(sinks[3]!.url, { id: 'failure', events: ['failed'] }),
      subscription(sinks[4]!.url, { id: 'disabled', enabled: false }),
      subscription(sinks[5]!.url, { id: 'all', events: ['idle'] }),
    ]);
    const pilot = await startJob(h.agent);
    const docs = await startJob(h.agent, 'Synthetic docs', { project: 'docs' });
    await h.tick();
    for (const job of [pilot, docs]) h.fake.finishTurn(h.fake.threadForJob(job.jobId).threadId, 'Synthetic result');
    await h.tick();
    await h.deliver();
    assert.deepEqual(sinks.map((sink) => sink.received.length), [1, 1, 0, 0, 0, 2]);
    for (const sink of sinks.slice(0, 2)) {
      const payload = sink.received[0]!.payload;
      assert.equal(payload.eventId, sinks[5]!.received.find((entry) => entry.payload.jobId === payload.jobId)!.payload.eventId);
    }
  });

  test('excerpts are per-subscription opt-in, bounded, and never include task or question content', async (t) => {
    const metadata = await receiver(t);
    const excerpts = await receiver(t);
    const h = await harness(t, [subscription(metadata.url), subscription(excerpts.url, { id: 'excerpt', excerptChars: 80 })]);
    const job = await startJob(h.agent, 'Synthetic task-only secret', { title: 'Synthetic safe explicit title' });
    await h.tick();
    const message = `Synthetic worker text ${'x'.repeat(5000)} full-transcript-tail-secret`;
    h.fake.finishTurn(h.fake.threadForJob(job.jobId).threadId, message);
    await h.tick();
    await h.deliver();
    assert.equal('excerpt' in metadata.received[0]!.payload, false);
    assert.deepEqual([excerpts.received[0]!.payload.excerpt, excerpts.received[0]!.payload.excerptTruncated], [message.slice(0, 80), true]);
    assert.equal(metadata.received[0]!.payload.eventId, excerpts.received[0]!.payload.eventId);
    assert.equal(JSON.stringify([...metadata.received, ...excerpts.received].map((entry) => entry.payload)).includes('task-only secret'), false);
    const diagnostic = JSON.stringify(h.gw.services.webhooks.diagnostics());
    for (const secret of [HEADER_VALUE, h.token, ...h.fake.validTokens, metadata.url, excerpts.url, message.slice(0, 80), 'full-transcript-tail-secret']) {
      assert.equal(diagnostic.includes(secret), false);
    }
    assertNotLogged(h.gw, [HEADER_VALUE, h.token, ...h.fake.validTokens, message.slice(0, 80), metadata.url, excerpts.url]);
  });
});

describe('durable webhook delivery and polling fallback', () => {
  test('failed completion bookkeeping releases sender slots and recovers immutable attempts after their leases', async (t) => {
    const uncertain = await receiver(t);
    const healthy = await receiver(t);
    const h = await harness(t, [
      ...Array.from({ length: 4 }, (_, n) => subscription(uncertain.url, { id: `uncertain-${n}`, projects: ['pilot'] })),
      subscription(healthy.url, { id: 'healthy', projects: ['docs'] }),
    ]);
    // Fault the actual completion transaction after the receiver acknowledges, preserving the
    // ambiguous attempt. A raw SQLite error can carry private data and must never reach logs.
    h.gw.services.db.exec(`CREATE TRIGGER synthetic_finish_failure BEFORE UPDATE OF state ON webhook_deliveries
      WHEN OLD.subscription_id LIKE 'uncertain-%' AND NEW.state = 'delivered'
      BEGIN SELECT RAISE(ABORT, 'Synthetic private database-error content'); END;`);
    const first = await startJob(h.agent);
    await h.agent.call('work_cancel', { jobId: first.jobId });
    await h.gw.gateway.webhooks.tick();
    assert.equal(uncertain.received.length, 4);
    assert.equal(h.gw.services.webhooks.diagnostics().attempts.filter((a) => a.outcome === 'in_progress').length, 4);
    assert.equal(h.gw.logs.filter((line) => JSON.parse(line).event === 'webhooks.tick_failed').length, 4);
    const original = uncertain.received.map((entry) => entry.body);
    const later = await startJob(h.agent, 'Synthetic healthy task', { project: 'docs' });
    await h.agent.call('work_cancel', { jobId: later.jobId });
    await h.gw.gateway.webhooks.tick();
    assert.equal(healthy.received.length, 1, 'all four failed local attempts release their slots');
    assert.equal(uncertain.received.length, 4, 'unexpired leases still prevent another send');
    h.gw.services.db.exec('DROP TRIGGER synthetic_finish_failure');
    h.gw.clock.advance(30_000);
    await h.deliver();
    assert.deepEqual(uncertain.received.slice(4).map((entry) => entry.body), original);
    const attempts = h.gw.services.webhooks.diagnostics().attempts;
    assert.equal(attempts.filter((a) => a.outcome === 'abandoned').length, 4);
    assert.equal(attempts.filter((a) => a.outcome === 'delivered').length, 5);
    assertNotLogged(h.gw, ['Synthetic private database-error content', HEADER_VALUE, uncertain.url, healthy.url]);
  });

  test('retry backoff retains the exact snapshot, while later events can arrive first and feed catch-up stays exclusive', async (t) => {
    const sink = await receiver(t);
    let failure = true;
    sink.respond((_entry, response) => response.writeHead(failure ? 503 : 204).end('Synthetic response-body secret'));
    const h = await harness(t, [subscription(sink.url, { excerptChars: 40 })]);
    const before = await h.agent.call<FeedPage>('work_feed');
    const job = await startJob(h.agent);
    await h.tick();
    const threadId = h.fake.threadForJob(job.jobId).threadId;
    h.fake.finishTurn(threadId, 'Synthetic first immutable worker text');
    await h.tick();
    await h.deliver();
    const first = sink.received[0]!;
    assert.equal(first.payload.type, 'idle');
    failure = false;
    await h.agent.call('work_continue', { jobId: job.jobId, message: 'Synthetic follow-up', requestId: 'later-turn' });
    h.fake.failRun(threadId);
    await h.tick();
    await h.deliver();
    assert.equal(sink.received.length, 2, 'a later logical event need not await an earlier retry');
    const later = sink.received[1]!.payload;
    assert.equal(later.type, 'failed');
    assert.ok(later.feedSequence > first.payload.feedSequence);
    h.gw.clock.advance(4999);
    await h.deliver();
    assert.equal(sink.received.length, 2, 'first retry waits five seconds');
    h.gw.clock.advance(1);
    await h.deliver();
    assert.equal(sink.received.length, 3);
    assert.equal(sink.received[2]!.body, first.body, 'the original state, excerpt, timestamp and ID survive the job changing');
    assert.equal(new Set(sink.received.map((entry) => entry.payload.eventId)).size, 2);

    // Save only contiguous feed progress; never use the maximum delivered webhook sequence as a skip watermark.
    let cursor = before.nextCursor;
    const caughtUp: FeedPage['events'] = [];
    for (let page = 0; page < 20; page++) {
      const result = await h.agent.call<FeedPage>('work_feed', { cursor, limit: 2 });
      assert.equal(typeof result.nextCursor, 'string');
      assert.ok(result.events.every((event) => Number(event.cursor) > Number(cursor)));
      caughtUp.push(...result.events);
      cursor = result.nextCursor;
      if (!result.hasMore) break;
      assert.ok(page < 19);
    }
    assert.equal(new Set(caughtUp.map((event) => event.cursor)).size, caughtUp.length);
    assert.ok(caughtUp.some((event) => event.cursor === first.payload.feedCursor));
    assert.ok(caughtUp.some((event) => event.cursor === later.feedCursor));
    assert.deepEqual((await h.agent.call<FeedPage>('work_feed', { cursor })).events, []);
    const diagnostics = JSON.stringify(h.gw.services.webhooks.diagnostics());
    assert.equal(diagnostics.includes('Synthetic response-body secret'), false);
    assert.equal(diagnostics.includes('immutable worker'), false);
  });

  test('retries exponentially, expires after one hour, and does not keep sending an exhausted event', async (t) => {
    const sink = await receiver(t);
    sink.respond((_entry, response) => response.writeHead(429).end('Synthetic private response'));
    const h = await harness(t, [subscription(sink.url)]);
    const job = await startJob(h.agent);
    await h.agent.call('work_cancel', { jobId: job.jobId });
    await h.deliver();
    h.gw.clock.advance(5000);
    await h.deliver();
    h.gw.clock.advance(9999);
    await h.deliver();
    assert.equal(sink.received.length, 2);
    h.gw.clock.advance(1);
    await h.deliver();
    assert.equal(sink.received.length, 3);
    assert.equal(new Set(sink.received.map((entry) => entry.body)).size, 1);
    h.gw.clock.advance(HOUR);
    await h.deliver();
    await h.deliver();
    assert.equal(sink.received.length, 3, 'expired events produce no new network attempt');
    assert.match(JSON.stringify(h.gw.services.webhooks.diagnostics()), /exhausted|expired/);
    const attempts = await cli(h, ['webhooks', 'attempts', 'routine', '--limit', '2']);
    assert.equal(attempts.code, 0, attempts.err);
    assert.equal(attempts.out.includes('Synthetic private response'), false);
    assert.equal(attempts.out.includes(HEADER_VALUE), false);
    assert.equal(attempts.out.includes(sink.url), false);
  });

  test('pending committed events and authoritative run attribution survive gateway restart', async (t) => {
    const sink = await receiver(t);
    const subscriptions = [subscription(sink.url)];
    const first = await harness(t, subscriptions);
    const job = await startJob(first.agent);
    const stillRunning = await startJob(first.agent);
    await first.tick();
    const threadId = first.fake.threadForJob(job.jobId).threadId;
    first.fake.finishTurn(threadId, 'Synthetic committed but undelivered reply');
    await first.tick();
    const feed = await first.agent.call<FeedPage>('work_feed');
    await first.agent.client.close();
    await first.gw.gateway.close();
    first.gw.door.disconnect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const restarted = await harness(t, subscriptions, {
      fake: first.fake, dataDir: first.gw.dataDir, door: first.gw.door, clock: first.gw.clock,
    });
    await restarted.deliver();
    assert.equal(sink.received.length, 1);
    const payload = sink.received[0]!.payload;
    assert.equal(payload.feedCursor, feed.events.find((event) => event.jobId === job.jobId && event.toState === 'idle')!.cursor);
    assert.deepEqual(payload.turnInitiator, { kind: 'gateway', clientId: first.agent.clientId });
    await restarted.tick();
    await restarted.deliver();
    assert.equal(sink.received.length, 1, 'recovery does not create a second logical completion');
    const after = await restarted.agent.call<FeedPage>('work_feed', { cursor: feed.nextCursor });
    assert.deepEqual(after.events, []);
    restarted.fake.finishTurn(restarted.fake.threadForJob(stillRunning.jobId).threadId, 'Synthetic completion after restart');
    await restarted.tick();
    await restarted.deliver();
    assert.equal(sink.received.length, 2);
    assert.deepEqual(sink.received[1]!.payload.turnInitiator, { kind: 'gateway', clientId: first.agent.clientId },
      'run attribution, not only an already-enqueued payload, survives restart');
  });

  test('a failed attempt resumes after restart using the same ID and bytes', async (t) => {
    const sink = await receiver(t);
    sink.respond((_entry, response) => response.writeHead(500).end());
    const subscriptions = [subscription(sink.url)];
    const first = await harness(t, subscriptions);
    const job = await startJob(first.agent);
    await first.agent.call('work_cancel', { jobId: job.jobId });
    await first.deliver();
    const original = sink.received[0]!.body;
    await first.agent.client.close();
    await first.gw.gateway.close();
    first.gw.door.disconnect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const next = await harness(t, subscriptions, { fake: first.fake, dataDir: first.gw.dataDir, door: first.gw.door, clock: first.gw.clock });
    await next.deliver();
    assert.equal(sink.received.length, 1, 'restart preserves the next-attempt deadline');
    sink.respond((_entry, response) => response.writeHead(204).end());
    next.gw.clock.advance(5000);
    await next.deliver();
    assert.equal(sink.received.length, 2);
    assert.equal(sink.received[1]!.body, original);
  });

  test('new subscriptions do not replay history and disabled, removed or revised routes cannot leak queued events', async (t) => {
    const original = await receiver(t);
    const replacement = await receiver(t);
    const h = await harness(t, []);
    const historical = await startJob(h.agent);
    await h.agent.call('work_cancel', { jobId: historical.jobId });
    const configure = (subscriptions: Record<string, unknown>[]) => {
      const config = parseConfig({ ...h.gw.services.config, webhooks: { subscriptions } });
      h.gw.services.webhooks.reconcile(config.webhooks, h.gw.dataDir);
    };
    configure([subscription(original.url)]);
    await h.deliver();
    assert.equal(original.received.length, 0, 'enabling a new route starts with future events');
    const cancel = async () => {
      const job = await startJob(h.agent);
      await h.agent.call('work_cancel', { jobId: job.jobId });
    };
    await cancel();
    configure([subscription(original.url, { enabled: false })]);
    await h.deliver();
    assert.equal(original.received.length, 0);
    configure([subscription(original.url)]);
    await h.deliver();
    assert.equal(original.received.length, 0, 're-enabling does not revive disabled backlog');
    await cancel();
    configure([subscription(replacement.url)]);
    await h.deliver();
    assert.equal(replacement.received.length, 0, 'a changed destination never receives the previous recipient backlog');
    await cancel();
    configure([]);
    configure([subscription(replacement.url)]);
    await h.deliver();
    assert.equal(replacement.received.length, 0, 'removal and re-addition never revive a queue');
    await cancel();
    await h.deliver();
    assert.equal(replacement.received.length, 1, 'new events reach the current enabled route');
    assert.equal(original.received.length, 0);
  });

  test('read-only service/CLI opens with old configuration cannot revert the active route', async (t) => {
    const old = await receiver(t);
    const current = await receiver(t);
    const h = await harness(t, [subscription(old.url)]);
    const originalConfig = h.gw.services.config;
    const changed = parseConfig({ ...originalConfig, webhooks: { subscriptions: [subscription(current.url)] } });
    h.gw.services.webhooks.reconcile(changed.webhooks, h.gw.dataDir);
    const reader = openServices({ config: originalConfig, dataDir: h.gw.dataDir, logger: silentLogger, clock: h.gw.clock });
    await reader.close();
    const listed = await cli(h, ['webhooks', 'list'], originalConfig);
    assert.equal(listed.code, 0, listed.err);
    const job = await startJob(h.agent);
    await h.agent.call('work_cancel', { jobId: job.jobId });
    await h.deliver();
    assert.equal(old.received.length, 0);
    assert.equal(current.received.length, 1);
    for (const secret of [old.url, current.url, HEADER_VALUE]) assert.equal(JSON.stringify(listed).includes(secret), false);
  });

  test('outbox write failure rolls back the job, feed event and same-state watcher observation together', async (t) => {
    const sink = await receiver(t);
    const h = await harness(t, [subscription(sink.url, { excerptChars: 80 })]);
    const job = await startJob(h.agent);
    await h.tick();
    const threadId = h.fake.threadForJob(job.jobId).threadId;
    const failWrites = () => h.gw.services.db.exec(`CREATE TRIGGER synthetic_fail_outbox BEFORE INSERT ON webhook_deliveries
      BEGIN SELECT RAISE(FAIL, 'synthetic outbox failure'); END`);
    const restoreWrites = () => h.gw.services.db.exec('DROP TRIGGER synthetic_fail_outbox');
    const before = await h.agent.call<FeedPage>('work_feed');
    failWrites();
    h.fake.finishTurn(threadId, 'Synthetic atomic first message');
    await h.tick();
    assert.equal(h.gw.services.jobs.store.require(job.jobId).state, 'running');
    assert.equal(h.gw.services.jobs.store.require(job.jobId).latestMessageExcerpt, null);
    assert.deepEqual((await h.agent.call<FeedPage>('work_feed', { cursor: before.nextCursor })).events, []);
    restoreWrites();
    await h.tick();
    await h.deliver();
    assert.equal(sink.received.length, 1);
    const baseline = h.gw.services.jobs.store.require(job.jobId);
    const cursor = (await h.agent.call<FeedPage>('work_feed')).nextCursor;
    h.fake.userTurn(threadId, 'Synthetic turn between polls');
    h.fake.finishTurn(threadId, 'Synthetic atomic second message');
    h.gw.clock.advance(2 * MINUTE);
    failWrites();
    await h.tick();
    const rolledBack = h.gw.services.jobs.store.require(job.jobId);
    assert.deepEqual([rolledBack.lastRunId, rolledBack.readPosition, rolledBack.latestMessageExcerpt],
      [baseline.lastRunId, baseline.readPosition, baseline.latestMessageExcerpt]);
    assert.deepEqual((await h.agent.call<FeedPage>('work_feed', { cursor })).events, []);
    restoreWrites();
    h.gw.clock.advance(2 * MINUTE);
    await h.tick();
    await h.deliver();
    assert.equal(sink.received.length, 2);
    assert.equal(sink.received[1]!.payload.excerpt, 'Synthetic atomic second message');
    assert.equal((await h.agent.call<FeedPage>('work_feed', { cursor })).events[0]!.type, 'turn_finished');
  });
});

describe('webhook transport safety and operator checks', () => {
  test('the automatic sender delivers new healthy events while an earlier response remains held', async (t) => {
    const slow = await receiver(t);
    const healthy = await receiver(t);
    slow.respond(() => {});
    const h = await harness(t, [subscription(slow.url, { id: 'slow' }), ...['one', 'two', 'three'].map((id) =>
      subscription(healthy.url, { id }))], { attemptTimeoutMs: 10_000 });
    const first = await startJob(h.agent);
    await h.agent.call('work_cancel', { jobId: first.jobId });
    h.gw.gateway.webhooks.start();
    try {
      await Promise.all([slow.whenReceived(1), healthy.whenReceived(3)]);
      const next = await startJob(h.agent);
      await h.agent.call('work_cancel', { jobId: next.jobId });
      await within(healthy.whenReceived(6), 4000);
      assert.equal(slow.received.length, 1, 'one stalled subscription must not occupy another sender slot');
      assert.equal(h.gw.services.webhooks.diagnostics('slow').attempts[0]!.outcome, 'in_progress');
      assert.equal(healthy.received.filter((entry) => entry.payload.jobId === next.jobId).length, 3);
    } finally { await h.gw.gateway.webhooks.stop(); }
  });

  test('a stalled subscription backlog cannot consume the slots of a healthy subscription', async (t) => {
    const slow = await receiver(t);
    const healthy = await receiver(t);
    slow.respond(() => {});
    const h = await harness(t, [subscription(slow.url, { id: 'slow', projects: ['pilot'] }),
      subscription(healthy.url, { id: 'healthy', projects: ['docs'] })], { attemptTimeoutMs: 10_000 });
    for (let n = 0; n < 6; n++) {
      const job = await startJob(h.agent);
      await h.agent.call('work_cancel', { jobId: job.jobId });
    }
    const job = await startJob(h.agent, 'Synthetic healthy work', { project: 'docs' });
    await h.agent.call('work_cancel', { jobId: job.jobId });
    const sending = h.gw.gateway.webhooks.tick();
    try {
      await within(healthy.whenReceived(1), 4000);
      assert.equal(slow.received.length, 1);
      assert.equal(healthy.received[0]!.payload.jobId, job.jobId);
      assert.equal(h.gw.services.webhooks.diagnostics('slow').attempts[0]!.outcome, 'in_progress');
    } finally { await h.gw.gateway.webhooks.stop(); await sending; }
  });

  test('overlapping ticks never exceed four active deliveries and stop aborts every occupied slot', async (t) => {
    const sink = await receiver(t);
    sink.respond(() => {});
    const h = await harness(t, Array.from({ length: 6 }, (_, n) => subscription(sink.url, { id: `routine-${n}` })),
      { attemptTimeoutMs: 10_000 });
    const job = await startJob(h.agent);
    await h.agent.call('work_cancel', { jobId: job.jobId });
    const ticks = [h.gw.gateway.webhooks.tick(), h.gw.gateway.webhooks.tick(), h.gw.gateway.webhooks.tick()];
    try {
      await within(sink.whenReceived(4), 4000);
      await h.agent.call('work_status', { jobId: job.jobId });
      assert.equal(sink.received.length, 4);
      assert.equal(h.gw.services.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE state = 'sending'").get()!.n, 4);
    } finally { await within(h.gw.gateway.webhooks.stop(), 2000); await Promise.all(ticks); }
    assert.equal(h.gw.services.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE state = 'sending'").get()!.n, 0);
    assert.equal(h.gw.services.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE state = 'pending'").get()!.n, 6);
    assert.equal(h.gw.services.webhooks.diagnostics().attempts.filter((attempt) => attempt.outcome === 'stopped').length, 4);
    await h.gw.gateway.webhooks.tick();
    assert.equal(sink.received.length, 4, 'a stopped sender cannot claim more work');
  });

  test('a network reset after request arrival retries the same event with no raw socket diagnostics', async (t) => {
    const sink = await receiver(t);
    // Reset after the request arrives, as required by AGENTS.md for the Node 26/macOS socket race.
    sink.respond((_entry, response) => response.socket?.destroy());
    const h = await harness(t, [subscription(sink.url)]);
    const job = await startJob(h.agent);
    await h.agent.call('work_cancel', { jobId: job.jobId });
    await h.deliver();
    assert.equal(sink.received.length, 1);
    assert.equal(h.gw.services.webhooks.diagnostics().attempts[0]!.outcome, 'network_error');
    sink.respond((_entry, response) => response.writeHead(204).end());
    h.gw.clock.advance(5000);
    await h.deliver();
    assert.equal(sink.received.length, 2);
    assert.equal(sink.received[1]!.body, sink.received[0]!.body);
    const diagnostics = JSON.stringify(h.gw.services.webhooks.diagnostics());
    for (const value of [sink.url, HEADER_VALUE, 'ECONNRESET', 'socket hang up']) assert.equal(diagnostics.includes(value), false);
  });

  test('deadlines cover delayed headers and a response body that never finishes, without delaying MCP', async (t) => {
    for (const phase of ['headers', 'body']) {
      const sink = await receiver(t);
      sink.respond((_entry, response) => {
        if (phase === 'body') { response.writeHead(200); response.write('Synthetic private incomplete response'); }
      });
      const h = await harness(t, [subscription(sink.url)], { attemptTimeoutMs: 60 });
      const job = await startJob(h.agent);
      await h.agent.call('work_cancel', { jobId: job.jobId });
      const sending = h.deliver();
      await sink.whenReceived(1);
      const status = await h.agent.call<{ state: string }>('work_status', { jobId: job.jobId });
      assert.equal(status.state, 'cancelled', 'MCP remains responsive during an in-flight webhook');
      await sending;
      assert.match(JSON.stringify(h.gw.services.webhooks.diagnostics()), /timeout/);
      sink.respond((_entry, response) => response.writeHead(204).end());
      h.gw.clock.advance(5000);
      await h.deliver();
      assert.equal(sink.received.length, 2);
      assert.equal(sink.received[0]!.body, sink.received[1]!.body);
      assertNotLogged(h.gw, ['Synthetic private incomplete response', sink.url, HEADER_VALUE]);
    }
  });

  test('redirects never forward authentication and oversized responses are bounded and sanitized', async (t) => {
    const redirect = await receiver(t);
    const target = await receiver(t);
    redirect.respond((_entry, response) => response.writeHead(307, { location: target.url }).end('Synthetic redirect-body secret'));
    const h = await harness(t, [subscription(redirect.url)]);
    const job = await startJob(h.agent);
    await h.agent.call('work_cancel', { jobId: job.jobId });
    await h.deliver();
    assert.equal(redirect.received.length, 1);
    assert.equal(target.received.length, 0, 'not even a same-host redirect receives the auth header');
    assert.match(JSON.stringify(h.gw.services.webhooks.diagnostics()), /307/);
    redirect.respond((_entry, response) => response.writeHead(200).end(`Synthetic response secret ${'x'.repeat(40000)}`));
    h.gw.clock.advance(5000);
    await h.deliver();
    const diagnostics = JSON.stringify(h.gw.services.webhooks.diagnostics());
    assert.match(diagnostics, /limit|large|oversize/);
    assert.equal(diagnostics.includes('Synthetic response secret'), false);
    assert.equal(target.received.length, 0);
  });

  test('concurrent sender ticks claim one delivery and shutdown leaves interrupted attempts recoverable', async (t) => {
    const sink = await receiver(t);
    sink.respond(() => {});
    const subscriptions = [subscription(sink.url)];
    const h = await harness(t, subscriptions, { attemptTimeoutMs: 1000 });
    const job = await startJob(h.agent);
    await h.agent.call('work_cancel', { jobId: job.jobId });
    const first = h.deliver();
    await sink.whenReceived(1);
    const parallel = Promise.all([h.deliver(), h.deliver()]);
    assert.equal(sink.received.length, 1);
    await h.agent.client.close();
    await h.gw.gateway.close();
    h.gw.door.disconnect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all([first, parallel]);
    sink.respond((_entry, response) => response.writeHead(204).end());
    h.gw.clock.advance(MINUTE);
    const restart = await harness(t, subscriptions, { fake: h.fake, dataDir: h.gw.dataDir, door: h.gw.door, clock: h.gw.clock });
    await restart.deliver();
    assert.equal(sink.received.length, 2, 'an ambiguous interrupted attempt may be redelivered');
    assert.equal(sink.received[0]!.body, sink.received[1]!.body);
  });

  test('CLI test ping sends real arbitrary-header auth and synthetic content without a job or subscription reconciliation', async (t) => {
    const sink = await receiver(t);
    const h = await harness(t, [subscription(sink.url)]);
    const before = await h.agent.call<FeedPage>('work_feed');
    const result = await cli(h, ['webhooks', 'ping', 'routine']);
    assert.equal(result.code, 0, result.err);
    assert.equal(sink.received.length, 1);
    const ping = sink.received[0]!;
    assert.equal(ping.headers['x-synthetic-sender-key'], HEADER_VALUE);
    assert.deepEqual(Object.keys(ping.payload).sort(), ['eventId', 'feedCursor', 'feedSequence', 'timestamp', 'type']);
    assert.equal(ping.payload.type, 'ping');
    assert.equal(ping.payload.feedSequence, null);
    assert.equal(ping.payload.feedCursor, null);
    assert.equal((await h.agent.call<FeedPage>('work_feed')).nextCursor, before.nextCursor);
    const attempts = await cli(h, ['webhooks', 'attempts', 'routine']);
    assert.equal(attempts.code, 0, attempts.err);
    for (const secret of [HEADER_VALUE, sink.url, 'synthetic-url-key']) assert.equal(JSON.stringify([result, attempts]).includes(secret), false);
    assertNotLogged(h.gw, [HEADER_VALUE, sink.url]);
    writeFileSync(join(h.gw.dataDir, 'grok.key'), '', { mode: 0o600 });
    const invalid = await cli(h, ['webhooks', 'ping', 'routine']);
    assert.equal(invalid.code, 1);
    assert.equal(sink.received.length, 1, 'an invalid credential never results in an unauthenticated test request');
  });
});

test('opt-in PR webhooks deliver bounded references once, with feed sequences and no worker metadata', async (t) => {
  const sink = await receiver(t);
  const h = await harness(t, [subscription(sink.url, { events: ['pull_request_opened', 'pull_request_merged'] })]);
  const job = await startJob(h.agent);
  await h.tick();
  const { threadId } = h.fake.threadForJob(job.jobId);
  const pr = { host: 'github.com', repository: 'sample/widgets', number: 21,
    url: 'https://github.com/sample/widgets/pull/21', state: 'open', title: 'PRIVATE-PR-TITLE', headBranch: 'PRIVATE-BRANCH' };
  h.fake.pullRequests.set(threadId, [pr]);
  h.gw.clock.advance(MINUTE + 1);
  await h.tick();
  await h.deliver();
  h.gw.clock.advance(MINUTE + 1);
  await h.tick();
  await h.deliver();
  h.fake.pullRequests.set(threadId, [{ ...pr, state: 'merged' }]);
  h.gw.clock.advance(MINUTE + 1);
  await h.tick();
  await h.deliver();
  assert.deepEqual(sink.received.map((r) => r.payload.type), ['pull_request_opened', 'pull_request_merged']);
  assert.equal(new Set(sink.received.map((r) => r.payload.eventId)).size, 2);
  for (const entry of sink.received) {
    const body = JSON.parse(entry.body);
    assert.deepEqual(body.pullRequests, [{ number: 21, state: body.type === 'pull_request_opened' ? 'open' : 'merged', url: pr.url }]);
    assert.equal(entry.body.includes('PRIVATE-'), false);
    const event = h.gw.services.jobs.store.recentEvents(job.jobId, 100).find((e) => e.id === body.feedSequence);
    assert.equal(event?.type, body.type);
  }
  assertNotLogged(h.gw, ['PRIVATE-PR-TITLE', 'PRIVATE-BRANCH', pr.url]);
});

test('PR webhooks carry at most twenty PRs, open ones first, from a job that follows two hundred, and stay inside the payload bound', async (t) => {
  const sink = await receiver(t);
  const h = await harness(t, [subscription(sink.url, { events: ['pull_request_opened', 'pull_request_merged'] })]);
  const job = await startJob(h.agent);
  await h.tick();
  const { threadId } = h.fake.threadForJob(job.jobId);
  // 205 linked PRs in a repository with a long name, #3 and #205 open and the rest merged: the job follows 200, the payload shows 20.
  const repository = `sample/${'w'.repeat(60)}`;
  h.fake.pullRequests.set(threadId, Array.from({ length: 205 }, (_, i) => ({
    host: 'github.com', repository, number: i + 1, url: `https://github.com/${repository}/pull/${i + 1}`,
    state: i + 1 === 3 || i + 1 === 205 ? 'open' : 'merged',
  })));
  h.gw.clock.advance(MINUTE + 1);
  await h.tick();
  await h.deliver();
  const followed = h.gw.services.jobs.store.require(job.jobId).pullRequests!;
  assert.equal(followed.length, 200);
  const everything = JSON.stringify(followed.map(({ number, state, url }) => ({ number, state, url })));
  assert.ok(Buffer.byteLength(everything) > MAX_PAYLOAD_BYTES, 'sending every PR the job follows would overflow the payload bound');
  // Both events arrive: neither was dropped for size.
  assert.deepEqual(sink.received.map((r) => r.payload.type).sort(), ['pull_request_merged', 'pull_request_opened']);
  for (const entry of sink.received) {
    assert.ok(Buffer.byteLength(entry.body) <= MAX_PAYLOAD_BYTES, 'inside the bound');
    const body = JSON.parse(entry.body) as { pullRequests: { number: number; state: string; url: string }[] };
    const newest = Array.from({ length: 18 }, (_, i) => 204 - i);
    assert.deepEqual(body.pullRequests.map((p) => p.number), [205, 3, ...newest], 'twenty: the open ones, then the newest');
    assert.deepEqual(Object.keys(body.pullRequests[0]!).sort(), ['number', 'state', 'url']);
  }
});

test('worker failures notify as failed with recoverable idle state; recovery emits once', async (t) => {
  const sink = await receiver(t);
  const h = await harness(t, [subscription(sink.url, { projects: ['pilot'], events: ['failed', 'running', 'idle'] })]);
  const job = await startJob(h.agent);
  await h.tick();
  await h.deliver();
  sink.received.length = 0;
  const thread = h.fake.threadForJob(job.jobId);
  h.fake.failRun(thread.threadId);
  await h.tick();
  await h.deliver();
  assert.deepEqual(sink.received.map((r) => [r.payload.type, r.payload.state]), [['failed', 'idle']]);
  h.gw.clock.advance(2 * MINUTE);
  await h.tick();
  await h.deliver();
  assert.equal(sink.received.length, 1);
  h.fake.userTurn(thread.threadId, 'Synthetic recovery');
  h.gw.clock.advance(2 * MINUTE);
  await h.tick();
  await h.deliver();
  assert.deepEqual(sink.received.map((r) => [r.payload.type, r.payload.state]), [['failed', 'idle'], ['running', 'running']]);
  assert.deepEqual(sink.received[1]!.payload.turnInitiator, { kind: 'unknown', clientId: null });
  await h.tick();
  await h.deliver();
  assert.equal(sink.received.length, 2);
  h.fake.finishTurn(thread.threadId, 'Synthetic completion');
  await h.tick();
  await h.deliver();
  assert.equal(sink.received.at(-1)!.payload.type, 'idle');
});
