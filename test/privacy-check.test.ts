import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { tempDir } from './helpers/tmp.ts';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'privacy-check.ts');

// Every private-looking value here is synthetic and assembled at run time, so this file never holds a complete match
// of a pattern the check looks for (the check scans this repository, tests included).
const dotted = (...parts: Array<string | number>): string => parts.join('.');
const BODY = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5';
const HOST = dotted('studio', 'fixture-net', 'ts', 'net');
const PRIVATE = 'quartz-harbor-17';

interface Sample {
  category: string;
  value: string;
  /** The distinctive part, which must not be printed either. */
  core?: string;
}

const SAMPLES: Sample[] = [
  { category: 'tailnet-host', value: HOST, core: 'fixture-net' },
  { category: 'tailnet-host', value: dotted('fixture-net', 'ts', 'net'), core: 'fixture-net' },
  { category: 'tailnet-host', value: dotted('<machine>', 'fixture-net', 'ts', 'net'), core: 'fixture-net' },
  { category: 'home-path', value: ['', 'Users', 'zoe-fixture', 'code'].join('/'), core: 'zoe-fixture' },
  { category: 'home-path', value: ['', 'home', 'zoe-fixture'].join('/'), core: 'zoe-fixture' },
  { category: 'home-path', value: `file://${['', 'Users', 'zoe-fixture', 'x'].join('/')}`, core: 'zoe-fixture' },
  ...[dotted(10, 0, 4, 7), dotted(172, 16, 0, 1), dotted(172, 31, 255, 254), dotted(192, 168, 1, 20), dotted(100, 64, 0, 1), dotted(100, 127, 255, 255)]
    .map((value) => ({ category: 'private-ip', value })),
  { category: 'private-ip', value: ['fd7a', '115c', 'a1e0', 'ab12', '4843', 'cd96', '6253', '7d2f'].join(':'), core: 'ab12:4843' },
  ...['p', 'o', 'u', 's', 'r'].map((kind) => ({ category: 'github-token', value: `gh${kind}_${BODY}`, core: BODY })),
  { category: 'github-token', value: `${'github'}_pat_11AAAAAAA0${BODY}`, core: BODY },
  { category: 'api-key', value: `s${'k'}-proj-${BODY}xY`, core: BODY },
  { category: 'slack-token', value: `xox${'b'}-123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWx`, core: 'AbCdEfGhIjKlMnOp' },
  { category: 'aws-key', value: `AK${'IA'}Q7RXZ2MWD4NHT6VB`, core: 'Q7RXZ2MWD4NHT6VB' },
  { category: 'aws-key', value: `AS${'IA'}Q7RXZ2MWD4NHT6VB`, core: 'Q7RXZ2MWD4NHT6VB' },
  { category: 'private-key', value: `-----BEGIN ${'PRIVATE'} KEY-----` },
  { category: 'private-key', value: `-----BEGIN RSA ${'PRIVATE'} KEY-----` },
  { category: 'webhook-url', value: `https://hooks.${'slack'}.com/services/T01ABCDEF/B02GHIJKL/q1w2e3r4t5y6u7i8o9p0a1s2`, core: 'q1w2e3r4t5y6u7i8' },
  { category: 'webhook-url', value: `https://${'discord'}.com/api/webhooks/123456789012345678/${BODY}`, core: BODY },
];

