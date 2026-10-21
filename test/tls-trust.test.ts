import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DetailedPeerCertificate } from 'node:tls';
import { promisify } from 'node:util';
import { checkCompromisedKeys } from '../src/tlsTrust.ts';
import { tempDir } from './helpers/tmp.ts';

// Public disclosure certificates, including both cross-sign variants of each key.
const impacted = JSON.parse(readFileSync(new URL('./fixtures/compromised-intermediates.json', import.meta.url), 'utf8')) as
  { name: string; sha256: string; spki_sha256: string; pem: string }[];
const roots = JSON.parse(readFileSync(new URL('./fixtures/tls-roots.json', import.meta.url), 'utf8')) as
  { sha256: string; pem: string }[];
const peer = (pem: string): DetailedPeerCertificate => new X509Certificate(pem).toLegacyObject() as DetailedPeerCertificate;

test('all eight compromised SPKIs, including cross-signs, are blocked at any chain depth', () => {
  assert.equal(impacted.length, 16);
  assert.equal(new Set(impacted.map((cert) => cert.spki_sha256)).size, 8);
  for (const cert of impacted) {
    const x509 = new X509Certificate(cert.pem);
    assert.equal(x509.fingerprint256.replaceAll(':', ''), cert.sha256);
    assert.equal(createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').toUpperCase(),
      cert.spki_sha256);
    const blocked = peer(cert.pem);
    const allowed = peer(roots[0]!.pem);
    for (const chain of [blocked, { ...allowed, issuerCertificate: blocked },
      { ...allowed, issuerCertificate: { ...allowed, issuerCertificate: blocked } }]) {
      assert.equal((checkCompromisedKeys(chain) as NodeJS.ErrnoException)?.code, 'CERT_REVOKED', cert.name);
    }
  }
});

test('unaffected roots and cyclic chains terminate; malformed certificate data fails closed', () => {
  for (const root of roots) {
    const allowed = peer(root.pem);
    allowed.issuerCertificate = allowed;
    assert.equal(checkCompromisedKeys(allowed), undefined);
    const second = peer(root.pem);
    second.issuerCertificate = allowed;
    allowed.issuerCertificate = second;
    assert.equal(checkCompromisedKeys(allowed), undefined);
  }
  assert.equal((checkCompromisedKeys({ raw: Buffer.from('invalid') } as DetailedPeerCertificate) as NodeJS.ErrnoException).code,
    'ERR_TLS_CERT_CHAIN_CHECK');
});

for (const system of [false, true]) {
  test(`startup preserves all trust anchors, including system/extra roots (system=${system})`, async (t) => {
    const extra = join(tempDir(t), 'extra.pem');
    writeFileSync(extra, roots.map((root) => root.pem).join('\n'));
    const { stdout } = await promisify(execFile)(process.execPath, [
      ...(system ? ['--use-system-ca'] : []), '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { X509Certificate } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import * as tls from 'node:tls';
      const roots = JSON.parse(readFileSync('test/fixtures/tls-roots.json', 'utf8'));
      const fingerprint = pem => new X509Certificate(pem).fingerprint256.replaceAll(':', '');
      assert.equal(roots.length, 3);
      for (const root of roots) assert.equal(fingerprint(root.pem), root.sha256);
      const before = tls.getCACertificates('default');
      assert.ok(roots.every(root => before.some(pem => fingerprint(pem) === root.sha256)));
      await import('./src/gateway.ts');
      assert.deepEqual(tls.getCACertificates('default'), before);
      console.log('preserved');
    `], { timeout: 15_000, env: { ...process.env, NODE_EXTRA_CA_CERTS: extra } });
    assert.equal(stdout.trim(), 'preserved');
  });
}

test('connect overloads compose custom checkers without mutating options; named ESM imports are patched', async () => {
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { X509Certificate } from 'node:crypto';
    import { readFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import tls, { connect as namedConnect } from 'node:tls';
    const impacted = JSON.parse(readFileSync('test/fixtures/compromised-intermediates.json', 'utf8'));
    const roots = JSON.parse(readFileSync('test/fixtures/tls-roots.json', 'utf8'));
    const blocked = new X509Certificate(impacted[0].pem).toLegacyObject();
    const allowed = new X509Certificate(roots[0].pem).toLegacyObject();
    let received;
    const sentinel = {};
    const original = function (...args) { received = args; return sentinel; };
    tls.connect = original;
    syncBuiltinESMExports();
    await import('./src/tlsTrust.ts');
    assert.notEqual(namedConnect, original);
    assert.equal(namedConnect, tls.connect);
    let checks = 0;
    const customError = new Error('synthetic hostname failure');
    const context = {};
    const checker = function () { assert.equal(this, context); checks++; return customError; };
    const cb = () => {};
    const options = { checkServerIdentity: checker, ca: roots[0].pem };
    const forms = [
      [[options, cb], 0], [[443, options, cb], 1], [[443, 'host.example', options, cb], 2],
      [['/synthetic/socket', options, cb], 1], [[443, cb], 1], [[443, 'host.example', cb], 2],
      [['/synthetic/socket', cb], 1], [[{port:443}, cb], 0], [[443], 1],
    ];
    for (const [args, index] of forms) {
      assert.equal(Reflect.apply(namedConnect, undefined, args), sentinel);
      const guarded = received[index];
      const checksBeforeBlock = checks;
      assert.equal(guarded.checkServerIdentity.call(context, 'host.example', blocked).code, 'CERT_REVOKED');
      assert.equal(checks, checksBeforeBlock);
      if (args.includes(options)) {
        const before = checks;
        assert.equal(guarded.ca, options.ca);
        assert.equal(guarded.checkServerIdentity.call(context, 'host.example', allowed), customError);
        assert.equal(checks, before + 1);
      } else {
        assert.equal(guarded.checkServerIdentity('host.example', allowed).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
      }
      if (args.at(-1) === cb) assert.equal(received.at(-1), cb);
      assert.equal(options.checkServerIdentity, checker);
    }
    for (const invalid of [null, undefined, 'invalid']) {
      const options = { checkServerIdentity: invalid };
      namedConnect(options);
      assert.equal(received[0], options, 'preserve native validation of invalid checkers');
    }
  `], { timeout: 15_000 });
});
