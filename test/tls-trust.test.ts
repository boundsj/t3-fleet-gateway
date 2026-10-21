import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

for (const system of [false, true]) {
  test(`startup removes affected trust anchors and preserves other defaults (system=${system})`, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      ...(system ? ['--use-system-ca'] : []), '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { X509Certificate } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import * as tls from 'node:tls';
      const roots = JSON.parse(readFileSync('test/fixtures/distrusted-roots.json', 'utf8'));
      const fingerprint = pem => new X509Certificate(pem).fingerprint256.replaceAll(':', '');
      assert.equal(roots.length, 3);
      for (const root of roots) assert.equal(fingerprint(root.pem), root.sha256);
      const denied = new Set(roots.map(root => root.sha256));
      const before = tls.getCACertificates('default');
      // Seed all anchors even on a future runtime whose bundled store has removed them.
      tls.setDefaultCACertificates([...before, ...roots.map(root => root.pem)]);
      assert.ok(roots.every(root => tls.getCACertificates('default').some(pem => fingerprint(pem) === root.sha256)));
      await import('./src/gateway.ts');
      const after = new Set(tls.getCACertificates('default').map(fingerprint));
      assert.deepEqual(after, new Set(before.map(fingerprint).filter(fp => !denied.has(fp))));
      assert.ok(after.size > 0);
      console.log('filtered');
    `], { timeout: 15_000 });
    assert.equal(stdout.trim(), 'filtered');
  });
}
