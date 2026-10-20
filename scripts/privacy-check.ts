/**
 * Privacy check: fails when files, commit messages or pull request text hold something that must not be public
 * (machine-specific values, credentials, private names). Plain Node 24+ with node: modules only.
 * Rules and placeholders: AGENTS.md, "Privacy and publishing". Usage: node scripts/privacy-check.ts --help
 *
 * CI logs are public, so the text that matched is NEVER printed: a finding is a location (path:line, "PR body:line",
 * "commit <sha>:line"), a category, and for the private denylist the entry's number. A file name that would match
 * is withheld the same way. Only fixed text, counts and git's own short ids reach the output.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `Usage: node scripts/privacy-check.ts [options]

Scan the repository's files (tracked ones, plus new files git would add) for values that must stay private.
The text that matched is never printed, only where it is and what kind it is.

  --file <path>       Also scan a text file, for example PR or release notes (repeatable)
  --stdin             Also scan text read from standard input
  --commits <range>   Also scan commit messages and author lines in a git range, for example origin/main..HEAD
  --help              Show this help

Private denylist (never committed): one entry per line, '#' starts a comment line, matched as a case-insensitive
substring, or 're:' plus a JavaScript regular expression (case-insensitive). Entries are numbered in order, the
variable's first, blank and comment lines not counted.
  PRIVACY_DENYLIST        entries, newline-separated (a repository secret in CI)
  PRIVACY_DENYLIST_FILE   file with entries; default .privacy-denylist at the repository root (gitignored; a linked
                          worktree without one uses the main checkout's)
In a GitHub Actions pull_request run (GITHUB_EVENT_PATH) the pull request title and body are scanned too.

Generic patterns: a line holding "privacy-check: allow" skips them, and scripts/privacy-allow.json skips named
categories for named files. Neither can skip a private denylist entry.

Exit codes: 0 clean, 1 findings, 2 the check could not run (usage, git, denylist or allowlist problem).`;

type Category =
  | 'tailnet-host' | 'home-path' | 'private-ip' | 'github-token' | 'api-key' | 'slack-token' | 'aws-key' | 'private-key' | 'webhook-url';

interface Rule {
  id: Category;
  /** Fixed text printed with a finding. */
  label: string;
  /** Global patterns; group captures feed `placeholder`. */
  patterns: RegExp[];
  /** True when a match is an obvious placeholder, not a finding. */
  placeholder?: (match: RegExpMatchArray) => boolean;
}

/** A filler body such as xxxxxxxx or 00000000 has almost no distinct characters; a real token has dozens. */
const isFiller = (text: string): boolean => new Set(text.toLowerCase()).size <= 3;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const PLACEHOLDER_TAILNETS = new Set(['example', 'tailnet', 'tailnet-name', 'your-tailnet', 'my-tailnet']);
const PLACEHOLDER_USERS = new Set(['user', 'username', 'you', 'me', 'name', 'someone', 'runner', 'shared']);

function placeholderTailnet(match: RegExpMatchArray): boolean {
  // match[1] is the host without ".ts.net"; its last label is the tailnet, the part that identifies the owner.
  const tailnet = (match[1] ?? '').split('.').pop()?.toLowerCase() ?? '';
  return PLACEHOLDER_TAILNETS.has(tailnet) || /^<[^<>]+>$/.test(tailnet);
}

function placeholderUser(match: RegExpMatchArray): boolean {
  const name = (match[1] ?? '').replace(/[._-]+$/, '').toLowerCase();
  return PLACEHOLDER_USERS.has(name) || /^(?:example|your|my)(?:[._-][a-z0-9]+)*$/.test(name);
}

