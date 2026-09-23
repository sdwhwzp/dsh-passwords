// F-25 回归测试：会话归属（sessionId 提取 / 枚举源清理 / 会话列表过滤）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_SCOPED_RE,
  AT_FILE_SEARCH_RE,
  extractAgentId,
  SUBUSER_BLOCKED_API_ENDPOINTS,
  isSubuserBlockedApiPath,
  extractSessionId,
  stripArchivedSessionIds,
  filterArchivedSessionIds,
  filterOwnedSessionIds,
  filterSessionItems,
  collectSessionCwd,
  collectSessionCwdFromWorkspaces,
  collectSessionParents,
  collectAuthorizedSessionIds,
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

test('collectSessionParents：只收集有效的委派链，自指与空值丢弃', () => {
  // session.list 的响应是嵌套的，链接可能出现在任意深度。
  const parents = collectSessionParents({
    result: {
      value: {
        items: [
          { sessionId: 'child', parentSessionId: 'parent', cwd: '/w' },
          { sessionId: 'plain', cwd: '/w' },
          { sessionId: 'self', parentSessionId: 'self' },
          { sessionId: 'blank', parentSessionId: '' },
          { nested: { items: [{ sessionId: 'deep', parentSessionId: 'root' }] } },
        ],
      },
    },
  });
  assert.deepEqual([...parents.entries()].sort(), [['child', 'parent'], ['deep', 'root']]);
});

test('F-25：SESSION_SCOPED_RE 命中会读取/写入会话的 RPC，但不命中 create/list', () => {
  for (const m of ['history', 'prompt', 'respond', 'archive', 'delete', 'rename', 'retitle', 'title', 'resume', 'fork', 'truncate', 'export', 'attachment', 'updateQueue', 'cancel', 'page', 'selectModel']) {
    assert.equal(SESSION_SCOPED_RE.test(`/api/session.${m}`), true, `session.${m} 应归属校验`);
    assert.equal(SESSION_SCOPED_RE.test(`/api/session/${m}`), true, `session/${m} 应归属校验`);
  }
  assert.equal(SESSION_SCOPED_RE.test('/api/workspace.archiveSession'), true, 'workspace.archiveSession 应归属校验');
  assert.equal(SESSION_SCOPED_RE.test('/api/workspace/archiveSession'), true, 'workspace/archiveSession 应归属校验');
  assert.equal(SESSION_SCOPED_RE.test('/api/session.create'), false, 'create 无源会话');
  assert.equal(SESSION_SCOPED_RE.test('/api/session.list'), false, 'list 单独过滤');
  assert.equal(SESSION_SCOPED_RE.test('/api/workspace.create'), false, '创建工作区不属于会话作用域');
  for (const endpoint of [
    'commands/execute', 'commands/list', 'subagents/list', 'subagents/prompt', 'subagents/interruptByParent',
    'fileUploads/upload', 'fileReferences/list', 'sessionReferenceResolver/candidates',
    'skills/list', 'messageFeedback/list', 'messageFeedback/put', 'messageFeedback/delete',
    'goals/clear', 'goals/complete', 'goals/create', 'goals/edit', 'goals/get', 'goals/pause', 'goals/resume',
    'sessionFeedback/record',
  ]) {
    assert.equal(SESSION_SCOPED_RE.test(`/api/${endpoint}`), true, `${endpoint} 应归属校验`);
  }
});

