/**
 * Live end-to-end check against a running gateway and a real T3 host. Not part of `npm test`.
 * Acts as an agent: registers, is approved with an operator-minted code (Operate), exchanges the
 * code, then drives two small jobs through the work_* tools. Prints a pass/fail transcript with ids
 * and states only: no tokens, codes or worker output. See docs/operations.md, "Live end-to-end check".
 *
 *   T3FG_E2E_APPROVAL_CODE=XXXXX-XXXXX node scripts/e2e-live.ts [--config path]
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfig, resolvePaths } from '../src/config.ts';
import { pkceChallenge, randomToken } from '../src/crypto.ts';

const HARMLESS_TASK =
  'This is an automated connectivity check. Reply with exactly the word READY and nothing else. ' +
  'Do not run any commands, do not read or change any files.';
const HARMLESS_FOLLOW_UP = 'Reply with exactly the word DONE and nothing else. Do not run any commands, do not read or change any files.';
/** Long enough that job B is still running when it is cancelled, and harmless. */
const LONG_HARMLESS_TASK =
  'This is an automated check. Count slowly from 1 to 200, writing each number on its own line, then reply FINISHED. ' +
  'Do not run any commands, do not read or change any files.';

class StepFailure extends Error {}

const env = process.env;
const { values: args } = parseArgs({ options: { config: { type: 'string' } }, strict: true });
const timeoutMs = Number(env.T3FG_E2E_TIMEOUT_SECONDS ?? 600) * 1000;
const pollMs = Number(env.T3FG_E2E_POLL_SECONDS ?? 5) * 1000;
let failures = 0;

function line(status: 'PASS' | 'FAIL' | 'INFO', step: string, detail = ''): void {
  process.stdout.write(`${status.padEnd(4)}  ${step}${detail ? `: ${detail}` : ''}\n`);
}

async function step<T>(name: string, run: () => Promise<{ value: T; detail?: string }>): Promise<T> {
  try {
    const { value, detail } = await run();
    line('PASS', name, detail);
    return value;
  } catch (error) {
    failures += 1;
    line('FAIL', name, error instanceof Error ? error.message : 'unexpected error');
    throw new StepFailure(name);
  }
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function json(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${what} returned HTTP ${response.status} without JSON`);
  }
}

function hiddenFields(html: string): Record<string, string> {
  const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[match[1] as string] = (match[2] as string).replaceAll(/&(amp|lt|gt|quot|#39);/g, (entity) => entities[entity] ?? entity);
  }
  return fields;
}

type Tool = <T = Record<string, unknown>>(name: string, input: Record<string, unknown>) => Promise<T>;

interface FeedPage {
  events: { jobId: string; type: string; toState: string | null; reason: string | null }[];
  nextCursor: string;
  hasMore: boolean;
}

/** Why a job stopped, from work_status: its state and lastError code and message. */
async function stopReason(call: Tool, jobId: string, state: string): Promise<string> {
  const status = await call<{ lastError: { code: string; message: string } | null }>('work_status', { jobId });
  if (state === 'failed' && status.lastError) return `job ${jobId} failed: lastError ${status.lastError.code}: ${status.lastError.message.slice(0, 300)}`;
  return `job ${jobId} reached ${state}${status.lastError ? ` (lastError ${status.lastError.code})` : ''}`;
}

/** Poll work_feed from `cursor` until the job reaches one of `targets`; fail on a state in `stops`. */
async function waitFor(call: Tool, jobId: string, cursor: string, targets: string[], stops: string[]): Promise<{ state: string; cursor: string }> {
  const deadline = Date.now() + timeoutMs;
  let next = cursor;
  while (Date.now() < deadline) {
    const page = await call<FeedPage>('work_feed', { cursor: next, limit: 200 });
    next = page.nextCursor;
    for (const event of page.events) {
      if (event.jobId !== jobId || event.toState === null) continue;
      line('INFO', `  ${jobId}`, `${event.type} -> ${event.toState}${event.reason ? ` (${event.reason})` : ''}`);
      if (event.toState === 'needs_input') line('INFO', `  ${jobId}`, 'waiting: answer or approve it in T3; this run keeps polling until the timeout');
      if (targets.includes(event.toState)) return { state: event.toState, cursor: next };
      if (stops.includes(event.toState)) throw new Error(await stopReason(call, jobId, event.toState));
    }
    if (!page.hasMore) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${targets.join(' or ')}`);
}

