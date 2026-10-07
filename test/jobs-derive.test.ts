import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isWorkerMessage, observe } from '../src/jobs/derive.ts';
import type { Job } from '../src/jobs/store.ts';
import type { ThreadItem, ThreadRead } from '../src/t3/schemas.ts';

const T0 = '2026-01-15T12:00:00.000Z';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job1',
    clientId: 'c',
    requestId: 'r',
    projectAlias: 'pilot',
    hostId: 'main',
    t3ProjectId: 'p',
    state: 'running',
    task: 'synthetic',
    title: 't [job:job1]',
    branch: 'fleet/job1',
    runtimeMode: 'auto',
    threadId: 'thread-1',
    threadTitle: 't [job:job1]',
    lastRunId: 'run-1',
    pendingRequestIds: [],
    latestMessageExcerpt: null,
    latestActivityAt: null,
    readPosition: null,
    hostUnreachableSince: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: 0,
    updatedAt: 0,
    dispatchStartedAt: 0,
    finishedAt: null,
    ...overrides,
  };
}

function item(position: number, overrides: Partial<ThreadItem> = {}): ThreadItem {
  return {
    position,
    itemId: `item-${position}`,
    runId: 'run-1',
    createdBy: 'agent',
    creationSource: 'provider',
    type: 'assistant_message',
    status: 'completed',
    text: `message ${position}`,
    textTruncated: false,
    updatedAt: T0,
    ...overrides,
  };
}

function read(
  thread: { status: string; activeRunId?: string | null; latestRunId?: string | null; pendingRequestCount?: number },
  runs: { runId: string; status: string }[] = [],
  items: ThreadItem[] = [],
  nextPosition: number | null = items.at(-1)?.position ?? null,
): ThreadRead {
  return {
    thread: {
      threadId: 'thread-1',
      link: 'synthetic',
      projectId: 'p',
      title: 't [job:job1]',
      status: thread.status,
      latestRunId: thread.latestRunId ?? runs[0]?.runId ?? null,
      activeRunId: thread.activeRunId ?? null,
      pendingRequestCount: thread.pendingRequestCount ?? 0,
      branch: 'fleet/job1',
      updatedAt: T0,
    },
    recentRuns: runs.map((run, index) => ({ ...run, ordinal: runs.length - index, completedAt: null })),
    items,
    nextPosition,
    hasMore: false,
  };
}

describe('state derivation', () => {
  test('an active run is running', () => {
    const seen = observe(job(), read({ status: 'running', activeRunId: 'run-1' }, [{ runId: 'run-1', status: 'running' }]), []);
    assert.equal(seen.state, 'running');
    assert.equal(seen.lastRunId, 'run-1');
  });

  test('a waiting thread needs input: a question if T3 lists one, else an approval', () => {
    const waiting = read({ status: 'waiting', activeRunId: 'run-1', pendingRequestCount: 1 }, [{ runId: 'run-1', status: 'waiting' }]);
    assert.deepEqual([observe(job(), waiting, ['req-1']).state, observe(job(), waiting, ['req-1']).reason], ['needs_input', 'question']);
    assert.deepEqual([observe(job(), waiting, []).state, observe(job(), waiting, []).reason], ['needs_input', 'approval']);
    assert.deepEqual(observe(job(), waiting, ['req-1']).pendingRequestIds, ['req-1']);
  });

  test('a finished turn is idle and follows the latest run', () => {
    for (const status of ['completed', 'interrupted', 'cancelled', 'rolled_back', 'idle']) {
      const seen = observe(job(), read({ status }, [{ runId: 'run-2', status: status === 'idle' ? 'completed' : status }]), []);
      assert.equal(seen.state, 'idle', status);
      assert.equal(seen.lastRunId, 'run-2');
    }
  });

  test('a failed run fails the job', () => {
    const seen = observe(job(), read({ status: 'failed' }, [{ runId: 'run-1', status: 'failed' }]), []);
    assert.deepEqual([seen.state, seen.errorCode], ['failed', 't3_run_failed']);
  });

  test('the run the gateway started keeps the job running even if the thread status lags', () => {
    const seen = observe(job({ lastRunId: 'run-2' }), read({ status: 'completed' }, [{ runId: 'run-2', status: 'queued' }, { runId: 'run-1', status: 'completed' }]), []);
    assert.equal(seen.state, 'running');
  });

  test('an unrecognised status counts as active', () => {
    assert.equal(observe(job(), read({ status: 'some_new_status' }), []).state, 'running');
  });

  test('cancel_requested becomes cancelled only when nothing is active', () => {
    const active = read({ status: 'running', activeRunId: 'run-1' }, [{ runId: 'run-1', status: 'running' }]);
    const stopped = read({ status: 'interrupted' }, [{ runId: 'run-1', status: 'interrupted' }]);
    assert.equal(observe(job({ state: 'cancel_requested' }), active, []).state, 'cancel_requested');
    assert.equal(observe(job({ state: 'cancel_requested' }), stopped, []).state, 'cancelled');
  });

  test('an idle job notices another finished turn', () => {
    const seen = observe(job({ state: 'idle', lastRunId: 'run-1' }), read({ status: 'completed' }, [{ runId: 'run-2', status: 'completed' }]), []);
    assert.equal(seen.anotherTurnFinished, true);
    const same = observe(job({ state: 'idle', lastRunId: 'run-2' }), read({ status: 'completed' }, [{ runId: 'run-2', status: 'completed' }]), []);
    assert.equal(same.anotherTurnFinished, false);
  });
});

describe('timeline reading', () => {
  test('the excerpt is the newest settled worker message, bounded', () => {
    const items = [
      item(0, { type: 'user_message', createdBy: 'agent', creationSource: 'mcp', text: 'the task' }),
      item(1, { text: 'x'.repeat(3000) }),
      item(2, { type: 'user_message', createdBy: 'user', creationSource: 'web', text: 'a person typed this' }),
    ];
    const seen = observe(job(), read({ status: 'completed' }, [], items), []);
    assert.equal(seen.excerpt, 'x'.repeat(2000));
    assert.equal(seen.readPosition, 2);
  });

  test('stops before an item that may still change', () => {
    const items = [item(4), item(5, { status: 'running', text: 'partial' }), item(6)];
    const seen = observe(job({ readPosition: 3 }), read({ status: 'running', activeRunId: 'run-1' }, [], items), []);
    assert.equal(seen.excerpt, 'message 4');
    assert.equal(seen.readPosition, 4);
    assert.equal(observe(job(), read({ status: 'running' }, [], [item(0, { status: 'running' })]), []).readPosition, null);
  });

  test('keeps the position and excerpt when nothing is new', () => {
    const seen = observe(job({ readPosition: 7 }), read({ status: 'running' }, [], [], null), []);
    assert.equal(seen.readPosition, 7);
    assert.equal(seen.excerpt, undefined);
  });

  test('recognises worker messages by type and creation source', () => {
    assert.equal(isWorkerMessage(item(0)), true);
    assert.equal(isWorkerMessage(item(0, { type: 'proposed_plan', creationSource: null })), true);
    assert.equal(isWorkerMessage(item(0, { type: 'message', creationSource: 'provider' })), true);
    assert.equal(isWorkerMessage(item(0, { type: 'user_message', creationSource: 'mcp' })), false);
    assert.equal(isWorkerMessage(item(0, { type: 'message', createdBy: 'user', creationSource: 'web' })), false);
  });
});