/** Placeholders, documented examples and lookalikes that must not be reported. */
const PLACEHOLDER_LINES = [
  'https://gateway.example.ts.net/mcp, studio.example.ts.net and example.ts.net',
  '<machine>.<tailnet>.ts.net and https://<tailnet>.ts.net/base',
  "a wildcard *.ts.net, ${host}.ts.net and endsWith('.ts.net')",
  '/Users/<user>/code, /home/someone/code, /home/runner/work, /Users/runner/work, /home/user/x, /Users/example-user/x, /Users/Shared/x',
  'see ~/.config/app, https://example.com/home/about and see/home/page',
  '192.0.2.10, 198.51.100.7, 203.0.113.9, 8.8.8.8, 127.0.0.1 and 0.0.0.0',
  'not addresses: 10.300.1.1, 192.168.1.256, 172.32.0.1, 100.128.0.1, 100.63.0.1, 10.0.0.1.2, 1.10.0.0 and 10.0.19045.2965',
  'Synthetic-task-text-31c7, task-text-abcdefghijklmnopqrstuvwxyz0123456789 and desk-abcdefghijklmnopqrstuvwxyz012345678',
  'a slug: sk-this-is-a-long-kebab-case-identifier-without-digits-in-it',
  `filler: gh${'p'}_${'x'.repeat(36)}, s${'k'}-${'x'.repeat(40)} and xox${'b'}-${'0'.repeat(12)}`,
  'prefixes in prose: ghp_, github_pat_, AKIA, xoxb- and sk-',
  'the AWS documentation example key AKIAIOSFODNN7EXAMPLE',
  'xoxb-<token> and xoxb-your-token-here-without-digits',
  `https://hooks.slack.${'com'}/services/T${'0'.repeat(8)}/B${'0'.repeat(8)}/${'X'.repeat(24)}`,
  'hooks.slack.com alone and https://discord.com/api/webhooks/<id>/<token>',
  '-----BEGIN CERTIFICATE-----',
];

type Files = Record<string, string | Buffer>;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Standard output and standard error together. */
  output: string;
}

/** What a child sees: nothing from the developer's git settings, and nothing from the CI secret or pull request payload this suite may run under. */
function environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ['PRIVACY_DENYLIST', 'PRIVACY_DENYLIST_FILE', 'GITHUB_EVENT_PATH', 'GITHUB_EVENT_NAME', 'GITHUB_ACTIONS']) delete env[name];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Synthetic',
    GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic',
    GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
    ...extra,
  };
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, env: environment(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function put(dir: string, files: Files): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

function repo(t: TestContext, files: Files = {}): string {
  const dir = tempDir(t, 't3fg-privacy-');
  git(dir, ['init', '-q', '-b', 'main']);
  put(dir, files);
  return dir;
}

function commit(dir: string, messages: string[], env: Record<string, string> = {}): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '--no-verify', ...messages.flatMap((message) => ['-m', message])], env);
  return git(dir, ['rev-parse', 'HEAD']);
}