const RULES: Rule[] = [
  {
    id: 'tailnet-host',
    label: 'Tailscale host name (*.ts.net) that is not a placeholder',
    // The tailnet is the label before ts.net. example.ts.net subdomains and <angle> placeholders pass.
    patterns: [/(?<![\w<>.-])((?:[\w<>-]+\.)*[\w<>-]+)\.ts\.net(?![\w-])/gi],
    placeholder: placeholderTailnet,
  },
  {
    id: 'home-path',
    label: 'home-directory path with a user name',
    // Not part of a URL or a longer path (example.com/home/x), and the name must be a real-looking one.
    patterns: [/(?<![\w.$}\])*~-])\/(?:Users|home)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g],
    placeholder: placeholderUser,
  },
  {
    id: 'private-ip',
    label: 'private or tailnet IP address',
    // Four valid octets in 10/8, 172.16/12, 192.168/16 or 100.64/10, and no digit or ".digit" around them.
    patterns: [
      new RegExp(
        `(?<![\\d.])(?:10(?:\\.${OCTET}){3}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.${OCTET}){2}|192\\.168(?:\\.${OCTET}){2}` +
        `|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])(?:\\.${OCTET}){2})(?!\\d|\\.\\d)`, 'g'),
      // Tailscale's documented IPv6 prefix, with at least two groups after it (the bare prefix is not an address).
      /(?<![0-9a-f:])fd7a:115c:a1e0(?::[0-9a-f]{1,4}){2,}/gi,
    ],
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    patterns: [/(?<!\w)(?:gh[pousr]_([A-Za-z0-9]{36,255})|github_pat_([A-Za-z0-9_]{22,255}))(?!\w)/g],
    placeholder: (match) => isFiller(match[1] ?? match[2] ?? ''),
  },
  {
    id: 'api-key',
    label: 'API key (sk-...)',
    // Not inside a word or slug (task-, desk-), at least 32 characters, mixed letters and digits.
    patterns: [/(?<![\w-])sk-([\w-]{32,})/g],
    placeholder: (match) => {
      const body = match[1] ?? '';
      return !/\d/.test(body) || !/[A-Za-z]/.test(body) || isFiller(body);
    },
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    patterns: [/(?<![A-Za-z0-9])xox[a-z]-([A-Za-z0-9-]{10,})/g],
    placeholder: (match) => !/\d/.test(match[1] ?? '') || isFiller(match[1] ?? ''),
  },
  {
    id: 'aws-key',
    label: 'AWS access key id',
    // The documentation example key ends in EXAMPLE.
    patterns: [/(?<![A-Za-z0-9])(?:AKIA|ASIA)([0-9A-Z]{16})(?![A-Za-z0-9])/g],
    placeholder: (match) => (match[1] ?? '').endsWith('EXAMPLE') || isFiller(match[1] ?? ''),
  },
  {
    id: 'private-key',
    label: 'private key block',
    patterns: [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
  },
  {
    id: 'webhook-url',
    label: 'Slack or Discord webhook URL',
    // Only a URL that carries the secret path; Slack's own documentation placeholder ends in XXXX filler.
    patterns: [
      /hooks\.slack\.com\/(?:services|workflows|triggers|actions)\/([\w/-]{8,})/g,
      /discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{5,}\/([\w-]{8,})/g,
    ],
    placeholder: (match) => isFiller((match[1] ?? '').split('/').pop() ?? ''),
  },
];
const CATEGORIES = new Set<string>(RULES.map((rule) => rule.id));
const MARKER = /privacy-check:\s*allow\b/i;
const ALLOW_FILE = 'scripts/privacy-allow.json';
const MAX_PRINTED = 200;

/** A problem that stops the check; the message is fixed text and never quotes input. */
class CheckError extends Error {}

interface DenyEntry {
  index: number;
  matches: (line: string, lower: string) => boolean;
}

interface AllowEntry {
  index: number;
  path: string;
  categories: Set<Category>;
  used: Set<Category>;
}

function git(cwd: string, args: string[], failure: string): Buffer {
  try {
    // Standard error is dropped: git's messages can quote paths and ranges.
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 });
  } catch {
    throw new CheckError(failure);
  }
}

