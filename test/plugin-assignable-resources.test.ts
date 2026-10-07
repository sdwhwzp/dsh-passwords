import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAssignableInventoryLoader,
  isPermanentGatewayExitCode,
  listAssignableWorkspaces,
  runInventoryWarmup,
} from '../src/plugin.js';

test('gateway permanent exit codes do not accept signal strings', () => {
  assert.equal(isPermanentGatewayExitCode(1), true);
  assert.equal(isPermanentGatewayExitCode(37), true);
  assert.equal(isPermanentGatewayExitCode(0), false);
  assert.equal(isPermanentGatewayExitCode('1'), false);
});

type Workspace = {
  path: string;
  title: string;
  sessionIds: readonly string[];
  status(): Promise<'ok' | 'missing-dir'>;
};

function registry(workspace: Workspace, archivedSessionIds: readonly string[] = []) {
  return {
    list: () => [workspace],
    archivedSessionIds,
  };
}

function workspace(sessionIds: readonly string[]): Workspace {
  return {
    path: '/workspaces/project',
    title: 'Project',
    sessionIds,
    status: async () => 'ok',
  };
}

test('Issue #25: live blank sessions remain assignable when registered by DSH', async () => {
  const result = await listAssignableWorkspaces(
    registry(workspace(['blank-live'])),
    { get: (id: string) => id === 'blank-live' ? { deriveMessages: () => [] } : undefined },
    { get: () => ({ title: 'New session' }) },
    undefined,
  );

  assert.deepEqual(result[0]?.sessions, [{ id: 'blank-live', title: 'New session' }]);
});

test('Issue #25: titled persisted blank sessions remain assignable', async () => {
  const result = await listAssignableWorkspaces(
    registry(workspace(['blank-persisted'])),
    { get: () => undefined },
    undefined,
    {
      readSurface: async () => ({ events: [] }),
      readTitle: async () => ({ title: 'Persisted new session' }),
    },
  );

  assert.deepEqual(result[0]?.sessions, [{ id: 'blank-persisted', title: 'Persisted new session' }]);
});

test('untitled persisted initialization slots are hidden from the assignment inventory', async () => {
  const result = await listAssignableWorkspaces(
    registry(workspace(['session-empty', 'session-message'])),
    { get: () => undefined },
    undefined,
    {
      readSurface: async (id: string) => ({ events: id === 'session-empty' ? [] : [{ type: 'user/message' }] }),
      readTitle: async () => undefined,
      listEvents: async (id: string) => id === 'session-empty'
        ? [{ type: 'session' }, { type: 'permission/preset' }, { type: 'sandbox/mode' }, { type: 'approval/policy' }, { type: 'subagent/model-selection-policy' }]
        : [{ type: 'user/message' }],
    },
  );

  assert.deepEqual(result[0]?.sessions, [{ id: 'session-message', title: 'session-message' }]);
});

test('untitled sessions with unknown raw events or empty raw logs are retained', async () => {
  const result = await listAssignableWorkspaces(
    registry(workspace(['unknown', 'no-events'])),
    { get: () => undefined },
    undefined,
    {
      readSurface: async () => ({ events: [] }),
      readTitle: async () => undefined,
      listEvents: async (id: string) => id === 'unknown' ? [{ type: 'turn/start' }] : [],
    },
  );

  assert.deepEqual(result[0]?.sessions, [
    { id: 'unknown', title: 'unknown' },
    { id: 'no-events', title: 'no-events' },
  ]);
});

test('Issue #25: archived sessions are never assignable, including blank sessions', async () => {
  const result = await listAssignableWorkspaces(
    registry(workspace(['blank-archived']), ['blank-archived']),
    { get: () => ({}) },
    { get: () => ({ title: 'Archived' }) },
    undefined,
  );

  assert.deepEqual(result[0]?.sessions, []);
});

test('Issue #25: a definitely missing persisted session is omitted', async () => {
  const missing = Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
  const result = await listAssignableWorkspaces(
    registry(workspace(['missing'])),
    { get: () => undefined },
    undefined,
    { readSurface: async () => { throw missing; } },
  );

  assert.deepEqual(result[0]?.sessions, []);
});

test('Issue #25: non-missing session storage failures are propagated', async () => {
  const failure = new Error('database unavailable');
  await assert.rejects(
    listAssignableWorkspaces(
      registry(workspace(['unavailable'])),
      { get: () => undefined },
      undefined,
      { readSurface: async () => { throw failure; } },
    ),
    failure,
  );
});