function check(cwd: string, args: string[] = [], options: { env?: Record<string, string>; input?: string } = {}): Run {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd, env: environment({ NODE_NO_WARNINGS: '1', ...options.env }), input: options.input ?? '', encoding: 'utf8', timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}${result.stderr}` };
}

/** The matched text must never reach a log, in any letter case. */
function assertSilent(run: Run, ...values: string[]): void {
  for (const value of values) assert.equal(run.output.toLowerCase().includes(value.toLowerCase()), false, 'the output printed text that matched');
}

/** The finding lines of a run ("location: what"), in order. */
const findings = (run: Run): string[] => run.stdout.split('\n').filter((line) => /^\S+:\d+: /.test(line));
const locations = (run: Run): string[] => findings(run).map((line) => line.slice(0, line.indexOf(': ')));
/** The whole output of a clean run. */
const ok = (files: number, entries = 0): string =>
  `privacy-check: ok. Scanned ${files} ${files === 1 ? 'file' : 'files'}; ${entries} private denylist ${entries === 1 ? 'entry' : 'entries'} loaded.\n`;
/** A run the check refused to make: exit code 2, one fixed line on standard error and nothing on standard output. */
const refused = (run: Run): { status: number | null; stdout: string; stderr: string } => ({ status: run.status, stdout: run.stdout, stderr: run.stderr });
const refusal = (message: string): { status: number; stdout: string; stderr: string } => ({ status: 2, stdout: '', stderr: `privacy-check: ${message}\n` });

const allow = (...entries: unknown[]): string => JSON.stringify({ files: entries });
const allowEntry = (extra: Record<string, unknown> = {}) => ({
  path: 'fixtures/key.txt', categories: ['private-key'], reason: 'Synthetic key used only by a test.', ...extra,
});

describe('privacy check: generic patterns', () => {
  test('reports each category by location and category only', (t) => {
    const files: Files = {};
    const name = (index: number) => `samples/${String(index + 1).padStart(2, '0')}.txt`;
    SAMPLES.forEach((sample, index) => { files[name(index)] = `first line\nsample: ${sample.value} end\nlast line\n`; });
    const run = check(repo(t, files));
    assert.equal(run.status, 1);
    SAMPLES.forEach((sample, index) => {
      const location = name(index).replace('.', '\\.');
      assert.match(run.stdout, new RegExp(`^${location}:2: .*\\[${sample.category}\\]$`, 'm'), `${sample.category} sample ${index + 1} is reported`);
    });
    assert.match(run.stdout, new RegExp(`^privacy-check: ${SAMPLES.length} findings\\. Scanned ${SAMPLES.length} files; 0 private`, 'm'));
    assertSilent(run, ...SAMPLES.flatMap((sample) => [sample.value, sample.core ?? sample.value]));
    assert.equal(run.stderr, '');
  });

  test('passes placeholders, documented examples and lookalikes', (t) => {
    const run = check(repo(t, { 'docs/placeholders.md': `${PLACEHOLDER_LINES.join('\n')}\n` }));
    assert.deepEqual({ status: run.status, output: run.output }, { status: 0, output: ok(1) });
  });

  test('reports a category once per line and prints at most 200 findings', (t) => {
    const twice = check(repo(t, { 'a.txt': `${dotted(10, 0, 0, 1)} and ${dotted(10, 0, 0, 2)}\n` }));
    assert.match(twice.stdout, /^a\.txt:1: .*\[private-ip\]$/m);
    assert.match(twice.stdout, /privacy-check: 1 finding\. Scanned 1 file;/);

    const many = Array.from({ length: 250 }, (_, index) => `address ${dotted(10, 0, 0, index)}`).join('\n');
    const run = check(repo(t, { 'big.txt': `${many}\n` }));
    assert.equal(run.status, 1);
    assert.equal(run.stdout.split('\n').filter((line) => line.startsWith('big.txt:')).length, 200);
    assert.match(run.stdout, /^\.\.\. and 50 more$/m);
    assert.match(run.stdout, /privacy-check: 250 findings\./);
  });

  test('an inline allow marker skips the generic patterns on its line only', (t) => {
    const run = check(repo(t, { 'a.md': `${HOST} privacy-check: allow\n${HOST}\n${HOST} <!-- privacy-check:   ALLOW -->\n` }));
    assert.equal(run.status, 1);
    assert.deepEqual(locations(run), ['a.md:2']);
    assertSilent(run, 'fixture-net');
  });
});

describe('privacy check: allow file', () => {
  test('skips named categories for named files and nothing else', (t) => {
    const key = `-----BEGIN ${'PRIVATE'} KEY-----`;
    const run = check(repo(t, {
      'scripts/privacy-allow.json': allow(allowEntry()),
      'fixtures/key.txt': `${key}\n${HOST}\n`,
      'fixtures/other.txt': `${key}\n`,
    }));
    assert.equal(run.status, 1);
    assert.deepEqual(locations(run), ['fixtures/key.txt:2', 'fixtures/other.txt:1']);
  });

  test('passes when the allowed file holds only what the entry allows', (t) => {
    const run = check(repo(t, { 'scripts/privacy-allow.json': allow(allowEntry()), 'fixtures/key.txt': `-----BEGIN ${'PRIVATE'} KEY-----\n` }));
    assert.deepEqual({ status: run.status, output: run.output }, { status: 0, output: ok(2) });
  });

  test('keeps the list minimal: an entry that suppresses nothing is a finding', (t) => {
    const unused = check(repo(t, {
      'scripts/privacy-allow.json': allow(allowEntry({ categories: ['private-key', 'home-path'] })),
      'fixtures/key.txt': `-----BEGIN ${'PRIVATE'} KEY-----\n`,
    }));
    assert.equal(unused.status, 1);
    assert.match(unused.stdout, /^scripts\/privacy-allow\.json: entry #1 allows home-path but its file does not need it; remove it$/m);

    const missing = check(repo(t, { 'scripts/privacy-allow.json': allow(allowEntry({ path: 'fixtures/gone.txt' })) }));
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /^scripts\/privacy-allow\.json: entry #1 names a file that is not in the checkout; remove it$/m);
  });

  test('refuses a malformed allow file without quoting it', (t) => {
    const cases: Array<[string, string]> = [
      ['not json', '{'],
      ['not an object with files', JSON.stringify([])],
      ['an extra top-level key', JSON.stringify({ files: [], extra: true })],
      ['an unknown category', allow(allowEntry({ categories: ['bogus-category'] }))],
      ['the private denylist as a category', allow(allowEntry({ categories: ['denylist'] }))],
      ['no categories', allow(allowEntry({ categories: [] }))],
      ['an empty reason', allow(allowEntry({ reason: '' }))],
      ['a parent path', allow(allowEntry({ path: '../outside.txt' }))],
      ['an absolute path', allow(allowEntry({ path: '/etc/hosts' }))],
      ['an unknown key', allow(allowEntry({ note: 'x' }))],
      ['a repeated path', allow(allowEntry(), allowEntry())],
    ];
    for (const [name, content] of cases) {
      const run = check(repo(t, { 'scripts/privacy-allow.json': content, 'fixtures/key.txt': 'x\n' }));
      assert.equal(run.status, 2, name);
      assert.match(run.stderr, /^privacy-check: .*privacy-allow\.json/, name);
      assert.equal(run.stdout, '', name);
      assertSilent(run, 'bogus-category', '/etc/hosts', 'outside.txt');
    }
  });
});

describe('privacy check: private denylist', () => {
  test('matches substrings without regard to case and regular expressions, and prints only the entry number', (t) => {
    const dir = repo(t, {
      'a.md': `fine\nsee ${PRIVATE.toUpperCase()} here\n`,
      'b.md': 'zebra-042 and zebra-4\n',
      'c.md': 'nothing private\n',
    });
    const run = check(dir, [], { env: { PRIVACY_DENYLIST: `# a comment\n\n${PRIVATE}\r\nre:zebra-\\d{3}\n` } });
    assert.equal(run.status, 1);
    assert.deepEqual(findings(run), ['a.md:2: private denylist entry #1', 'b.md:1: private denylist entry #2']);
    assert.match(run.stdout, /Scanned 3 files; 2 private denylist entries loaded\.$/m);
    assertSilent(run, PRIVATE, 'zebra', 'quartz');
  });

  test('reads .privacy-denylist by default, after the variable, and never scans the list itself', (t) => {
    const dir = repo(t, {
      '.privacy-denylist': '# local list\r\nbravo-private\r\nALPHA-PRIVATE\r\n',
      'a.md': 'alpha-private\n',
      'b.md': 'bravo-private\n',
    });
    const run = check(dir, [], { env: { PRIVACY_DENYLIST: 'alpha-private' } });
    assert.equal(run.status, 1);
    // The variable's entry is #1 and the file's duplicate of it is dropped; the file's own entry follows as #2.
    assert.deepEqual(findings(run), ['a.md:1: private denylist entry #1', 'b.md:1: private denylist entry #2']);
    assert.match(run.stdout, /Scanned 2 files; 2 private denylist entries loaded\.$/m);
    assertSilent(run, 'alpha-private', 'bravo-private');
  });

  test('PRIVACY_DENYLIST_FILE replaces the default file and is resolved from the working directory', (t) => {
    const dir = repo(t, { '.privacy-denylist': 'ignored-entry\n', 'lists/mine.txt': `${PRIVATE}\n`, 'a.md': `${PRIVATE}\n`, 'b.md': 'ignored-entry\n' });
    const run = check(dir, [], { env: { PRIVACY_DENYLIST_FILE: 'lists/mine.txt' } });
    assert.equal(run.status, 1);
    assert.deepEqual(findings(run), ['a.md:1: private denylist entry #1']);
    assert.match(run.stdout, /Scanned 3 files; 1 private denylist entry loaded\.$/m);
  });

  test('a committed denylist file is a finding, because the list itself must stay private', (t) => {
    const dir = repo(t, { '.privacy-denylist': `${PRIVATE}\n` });
    git(dir, ['add', '-A']);
    const run = check(dir);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^\.privacy-denylist:1: private denylist entry #1$/m);
    assertSilent(run, PRIVATE);
  });

  test('a linked worktree without its own list uses the main checkout\'s', (t) => {
    const main = repo(t, { '.gitignore': '.privacy-denylist\n', 'README.md': 'hello\n', '.privacy-denylist': `${PRIVATE}\n` });
    commit(main, ['Initial commit']);
    const linked = join(tempDir(t, 't3fg-privacy-wt-'), 'linked');
    git(main, ['worktree', 'add', '-q', '-b', 'topic', linked]);
    put(linked, { 'notes.md': `${PRIVATE}\n` });
    const run = check(linked);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^notes\.md:1: private denylist entry #1$/m);
    assert.match(run.stdout, /1 private denylist entry loaded\./);
    assertSilent(run, PRIVATE);
  });

  test('a file name that would match is withheld, and so is a generic match in a name', (t) => {
    const run = check(repo(t, { [`docs/${PRIVATE}-notes.md`]: 'fine\n', [`docs/${HOST}.md`]: 'fine\n' }), [], { env: { PRIVACY_DENYLIST: PRIVATE } });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^<file name withheld #1>: in the file name, private denylist entry #1$/m);
    assert.match(run.stdout, /^<file name withheld #2>: in the file name, Tailscale host name .*\[tailnet-host\]$/m);
    assertSilent(run, PRIVATE, 'fixture-net');
  });

  test('neither the inline marker nor the allow file can skip an entry', (t) => {
    const dir = repo(t, {
      'scripts/privacy-allow.json': allow(allowEntry({ path: 'fixtures/key.txt' })),
      'fixtures/key.txt': `-----BEGIN ${'PRIVATE'} KEY-----\n${PRIVATE}\n`,
      'a.md': `${PRIVATE} privacy-check: allow\n`,
    });
    const run = check(dir, [], { env: { PRIVACY_DENYLIST: PRIVATE } });
    assert.equal(run.status, 1);
    assert.deepEqual(findings(run), ['a.md:1: private denylist entry #1', 'fixtures/key.txt:2: private denylist entry #1']);
  });

  test('refuses entries and files it cannot use, naming only the entry number', (t) => {
    const dir = repo(t, { 'a.md': 'fine\n' });
    const invalid = check(dir, [], { env: { PRIVACY_DENYLIST: `${PRIVATE}\nre:(unclosed-${PRIVATE}` } });
    assert.deepEqual(refused(invalid), refusal('private denylist entry #2 is not a valid regular expression'));
    const everything = check(dir, [], { env: { PRIVACY_DENYLIST: 're:x*' } });
    assert.deepEqual(refused(everything), refusal('private denylist entry #1 would match every line'));
    const missing = check(dir, [], { env: { PRIVACY_DENYLIST_FILE: join(dir, 'no-such-list') } });
    assert.deepEqual(refused(missing), refusal('the private denylist file could not be read'));
    assertSilent(invalid, PRIVATE);
    assertSilent(missing, 'no-such-list');
  });

  test('an empty variable and a missing default file mean no entries', (t) => {
    const run = check(repo(t, { 'a.md': 'fine\n' }), [], { env: { PRIVACY_DENYLIST: '' } });
    assert.deepEqual({ status: run.status, output: run.output }, { status: 0, output: ok(1) });
  });
});

