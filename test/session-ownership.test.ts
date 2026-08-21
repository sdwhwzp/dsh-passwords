// 工作区授权 + 会话例外过滤回归测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_SCOPED_RE,
  extractSessionId,
  isDisplayableDshSession,
  isDisplayableDshSurface,
  stripArchivedSessionIds,
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

test('工作区过滤：启用目录内默认显示全部活动会话，禁用覆盖逐条关闭', () => {
  const disabled = new Set(['s-off']);
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
    (id) => !disabled.has(id),
    (cwd) => cwd === '/workspace/a',
  ) as typeof value;
  assert.deepEqual(out.result.value.map((item) => item.sessionId), ['s-on']);
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
  for (let i = 0; i < 20; i++) value = { nested: value };
  const out = filterSessionItems(value, () => true) as Record<string, unknown>;
  let cursor: unknown = out;
  for (let i = 0; i < 20; i++) cursor = (cursor as Record<string, unknown>)?.nested;
  assert.ok(cursor === null || cursor === undefined);
});

test('深度上限内：permissions.options 深层投影不被截断', () => {
  // 回归：真实 session.list 的 permissions.options 选项对象位于深度 9
  // （result→value→items→[i]→projections→values→permissions→options→[o]），
  // 旧上限 8 会把它置 null，前端 PermissionSelect 遍历 null 崩溃。
  const value = {
    result: {
      value: {
        items: [
          {
            sessionId: 's-1',
            cwd: '/allowed',
            projections: {
              values: {
                permissions: {
                  options: [
                    { value: 'read-only', name: 'read-only' },
                    { value: 'workspace-write', name: 'workspace-write' },
                    { value: 'danger-full-access', name: 'danger-full-access' },
                  ],
                  currentValue: 'workspace-write',
                },
              },
            },
          },
        ],
      },
    },
  };
  const out = filterSessionItems(value, () => true, (cwd) => cwd === '/allowed') as typeof value;
  const options = out.result.value.items[0].projections.values.permissions.options;
  assert.deepEqual(
    options,
    [
      { value: 'read-only', name: 'read-only' },
      { value: 'workspace-write', name: 'workspace-write' },
      { value: 'danger-full-access', name: 'danger-full-access' },
    ],
  );
});