test('0.1.7：宿主桌面动作改为硬拒，新增会话作用域 RPC 纳入归属校验（点号/斜杠同口径）', () => {
  // session-controller：projections 带 request.sessionId，仍做归属校验。
  for (const m of ['projections']) {
    assert.equal(SESSION_SCOPED_RE.test(`/api/session.${m}`), true, `session.${m} 应归属校验`);
    assert.equal(SESSION_SCOPED_RE.test(`/api/session/${m}`), true, `session/${m} 应归属校验`);
  }
  // workspace-controller：三个会话导航状态写与 archiveSession 同类。
  for (const m of ['pinSession', 'unpinSession', 'unarchiveSession']) {
    assert.equal(SESSION_SCOPED_RE.test(`/api/workspace.${m}`), true, `workspace.${m} 应归属校验`);
    assert.equal(SESSION_SCOPED_RE.test(`/api/workspace/${m}`), true, `workspace/${m} 应归属校验`);
  }
  // 0.1.7：三个宿主桌面动作的 wire 里没有会话身份（取不到身份，归属校验无意义），
  // 改为 SUBUSER_BLOCKED_API_ENDPOINTS 硬拒。
  for (const endpoint of ['session/openWorkspacePath', 'session/canOpenWorkspacePath', 'session/workspacePathApplications']) {
    assert.equal(SUBUSER_BLOCKED_API_ENDPOINTS.has(endpoint), true, `${endpoint} 应硬拒`);
    assert.equal(isSubuserBlockedApiPath(`/api/${endpoint}`), true, endpoint);
    assert.equal(SESSION_SCOPED_RE.test(`/api/${endpoint}`), false, `${endpoint} 不再走归属校验`);
  }
  // 前缀相近的方法/命名空间不得被顺带纳入
  assert.equal(SESSION_SCOPED_RE.test('/api/session/projectionsExtra'), false);
  assert.equal(SESSION_SCOPED_RE.test('/api/session/openWorkspacePathExtra'), false);
  assert.equal(SESSION_SCOPED_RE.test('/api/session/canOpenWorkspacePathExtra'), false);
  assert.equal(SESSION_SCOPED_RE.test('/api/workspace/pinSessions'), false);
  assert.equal(SESSION_SCOPED_RE.test('/api/workspace/unpinSessionExtra'), false);
  assert.equal(SESSION_SCOPED_RE.test('/api/session/pinSession'), false, '不可跨命名空间误命中');
  assert.equal(SESSION_SCOPED_RE.test('/api/pinSession/list'), false);
  // 硬拒按方法精确匹配：前缀相近不扩散
  assert.equal(isSubuserBlockedApiPath('/api/session/openWorkspacePathExtra'), false);
  assert.equal(isSubuserBlockedApiPath('/api/session/workspacePathApplicationsX'), false);
});

test('0.1.7：新增 RPC 的请求体会话身份可被收集（用于逐会话授权）', () => {
  const envelope = (method: string, args: Record<string, unknown>): unknown => ({
    type: 'client-request',
    rpcId: 'rpc-1',
    method,
    payload: { args },
  });
  // session/projections、workspace/{pin,unpin,unarchive}Session 的 wire 是 request.sessionId
  const cases: Array<{ method: string; args: Record<string, unknown>; id: string }> = [
    { method: 'session/projections', args: { request: { sessionId: 's-proj' } }, id: 's-proj' },
    { method: 'workspace/pinSession', args: { request: { sessionId: 's-pin' } }, id: 's-pin' },
    { method: 'workspace/unpinSession', args: { request: { sessionId: 's-unpin' } }, id: 's-unpin' },
    { method: 'workspace/unarchiveSession', args: { request: { sessionId: 's-unarchive' } }, id: 's-unarchive' },
  ];
  for (const item of cases) {
    assert.deepEqual(
      [...(collectAuthorizedSessionIds(envelope(item.method, item.args)) ?? [])],
      [item.id],
      `${item.method} 必须收集到请求体会话身份`,
    );
  }
  // 形状不符（sessionId 非字符串）→ 整体 null，调用方必须 403
  assert.equal(
    collectAuthorizedSessionIds(envelope('workspace/pinSession', { request: { sessionId: 7 } })),
    null,
  );
  // wire 里没有会话身份的两个方法：网关取不到身份就只能硬拒（0.1.7 已改为
  // SUBUSER_BLOCKED_API_ENDPOINTS），收集结果仍为空、不会凭空造出授权。
  assert.deepEqual(
    [...(collectAuthorizedSessionIds(envelope('session/canOpenWorkspacePath', {})) ?? [])],
    [],
  );
  assert.deepEqual(
    [...(collectAuthorizedSessionIds(envelope('session/workspacePathApplications', { path: '/w/a.txt' })) ?? [])],
    [],
  );
  assert.equal(isSubuserBlockedApiPath('/api/session/canOpenWorkspacePath'), true);
  assert.equal(isSubuserBlockedApiPath('/api/session/workspacePathApplications'), true);
});
