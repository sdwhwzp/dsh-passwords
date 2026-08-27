import assert from 'node:assert/strict';
import test from 'node:test';
import { filterTenantEventEnvelope, type TenantEventAccess } from '../src/tenant-events.js';

const access: TenantEventAccess = {
  workspacePathAllowed: (path) => path.startsWith('/tenants/u2'),
  workspaceIdAllowed: (workspaceId) => workspaceId === 'ws-user',
  sessionOwned: (sessionId) => sessionId.startsWith('user-'),
  sessionVisible: (sessionId) => sessionId === 'user-live',
  newSessionVisible: (sessionId, cwd) => sessionId.startsWith('user-') && cwd.startsWith('/tenants/u2'),
};

function envelope(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'server-request',
    rpcId: `rpc-${String(payload.type)}`,
    method: payload.type,
    payload,
  };
}

test('tenant Host frames keep only owned workspaces and sessions', () => {
  const ownWorkspace = filterTenantEventEnvelope(envelope({
    type: 'host/workspace-changed',
    workspace: {
      workspaceId: 'ws-user',
      path: '/tenants/u2/project',
      title: 'User project',
      sessionIds: ['user-live', 'user-archived', 'admin-live'],
    },
  }), access);
  assert.deepEqual(
    (ownWorkspace?.payload as { workspace: { sessionIds: string[] } }).workspace.sessionIds,
    ['user-live'],
  );

  assert.equal(filterTenantEventEnvelope(envelope({
    type: 'host/workspace-changed',
    workspace: {
      workspaceId: 'ws-admin',
      path: '/admin/private',
      sessionIds: ['admin-live'],
    },
  }), access), undefined);
  assert.equal(filterTenantEventEnvelope(envelope({
    type: 'host/session-added',
    sessionId: 'admin-new',
    blank: true,
    cwd: '/admin/private',
  }), access), undefined);
  assert.notEqual(filterTenantEventEnvelope(envelope({
    type: 'host/session-added',
    sessionId: 'user-new',
    blank: true,
    cwd: '/tenants/u2/project',
  }), access), undefined);
});

test('tenant archive and order snapshots contain no other account identifiers', () => {
  const archives = filterTenantEventEnvelope(envelope({
    type: 'host/archived-sessions-changed',
    archivedSessionIds: ['admin-old', 'user-archived'],
  }), access);
  assert.deepEqual(
    (archives?.payload as { archivedSessionIds: string[] }).archivedSessionIds,
    ['user-archived'],
  );

  const order = filterTenantEventEnvelope(envelope({
    type: 'host/workspace-order-changed',
    workspaceIds: ['ws-admin', 'ws-user'],
  }), access);
  assert.deepEqual((order?.payload as { workspaceIds: string[] }).workspaceIds, ['ws-user']);
});

test('tenant mux drops foreign sessions and unknown global events', () => {
  assert.notEqual(filterTenantEventEnvelope(envelope({
    type: 'session/event',
    sessionId: 'user-live',
    event: { type: 'assistant/message', data: { content: 'owned' } },
  }), access), undefined);
  assert.equal(filterTenantEventEnvelope(envelope({
    type: 'session/event',
    sessionId: 'admin-live',
    event: { type: 'assistant/message', data: { content: 'secret' } },
  }), access), undefined);
  assert.equal(filterTenantEventEnvelope(envelope({
    type: 'host/remote-event',
    event: 'plugin/global-secret',
    args: ['secret'],
  }), access), undefined);
  assert.equal(filterTenantEventEnvelope({ payload: { type: 'session/event' } }, access), undefined);
});