function parseDenylist(texts: string[]): DenyEntry[] {
  const seen = new Set<string>();
  const entries: DenyEntry[] = [];
  for (const text of texts) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const key = line.startsWith('re:') ? line : line.toLowerCase();
      if (!line || line.startsWith('#') || seen.has(key)) continue;
      seen.add(key);
      const index = entries.length + 1;
      if (line.startsWith('re:')) {
        const source = line.slice(3).trim();
        let pattern: RegExp;
        try {
          pattern = new RegExp(source, 'i');
        } catch {
          throw new CheckError(`private denylist entry #${index} is not a valid regular expression`);
        }
        if (!source || pattern.test('')) throw new CheckError(`private denylist entry #${index} would match every line`);
        entries.push({ index, matches: (value) => pattern.test(value) });
      } else {
        const needle = line.toLowerCase();
        entries.push({ index, matches: (_value, lower) => lower.includes(needle) });
      }
    }
  }
  return entries;
}

function readText(path: string, failure: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new CheckError(failure);
  }
}

/** The default denylist file: the checkout's own, else the main checkout's when this is a linked worktree. */
function defaultDenylistFile(root: string): string | null {
  const own = join(root, '.privacy-denylist');
  if (existsSync(own)) return own;
  const common = git(root, ['rev-parse', '--git-common-dir'], 'git rev-parse failed').toString('utf8').trim();
  const shared = join(dirname(resolve(root, common)), '.privacy-denylist');
  return shared !== own && existsSync(shared) ? shared : null;
}

function loadDenylist(root: string, cwd: string, env: NodeJS.ProcessEnv): { entries: DenyEntry[]; files: string[] } {
  const texts: string[] = [];
  const files: string[] = [];
  if (env.PRIVACY_DENYLIST) texts.push(env.PRIVACY_DENYLIST);
  const explicit = env.PRIVACY_DENYLIST_FILE;
  const path = explicit ? resolve(cwd, explicit) : defaultDenylistFile(root);
  if (path) {
    texts.push(readText(path, 'the private denylist file could not be read'));
    files.push(path);
  }
  return { entries: parseDenylist(texts), files };
}

function loadAllowlist(root: string): AllowEntry[] {
  const path = join(root, ALLOW_FILE);
  if (!existsSync(path)) return [];
  const invalid = (index: number) =>
    new CheckError(`${ALLOW_FILE} entry #${index} is invalid: it needs a repository path, known categories and a reason`);
  let data: unknown;
  try {
    data = JSON.parse(readText(path, `${ALLOW_FILE} could not be read`));
  } catch (error) {
    if (error instanceof CheckError) throw error;
    throw new CheckError(`${ALLOW_FILE} is not valid JSON`);
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isRecord(data) || Object.keys(data).some((key) => key !== 'files') || !Array.isArray(data.files)) {
    throw new CheckError(`${ALLOW_FILE} must be an object with a "files" array`);
  }
  const paths = new Set<string>();
  return data.files.map((item: unknown, position: number): AllowEntry => {
    const index = position + 1;
    if (!isRecord(item) || Object.keys(item).some((key) => !['path', 'categories', 'reason'].includes(key))) throw invalid(index);
    const { path: file, categories, reason } = item;
    if (typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')) {
      throw invalid(index);
    }
    if (!Array.isArray(categories) || categories.length === 0 || !categories.every((c) => typeof c === 'string' && CATEGORIES.has(c))) {
      throw invalid(index);
    }
    if (typeof reason !== 'string' || reason.trim().length < 10) throw invalid(index);
    if (paths.has(file)) throw new CheckError(`${ALLOW_FILE} entry #${index} repeats an earlier path`);
    paths.add(file);
    return { index, path: file, categories: new Set(categories as Category[]), used: new Set() };
  });
}

/** Where a pull request payload says the title and body are, when this run is a pull request event. */
function pullRequestText(env: NodeJS.ProcessEnv): { title: string; body: string } | null {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return null;
  const required = /^pull_request/.test(env.GITHUB_EVENT_NAME ?? '');
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    if (required) throw new CheckError('the pull request event payload could not be read');
    return null;
  }
  const request = typeof payload === 'object' && payload !== null ? (payload as { pull_request?: unknown }).pull_request : undefined;
  if (typeof request !== 'object' || request === null) return null;
  const { title, body } = request as { title?: unknown; body?: unknown };
  return { title: typeof title === 'string' ? title : '', body: typeof body === 'string' ? body : '' };
}