test('Issue #39: batched titles preserve order and skip surface reads for titled sessions', async () => {
  let observedIds: readonly string[] = [];
  const surfaceCalls: string[] = [];
  const result = await listAssignableWorkspaces(
    registry(workspace(['titled', 'untitled'])),
    { get: () => undefined },
    undefined,
    {
      readTitleSnapshots: async (ids) => {
        observedIds = ids;
        return ids.map((sessionId) => ({
          sessionId,
          status: 'fulfilled',
          value: { title: { title: sessionId === 'titled' ? 'Title' : '' } },
        }));
      },
      readTitle: async () => { throw new Error('batch result should be used'); },
      readSurface: async (id) => { surfaceCalls.push(id); return { events: [{ type: 'user/message' }] }; },
      listEvents: async () => [{ type: 'user/message' }],
    },
  );

  assert.deepEqual(observedIds, ['titled', 'untitled']);
  assert.deepEqual(surfaceCalls, ['untitled']);
  assert.deepEqual(result[0]?.sessions, [
    { id: 'titled', title: 'Title' },
    { id: 'untitled', title: 'untitled' },
  ]);
});

test('Issue #39: batch misses fall back per id and definite missing sessions remain omitted', async () => {
  const missing = Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
  const readTitleCalls: string[] = [];
  const surfaceCalls: string[] = [];
  const result = await listAssignableWorkspaces(
    registry(workspace(['batch-hit', 'batch-miss', 'deleted'])),
    { get: () => undefined },
    undefined,
    {
      readTitleSnapshots: async () => [{
        sessionId: 'batch-hit', status: 'fulfilled', value: { title: { title: 'Batch title' } },
      }],
      readTitle: async (id) => {
        readTitleCalls.push(id);
        if (id === 'deleted') throw missing;
        return { title: 'Fallback title' };
      },
      readSurface: async (id) => { surfaceCalls.push(id); return { events: [{ type: 'user/message' }] }; },
      listEvents: async () => [{ type: 'user/message' }],
    },
  );

  assert.deepEqual(readTitleCalls, ['batch-miss', 'deleted']);
  assert.deepEqual(surfaceCalls, [], 'a fallback title avoids the surface read');
  assert.deepEqual(result[0]?.sessions, [
    { id: 'batch-hit', title: 'Batch title' },
    { id: 'batch-miss', title: 'Fallback title' },
  ]);
});

test('Issue #39: missing sessions in legacy title fallback are omitted; other title errors propagate', async () => {
  const missing = Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
  const result = await listAssignableWorkspaces(
    registry(workspace(['missing', 'present'])),
    { get: () => undefined },
    undefined,
    {
      readTitle: async (id) => { if (id === 'missing') throw missing; return { title: 'Present' }; },
      readSurface: async (id) => {
        if (id === 'missing') throw missing;
        return { events: [{ type: 'user/message', id }] };
      },
    },
  );
  assert.deepEqual(result[0]?.sessions, [{ id: 'present', title: 'Present' }]);

  const failure = new Error('storage unavailable');
  await assert.rejects(
    listAssignableWorkspaces(
      registry(workspace(['broken'])), { get: () => undefined }, undefined,
      { readTitle: async () => { throw failure; }, readSurface: async () => ({ events: [] }) },
    ),
    failure,
  );
});

test('Issue #39: rejected batch results propagate non-missing errors', async () => {
  const failure = new Error('snapshot storage unavailable');
  await assert.rejects(
    listAssignableWorkspaces(
      registry(workspace(['broken'])), { get: () => undefined }, undefined,
      {
        readTitleSnapshots: async () => [{ sessionId: 'broken', status: 'rejected', reason: failure }],
        readSurface: async () => ({ events: [] }),
      },
    ),
    failure,
  );
});

