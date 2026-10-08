import assert from 'node:assert/strict';
import test from 'node:test';
import { listAssignableWorkspaces } from '../src/assignable-workspaces.js';

function workspace(sessionIds: readonly string[], status: 'ok' | 'missing-dir' = 'ok') {
  return {
    path: '/workspaces/project',
    title: 'Project',
    sessionIds,
    status: async () => status,
  };
}

function registry(sessionIds: readonly string[], archivedSessionIds: readonly string[] = []) {
  return {
    list: () => [workspace(sessionIds)],
    archivedSessionIds,
  };
}

test('new live blank sessions are assignable with a title or their session ID', async () => {
  const titled = { deriveMessages: () => [] };
  const untitled = { deriveMessages: () => [] };
  const result = await listAssignableWorkspaces(
    registry(['untitled', 'titled']),
    { get: (id) => id === 'titled' ? titled : untitled },
    { get: (session) => session === titled ? { title: 'New session' } : undefined },
    undefined,
  );
  assert.deepEqual(result, [{
    path: '/workspaces/project',
    title: 'Project',
    sessions: [{ id: 'untitled', title: 'untitled' }, { id: 'titled', title: 'New session' }],
  }]);
});

test('persisted blank sessions remain assignable without activating them', async () => {
  const reads: string[] = [];
  const result = await listAssignableWorkspaces(
    registry(['titled', 'untitled']),
    { get: () => undefined },
    undefined,
    {
      readSurface: async (id) => { reads.push(id); return { events: [] }; },
      readTitle: async (id) => id === 'titled' ? { title: 'Saved session' } : undefined,
    },
  );
  assert.deepEqual(reads, ['untitled']);
  assert.deepEqual(result[0]?.sessions, [
    { id: 'titled', title: 'Saved session' },
    { id: 'untitled', title: 'untitled' },
  ]);
});

test('each inventory excludes archived sessions, unregistered sessions, and missing directories', async () => {
  const archivedSessionIds: string[] = ['archived'];
  const current = workspace(['active', 'archived']);
  const registrations = [current, workspace(['missing-directory-session'], 'missing-dir')];
  const lookedUp: string[] = [];
  const inventory = () => listAssignableWorkspaces(
    { list: () => registrations, archivedSessionIds },
    { get: (id) => { lookedUp.push(id); return {}; } },
    undefined,
    undefined,
  );

  assert.deepEqual((await inventory())[0]?.sessions, [{ id: 'active', title: 'active' }]);
  assert.deepEqual(lookedUp, ['active']);
  archivedSessionIds.push('active');
  assert.deepEqual((await inventory())[0]?.sessions, []);
  registrations.splice(0, 1);
  assert.deepEqual(await inventory(), []);
});

test('a deleted persisted session is omitted while other blank sessions remain', async () => {
  const result = await listAssignableWorkspaces(
    registry(['deleted', 'blank']),
    undefined,
    undefined,
    {
      readSurface: async (id) => {
        if (id === 'deleted') {
          throw Object.assign(new Error('session deleted'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
        }
        return { events: [] };
      },
    },
  );
  assert.deepEqual(result[0]?.sessions, [{ id: 'blank', title: 'blank' }]);
});

test('storage failures and missing referenced events reject the inventory', async () => {
  for (const failure of [
    new Error('database unavailable'),
    Object.assign(new Error('session event not found'), { code: 'SESSION_QUERY_EVENT_NOT_FOUND' }),
    Object.assign(new Error('session file not found'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' }),
  ]) {
    await assert.rejects(
      listAssignableWorkspaces(registry(['unavailable']), undefined, undefined, {
        readSurface: async () => { throw failure; },
      }),
      (error) => error === failure,
    );
  }
});

test('a missing title observation omits a deleted session without loading its surface', async () => {
  const failure = Object.assign(new Error('session deleted'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
  const result = await listAssignableWorkspaces(registry(['deleted']), undefined, undefined, {
    readSurface: async () => { throw new Error('deleted sessions must not load'); },
    readTitle: async () => { throw failure; },
  });
  assert.deepEqual(result[0]?.sessions, []);
});

test('missing Host services reject unverified entries instead of returning an empty inventory', async () => {
  await assert.rejects(
    listAssignableWorkspaces(undefined, undefined, undefined, undefined),
    /workspace registry unavailable/,
  );
  await assert.rejects(
    listAssignableWorkspaces(registry(['unknown']), undefined, undefined, undefined),
    /session query unavailable/,
  );
  assert.deepEqual(await listAssignableWorkspaces(registry([]), undefined, undefined, undefined), [{
    path: '/workspaces/project', title: 'Project', sessions: [],
  }]);
});
