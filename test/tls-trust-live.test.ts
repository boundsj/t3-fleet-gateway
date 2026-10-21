import '../src/tlsTrust.ts';
import assert from 'node:assert/strict';
import { get } from 'node:https';
import { connect } from 'node:tls';
import { test } from 'node:test';

// Opt-in public-network check; never contacts configured gateway hosts or receivers.
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
const certificateFailure = (error: unknown): boolean => {
  const e = error as { code?: string; cause?: unknown };
  const codes = process.env.TLS_REQUIRE_KEY_BLOCK === '1' ? ['CERT_REVOKED']
    : ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
      'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE'];
  return codes.includes(e.code ?? '') || (e.cause !== undefined && certificateFailure(e.cause));
};

for (const [name, client] of Object.entries(clients)) {
  for (const prefix of ['dv-g3b', 'dv-g3b-aaa', 'ev-g3c', 'ev-g3c-aaa']) {
    test(`${name} rejects compromised ${prefix} chain`, options, async () => {
      // Rejected handshakes must stay rejected on a repeat (no accepted session to cache).
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(client(`${prefix}-emudhra.we-have-a-problem.com`), certificateFailure);
      }
    });
  }
  for (const host of ['github.com', 'nodejs.org']) {
    test(`${name} accepts normal public TLS at ${host}`, options, async () => { await client(host); });
  }
}
