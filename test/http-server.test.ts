import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { test } from 'node:test';
import { createRouter, listen } from '../src/http/server.ts';
import { sendJson } from '../src/http/io.ts';
import { createLogger } from '../src/log.ts';

/** Send the request target verbatim, without a client's URL normalization. */
function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => socket.destroy(new Error('HTTP response timed out')));
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: gateway.invalid\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve(response));
  });
}

test('malformed request targets return 400 without uncaught errors or raw targets in logs', async (t) => {
  const logs: string[] = [];
  const logger = createLogger({ sink: (line) => logs.push(line) });
  const server = await listen(createRouter([
    { path: '/health', methods: { GET: (_req, res) => sendJson(res, 200, { ok: true }) } },
  ], logger), '127.0.0.1', 0);
  t.after(() => server.close());
  const uncaught: unknown[] = [];
  const monitor = (error: Error) => { uncaught.push(error); };
  process.on('uncaughtExceptionMonitor', monitor);
  t.after(() => process.off('uncaughtExceptionMonitor', monitor));

  for (const target of ['//[', '//%5B', '//x:99999', '//a%20b', '///x:99999', 'http://[']) {
    const before = logs.length;
    const response = await rawRequest(server.port, target);
    assert.match(response, /^HTTP\/1\.1 400 /);
    const records = logs.slice(before).map((line) => JSON.parse(line));
    // Node may reject absolute-form targets itself, before invoking the router.
    if (target !== 'http://[' || records.length > 0) {
      assert.equal(response.split('\r\n\r\n')[1], '{"error":"invalid_request"}');
      assert.match(response, /content-type: application\/json/i);
      assert.equal(records.length, 1);
      assert.equal(records[0].event, 'http.request');
      assert.equal(records[0].path, '(invalid)');
      assert.equal(records[0].status, 400);
      assert.equal(records[0].method, 'GET');
      assert.equal(typeof records[0].durationMs, 'number');
    }
    assert.equal(logs.slice(before).join('\n').includes(target), false);
    assert.match(await rawRequest(server.port, '/health'), /^HTTP\/1\.1 200 /);
  }
  assert.deepEqual(uncaught, []);
});

test('valid request targets retain URL routing and sanitized finish logs', async (t) => {
  const logs: string[] = [];
  const server = await listen(createRouter([
    { path: '/health', methods: { GET: (_req, res, url) => sendJson(res, 200, { value: url.searchParams.get('value') }) } },
  ], createLogger({ sink: (line) => logs.push(line) })), '127.0.0.1', 0);
  t.after(() => server.close());
  for (const target of ['/health?value=synthetic', '//example.com/health?value=synthetic',
    '///example.com/health?value=synthetic', 'http://example.com/health?value=synthetic']) {
    const response = await rawRequest(server.port, target);
    assert.match(response, /^HTTP\/1\.1 200 /);
    assert.equal(response.split('\r\n\r\n')[1], '{"value":"synthetic"}');
    assert.equal(JSON.parse(logs.at(-1)!).path, '/health');
  }
  assert.match(await rawRequest(server.port, '/unknown?private=synthetic'), /^HTTP\/1\.1 404 /);
  assert.equal(JSON.parse(logs.at(-1)!).path, '(unmatched)');
  assert.doesNotMatch(logs.join('\n'), /synthetic|example\.com|unknown/);
});