describe('privacy check: other sources', () => {
  test('--file and --stdin scan release notes and PR text, repeatable', (t) => {
    const dir = repo(t, { 'a.md': 'fine\n' });
    const notes = join(tempDir(t, 't3fg-privacy-notes-'), 'notes.md');
    const more = join(tempDir(t, 't3fg-privacy-notes-'), 'more.md');
    writeFileSync(notes, `Release notes\r\nrolled out on ${HOST}\r\n`);
    writeFileSync(more, `${['', 'Users', 'zoe-fixture', 'x'].join('/')}\n`);
    const run = check(dir, ['--file', notes, '--file', more, '--stdin'], { input: `one\ntwo\n${dotted(192, 168, 0, 9)}\n` });
    assert.equal(run.status, 1);
    assert.deepEqual(run.stdout.split('\n').filter((line) => /^\S+:\d+: /.test(line)).map((line) => line.replace(/: .*\[(.*)\]$/, ' $1')), [
      `${notes}:2 tailnet-host`, `${more}:1 home-path`, 'stdin:3 private-ip',
    ]);
    assert.match(run.stdout, /Scanned 1 file, 3 more texts;/);
    assertSilent(run, 'fixture-net', 'zoe-fixture', dotted(192, 168, 0, 9));
    assert.equal(check(dir, ['--stdin'], { input: 'clean\n' }).status, 0);
  });

  test('--file also applies the private denylist, and an unreadable file stops the check', (t) => {
    const dir = repo(t, { 'a.md': 'fine\n' });
    const notes = join(tempDir(t, 't3fg-privacy-notes-'), 'notes.md');
    writeFileSync(notes, `release ${PRIVATE}\n`);
    const run = check(dir, ['--file', notes], { env: { PRIVACY_DENYLIST: PRIVATE } });
    assert.equal(run.status, 1);
    assert.match(run.stdout, new RegExp(`^${notes.replaceAll('.', '\\.')}:1: private denylist entry #1$`, 'm'));
    assertSilent(run, PRIVATE);
    const missing = check(dir, ['--file', 'no-such-notes.md']);
    assert.deepEqual(refused(missing), refusal('a --file argument could not be read'));
  });

  test('--commits scans commit messages and author lines in a range', (t) => {
    const dir = repo(t, { 'a.txt': 'one\n' });
    commit(dir, [`Old commit mentioning ${HOST}`]);
    put(dir, { 'a.txt': 'two\n' });
    const sha = commit(dir, ['Second commit', `Notes: deployed on ${HOST}`], { GIT_AUTHOR_EMAIL: `someone@${PRIVATE}.invalid` });
    const short = sha.slice(0, 10);

    const run = check(dir, ['--commits', 'HEAD~1..HEAD'], { env: { PRIVACY_DENYLIST: PRIVATE } });
    assert.equal(run.status, 1);
    assert.deepEqual(run.stdout.split('\n').filter((line) => line.startsWith('commit ')).map((line) => line.replace(/: .*\[(.*)\]$/, ' $1')), [
      `commit ${short}:author: private denylist entry #1`, `commit ${short}:3 tailnet-host`,
    ]);
    assert.match(run.stdout, /Scanned 1 file, 1 commit;/);
    assertSilent(run, PRIVATE, 'fixture-net');

    // An empty range scans no commit; the old commit is outside the first range and inside the whole history.
    const empty = check(dir, ['--commits', 'HEAD..HEAD']);
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /Scanned 1 file, 0 commits;/);
    assert.match(check(dir, ['--commits', 'HEAD']).stdout, /^commit [0-9a-f]{10}:1: .*\[tailnet-host\]$/m);
  });

  test('--commits refuses a bad range without echoing it', (t) => {
    const dir = repo(t, { 'a.txt': 'one\n' });
    commit(dir, ['Initial commit']);
    for (const args of [['--commits', `no-such-ref-${PRIVATE}..HEAD`], ['--commits=--oneline'], ['--commits', '--oneline'], ['--commits']]) {
      const run = check(dir, args);
      assert.equal(run.status, 2, args.join(' '));
      assert.equal(run.stdout, '');
      assertSilent(run, PRIVATE);
    }
  });

  test('scans the title and body of a pull request payload', (t) => {
    const dir = repo(t, { 'a.md': 'fine\n' });
    const payload = join(tempDir(t, 't3fg-privacy-event-'), 'event.json');
    writeFileSync(payload, JSON.stringify({
      action: 'edited',
      pull_request: { title: `Add a thing on ${HOST}`, body: `Summary\n\nChecked against ${PRIVATE}\n${dotted(10, 1, 2, 3)}` },
    }));
    const env = { GITHUB_EVENT_PATH: payload, GITHUB_EVENT_NAME: 'pull_request', PRIVACY_DENYLIST: PRIVATE };
    const run = check(dir, [], { env });
    assert.equal(run.status, 1);
    assert.deepEqual(run.stdout.split('\n').filter((line) => line.startsWith('PR ')).map((line) => line.replace(/: .*\[(.*)\]$/, ' $1')), [
      'PR title:1 tailnet-host', 'PR body:3: private denylist entry #1', 'PR body:4 private-ip',
    ]);
    assert.match(run.stdout, /Scanned 1 file, 1 more text;/);
    assertSilent(run, PRIVATE, 'fixture-net', dotted(10, 1, 2, 3));

    writeFileSync(payload, JSON.stringify({ action: 'opened', pull_request: { title: 'Fine title', body: null } }));
    assert.equal(check(dir, [], { env }).status, 0);
  });

  test('ignores other events, and stops on a pull request payload it cannot read', (t) => {
    const dir = repo(t, { 'a.md': 'fine\n' });
    const payload = join(tempDir(t, 't3fg-privacy-event-'), 'event.json');
    writeFileSync(payload, JSON.stringify({ ref: 'refs/heads/main', head_commit: { message: `pushed from ${HOST}` } }));
    assert.equal(check(dir, [], { env: { GITHUB_EVENT_PATH: payload, GITHUB_EVENT_NAME: 'push' } }).status, 0);

    writeFileSync(payload, 'not json');
    assert.equal(check(dir, [], { env: { GITHUB_EVENT_PATH: payload, GITHUB_EVENT_NAME: 'push' } }).status, 0);
    const unreadable = check(dir, [], { env: { GITHUB_EVENT_PATH: payload, GITHUB_EVENT_NAME: 'pull_request' } });
    assert.deepEqual(refused(unreadable), refusal('the pull request event payload could not be read'));
  });
});