test('Issue #39: inventory TTL is opt-in, scoped per loader, and coalesces concurrent misses', async () => {
  let now = 10_000;
  const originalNow = Date.now;
  Date.now = () => now;
  let reads = 0;
  let noCacheReads = 0;
  const reg = registry(workspace(['cached']));
  let resolveTitle: ((value: { title: string }) => void) | undefined;
  let markTitleStarted: (() => void) | undefined;
  const titleStarted = new Promise<void>((resolve) => { markTitleStarted = resolve; });
  const query = {
    readTitle: async () => {
      reads += 1;
      markTitleStarted?.();
      return await new Promise<{ title: string }>((resolve) => { resolveTitle = resolve; });
    },
    readSurface: async () => ({ events: [{ type: 'user/message' }] }),
  };
  try {
    const noCache = createAssignableInventoryLoader(0);
    const plainQuery = {
      readTitle: async () => { noCacheReads += 1; return { title: 'cached' }; },
      readSurface: query.readSurface,
    };
    await noCache(reg, { get: () => undefined }, undefined, plainQuery);
    await noCache(reg, { get: () => undefined }, undefined, plainQuery);
    assert.equal(noCacheReads, 2, 'TTL 0 recomputes for every request');
    assert.equal(reads, 0);

    const loader = createAssignableInventoryLoader(100);
    const first = loader(reg, { get: () => undefined }, undefined, query);
    const second = loader(reg, { get: () => undefined }, undefined, query);
    await titleStarted;
    assert.equal(reads, 1, 'concurrent cold requests share one enumeration');
    resolveTitle?.({ title: 'cached title' });
    await Promise.all([first, second]);
    await loader(reg, { get: () => undefined }, undefined, query);
    assert.equal(reads, 1, 'warm requests use the instance cache');

    const otherInstance = createAssignableInventoryLoader(100);
    let otherReads = 0;
    await otherInstance(reg, { get: () => undefined }, undefined, {
      readTitle: async () => { otherReads += 1; return { title: 'other' }; },
      readSurface: query.readSurface,
    });
    assert.equal(otherReads, 1, 'separate plugin instances do not share cached data');

    now += 101;
    // readTitle fires when an enumeration *starts*, so a background refresh can increment
    // `reads` before it has published its result. Poll the published snapshot instead —
    // that is the observable we actually care about. The loop terminates as soon as the
    // revalidated snapshot is served, because after it lands the frozen mock clock sees a
    // cache that is fresh again (so no further pass is ever started).
    const revalidateQuery = {
      readTitle: async () => { reads += 1; return { title: 'expired' }; },
      readSurface: query.readSurface,
    };
    const stale = await loader(reg, { get: () => undefined }, undefined, revalidateQuery);
    const titleOf = (workspaces: readonly { sessions: readonly { title: string }[] }[]): string | undefined =>
      workspaces.flatMap((workspace) => workspace.sessions)[0]?.title;
    const staleTitle = titleOf(stale);
    assert.equal(staleTitle, 'cached title', 'expired entries are served stale instead of blocking on a recompute');

    let revalidatedTitle = staleTitle;
    for (let attempt = 0; attempt < 200 && revalidatedTitle !== 'expired'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      revalidatedTitle = titleOf(await loader(reg, { get: () => undefined }, undefined, revalidateQuery));
    }
    assert.equal(reads, 2, 'expired entries are revalidated with a single background pass');
    assert.equal(revalidatedTitle, 'expired', 'the background refresh publishes its result');

    const warmAgain = await loader(reg, { get: () => undefined }, undefined, {
      readTitle: async () => { reads += 1; return { title: 'unused' }; },
      readSurface: query.readSurface,
    });
    assert.equal(reads, 2, 'callers after revalidation use the refreshed snapshot');
    assert.equal(titleOf(warmAgain), 'expired');
  } finally {
    Date.now = originalNow;
  }
});

test('Issue #39: warmup populates the cache, and a missing registry or a failed pass only logs', async () => {
  const warnings: string[] = [];
  const logs: string[] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    let loads = 0;
    const load = async (): Promise<never[]> => { loads += 1; return []; };

    const noRegistry = await runInventoryWarmup(load, () => null);
    assert.equal(noRegistry, false, 'a missing registry is not a warmup');
    assert.equal(loads, 0, 'a missing registry never reaches the loader');
    assert.match(warnings.join('\n'), /workspace registry unavailable/);

    const target = {
      reg: { list: async () => [] } as never,
      sessions: undefined,
      sessionTitle: undefined,
      sessionQuery: undefined,
    };
    const ok = await runInventoryWarmup(async () => { loads += 1; return [{ path: '/w' } as never]; }, () => target);
    assert.equal(ok, true, 'a completed pass reports success');
    assert.equal(loads, 1, 'exactly one enumeration per successful warmup');
    assert.match(logs.join('\n'), /inventory warmup ok: 1 workspaces/);

    const failed = await runInventoryWarmup(async () => { throw new Error('corpus unreadable'); }, () => target);
    assert.equal(failed, false, 'a failing pass never rejects the warmup caller');
    assert.match(warnings.join('\n'), /inventory warmup failed: Error: corpus unreadable/);
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
});
