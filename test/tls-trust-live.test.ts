import assert from 'node:assert/strict';
import { get } from 'node:https';
import { connect } from 'node:tls';
import { test } from 'node:test';
import { nodeVersionProblem } from '../src/nodeVersion.ts';

// Opt-in public-network check that Node itself blocks the compromised eMudhra/emSign intermediates
// (CVE-2026-111943, nodejs/node#66871); never contacts configured gateway hosts or receivers. Run it
// with and without --use-system-ca (docs/security.md, "Compromised eMudhra intermediates").
const options = { skip: process.env.TLS_LIVE_TEST !== '1' };
const tlsClient = (host: string, customIdentity = false) => new Promise<void>((resolve, reject) => {
  const socket = connect({ host, port: 443, servername: host,
    ...(customIdentity ? { checkServerIdentity: () => undefined } : {}) }, () => {
    socket.destroy();
    resolve();
  });
  const timer = setTimeout(() => socket.destroy(new Error('TLS probe timeout')), 8_000);
  socket.once('close', () => clearTimeout(timer));
  socket.on('error', reject);
});
const clients = {
  fetch: async (host: string) => {
    const response = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(8_000), redirect: 'manual' });
    await response.body?.cancel();
  },
  https: (host: string) => new Promise<void>((resolve, reject) => {
    const request = get(`https://${host}/`, { agent: false, signal: AbortSignal.timeout(8_000) }, (response) => {
      response.resume();
      resolve();
    });
    request.on('error', reject);
  }),
  tls: (host: string) => tlsClient(host),
  'tls-custom-identity': (host: string) => tlsClient(host, true),
};
// Node's key block reports CERT_REVOKED. Any other failure (a missing root, DNS, a timeout) proves nothing.
const keyBlocked = (error: unknown): boolean => {
  const e = error as { code?: string; cause?: unknown };
  return e.code === 'CERT_REVOKED' || (e.cause !== undefined && keyBlocked(e.cause));
};

test('runs on a fixed Node with nothing preloaded', options, () => {
  assert.equal(nodeVersionProblem(process.versions.node), undefined);
  assert.deepEqual(process.execArgv.filter((arg) => /^--(import|require|loader|experimental-loader)\b|^-r$/.test(arg)), []);
});

for (const [name, client] of Object.entries(clients)) {
  for (const prefix of ['dv-g3b', 'dv-g3b-aaa', 'ev-g3c', 'ev-g3c-aaa']) {
    test(`${name} rejects compromised ${prefix} chain`, options, async () => {
      // Rejected handshakes must stay rejected on a repeat (no accepted session to cache).
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(client(`${prefix}-emudhra.we-have-a-problem.com`), keyBlocked);
      }
    });
  }
  for (const host of ['github.com', 'nodejs.org']) {
    test(`${name} accepts normal public TLS at ${host}`, options, async () => { await client(host); });
  }
}
