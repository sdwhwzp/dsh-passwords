// 工作区授权 + 会话例外过滤回归测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_SCOPED_RE,
  AT_FILE_SEARCH_RE,
  extractAgentId,
  extractSessionId,
  isDisplayableDshSession,
  isDisplayableDshSurface,
  stripArchivedSessionIds,
  filterArchivedSessionIds,
  filterOwnedSessionIds,
  filterSessionItems,
  collectSessionCwd,
  collectSessionCwdFromWorkspaces,
} from '../src/permissions.js';

test('工作区授权：会话 RPC 路由命中，create/list 单独处理', () => {
  for (const method of ['history', 'prompt', 'respond', 'archive', 'delete', 'rename', 'fork']) {
    assert.equal(SESSION_SCOPED_RE.test(`/api/session.${method}`), true);
  }
  assert.equal(SESSION_SCOPED_RE.test('/api/session.create'), false);
  assert.equal(SESSION_SCOPED_RE.test('/api/session.list'), false);
});

test('工作区授权：dsh-at-file 搜索按 agentId 执行会话归属检查', () => {
  assert.equal(AT_FILE_SEARCH_RE.test('/api/atFile/search'), true);
  assert.equal(AT_FILE_SEARCH_RE.test('/api/atFile/getSettings'), false);
  assert.equal(extractAgentId({ payload: { agentId: 's-file' } }), 's-file');
  assert.equal(extractAgentId({ sessionId: 's-other' }), null);
});

test('extractSessionId：提取顶层与嵌套 sessionId', () => {
  assert.equal(extractSessionId({ sessionId: 's-1' }), 's-1');
  assert.equal(extractSessionId({ args: { request: { sessionId: 's-2' } } }), 's-2');
  assert.equal(extractSessionId({ id: 'x' }), null);
});

test('设置页会话投影：dsh 空白槽位不展示，但无标题的真实会话保留', () => {
  const blank = { deriveMessages: () => [] };
  const realWithoutTitle = { deriveMessages: () => [{ role: 'user', content: 'hello' }] };
  const legacySession = {};
  assert.equal(isDisplayableDshSession(blank), false);
  assert.equal(isDisplayableDshSession(realWithoutTitle), true);
  assert.equal(isDisplayableDshSession(legacySession), true);
  assert.equal(isDisplayableDshSession(undefined), true);
  assert.equal(isDisplayableDshSurface([]), false);
  assert.equal(isDisplayableDshSurface([{ type: 'user/message' }]), true);
  assert.equal(isDisplayableDshSurface(undefined), true);
});

test('归档枚举源清理：archivedSessionIds 被清空', () => {
  const value = { workspaces: [{ archivedSessionIds: ['s-archived'] }] };
  assert.equal(stripArchivedSessionIds(value), true);
  assert.deepEqual(value.workspaces[0].archivedSessionIds, []);
});

test('可见归档会话保留工作区槽位，不会掉入未分组', () => {
  const value = {
    result: {
      value: {
        items: [{ path: '/a', sessionIds: ['s-active', 's-archived', 's-disabled', 's-foreign'] }],
        archivedSessionIds: ['s-archived', 's-disabled', 's-foreign'],
      },
    },
  };
  const owned = new Set(['s-active', 's-archived', 's-disabled']);
  const disabled = new Set(['s-disabled']);
  const archived = new Set(value.result.value.archivedSessionIds);
  const visible = new Set(collectSessionCwdFromWorkspaces(value).keys());
  filterArchivedSessionIds(
    value,
    (id) => archived.has(id) && visible.has(id) && owned.has(id) && !disabled.has(id),
  );
  filterOwnedSessionIds(value, (id) => owned.has(id) && !disabled.has(id));
  assert.deepEqual(value.result.value.items[0].sessionIds, ['s-active', 's-archived']);
  assert.deepEqual(value.result.value.archivedSessionIds, ['s-archived']);
});