describe('privacy check: files and exit codes', () => {
  test('scans tracked and new files from any directory of the work tree, and skips what is not text it owns', (t) => {
    const outside = tempDir(t, 't3fg-privacy-outside-');
    writeFileSync(join(outside, 'target.txt'), `${HOST}\n`);
    const dir = repo(t, {
      '.gitignore': 'ignored/\n',
      'tracked.txt': 'fine\r\n',
      'sub/deeper/new.txt': `fine\r\nstill fine\r\n${HOST}\r\n`,
      'ignored/secret.txt': `${HOST}\n`,
      'node_modules/pkg/index.js': `${HOST}\n`,
      'binary.bin': Buffer.concat([Buffer.from(`${HOST}\n`), Buffer.from([0, 1, 2])]),
      'gone.txt': `${HOST}\n`,
    });
    symlinkSync(join(outside, 'target.txt'), join(dir, 'link.txt'));
    git(dir, ['add', 'tracked.txt', 'gone.txt', '.gitignore']);
    rmSync(join(dir, 'gone.txt'));

    const run = check(join(dir, 'sub', 'deeper'));
    assert.equal(run.status, 1);
    assert.deepEqual(locations(run), ['sub/deeper/new.txt:3']);
    assert.match(run.stdout, /Scanned 3 files \(1 binary skipped\);/);
  });

  test('a clean repository passes with exit code 0', (t) => {
    const run = check(repo(t, { 'a.md': 'hello\n', 'b/c.ts': 'export const x = 1;\n' }));
    assert.deepEqual({ status: run.status, output: run.output }, { status: 0, output: ok(2) });
  });

  test('usage and environment problems exit with code 2 and no scan output', (t) => {
    const dir = repo(t, { 'a.md': 'fine\n' });
    for (const args of [['--nope'], ['stray-argument'], ['--stdin=yes']]) {
      const run = check(dir, args);
      assert.deepEqual(refused(run), refusal('unrecognized arguments; see --help'), args.join(' '));
    }
    const notGit = check(tempDir(t, 't3fg-privacy-plain-'));
    assert.deepEqual(refused(notGit), refusal('this is not a git work tree, or git is not available'));
  });

  test('--help prints the usage and exits with code 0', (t) => {
    const run = check(repo(t), ['--help']);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /^Usage: node scripts\/privacy-check\.ts/);
    assert.match(run.stdout, /PRIVACY_DENYLIST_FILE/);
  });
});
