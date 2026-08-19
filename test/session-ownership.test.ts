// F-25 回归测试：会话归属（sessionId 提取 / 枚举源清理 / 会话列表过滤）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_SCOPED_RE,
  extractSessionId,
  stripArchivedSessionIds,
  filterSessionItems,
  collectSessionCwd,
  collectSessionMeta,
  collectSessionCwdFromWorkspaces,
} from '../src/permissions.js';

test('F-25：SESSION_SCOPED_RE 命中会读取/写入会话的 RPC，但不命中 create/list', () => {
  for (const m of ['history', 'prompt', 'respond', 'archive', 'delete', 'rename', 'retitle', 'title', 'resume', 'fork', 'truncate', 'export']) {
    assert.equal(SESSION_SCOPED_RE.test(`/api/session.${m}`), true, `session.${m} 应归属校验`);
    assert.equal(SESSION_SCOPED_RE.test(`/api/session/${m}`), true, `session/${m} 应归属校验`);
  }
  assert.equal(SESSION_SCOPED_RE.test('/api/session.create'), false, 'create 无源会话');
  assert.equal(SESSION_SCOPED_RE.test('/api/session.list'), false, 'list 单独过滤');
});

test('F-25：extractSessionId 提取顶层与嵌套 sessionId', () => {
  assert.equal(extractSessionId({ sessionId: 'session-1', prompt: {} }), 'session-1');
  assert.equal(extractSessionId({ args: { request: { sessionId: 's-2' } } }), 's-2');
  assert.equal(extractSessionId({ id: 'x' }), null, '无 sessionId 返回 null');
});

test('F-25：stripArchivedSessionIds 清空 archivedSessionIds 数组', () => {
  const obj = {
    workspaces: [{ id: 'w1', archivedSessionIds: ['s1', 's2'] }],
    keep: 'x',
  };
  const changed = stripArchivedSessionIds(obj);
  assert.equal(changed, true);
  assert.deepEqual(obj.workspaces[0].archivedSessionIds, []);
  assert.equal(obj.keep, 'x');
});

test('F-25：filterSessionItems 只保留自己拥有的会话（sessionId+cwd 条目）', () => {
  const owned = new Set(['s-own']);
  const tree = {
    result: {
      value: [
        { sessionId: 's-own', cwd: '/root/11', title: 'mine' },
        { sessionId: 's-other', cwd: '/root/21', title: 'theirs' },
        { sessionId: 's-admin', cwd: '/root/21', title: 'admin' },
      ],
    },
  };
  const out = filterSessionItems(tree, (id) => owned.has(id)) as typeof tree;
  const items = out.result.value as Array<{ sessionId: string }>;
  assert.deepEqual(items.map((i) => i.sessionId), ['s-own'], '只留下自己拥有的会话');
});

test('F-25：受限子用户按 cwd 白名单过滤会话（去未分组+新会话孤儿）', () => {
  const owned = (id: string) => id.startsWith('s-');
  const allowed = (cwd: string) => cwd.startsWith('/root/21') || cwd === '/root/21';
  const tree = {
    result: {
      value: [
        // 权限撤销前在 /root/11 创建的旧会话：工作区已被隐藏 → 应丢弃
        { sessionId: 's-old11', cwd: '/root/11', blank: true },
        // 当前授权目录 /root/21 内的会话 → 保留
        { sessionId: 's-new21', cwd: '/root/21', blank: true },
        // cwd 字段缺失：无法确认在白名单内 → fail-closed 丢弃
        { sessionId: 's-nocwd', blank: true },
      ],
    },
  };
  const out = filterSessionItems(tree, owned, allowed) as typeof tree;
  const items = out.result.value as Array<{ sessionId: string }>;
  assert.deepEqual(items.map((i) => i.sessionId), ['s-new21'], '只保留白名单内会话，未分组孤儿被剔除');
});

test('F-25：cwdAllowed 为 null 时不按目录过滤（不限目录子用户保持归属语义）', () => {
  const owned = new Set(['s-a']);
  const tree = {
    result: {
      value: [
        { sessionId: 's-a', cwd: '/anywhere', blank: true },
        { sessionId: 's-b', cwd: '/elsewhere', blank: true },
      ],
    },
  };
  const out = filterSessionItems(tree, (id) => owned.has(id), null) as typeof tree;
  const items = out.result.value as Array<{ sessionId: string }>;
  assert.deepEqual(items.map((i) => i.sessionId), ['s-a'], '不限目录只按归属');
});

test('F-25：collectSessionCwd 收集 sessionId→cwd（供会话作用域 RPC 校验）', () => {
  const tree = {
    result: {
      value: {
        items: [
          { sessionId: 's-1', cwd: '/root/11' },
          { sessionId: 's-2', cwd: '/root/21' },
          { sessionId: 's-3' }, // 无 cwd → 不收集
        ],
      },
    },
  };
  const m = collectSessionCwd(tree);
  assert.equal(m.get('s-1'), '/root/11');
  assert.equal(m.get('s-2'), '/root/21');
  assert.equal(m.has('s-3'), false, '无 cwd 不收集');
});

test('F-25：collectSessionCwdFromWorkspaces 用工作区 path 反推会话 cwd', () => {
  const tree = {
    result: {
      value: {
        items: [
          { workspaceId: 'w1', path: '/root/11', sessionIds: ['s-1', 's-2'] },
          { workspaceId: 'w2', path: '/root/21', sessionIds: ['s-3'] },
        ],
        archivedSessionIds: ['s-4'],
      },
    },
  };
  const m = collectSessionCwdFromWorkspaces(tree);
  assert.equal(m.get('s-1'), '/root/11');
  assert.equal(m.get('s-2'), '/root/11');
  assert.equal(m.get('s-3'), '/root/21');
  assert.equal(m.has('s-4'), false, 'archived 不在工作区 items 里 → 不映射（fail-closed）');
});

// ── D6：collectSessionMeta（会话注册表收割） ─────────────────

test('D6：collectSessionMeta 收集 sessionId → {cwd, title}', () => {
  const tree = {
    result: {
      value: [
        { sessionId: 's-1', cwd: '/root/11', title: 'one' },
        { sessionId: 's-2', cwd: '/root/21' }, // 无 title
        { sessionId: 's-3', title: 'only-title' }, // 无 cwd
        { sessionId: '' }, // 空 sessionId 忽略
        { cwd: '/orphan' }, // 无 sessionId 忽略
      ],
    },
  };
  const m = collectSessionMeta(tree);
  assert.deepEqual(m.get('s-1'), { cwd: '/root/11', title: 'one' });
  assert.deepEqual(m.get('s-2'), { cwd: '/root/21', title: null });
  assert.deepEqual(m.get('s-3'), { cwd: null, title: 'only-title' });
  assert.equal(m.has(''), false, '空 sessionId 不收集');
  assert.equal(m.has('s-orphan'), false, '无 sessionId 对象不收集');
});

test('D6：collectSessionMeta 同 id 多次出现合并（后值覆盖空值）', () => {
  const tree = [
    { sessionId: 's-x', cwd: '/root/11' }, // 先只有 cwd
    { sessionId: 's-x', title: 'later' }, // 后出现补 title
  ];
  const m = collectSessionMeta(tree);
  assert.deepEqual(m.get('s-x'), { cwd: '/root/11', title: 'later' }, '同一会话跨条目合并 cwd+title');
});