test('工作区过滤：只显示活动工作区成员，禁用覆盖逐条关闭', () => {
  const disabled = new Set(['s-off']);
  const active = new Set(['s-on', 's-off']);
  const value = {
    result: {
      value: [
        { sessionId: 's-on', cwd: '/workspace/a' },
        { sessionId: 's-off', cwd: '/workspace/a' },
        { sessionId: 's-other', cwd: '/workspace/b' },
      ],
    },
  };
  const out = filterSessionItems(
    value,
    (id) => active.has(id) && !disabled.has(id),
    (cwd) => cwd === '/workspace/a',
  ) as typeof value;
  assert.deepEqual(out.result.value.map((item) => item.sessionId), ['s-on']);
});

test('会话过滤按调用方提供的归属判定，不因 cwd 相同自动保留', () => {
  const value = {
    result: {
      value: [
        { sessionId: 's-active', cwd: '/workspace/a' },
        { sessionId: 's-unowned', cwd: '/workspace/a' },
      ],
    },
  };
  const active = new Set(['s-active']);
  const out = filterSessionItems(
    value,
    (id) => active.has(id),
    (cwd) => cwd === '/workspace/a',
  ) as typeof value;
  assert.deepEqual(out.result.value.map((item) => item.sessionId), ['s-active']);
});

test('工作区不过滤时 disabledSessions 仍能关闭单独会话', () => {
  const value = { result: { value: [{ sessionId: 's-on', cwd: '/any' }, { sessionId: 's-off', cwd: '/any' }] } };
  const out = filterSessionItems(value, (id) => id !== 's-off', null) as typeof value;
  assert.deepEqual(out.result.value.map((item) => item.sessionId), ['s-on']);
});

test('工作区 cwd 缺失：受限用户 fail-closed 丢弃', () => {
  const value = { result: { value: [{ sessionId: 's-no-cwd' }, { sessionId: 's-ok', cwd: '/workspace/a' }] } };
  const out = filterSessionItems(value, () => true, (cwd) => cwd === '/workspace/a') as typeof value;
  assert.deepEqual(out.result.value.map((item) => item.sessionId), ['s-ok']);
});

test('已授权会话内的深层投影保持完整', () => {
  const value = {
    result: {
      value: {
        items: [{
          sessionId: 's-ok',
          cwd: '/workspace/a',
          projections: {
            values: {
              permissions: {
                currentValue: 'workspace-write',
                options: [{ value: 'workspace-write', name: 'workspace-write' }],
              },
              imageLimits: { mediaTypes: ['image/png'] },
            },
          },
        }],
      },
    },
  };
  const out = filterSessionItems(value, () => true, (cwd) => cwd === '/workspace/a') as typeof value;
  assert.deepEqual(out, value);
});

test('collectSessionCwd：只收集有效 cwd', () => {
  const value = { result: { value: [{ sessionId: 's-a', cwd: '/a' }, { sessionId: 's-b' }] } };
  const map = collectSessionCwd(value);
  assert.equal(map.get('s-a'), '/a');
  assert.equal(map.has('s-b'), false);
});

test('collectSessionCwdFromWorkspaces：活动 sessionIds 映射到工作区路径，归档不进入映射', () => {
  const value = {
    result: { value: { items: [{ path: '/a', sessionIds: ['s-a'] }, { path: '/b', sessionIds: ['s-b'] }], archivedSessionIds: ['s-old'] } },
  };
  const map = collectSessionCwdFromWorkspaces(value);
  assert.equal(map.get('s-a'), '/a');
  assert.equal(map.get('s-b'), '/b');
  assert.equal(map.has('s-old'), false);
});

test('深度超限：不可验证会话子树不原样透传', () => {
  let value: Record<string, unknown> = { sessionId: 'secret', cwd: '/secret' };
  for (let i = 0; i < 10; i++) value = { nested: value };
  const out = filterSessionItems(value, () => true) as Record<string, unknown>;
  let cursor: unknown = out;
  for (let i = 0; i < 10; i++) cursor = (cursor as Record<string, unknown>)?.nested;
  assert.ok(cursor === null || cursor === undefined);
});
