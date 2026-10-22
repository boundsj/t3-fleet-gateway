import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isThreadId, isThreadLink, MAX_THREAD_ID_CHARS, threadLink } from '../src/threadId.js';
import { responseThreadIdSchema, threadIdSchema } from '../src/t3/threadId.ts';
import { threadLinkTarget } from '../src/jobs/derive.ts';
import { loadApp } from './helpers/dashboardApp.ts';

const uuid = '11111111-2222-4333-8444-555555555555';

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
  for (const id of ['', '.', '..', 'bad/id', 'bad\\id', 'bad id', 'bad\nvalue', 'bad?x', 'bad#x', 'bad%xx', 'bad%',
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
