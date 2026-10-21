import '../src/tlsTrust.ts';
import assert from 'node:assert/strict';
import { get } from 'node:https';
import { connect } from 'node:tls';
import { test } from 'node:test';

// Opt-in public-network check; never contacts configured gateway hosts or receivers.
const options = { skip: process.env.TLS_LIVE_TEST !== '1' };
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
  tls: (host: string) => new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host }, () => {
      socket.destroy();
      resolve();
    });
    socket.setTimeout(8_000, () => socket.destroy(new Error('TLS probe timeout')));
    socket.on('error', reject);
  }),
};
const certificateFailure = (error: unknown): boolean => {
  const e = error as { code?: string; cause?: unknown };
  return ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
    'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE'].includes(e.code ?? '') || (e.cause !== undefined && certificateFailure(e.cause));
};

for (const [name, client] of Object.entries(clients)) {
  for (const prefix of ['dv-g3b', 'dv-g3b-aaa', 'ev-g3c', 'ev-g3c-aaa']) {
    test(`${name} rejects compromised ${prefix} chain`, options, async () => {
      await assert.rejects(client(`${prefix}-emudhra.we-have-a-problem.com`), certificateFailure);
    });
  }
  for (const host of ['github.com', 'nodejs.org']) {
    test(`${name} accepts normal public TLS at ${host}`, options, async () => { await client(host); });
  }
}
