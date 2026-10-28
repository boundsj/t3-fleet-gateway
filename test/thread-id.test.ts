import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isThreadId, isThreadLink, MAX_THREAD_ID_CHARS, threadLink } from '../src/threadId.js';
import { responseThreadIdSchema, threadIdSchema } from '../src/t3/threadId.ts';
import { threadLinkTarget } from '../src/jobs/derive.ts';
import { launchResultSchema, threadListSchema, threadReadSchema } from '../src/t3/schemas.ts';
import { loadApp } from './helpers/dashboardApp.ts';

const uuid = '11111111-2222-4333-8444-555555555555';

test('v2 links preserve the owning environment and opaque ids through both wrappers and the dashboard', async () => {
  const app = await loadApp();
  for (const id of ['thread-1', `mcp:${uuid}`, 'thread:synthetic%2Ffolder', "synthetic!~*'()", 'a'.repeat(MAX_THREAD_ID_CHARS)]) {
    const link = `t3-thread://v2/env-synthetic/${id}`;
    assert.equal(isThreadLink(link), true);
    assert.equal(app.safeHref(link), true);
    for (const supplied of [link, `<${link}>`, `[Synthetic title](${link.replaceAll('(', '%28').replaceAll(')', '%29')})`]) {
      assert.equal(threadLinkTarget(supplied), supplied.startsWith('[') ? link.replaceAll('(', '%28').replaceAll(')', '%29') : link);
    }
  }
});

test('thread result boundaries replace unusable links with the canonical v1 fallback', async () => {
  const app = await loadApp();
  const malformed = [
    't3-thread://v2/thread-1', 't3-thread://v2//thread-1', 't3-thread://v2/env-synthetic/',
    ...['.', '..', '%2e', '.%2E', '%2e%2e', 'bad/id', 'bad\\id', 'bad id', 'bad\nvalue', 'bad\n', 'bad\r', 'bad?x', 'bad#x',
      'bad%xx', 'bad%0', 'é', 'a'.repeat(MAX_THREAD_ID_CHARS + 1)]
      .flatMap((id) => [`t3-thread://v2/${id}/thread-1`, `t3-thread://v2/env-synthetic/${id}`]),
    't3-thread://v1/a/b', 't3-thread://v3/env-synthetic/thread-1', 'javascript:alert(1)', 'not a URL',
  ];
  const summary = { threadId: 'thread-1', title: 'Synthetic thread', status: 'idle', latestRunId: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const check = (link: string | null | undefined, expected: string) => {
    assert.equal(launchResultSchema.parse({ threadId: 'thread-1', projectId: 'p', runId: null, status: 'idle', link }).link, expected);
    assert.equal(threadListSchema.parse({ projectId: 'p', threads: [{ ...summary, link }], nextCursor: null, total: 1 }).threads[0]!.link, expected);
    assert.equal(threadReadSchema.parse({ thread: { ...summary, projectId: 'p', activeRunId: null, pendingRequestCount: 0, branch: null, link },
      recentRuns: [], items: [], nextPosition: null, hasMore: false }).thread.link, expected);
  };
  for (const link of malformed) {
    assert.equal(isThreadLink(link), false);
    assert.equal(app.safeHref(link), false);
    for (const supplied of [link, `<${link}>`, `[Synthetic title](${link})`]) {
      assert.equal(threadLinkTarget(supplied), null);
      check(supplied, 't3-thread://v1/thread-1');
    }
  }
  for (const link of [undefined, null, '']) check(link, 't3-thread://v1/thread-1');
  check('[Synthetic title](t3-thread://v1/thread-1)', 't3-thread://v1/thread-1');
  check('<t3-thread://v2/env-synthetic/thread-1>', 't3-thread://v2/env-synthetic/thread-1');
});

test('shared thread identity and URI boundaries preserve opaque T3 ids without decoding their components', async () => {
  const app = await loadApp();
  const ids = [uuid, `mcp:${uuid}`, `thread:project:synthetic:${uuid}`, `thread:${uuid}`,
    `import:codex:${uuid}`, `thread:mcp:synthetic%3Anamespace:request:0`,
    `thread:delegated-task:command%3Amcp%3A${uuid}%3Adelegate-task%3Asynthetic`,
    `thread:provider:codex:provider-instance:synthetic:native-thread:${uuid}`,
    // encodeURIComponent leaves !~*'() untouched; these can occur in derived native ids.
    "thread:provider:synthetic:native-thread:synthetic!~*'()%2Ffolder%253Avalue",
    'a'.repeat(MAX_THREAD_ID_CHARS)];
  for (const id of ids) {
    assert.equal(isThreadId(id), true);
    assert.equal(threadIdSchema.parse(id), id);
    const link = threadLink(id)!;
    assert.equal(decodeURIComponent(new URL(link).pathname.slice(1)), id);
    assert.equal(isThreadLink(link), true);
    assert.equal(app.safeHref(link), true);
    assert.equal(threadLinkTarget(link), link);
    assert.doesNotMatch(link, /[!'()*\s<>"\\]/);
  }
  for (const id of ['', '.', '..', 'bad/id', 'bad\\id', 'bad id', 'bad\nvalue', 'bad\n', 'bad\r', 'bad?x', 'bad#x', 'bad%xx', 'bad%',
    'bad%0', 'bad"value', '<bad>', 'é', 'a'.repeat(MAX_THREAD_ID_CHARS + 1), null]) {
    assert.equal(isThreadId(id), false);
    assert.equal(threadIdSchema.safeParse(id).success, false);
    assert.equal(threadLink(id), null);
  }
  for (const link of ['t3-thread://v1/..', 't3-thread://v1/bad%xx', 't3-thread://v1/a/b', 't3-thread://v1/a?x',
    't3-thread://v1/%2F', 't3-thread://v1/%0A', 't3-thread://v1/%252', 't3-thread://v2/x']) {
    assert.equal(isThreadLink(link), false);
    assert.equal(app.safeHref(link), false);
  }
});


test('response ids allow unfamiliar formats within a nonblank control-free bound', () => {
  for (const id of ['synthetic/future-thread', 'synthetic future thread', 'synthetic%future', 'synthetic-λ']) {
    assert.equal(responseThreadIdSchema.parse(id), id);
    assert.equal(threadIdSchema.safeParse(id).success, false);
    assert.equal(threadLink(id), null);
  }
  for (const id of ['', ' ', '\t', 'bad\nvalue', 'bad\u0000value', 'bad\u0085value', 'a'.repeat(MAX_THREAD_ID_CHARS + 1)]) {
    assert.equal(responseThreadIdSchema.safeParse(id).success, false);
  }
});

test('MCP link delimiters stay byte-identical and existing percent escapes remain opaque', () => {
  assert.equal(threadLink(`mcp:${uuid}`), `t3-thread://v1/mcp:${uuid}`);
  assert.equal(threadLink('thread:provider:synthetic:native-thread:synthetic%2Ffolder'),
    't3-thread://v1/thread:provider:synthetic:native-thread:synthetic%252Ffolder');
  assert.equal(threadLinkTarget(null), null);
  assert.equal(threadLinkTarget(undefined), null);
});
