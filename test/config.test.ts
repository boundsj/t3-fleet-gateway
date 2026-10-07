import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig, parseConfig, resolvePaths, runtimeModeAllowed } from '../src/config.ts';
import { GatewayError } from '../src/errors.ts';
import { tempDir } from './helpers/tmp.ts';

const minimal = {
  publicUrl: 'https://gateway.example.ts.net',
  hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:3773' }],
};

function invalid(input: unknown, pattern: RegExp): void {
  assert.throws(
    () => parseConfig(input),
    (error: unknown) => error instanceof GatewayError && error.code === 'config_invalid' && pattern.test(error.message),
  );
}

describe('config', () => {
  test('applies defaults to a minimal config', () => {
    const config = parseConfig(minimal);
    assert.equal(config.publicUrl, 'https://gateway.example.ts.net');
    assert.deepEqual(config.listen, { host: '127.0.0.1', port: 3790 });
    assert.deepEqual(config.tokens, { accessTtlSeconds: 43200, refreshIdleTtlDays: 90 });
    assert.deepEqual(config.renewal, { renewWhenDaysLeft: 5, checkEveryMinutes: 60 });
    assert.equal(config.hosts[0]?.access, 'auto');
    assert.equal(config.hosts[0]?.maxConcurrentJobs, 2);
    assert.deepEqual(config.hosts[0]?.mintPairingCode, ['t3', 'auth', 'pairing', 'create', '--ttl', '5m', '--json']);
  });

  test('projects allow work_start unless allowWorkStart is false', () => {
    const project = { alias: 'pilot', host: 'main', t3ProjectId: 'project-1' };
    assert.equal(parseConfig({ ...minimal, projects: [project] }).projects[0]?.allowWorkStart, true);
    assert.equal(parseConfig({ ...minimal, projects: [{ ...project, allowWorkStart: false }] }).projects[0]?.allowWorkStart, false);
    invalid({ ...minimal, projects: [{ ...project, allowWorkStart: 'no' }] }, /projects\[0\]\.allowWorkStart/);
  });

  test('the committed example config is valid', () => {
    const config = loadConfig(join(import.meta.dirname, '..', 'config.example.json'));
    assert.equal(config.projects[0]?.runtimeMode, 'approval-required');
  });

  test('normalizes publicUrl to an origin and keeps a port', () => {
    const config = parseConfig({ ...minimal, publicUrl: 'https://gateway.example.ts.net:8443/' });
    assert.equal(config.publicUrl, 'https://gateway.example.ts.net:8443');
  });

  test('rejects insecure or non-origin URLs', () => {
    invalid({ ...minimal, publicUrl: 'http://gateway.example.ts.net' }, /publicUrl: publicUrl must use https/);
    invalid({ ...minimal, publicUrl: 'https://gateway.example.ts.net/base' }, /must be an origin/);
    invalid({ ...minimal, publicUrl: 'not a url' }, /absolute URL/);
    invalid({ ...minimal, hosts: [{ id: 'main', t3Url: 'http://remote.example.ts.net:3773' }] }, /hosts\[0\]\.t3Url/);
  });

  test('accepts loopback http for local development', () => {
    assert.equal(parseConfig({ ...minimal, publicUrl: 'http://127.0.0.1:3790' }).publicUrl, 'http://127.0.0.1:3790');
  });

  test('rejects unknown keys so typos surface', () => {
    invalid({ ...minimal, hosst: [] }, /Unrecognized key/);
  });

  test('requires a loopback listen address', () => {
    invalid({ ...minimal, listen: { host: '0.0.0.0', port: 3790 } }, /loopback/);
  });

  test('validates hosts and project references', () => {
    invalid({ ...minimal, hosts: [] }, /at least one host/);
    invalid({ ...minimal, hosts: [minimal.hosts[0], minimal.hosts[0]] }, /duplicate host id/);
    invalid({ ...minimal, projects: [{ alias: 'a', host: 'other', t3ProjectId: 'p' }] }, /unknown host "other"/);
    invalid({ ...minimal, projects: [{ alias: 'a', host: 'main' }] }, /exactly one of t3ProjectId or t3ProjectTitle/);
    invalid(
      { ...minimal, projects: [{ alias: 'a', host: 'main', t3ProjectId: 'p', t3ProjectTitle: 'p' }] },
      /exactly one/,
    );
    invalid(
      {
        ...minimal,
        projects: [
          { alias: 'a', host: 'main', t3ProjectId: 'p' },
          { alias: 'a', host: 'main', t3ProjectId: 'q' },
        ],
      },
      /duplicate project alias/,
    );
    invalid({ ...minimal, hosts: [{ id: 'Main Host', t3Url: 'http://127.0.0.1:3773' }] }, /hosts\[0\]\.id/);
  });

  test('defaults runtimeMode to approval-required and enforces the host access ceiling', () => {
    const config = parseConfig({ ...minimal, projects: [{ alias: 'pilot', host: 'main', t3ProjectTitle: 'Pilot' }] });
    assert.equal(config.projects[0]?.runtimeMode, 'approval-required');
    invalid(
      {
        ...minimal,
        hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:3773', access: 'approval-required' }],
        projects: [{ alias: 'pilot', host: 'main', t3ProjectId: 'p', runtimeMode: 'full-access' }],
      },
      /exceeds host "main" access/,
    );
    assert.equal(runtimeModeAllowed('approval-required', 'read-only'), false);
    assert.equal(runtimeModeAllowed('auto', 'full-access'), true);
  });

  test('loadConfig reports a missing file and bad JSON with stable codes', (t) => {
    const dir = tempDir(t);
    assert.throws(() => loadConfig(join(dir, 'missing.json')), { code: 'config_not_found' });
    const path = join(dir, 'config.json');
    writeFileSync(path, '{ nope');
    assert.throws(() => loadConfig(path), { code: 'config_invalid' });
  });

  test('resolvePaths prefers flags, then environment, then home defaults', () => {
    const env = { T3FG_CONFIG: '/path/to/config.json', T3FG_DATA_DIR: '/path/to/data' };
    assert.deepEqual(resolvePaths(env), { configPath: '/path/to/config.json', dataDir: '/path/to/data' });
    assert.equal(resolvePaths(env, { dataDir: '/path/to/other' }).dataDir, '/path/to/other');
    assert.match(resolvePaths({}).configPath, /\.config\/t3-fleet-gateway\/config\.json$/);
    assert.match(resolvePaths({}).dataDir, /\.local\/share\/t3-fleet-gateway$/);
  });
});
