import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openDataDir } from '../src/dataDir.ts';
import { tempDir } from './helpers/tmp.ts';

// Public synthetic test certificate/private key. Trusted only by the isolated CLI child below.
const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDJjCCAg6gAwIBAgIUR//1UUhz2jTqqRErlbMR8FY8W1IwDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZU3ludGhldGljIHdlYmhvb2sgZml4dHVyZTAgFw0yNjEw
MTcxNzQ4MTBaGA8yMTI2MDkyMzE3NDgxMFowJDEiMCAGA1UEAwwZU3ludGhldGlj
IHdlYmhvb2sgZml4dHVyZTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AKtmqZ/N7mJUtQf9BR8If6aEYtES7scBFtAV83+gAyhERU22YjeP9LGYG0eh2tg8
Zk6iP+pzZsjOYkYCcnz1NDPZVZSq2TrvKqtgNXLN79nwujCAsMW7NMwifqet7nzi
WEKj41DfKLBC4ZU2SPHUFJLheU1+h+KhxA3xHgOD0d7NQ5GjKzXzfsk3g/Mcdu/t
HTXnCVPatBKNoVst1XMhGOFvW9xVHAWAk8PkKCFH/UVe1x9iJTzXJty2dSnF2Y9d
rZI+7SAyPF3y9nDsnZ3Oxsoyykm1HRRHb1kSx7/AeYeyq2Kh+yQ1PQZ4wQyN/gXf
EfCnWhCBBkxvGynFaB+O7IsCAwEAAaNOMEwwHQYDVR0OBBYEFCBV+JkzkZtu7e+1
66uHEDlLsOO5MBoGA1UdEQQTMBGHBH8AAAGCCWxvY2FsaG9zdDAPBgNVHRMBAf8E
BTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAbIK3SAmSHg7xNzYoD2CzySY4FpWYD
B2NBEGeXKIXh1nQmWp7OwYZeBgF898q+OJbfy2wCsp3RHBLEx7oJ16ibroJtTYb1
NvZiKDYVSM9YbEv2dEq7qCNeUr/tMozYMgloOmSG0bYbdunaw+LpEne173Z3iCcI
NgwF6OrAGF4gCKwaCRBXsHuFr+6OifDzWZbr1aRH3GMY5oxKNzfgt+gkZk2gM2E4
kETShk1boUg6Qz0P3l++9M2eBUABhQvl2lIt1NQaRwfZdIN2cBrZ43UsuZ9UcZIv
3Wk9BdFa1bKdP5Lbxx0G+VSd5ulOc6YPjBnkjQuRV0DmQq+m0QBWQvi/
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCrZqmfze5iVLUH
/QUfCH+mhGLREu7HARbQFfN/oAMoREVNtmI3j/SxmBtHodrYPGZOoj/qc2bIzmJG
AnJ89TQz2VWUqtk67yqrYDVyze/Z8LowgLDFuzTMIn6nre584lhCo+NQ3yiwQuGV
Nkjx1BSS4XlNfofiocQN8R4Dg9HezUORoys1837JN4PzHHbv7R015wlT2rQSjaFb
LdVzIRjhb1vcVRwFgJPD5CghR/1FXtcfYiU81ybctnUpxdmPXa2SPu0gMjxd8vZw
7J2dzsbKMspJtR0UR29ZEse/wHmHsqtiofskNT0GeMEMjf4F3xHwp1oQgQZMbxsp
xWgfjuyLAgMBAAECggEABahWwTU/K7JWjnc/BP7ZL4xFuyQ84DIAtTO142JCkxYN
AqPWKLXRCQtCLSBKzUYWLX0nm88ZA/GfflV/FCShmGMRjKqb9Z1GpFHW4/C42nx4
hjAQMnyGQ5ZNGRVZKUWGtFoDhd5ahStxlcLGuHtthkorl/QTjF84gPcKRhRtg8Ur
PLs00ThDwafFqbJzQ0T2xHp3zQUELQ2+gB+MAHkISr+3Bbkx3uwb8mPrGlyMoB28
hFTAtfJ47vIdAK9uU11XMlrgDYZxEr52MDbyM3Ot+S+mjsWCfkItQum//Q+65bOR
y3xYXRUD6iaanl0K9CdueibbTif64Kn/TuH2IMQPnQKBgQDWv5GwHGfpvWqvKQ0B
mcAzTPrTD86/rfwlE8gobdl1EMGlgNvf8jBtnRco7bJGCcSvFtab72bA2HwCKSXe
J+wAEMST9PADrbv/56b2c5FKg5wI0QvE0YyCC6UGnrOCQj2x10ZNLPffFudH9F4X
OGzzLXD2voP3Xildl/snZjQBbQKBgQDMU3Qh4xQrsjxpwtUFreEHYztxqKubB2hX
9bhhtbT90ukTZY7kTrkK5sxIn3Rmdwil1oqhypE8kTj75Ftp7HGrpflJydtCvLom
BIA13Hv7hDjg1ET7zum8jAiuy/L8qfjd3p9QTqQpnwDQ72xPEc0vIZHmBtv4U4c8
5DLdhu5i1wKBgDK5XTgz/XeAfkqRb7kJEBUOAdEI0tUDy6MWYRjrmYnFQ3hMT6M+
GaJKkMXiH1HbzNFum5KJocO7Xs9D2OX4mA4L5+Lq4CZ+SwHPPejIs3DeVWTfu9/p
fz7YcUp3Af+qldgD+V8RWBsh1c9xMSha86EdAqnFpnYvj6XD2FceFPqhAoGAE+wX
KK6xaslIJq++gX1Asa21QBHIGaeRPvJQdgZ3jUAhRajjU9NxK2Txiisx+EOm7jSK
89eCbbtjKPxNBXjuZGQceFtcK5enNsm9joLe+9kaiqFn0H2OQLoOpqxwFr6j604n
jnb8fqpoM/cEQnlj3jKRvTHyBLZwOzms0/iyCaUCgYEApO++hNP/367pfm9EFsfR
hFD9yLZz7Ffph9ONZy0XEht4no86amAVDgvtlN1zoKgFOCf42lq7U/5JTstzKsB2
p7UQiKUYskjunGyPmz6TW6b4bIJV1xzlbSfv0YUTvUvhb8BQpxfyvERgLCG3iez3
0q+/Az39fpZBHM/FmrjdDIs=
-----END PRIVATE KEY-----
`;

test('HTTPS uses verified TLS and arbitrary authentication; untrusted certificates and redirects fail closed', async (t) => {
  const dir = tempDir(t);
  const dataDir = join(dir, 'data');
  openDataDir(dataDir);
  const certificateFile = join(dir, 'synthetic-ca.pem');
  const configFile = join(dir, 'config.json');
  const senderKey = 'synthetic-https-private-sender-key';
  const roots = JSON.parse(readFileSync(new URL('./fixtures/tls-roots.json', import.meta.url), 'utf8')) as { pem: string }[];
  // Public roots and the private test CA must all remain trusted.
  writeFileSync(certificateFile, CERTIFICATE + roots.map((root) => root.pem).join('\n'));
  writeFileSync(join(dataDir, 'sender.key'), senderKey, { mode: 0o600 });
  const received: { path: string | undefined; key: string | string[] | undefined; payload: Record<string, unknown> }[] = [];
  const server = createServer({ key: KEY, cert: CERTIFICATE }, async (req, res) => {
    if (req.url === '/trust-check') { res.writeHead(204).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ path: req.url, key: req.headers['x-grok-routine-sender-key'], payload: JSON.parse(Buffer.concat(chunks).toString()) });
    if (req.url === '/redirect') res.writeHead(307, { location: '/unintended-recipient' }).end();
    else res.writeHead(204).end();
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const configure = (path: string) => writeFileSync(configFile, JSON.stringify({
    publicUrl: 'https://gateway.example.com', hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9' }],
    webhooks: { subscriptions: [{ id: 'grok', enabled: true, url: `${origin}${path}`,
      auth: { header: 'X-Grok-Routine-Sender-Key', secretFile: 'sender.key' } }] },
  }), { mode: 0o600 });
  const invoke = async (trusted: boolean) => {
    const env = { ...process.env };
    delete env.NODE_EXTRA_CA_CERTS;
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (trusted) env.NODE_EXTRA_CA_CERTS = certificateFile;
    try {
      const result = await promisify(execFile)(process.execPath,
        [fileURLToPath(new URL('../bin/t3-fleet-gateway.js', import.meta.url)), 'webhooks', 'ping', 'grok', '--config', configFile, '--data-dir', dataDir],
        { env, timeout: 15_000, maxBuffer: 100_000 });
      return { code: 0, ...result };
    } catch (error) {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  };
  configure('/synthetic-private-routine');
  const untrusted = await invoke(false);
  assert.equal(untrusted.code, 1);
  assert.match(untrusted.stdout + untrusted.stderr, /tls_error/);
  assert.equal(received.length, 0, 'TLS authentication precedes sending the header or body');
  const trusted = await invoke(true);
  assert.equal(trusted.code, 0, trusted.stderr);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.key, senderKey);
  assert.deepEqual(Object.keys(received[0]!.payload).sort(), ['eventId', 'feedCursor', 'feedSequence', 'timestamp', 'type']);
  assert.equal(received[0]!.payload.type, 'ping');
  configure('/redirect');
  const redirect = await invoke(true);
  assert.equal(redirect.code, 1);
  assert.match(redirect.stdout + redirect.stderr, /redirect/);
  assert.deepEqual(received.map((entry) => entry.path), ['/synthetic-private-routine', '/redirect']);
  for (const result of [untrusted, trusted, redirect]) {
    for (const secret of [senderKey, origin, 'synthetic-private-routine', certificateFile]) {
      assert.equal((result.stdout + result.stderr).includes(secret), false);
    }
  }
  for (const system of [false, true]) {
    for (const extra of [false, true]) {
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_EXTRA_CA_CERTS: extra ? certificateFile : '' };
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      await promisify(execFile)(process.execPath, [
        ...(system ? ['--use-system-ca'] : []), '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { X509Certificate } from 'node:crypto';
        import * as tls from 'node:tls';
        await import('./src/gateway.ts');
        const extra = tls.getCACertificates('extra');
        const defaults = new Set(tls.getCACertificates('default').map(pem => new X509Certificate(pem).fingerprint256));
        if (extra.length) {
          assert.equal(extra.length, 4);
          assert.ok(defaults.has(new X509Certificate(extra[0]).fingerprint256));
          for (const pem of extra.slice(1)) assert.ok(defaults.has(new X509Certificate(pem).fingerprint256));
        }
        const checkFetch = async () => {
          const response = await fetch(${JSON.stringify(`${origin}/trust-check`)}, { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 204);
          await response.body?.cancel();
        };
        const checkTls = () => new Promise((resolve, reject) => {
          const socket = tls.connect({ host: '127.0.0.1', port: ${String((server.address() as AddressInfo).port)} }, () => {
            assert.ok(socket.authorized);
            socket.destroy();
            resolve();
          });
          socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
          socket.on('error', reject);
        });
        for (const check of [checkFetch, checkTls]) {
          if (${String(extra)}) await check();
          else await assert.rejects(check(), error =>
            (error.cause?.code ?? error.code) === 'DEPTH_ZERO_SELF_SIGNED_CERT');
        }
      `], { env, timeout: 15_000, maxBuffer: 100_000 });
    }
  }
});
