import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import * as z from 'zod';
import type { T3Access } from '../config.ts';
import { pkceChallenge, randomToken } from '../crypto.ts';
import { GatewayError } from '../errors.ts';
import { SECOND, type Clock } from '../time.ts';

const COMMAND_TIMEOUT_MS = 60 * SECOND;
const HTTP_TIMEOUT_MS = 15 * SECOND;

export interface ObtainedCredential {
  accessToken: string;
  t3ClientId: string;
  scope: string;
  access: T3Access;
  issuedAt: number;
  expiresAt: number;
}

export interface PairingFlowOptions {
  hostId: string;
  t3Url: string;
  access: T3Access;
  mintPairingCode: readonly string[];
  clock: Clock;
  /** Runs the mint command and returns its stdout. Replaceable in tests. */
  runCommand?: (argv: readonly string[]) => Promise<string>;
}

const registrationSchema = z.looseObject({ client_id: z.string().min(1) });
const pairingOutputSchema = z.looseObject({ credential: z.string().min(1) });
const decisionSchema = z.looseObject({ redirectTo: z.string().min(1) });
const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().default(''),
  token_type: z.string(),
});

/** Run a command without a shell and return stdout. Output is never logged: it holds a pairing code. */
export function runCommand(argv: readonly string[]): Promise<string> {
  const [file, ...args] = argv;
  if (!file) return Promise.reject(new GatewayError('pairing_command_failed', 'mintPairingCode is empty'));
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) {
        const exit = typeof error.code === 'number' ? `exit code ${error.code}` : (error.code ?? error.signal ?? 'failed');
        reject(new GatewayError('pairing_command_failed', `Pairing command "${file}" failed (${exit}). Run it by hand to see why.`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** A loopback port nothing is listening on, so the never-followed redirect URI is harmless. */
async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== 'object' || address === null) throw new GatewayError('enrollment_failed', 'Could not pick a loopback port');
  return address.port;
}

async function postJson(step: string, url: string, body: unknown, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      ...init,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...init.headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  } catch (error) {
    throw new GatewayError('host_unreachable', `T3 ${step} request failed: ${(error as Error).name}`, { cause: error });
  }
  const text = await response.text();
  if (!response.ok) {
    let reason = '';
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const detail = typeof parsed.error === 'string' ? parsed.error : typeof parsed.message === 'string' ? parsed.message : '';
      reason = detail ? `: ${detail.slice(0, 200)}` : '';
    } catch {
      // Body is not JSON; the status is enough.
    }
    throw new GatewayError('enrollment_failed', `T3 ${step} returned HTTP ${response.status}${reason}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError('enrollment_failed', `T3 ${step} returned a non-JSON response`);
  }
}

function expect<T>(step: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GatewayError('enrollment_failed', `T3 ${step} response has an unexpected shape`);
  return parsed.data;
}

/**
 * Obtain a T3 MCP credential through T3's pairing-code approval, with no browser:
 * register a public client, mint a pairing code with the operator's command, submit the approval
 * decision with that code, and exchange the resulting authorization code (PKCE) for a token.
 * The caller must verify the credential before using it.
 */
export async function obtainCredential(options: PairingFlowOptions): Promise<ObtainedCredential> {
  const base = options.t3Url;
  const resource = `${base}/mcp`;
  const redirectUri = `http://127.0.0.1:${await unusedLoopbackPort()}/callback`;
  const registration = expect(
    'registration',
    registrationSchema,
    await postJson('registration', `${base}/oauth/mcp/register`, {
      client_name: `t3-fleet-gateway (${options.hostId})`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'none',
    }),
  );

  const run = options.runCommand ?? runCommand;
  let pairingOutput: unknown;
  try {
    pairingOutput = JSON.parse(await run(options.mintPairingCode));
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('pairing_command_failed', 'Pairing command did not print JSON. Include --json in mintPairingCode.');
  }
  const pairing = pairingOutputSchema.safeParse(pairingOutput);
  if (!pairing.success) throw new GatewayError('pairing_command_failed', 'Pairing command output has no "credential" field');

  const verifier = randomToken(48);
  const state = randomToken(16);
  const decision = expect(
    'approval',
    decisionSchema,
    await postJson('approval', `${base}/oauth/mcp/decision`, {
      authorization: {
        response_type: 'code',
        client_id: registration.client_id,
        redirect_uri: redirectUri,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        resource,
      },
      decision: { _tag: 'pairing-code', access: options.access, code: pairing.data.credential },
    }),
  );
  let redirect: URL;
  try {
    redirect = new URL(decision.redirectTo);
  } catch {
    throw new GatewayError('enrollment_failed', 'T3 approval returned an invalid redirect');
  }
  const deniedWith = redirect.searchParams.get('error');
  if (deniedWith) throw new GatewayError('enrollment_failed', `T3 refused the approval: ${deniedWith.slice(0, 100)}`);
  const code = redirect.searchParams.get('code');
  if (!code || redirect.searchParams.get('state') !== state) {
    throw new GatewayError('enrollment_failed', 'T3 approval redirect is missing the code or has the wrong state');
  }

  const issuedAt = options.clock();
  const token = expect(
    'token',
    tokenSchema,
    await postJson(
      'token',
      `${base}/oauth/mcp/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: registration.client_id,
        code_verifier: verifier,
        resource,
      }).toString(),
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    ),
  );
  if (token.token_type.toLowerCase() !== 'bearer') throw new GatewayError('enrollment_failed', `Unsupported T3 token type ${token.token_type}`);
  return {
    accessToken: token.access_token,
    t3ClientId: registration.client_id,
    scope: token.scope,
    access: options.access,
    issuedAt,
    expiresAt: issuedAt + token.expires_in * SECOND,
  };
}
