import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { isSupportedNode, MIN_NODE_VERSIONS, nodeVersionProblem } from '../src/nodeVersion.ts';
import { pretendNode } from './helpers/nodeVersion.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('only Node releases that block the compromised eMudhra/emSign intermediates are supported', () => {
  for (const version of ['24.22.1', 'v24.22.1', '24.22.2', '24.23.0', '26.12.1', '26.12.2', '26.13.0', '27.0.0', '28.1.0-nightly20270101']) {
    assert.equal(isSupportedNode(version), true, version);
    assert.equal(nodeVersionProblem(version), undefined, version);
  }
  for (const version of ['24.22.0', '24.21.9', '24.0.0', '25.9.0', '26.0.0', '26.12.0', '26.11.5', '22.20.0', '20.0.0', '', 'v26', 'not-a-version']) {
    assert.equal(isSupportedNode(version), false, version);
  }
  assert.match(nodeVersionProblem('26.12.0') ?? '', /^Node\.js 26\.12\.0 is not supported: use 24\.22\.1 or a later 24\.x, or 26\.12\.1 or newer\. .*eMudhra/);
});

test('this test run uses a supported Node', () => {
  assert.equal(nodeVersionProblem(process.versions.node), undefined);
});

test('engines, the CI matrix and the docs name the same minimum releases', () => {
  assert.deepEqual(MIN_NODE_VERSIONS, ['24.22.1', '26.12.1']);
  const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node;
  assert.equal(engines, '^24.22.1 || >=26.12.1');
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { engines?: { node: string } }> };
  assert.equal(lock.packages['']?.engines?.node, engines);
  const matrix = [...read('.github/workflows/check.yml').matchAll(/node: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(matrix)].sort(), [...MIN_NODE_VERSIONS]);
});

test('the launcher refuses an unfixed Node before loading the CLI', async () => {
  const launcher = fileURLToPath(new URL('../bin/t3-fleet-gateway.js', import.meta.url));
  const refused = await promisify(execFile)(process.execPath, ['--import', pretendNode('26.12.0'), launcher, '--version'])
    .then(() => assert.fail('the launcher ran'), (error: { code: number; stdout: string; stderr: string }) => error);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.equal(refused.stderr, `t3-fleet-gateway: ${nodeVersionProblem('26.12.0')}\n`);

  const { stdout } = await promisify(execFile)(process.execPath, ['--import', pretendNode('24.22.1'), launcher, '--version']);
  assert.match(stdout, /\d+\.\d+\.\d+/);
});
