import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { TestClock } from './clock.ts';
import { startFakeT3, type FakeT3 } from './fakeT3.ts';
import type { FrontDoor } from './frontDoor.ts';
import { startTestGateway, type TestGateway } from './gateway.ts';
import { signIn } from './oauthFlow.ts';

/** An agent connected to the gateway with a bearer token, calling tools like a hosted agent would. */
export interface Agent {
  clientId: string;
  client: Client;
  /** Call a tool and return its structuredContent; fails the test on a tool error. */
  call<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Call a tool that must fail; returns the error code and full text. */
  callError(name: string, args?: Record<string, unknown>): Promise<{ code: string; text: string }>;
}

export async function connectAgent(t: TestContext, gw: TestGateway, access: 'read' | 'operate' = 'operate'): Promise<Agent> {
  const { clientId, tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode, { access });
  return agentWithToken(t, gw.baseUrl, clientId, tokens.access_token);
}

export async function agentWithToken(t: TestContext, baseUrl: string, clientId: string, token: string): Promise<Agent> {
  const client = new Client({ name: 'test-agent', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: { token: async () => token } }));
  t.after(() => client.close());
  const text = (result: { content?: unknown }) => JSON.stringify(result.content ?? []);
  return {
    clientId,
    client,
    async call<T>(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name} failed: ${text(result)}`);
      return result.structuredContent as T;
    },
    async callError(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
      const content = (result.content as { type: string; text: string }[])[0]?.text ?? '';
      return { code: content.split(':')[0] ?? '', text: content };
    },
  };
}

export interface JobHarness {
  fake: FakeT3;
  gw: TestGateway;
  agent: Agent;
  /** Run one dispatcher and watcher tick. */
  tick(): Promise<void>;
  /** Advance the gateway clock past any host backoff, then tick. */
  tickAfter(ms: number): Promise<void>;
}

export interface JobHarnessOptions {
  maxConcurrentJobs?: number;
  fake?: FakeT3;
  dataDir?: string;
  /** Reuse the first gateway's front door (restart tests). */
  door?: FrontDoor;
  clock?: TestClock;
  watcher?: Record<string, unknown>;
  /** Run the engine on a timer instead of by hand. */
  intervalMs?: number;
  launchTimeoutMs?: number;
  /** Extra fields for the host's config entry. */
  host?: Record<string, unknown>;
}

/**
 * A gateway with one enrolled host backed by a fake T3, two projects, and an Operate agent.
 * The job engine is driven by hand with tick() unless intervalMs is given.
 */
export async function startJobHarness(t: TestContext, options: JobHarnessOptions = {}): Promise<JobHarness> {
  const fake = options.fake ?? (await startFakeT3());
  if (!options.fake) t.after(() => fake.close());
  const gw = await startTestGateway(t, {
    config: {
      hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand(), maxConcurrentJobs: options.maxConcurrentJobs ?? 2, ...options.host }],
      projects: [
        { alias: 'pilot', description: 'Synthetic pilot project', host: 'main', t3ProjectId: 'project-1', runtimeMode: 'auto', baseRef: 'main' },
        {
          alias: 'docs',
          host: 'main',
          t3ProjectTitle: 'Synthetic project 2',
          branchPrefix: 'agents/',
          baseRef: 'trunk',
          modelSelection: { model: 'synthetic-large' },
        },
      ],
      ...(options.watcher ? { watcher: { pollSeconds: 10, ...options.watcher } } : {}),
    },
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.door ? { door: options.door } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    jobEngine: {
      ...(options.intervalMs ? { intervalMs: options.intervalMs } : { autoStart: false }),
      ...(options.launchTimeoutMs ? { launchTimeoutMs: options.launchTimeoutMs } : {}),
    },
  });
  if (gw.services.registry.credentialStatus('main').state === 'missing') await gw.services.registry.enroll('main');
  const agent = await connectAgent(t, gw, 'operate');
  const tick = () => gw.gateway.engine.tick();
  return {
    fake,
    gw,
    agent,
    tick,
    async tickAfter(ms: number) {
      gw.clock.advance(ms);
      await tick();
    },
  };
}

export interface StartedJob {
  jobId: string;
  state: string;
  threadId: string | null;
  title: string;
  branch: string;
}

export async function startJob(agent: Agent, task = 'Synthetic task: add a README section', extra: Record<string, unknown> = {}): Promise<StartedJob> {
  const result = await agent.call<{ job: StartedJob; created: boolean }>('work_start', {
    project: 'pilot',
    task,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...extra,
  });
  return result.job;
}

export async function jobState(agent: Agent, jobId: string): Promise<string> {
  return (await agent.call<{ state: string }>('work_status', { jobId })).state;
}

/** Assert that none of the given content strings reached the logs. */
export function assertNotLogged(gw: TestGateway, contents: readonly string[]): void {
  const log = gw.logs.join('\n');
  for (const content of contents) assert.equal(log.includes(content), false, `content leaked into the logs: ${content.slice(0, 20)}…`);
}