function commitRecords(root: string, range: string): { sha: string; author: string; committer: string; message: string }[] {
  if (!range || range.startsWith('-')) throw new CheckError('--commits needs a git revision range such as origin/main..HEAD');
  // Per commit: id, author and committer lines, then the whole message. Git's own error text is never shown (it can quote the range).
  const args = ['log', '-z', '--format=%H%n%an <%ae>%n%cn <%ce>%n%B', '--end-of-options', range];
  const output = git(root, args, 'git log failed; is the --commits range valid?').toString('utf8');
  return output.split('\0').filter(Boolean).map((record) => {
    const [sha = '', author = '', committer = '', ...message] = record.split('\n');
    return { sha, author, committer, message: message.join('\n') };
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string, out: (line: string) => void): Promise<number> {
  let options;
  try {
    options = parseArgs({
      args: argv,
      options: {
        file: { type: 'string', multiple: true },
        stdin: { type: 'boolean' },
        commits: { type: 'string' },
        help: { type: 'boolean' },
      },
      allowPositionals: false,
    }).values;
  } catch {
    throw new CheckError('unrecognized arguments; see --help');
  }
  if (options.help) {
    out(HELP);
    return 0;
  }

  const root = git(cwd, ['rev-parse', '--show-toplevel'], 'this is not a git work tree, or git is not available').toString('utf8').trim();
  const denylist = loadDenylist(root, cwd, env);
  const allowlist = loadAllowlist(root);
  const allowByPath = new Map(allowlist.map((entry) => [entry.path, entry]));

  const findings: string[] = [];
  const reported = new Set<string>();
  const none = new Set<Category>();
  let withheld = 0;

  const report = (where: string, what: string): void => {
    const line = `${where}: ${what}`;
    if (!reported.has(line)) {
      reported.add(line);
      findings.push(line);
    }
  };

  /** What one line holds, as fixed text. Private denylist hits are never suppressible; generic ones can be. */
  const hitsFor = (line: string, allowed: ReadonlySet<Category>, used: Set<Category>): string[] => {
    const hits: string[] = [];
    if (denylist.entries.length > 0) {
      const lower = line.toLowerCase();
      for (const entry of denylist.entries) if (entry.matches(line, lower)) hits.push(`private denylist entry #${entry.index}`);
    }
    if (MARKER.test(line)) return hits;
    for (const rule of RULES) {
      const found = rule.patterns.some((pattern) => {
        for (const match of line.matchAll(pattern)) if (!rule.placeholder?.(match)) return true;
        return false;
      });
      if (!found) continue;
      if (allowed.has(rule.id)) used.add(rule.id);
      else hits.push(`${rule.label} [${rule.id}]`);
    }
    return hits;
  };

  const scanText = (
    where: (line: number) => string,
    text: string,
    allowed: ReadonlySet<Category> = none,
    used: Set<Category> = new Set(),
  ): void => {
    let number = 0;
    for (const line of text.split(/\r?\n/)) {
      number++;
      for (const hit of hitsFor(line, allowed, used)) report(where(number), hit);
    }
  };

  /** A path as shown to the reader, or a stand-in when the path itself would match something. */
  const labelFor = (path: string): string => {
    const hits = hitsFor(path, none, new Set());
    if (hits.length === 0) return path;
    const label = `<file name withheld #${++withheld}>`;
    for (const hit of hits) report(label, `in the file name, ${hit}`);
    return label;
  };

  // Tracked files and new files git would add. An untracked denylist file is the one thing never scanned: it is the list.
  const listed = (args: string[]): string[] =>
    git(root, ['ls-files', '-z', ...args], 'git ls-files failed').toString('utf8').split('\0').filter(Boolean);
  const denylistFiles = new Set(denylist.files.map((file) => realpathSync(file)));
  const isDenylistFile = (path: string): boolean => {
    try {
      return denylistFiles.has(realpathSync(join(root, path)));
    } catch {
      return false;
    }
  };
  const untracked = listed(['--others', '--exclude-standard']).filter((path) => !isDenylistFile(path));
  const paths = [...new Set([...listed([]), ...untracked])].sort();

  let files = 0;
  let binary = 0;
  const seenPaths = new Set<string>();
  for (const path of paths) {
    if (path.split('/').includes('node_modules')) continue;
    const absolute = join(root, path);
    let buffer: Buffer;
    try {
      if (!lstatSync(absolute).isFile()) continue;
      buffer = readFileSync(absolute);
    } catch {
      continue;
    }
    seenPaths.add(path);
    if (buffer.includes(0)) {
      binary++;
      continue;
    }
    files++;
    const label = labelFor(path);
    const allow = allowByPath.get(path);
    scanText((line) => `${label}:${line}`, buffer.toString('utf8'), allow?.categories, allow?.used);
  }

  let extras = 0;
  for (const file of options.file ?? []) {
    const label = labelFor(file);
    scanText((line) => `${label}:${line}`, readText(resolve(cwd, file), 'a --file argument could not be read'));
    extras++;
  }
  if (options.stdin) {
    scanText((line) => `stdin:${line}`, await readStdin());
    extras++;
  }
  const request = pullRequestText(env);
  if (request) {
    scanText(() => 'PR title:1', request.title);
    scanText((line) => `PR body:${line}`, request.body);
    extras++;
  }
  let commits = 0;
  if (options.commits !== undefined) {
    for (const commit of commitRecords(root, options.commits)) {
      const short = commit.sha.slice(0, 10);
      scanText(() => `commit ${short}:author`, commit.author);
      scanText(() => `commit ${short}:committer`, commit.committer);
      scanText((line) => `commit ${short}:${line}`, commit.message);
      commits++;
    }
  }

  // Keep the allowlist minimal: an entry that no longer suppresses anything has to go.
  for (const entry of allowlist) {
    if (!seenPaths.has(entry.path)) {
      report(ALLOW_FILE, `entry #${entry.index} names a file that is not in the checkout; remove it`);
      continue;
    }
    for (const category of entry.categories) {
      if (!entry.used.has(category)) report(ALLOW_FILE, `entry #${entry.index} allows ${category} but its file does not need it; remove it`);
    }
  }

  for (const line of findings.slice(0, MAX_PRINTED)) out(line);
  if (findings.length > MAX_PRINTED) out(`... and ${findings.length - MAX_PRINTED} more`);
  if (findings.length > 0) {
    out('The text that matched is not printed. Replace it with a placeholder (AGENTS.md, "Privacy and publishing");');
    out('a rare intentional fixture can carry "privacy-check: allow" on its line. Private denylist entries cannot be allowed.');
  }
  const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
  const scanned = [`${plural(files, 'file')}${binary > 0 ? ` (${binary} binary skipped)` : ''}`];
  if (options.commits !== undefined) scanned.push(plural(commits, 'commit'));
  if (extras > 0) scanned.push(plural(extras, 'more text'));
  const count = denylist.entries.length;
  const verdict = findings.length === 0 ? 'ok' : plural(findings.length, 'finding');
  out(`privacy-check: ${verdict}. Scanned ${scanned.join(', ')}; ${count} private denylist ${count === 1 ? 'entry' : 'entries'} loaded.`);
  return findings.length === 0 ? 0 : 1;
}

try {
  process.exitCode = await run(process.argv.slice(2), process.env, process.cwd(), (line) => console.log(line));
} catch (error) {
  // Messages of CheckError are fixed text. Anything else is reported by type only: its message may quote input.
  const reason = error instanceof CheckError ? error.message : `unexpected ${error instanceof Error ? error.name : 'error'}`;
  console.error(`privacy-check: ${reason}`);
  process.exitCode = 2;
}