async function main(): Promise<void> {
  const approvalCode = env.T3FG_E2E_APPROVAL_CODE;
  if (!approvalCode) {
    process.stderr.write('Set T3FG_E2E_APPROVAL_CODE to a code from `t3-fleet-gateway pair`.\n');
    process.exit(2);
  }
  const config = loadConfig(resolvePaths(env, args.config ? { configPath: args.config } : {}).configPath);
  const baseUrl = (env.T3FG_E2E_URL ?? config.publicUrl).replace(/\/$/, '');
  const projectAlias = env.T3FG_E2E_PROJECT ?? config.projects[0]?.alias;
  if (!projectAlias) throw new Error('No project configured; set T3FG_E2E_PROJECT');
  line('INFO', 'target', `${baseUrl} project ${projectAlias}`);

  const metadata = await step('oauth metadata', async () => {
    const server = await json(await fetch(`${baseUrl}/.well-known/oauth-authorization-server`), 'authorization server metadata');
    const resource = await json(await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`), 'protected resource metadata');
    ensure(typeof server.registration_endpoint === 'string' && typeof resource.resource === 'string', 'metadata is incomplete');
    return { value: { server, resource: resource.resource as string }, detail: `resource ${resource.resource}` };
  });
  const endpoint = (name: string) => new URL(new URL(String(metadata.server[name])).pathname, baseUrl).href;
  const redirectUri = 'http://127.0.0.1:9/e2e-callback';

  const clientId = await step('register', async () => {
    const response = await fetch(endpoint('registration_endpoint'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 't3-fleet-gateway live e2e', redirect_uris: [redirectUri] }),
    });
    const body = await json(response, 'registration');
    ensure(response.status === 201 && typeof body.client_id === 'string', `registration returned HTTP ${response.status}`);
    return { value: body.client_id };
  });

  const verifier = randomToken(48);
  const authorizationCode = await step('approve (Operate)', async () => {
    const authorize = new URL(endpoint('authorization_endpoint'));
    for (const [name, value] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state: randomToken(8),
      scope: 'fleet:read fleet:operate',
      resource: metadata.resource,
    })) {
      authorize.searchParams.set(name, value);
    }
    const page = await fetch(authorize);
    ensure(page.status === 200, `approval page returned HTTP ${page.status}`);
    const decision = await fetch(endpoint('authorization_endpoint'), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...hiddenFields(await page.text()), approval_code: approvalCode, access: 'operate', decision: 'approve' }),
    });
    const location = decision.headers.get('location');
    const code = location ? new URL(location).searchParams.get('code') : null;
    ensure(decision.status === 303 && code, `approval failed (HTTP ${decision.status}${location ? `, ${new URL(location).searchParams.get('error') ?? ''}` : ''})`);
    return { value: code };
  });

  const accessToken = await step('token exchange', async () => {
    const response = await fetch(endpoint('token_endpoint'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: metadata.resource,
      }),
    });
    const body = await json(response, 'token');
    ensure(response.status === 200 && typeof body.access_token === 'string', `token endpoint returned HTTP ${response.status}`);
    ensure(body.scope === 'fleet:read fleet:operate', `granted scope is "${String(body.scope)}"`);
    return { value: body.access_token, detail: `scope ${body.scope}` };
  });

  const client = new Client({ name: 't3-fleet-gateway-e2e', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: { token: async () => accessToken } }));
  const call: Tool = async (name, input) => {
    const result = await client.callTool({ name, arguments: input });
    if (result.isError === true) {
      const text = (result.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? '';
      throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    }
    return result.structuredContent as never;
  };

  try {
    await step('fleet_status', async () => {
      const status = await call<{
        hosts: { id: string; reachable: boolean | null }[];
        projects: { alias: string; host: string; runtimeMode: string; modelConfigured: boolean }[];
      }>('fleet_status', {});
      const project = status.projects.find((candidate) => candidate.alias === projectAlias);
      ensure(project, `project ${projectAlias} is not configured`);
      const host = status.hosts.find((candidate) => candidate.id === project.host);
      ensure(host?.reachable === true, `host ${project.host} is not reachable`);
      const model = project.modelConfigured ? 'model configured' : "T3's default model (doctor checks it exists)";
      return { value: undefined, detail: `host ${host.id} reachable; project ${project.runtimeMode}, ${model}` };
    });

    let cursor = await latestCursor(call);

    const first = await step('work_start (job A)', async () => {
      const result = await call<{ job: { jobId: string; state: string; branch: string } }>('work_start', {
        project: projectAlias,
        task: HARMLESS_TASK,
        title: 't3-fleet-gateway live e2e',
        requestId: randomUUID(),
      });
      return { value: result.job.jobId, detail: `${result.job.jobId} ${result.job.state} on ${result.job.branch}` };
    });

    cursor = await step('job A reaches idle', async () => {
      const reached = await waitFor(call, first, cursor, ['idle'], ['failed', 'cancelled']);
      return { value: reached.cursor };
    });

    await step('work_status (job A)', async () => {
      const status = await call<{ state: string; threadId: string | null; latestMessageExcerpt: string | null }>('work_status', { jobId: first });
      ensure(status.state === 'idle' && status.threadId, `state ${status.state}`);
      ensure(status.latestMessageExcerpt, 'no worker message excerpt recorded');
      // Only a real T3 shows that the worker's reply is recognised and read back.
      ensure(/READY/.test(status.latestMessageExcerpt), `the excerpt (${status.latestMessageExcerpt.length} chars) does not mention READY`);
      return { value: undefined, detail: `thread ${status.threadId}, excerpt mentions READY` };
    });

    await step('work_continue (job A)', async () => {
      const result = await call<{ job: { state: string }; delivery: string }>('work_continue', {
        jobId: first,
        message: HARMLESS_FOLLOW_UP,
        requestId: randomUUID(),
      });
      ensure(result.job.state === 'running', `state ${result.job.state}`);
      return { value: undefined, detail: `delivery ${result.delivery}` };
    });

    cursor = await step('job A reaches idle again', async () => {
      const reached = await waitFor(call, first, cursor, ['idle'], ['failed', 'cancelled']);
      const status = await call<{ latestMessageExcerpt: string | null }>('work_status', { jobId: first });
      ensure(status.latestMessageExcerpt && /DONE/.test(status.latestMessageExcerpt), 'the excerpt of the second turn does not mention DONE');
      return { value: reached.cursor, detail: 'excerpt mentions DONE' };
    });

    /** Start a job that should still be running when it is cancelled, and wait until it runs. */
    const startLongJob = async (label: string): Promise<string> => {
      const jobId = await step(`work_start (${label})`, async () => {
        const result = await call<{ job: { jobId: string; state: string } }>('work_start', {
          project: projectAlias,
          task: LONG_HARMLESS_TASK,
          title: 't3-fleet-gateway live e2e (cancel)',
          requestId: randomUUID(),
        });
        return { value: result.job.jobId, detail: `${result.job.jobId} ${result.job.state}` };
      });
      await step(`${label} starts running`, async () => {
        const reached = await waitFor(call, jobId, cursor, ['running'], ['idle', 'failed', 'cancelled']);
        cursor = reached.cursor;
        return { value: undefined, detail: reached.state };
      });
      return jobId;
    };
    const cancel = (label: string, jobId: string) =>
      step(`work_cancel (${label})`, async () => {
        const result = await call<{ outcome: string; delivered: boolean; job: { state: string } }>('work_cancel', { jobId });
        return { value: result, detail: `outcome ${result.outcome}, delivered ${result.delivered}` };
      });

    let second = await startLongJob('job B');
    let cancelled = await cancel('job B', second);
    if (cancelled.outcome !== 'cancel_requested') {
      // The worker can finish before the cancel arrives; one fresh job tells a fast worker from a broken interrupt.
      const state = cancelled.job.state;
      line('INFO', 'work_cancel (job B)', `job B had already finished (state ${state}); starting one replacement and cancelling again`);
      second = await startLongJob('replacement job B');
      cancelled = await cancel('replacement job B', second);
    }

    await step('the cancel reached a running job', async () => {
      // Only an interrupt of a run that is still going shows that T3 stops the worker and the watcher sees it.
      ensure(
        cancelled.outcome === 'cancel_requested',
        `outcome ${cancelled.outcome} (state ${cancelled.job.state}): the job was not running when cancelled, so the interrupt was not exercised`,
      );
      return { value: undefined };
    });

    await step('watcher confirms job B cancelled', async () => {
      await waitFor(call, second, cursor, ['cancelled'], ['failed', 'idle']);
      return { value: undefined };
    });

    await step('clean up job A (work_cancel on an idle job)', async () => {
      const result = await call<{ outcome: string }>('work_cancel', { jobId: first });
      return { value: undefined, detail: result.outcome };
    });
  } finally {
    await client.close();
  }
}

/** Skip existing history: page to the newest event so only this run's events are followed. */
async function latestCursor(call: Tool): Promise<string> {
  let cursor = '0';
  for (;;) {
    const page = await call<FeedPage>('work_feed', { cursor, limit: 200 });
    cursor = page.nextCursor;
    if (!page.hasMore) return cursor;
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof StepFailure)) {
    failures += 1;
    line('FAIL', 'setup', error instanceof Error ? error.message : 'unexpected error');
  }
}
process.stdout.write(failures === 0 ? 'E2E PASS\n' : `E2E FAIL (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
