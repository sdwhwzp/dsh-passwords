// 权限模块安全关键纯函数的回归测试（之前零覆盖）：
// 沙盒降级 / 审批强制拒绝 / 会话归属过滤 / 权限路径过滤 / preset 解析。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  permissionPresetFromCommand,
  presetFromSettingsMutate,
  forceRejectApproval,
  clampSessionHistorySandbox,
  filterByPathField,
  filterOwnedSessionIds,
  filterSessionSearchItems,
  sandboxPresetRank,
  parseSessionAddress,
  isUploadRequest,
  parseEndpointAllowlist,
  parseEndpointRule,
  endpointAllowed,
  isOfficialRootPath,
  classifySubuserPath,
  pathWithin,
  workspaceRegistrationAllowed,
  directoryEntryVisible,
} from '../src/permissions.js';

test('alpha.1：原始 session 上传路径纳入上传权限门卫', () => {
  assert.equal(isUploadRequest('POST', '/api/session/uploadFileBinary'), true);
  assert.equal(isUploadRequest('POST', '/api/fileUploads/upload'), true);
  assert.equal(isUploadRequest('GET', '/api/session/uploadFileBinary'), false);
  assert.equal(isUploadRequest('POST', '/api/third-party-uploads'), false, '第三方上传端点不再内置在官方门卫里');
});

// ── 端点登记表：可选传输前缀、匹配与子用户分类器 ──────────────────

test('parseEndpointAllowlist：接受可选能力/传输前缀并规范化大小写', () => {
  assert.deepEqual(parseEndpointAllowlist('WS:/api/a,Http:/api/b,Owner:/api/c,/api/d', 'TEST'), [
    'ws:/api/a',
    'http:/api/b',
    'owner:/api/c',
    '/api/d',
  ]);
});

test('parseEndpointRule：能力与传输前缀可任意组合/顺序', () => {
  assert.deepEqual(parseEndpointRule('owner:ws:/x'), { capability: 'owner-only', transport: 'ws', path: '/x' });
  assert.deepEqual(parseEndpointRule('ws:owner:/x'), { capability: 'owner-only', transport: 'ws', path: '/x' });
  assert.deepEqual(parseEndpointRule('http:/x'), { capability: 'ssh', transport: 'http', path: '/x' });
  assert.deepEqual(parseEndpointRule('/x'), { capability: 'ssh', transport: 'any', path: '/x' });
});

test('parseEndpointAllowlist：前缀后缺路径 / 非斜杠开头 / 非法字符 / 网关前缀均启动即失败', () => {
  assert.throws(() => parseEndpointAllowlist('ws:', 'TEST'), /missing a path/);
  assert.throws(() => parseEndpointAllowlist('owner:', 'TEST'), /missing a path/);
  assert.throws(() => parseEndpointAllowlist('ws:api/a', 'TEST'), /must start with \//);
  assert.throws(() => parseEndpointAllowlist('/api/a?x=1', 'TEST'), /query, encoding/);
  assert.throws(() => parseEndpointAllowlist('/gateway/login', 'TEST'), /gateway paths cannot be registered/);
  assert.throws(() => parseEndpointAllowlist('http:/api/dsh-passwords/internal/x', 'TEST'), /internal gateway paths/);
});

test('endpointAllowed：按传输与能力过滤（不传 capability 时两类规则都算命中）', () => {
  const rules = parseEndpointAllowlist('ws:/api/ws-only,http:/api/http-only,/api/both,owner:/api/owner', 'TEST');
  assert.equal(endpointAllowed('/api/both', rules), true);
  assert.equal(endpointAllowed('/api/both', rules, { transport: 'http' }), true);
  assert.equal(endpointAllowed('/api/both', rules, { transport: 'ws' }), true);
  assert.equal(endpointAllowed('/api/ws-only', rules, { transport: 'ws' }), true);
  assert.equal(endpointAllowed('/api/ws-only', rules, { transport: 'http' }), false);
  assert.equal(endpointAllowed('/api/http-only', rules, { transport: 'http' }), true);
  assert.equal(endpointAllowed('/api/http-only', rules, { transport: 'ws' }), false);
  assert.equal(endpointAllowed('/api/other', rules), false);
  assert.equal(endpointAllowed('/api/owner', rules), true, '不传 capability：两类规则都命中（SSRF 校验口径）');
  assert.equal(endpointAllowed('/api/owner', rules, { capability: 'ssh' }), false);
  assert.equal(endpointAllowed('/api/owner', rules, { capability: 'owner-only' }), true);
});

test('classifySubuserPath：传输过滤 + owner: 优先于 ssh + 官方/第三方划分', () => {
  const endpointRules = parseEndpointAllowlist(
    'ws:/api/plugin/terminal,http:/api/plugin/exec,/api/plugin/hosts,owner:/api/plugin/hosts',
    'TEST',
  );

  // 传输过滤
  assert.equal(classifySubuserPath('/api/plugin/terminal', { endpointRules, transport: 'ws' }), 'ssh');
  assert.equal(classifySubuserPath('/api/plugin/terminal', { endpointRules, transport: 'http' }), 'third-party');
  assert.equal(classifySubuserPath('/api/plugin/exec', { endpointRules, transport: 'http' }), 'ssh');
  assert.equal(classifySubuserPath('/api/plugin/exec', { endpointRules, transport: 'ws' }), 'third-party');

  // owner: 优先（同一路径同时以 ssh 与 owner: 登记）
  assert.equal(classifySubuserPath('/api/plugin/hosts', { endpointRules, transport: 'http' }), 'owner-only');
  assert.equal(classifySubuserPath('/api/plugin/hosts', { endpointRules, transport: 'ws' }), 'owner-only');

  // 官方面（/api 命名空间 + 官方根级路径）
  assert.equal(classifySubuserPath('/api/session/history', { endpointRules, transport: 'http' }), 'official');
  assert.equal(classifySubuserPath('/api/workspace.list', { endpointRules, transport: 'http' }), 'official');
  assert.equal(classifySubuserPath('/api/permissionPresets/catalog', { endpointRules, transport: 'http' }), 'official', 'alpha.1 官方权限预设目录');
  assert.equal(classifySubuserPath('/api/terminal/shells', { endpointRules, transport: 'http' }), 'third-party', 'terminal 命名空间故意不开放给子用户（远程 shell = 沙箱逃逸）');
  assert.equal(classifySubuserPath('/', { endpointRules, transport: 'http' }), 'official');
  assert.equal(classifySubuserPath('/assets/app.js', { endpointRules, transport: 'http' }), 'official');
  assert.equal(classifySubuserPath('/plugins/pkg/client.js', { endpointRules, transport: 'http' }), 'official');
  assert.equal(classifySubuserPath('/api/dsh-passwords/state', { endpointRules, transport: 'http' }), 'platform');

  // 未登记的第三方面：/api 与根级插件路由一律 third-party（fail-closed）
  assert.equal(classifySubuserPath('/api/plugin-other/x', { endpointRules, transport: 'http' }), 'third-party');
  assert.equal(classifySubuserPath('/api/live-stats', { endpointRules, transport: 'http' }), 'third-party');
  assert.equal(classifySubuserPath('/third-party-panel/status', { endpointRules, transport: 'http' }), 'third-party');
});

test('classifySubuserPath：尾部 /* 只放行直接子路径（不放行基路径与更深层）', () => {
  const endpointRules = parseEndpointAllowlist('/api/plugin/*', 'TEST');
  assert.equal(classifySubuserPath('/api/plugin/one', { endpointRules, transport: 'http' }), 'ssh');
  assert.equal(classifySubuserPath('/api/plugin', { endpointRules, transport: 'http' }), 'third-party');
  assert.equal(classifySubuserPath('/api/plugin/one/two', { endpointRules, transport: 'http' }), 'third-party');
});

test('isOfficialRootPath：官方根级白名单（SPA 壳 / 静态 / 插件 bundle），其余根路径 fail-closed', () => {
  for (const allowed of [
    '/', '/index.html', '/favicon.ico', '/assets/app.js', '/plugins', '/plugins/pkg/client.js', '/logo.svg',
    '/open-in-app/apps', '/open-in-app/icon/vscode', '/open-in-app/open',
  ]) {
    assert.equal(isOfficialRootPath(allowed), true, `${allowed} 属官方根级`);
  }
  for (const denied of ['/third-party-panel/read', '/modlens', '/sidebar/ws/terminal', '/api/x', '/html', '/open-in-app/unknown']) {
    assert.equal(isOfficialRootPath(denied), false, `${denied} 不属官方根级`);
  }
});

// ── RC.1 SessionAddress（普通会话与子代理地址） ─────────────────

test('parseSessionAddress：保留普通会话与完整 subagent 地址', () => {
  assert.deepEqual(parseSessionAddress({ kind: 'session', sessionId: 'parent-visible' }), {
    kind: 'session',
    sessionId: 'parent-visible',
  });
  assert.deepEqual(parseSessionAddress({
    kind: 'subagent',
    parentSessionId: 'parent-visible',
    childSessionId: 'child-visible',
    mode: 'continuable',
  }), {
    kind: 'subagent',
    parentSessionId: 'parent-visible',
    childSessionId: 'child-visible',
    mode: 'continuable',
  });
  const oneShot = parseSessionAddress({
    kind: 'subagent',
    parentSessionId: 'parent-visible',
    childSessionId: 'child-one-shot',
    mode: 'one-shot',
  });
  assert.equal(oneShot?.kind, 'subagent');
  assert.equal(oneShot?.mode, 'one-shot');
});

test('parseSessionAddress：拒绝不完整或伪造的子代理地址', () => {
  assert.equal(parseSessionAddress({ kind: 'subagent', parentSessionId: 'p', childSessionId: 'c' }), null);
  assert.equal(parseSessionAddress({ kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'invalid' }), null);
  assert.equal(parseSessionAddress({ kind: 'session', sessionId: '' }), null);
  assert.equal(parseSessionAddress({ kind: 'session', sessionId: 'x'.repeat(201) }), null);
});

// ── permissionPresetFromCommand（/permission 命令解析） ─────────

test('permissionPresetFromCommand：解析 preset 参数', () => {
  assert.equal(permissionPresetFromCommand('/permission workspace-write'), 'workspace-write');
  assert.equal(permissionPresetFromCommand('/permission read-only'), 'read-only');
  assert.equal(permissionPresetFromCommand('/permission danger-full-access'), 'danger-full-access');
});

test('permissionPresetFromCommand：非本命令/无参数返回 null', () => {
  assert.equal(permissionPresetFromCommand('/permission'), null);
  assert.equal(permissionPresetFromCommand('/help'), null);
  assert.equal(permissionPresetFromCommand('/permission '), null);
  assert.equal(permissionPresetFromCommand('permission workspace-write'), null);
});

// ── presetFromSettingsMutate（settings.mutate 找 defaultPreset） ─

test('presetFromSettingsMutate：path 数组含 defaultPreset 时返回 value', () => {
  const body = {
    ops: [{ path: ['permission', 'defaultPreset'], value: 'read-only' }],
  };
  assert.equal(presetFromSettingsMutate(body), 'read-only');
  assert.equal(presetFromSettingsMutate({ ops: [{ path: ['other'], value: 'x' }] }), null);
  assert.equal(presetFromSettingsMutate(null), null);
});

test('presetFromSettingsMutate：args 伪包裹里的值也会命中（fail-closed 方向）', () => {
  const body = { args: { path: ['permission', 'defaultPreset'], value: 'danger-full-access' } };
  // 与 extractPathFromBody/extractWorkspaceId 不同，这里不跳过 args——
  // 注意：这是故意的 fail-closed（沙盒检测里命中 args 高权限会 403 拦截，
  // dsh 忽略 args 走默认 preset 时也只是多拦不误放），与路径白名单相反方向，安全。
  assert.equal(presetFromSettingsMutate(body), 'danger-full-access');
});

// ── forceRejectApproval（受限子用户 AI 提权审批强制拒绝） ──────

test('forceRejectApproval：outcome 非 rejected 时改为 rejected', () => {
  const obj = { approvalId: 'ap1', outcome: 'approved' };
  assert.equal(forceRejectApproval(obj), true);
  assert.equal(obj.outcome, 'rejected');
});

test('forceRejectApproval：嵌套 result.value 信封也能命中', () => {
  const obj = { result: { value: { approvalId: 'ap2', outcome: 'accepted' } } };
  assert.equal(forceRejectApproval(obj), true);
  assert.equal(obj.result.value.outcome, 'rejected');
});

test('forceRejectApproval：已是 rejected / ask_user_question(answer) 不改', () => {
  const obj = { approvalId: 'ap3', outcome: 'rejected' };
  assert.equal(forceRejectApproval(obj), false);
  assert.equal(obj.outcome, 'rejected');
  const q = { answer: 'yes' }; // ask_user_question 的响应用 answer，不受影响
  assert.equal(forceRejectApproval(q), false);
});

// ── clampSessionHistorySandbox（沙盒降级） ─────────────────────

/** 构造 one-line 对象（不引 dsh 深层类型，结构足够即可） */
const mk = (o: Record<string, unknown>) => o;

test('clampSessionHistorySandbox：preset/mode/currentValue 超过授权级别时降级', () => {
  const target = mk({
    events: [
      { event: { type: 'permission/preset', data: { preset: 'danger-full-access' } } },
      { event: { type: 'sandbox/mode', data: { mode: 'workspace-write' } } },
    ],
    projections: { values: { permissions: { currentValue: 'danger-full-access' } } },
  });
  const changed = clampSessionHistorySandbox(target, 'read-only');
  assert.equal(changed, true);
  assert.equal(((target as any).events[0].event as any).data.preset, 'read-only');
  assert.equal(((target as any).events[1].event as any).data.mode, 'read-only');
  assert.equal(((target as any).projections.values.permissions as any).currentValue, 'read-only');
});

test('clampSessionHistorySandbox：同级别/更低级别不改', () => {
  const target = mk({
    events: [{ event: { type: 'sandbox/mode', data: { mode: 'read-only' } } }],
    projections: { values: { permissions: { currentValue: 'read-only' } } },
  });
  assert.equal(clampSessionHistorySandbox(target, 'workspace-write'), false);
  assert.equal(((target as any).events[0].event as any).data.mode, 'read-only');
});

test('clampSessionHistorySandbox：allowedMode=null 时不动（主用户不限）', () => {
  const target = mk({ events: [{ event: { type: 'sandbox/mode', data: { mode: 'danger-full-access' } } }] });
  assert.equal(clampSessionHistorySandbox(target, null), false);
});

// ── filterByPathField（白名单路径过滤） ────────────────────────

test('filterByPathField：白名单外的带 path 对象被丢弃，其余保留', () => {
  const input = {
    items: [
      { path: '/root/11', id: 'a' },
      { path: '/root/21', id: 'b' },
      { title: '无 path 字段' },
    ],
  };
  const out = filterByPathField(input, ['/root/21'], 'path') as typeof input;
  assert.equal(out.items.length, 2);
  assert.equal((out.items[0] as any).id, 'b');
  assert.equal((out.items[1] as any).title, '无 path 字段');
});

test('filterByPathField：空白名单 = 全部允许；__deny__ 哨兵 = 全部拒绝', () => {
  const input = { items: [{ path: '/x' }] };
  assert.equal((filterByPathField(input, [], 'path') as any).items.length, 1);
  assert.equal((filterByPathField(input, ['__deny__'], 'path') as any).items.length, 0);
});

// ── filterOwnedSessionIds（会话归属过滤） ───────────────────────

test('filterOwnedSessionIds：只保留 keep() 通过的 sessionId', () => {
  const input = { items: [{ path: '/w', sessionIds: ['s1', 's2', 's3'] }] };
  filterOwnedSessionIds(input, (id) => id === 's2');
  assert.deepEqual((input.items[0] as any).sessionIds, ['s2']);
});

test('filterOwnedSessionIds：sessionIds 含非字符串时清除非法值（fail-closed）', () => {
  const input = { items: [{ sessionIds: ['s1', 2] }] };
  filterOwnedSessionIds(input, () => true);
  assert.deepEqual((input.items[0] as any).sessionIds, ['s1']);
});

// ── filterSessionSearchItems（rc.1 session/search 授权过滤） ────

test('filterSessionSearchItems：只保留授权会话并保留摘要字段', () => {
  const visible = { sessionId: 's-visible', snippet: 'allowed', score: 0.9 };
  const hidden = { sessionId: 's-hidden', snippet: 'secret' };
  const out = filterSessionSearchItems([visible, hidden], (id) => id === 's-visible');
  assert.deepEqual(out, [visible]);
  assert.notEqual(out?.[0], visible, '过滤结果应创建新对象，避免把上游对象交给后续调用方');
});

test('filterSessionSearchItems：非法或缺少 sessionId 的项直接丢弃', () => {
  const out = filterSessionSearchItems([
    null,
    1,
    'not-an-object',
    [],
    {},
    { sessionId: '' },
    { sessionId: 42, snippet: 'invalid id' },
    { sessionId: 's-visible', snippet: 'allowed' },
  ], () => true);
  assert.deepEqual(out, [{ sessionId: 's-visible', snippet: 'allowed' }]);
});

test('filterSessionSearchItems：非数组结果返回 null，触发上层 fail-closed', () => {
  assert.equal(filterSessionSearchItems(null, () => true), null);
  assert.equal(filterSessionSearchItems({ items: [] }, () => true), null);
});

// ── sandboxPresetRank（级别映射） ──────────────────────────────

test('sandboxPresetRank：未知值按最宽松 2 处理（防越权切换）', () => {
  assert.equal(sandboxPresetRank('read-only'), 0);
  assert.equal(sandboxPresetRank('workspace-write'), 1);
  assert.equal(sandboxPresetRank('danger-full-access'), 2);
  assert.equal(sandboxPresetRank('bogus'), 2);
});

// ── D1 工作流：工作区登记白名单与目录浏览可见性 ──────────────────

test('pathWithin：相等/子路径/点段/根与空白语义', () => {
  assert.equal(pathWithin('/root/33', '/root/33'), true, '相等');
  assert.equal(pathWithin('/root/33/sub', '/root/33'), true, '子路径');
  assert.equal(pathWithin('/root/33/../34', '/root/33'), false, '点段解析后不再在内');
  assert.equal(pathWithin('/root/33', '/root/34'), false);
  assert.equal(pathWithin('/anything', '/'), true, '根 = 全盘');
  assert.equal(pathWithin('/anything', ''), false, '空根无效');
  assert.equal(pathWithin('/anything', '.'), false, '当前目录根无效');
});

test('workspaceRegistrationAllowed：只接受精确分配/自己子树/刚创建目录', () => {
  const assigned = ['/root/33'];
  const owned = ['/root/33/mine'];
  const pending = ['/root/33/fresh'];
  assert.equal(workspaceRegistrationAllowed('/root/33', assigned, owned, pending), true, '精确分配');
  assert.equal(workspaceRegistrationAllowed('/root/33/mine/sub', assigned, owned, pending), true, '自己的工作区子树');
  assert.equal(workspaceRegistrationAllowed('/root/33/fresh', assigned, owned, pending), true, '刚创建目录');
  assert.equal(workspaceRegistrationAllowed('/root/33/preexisting', assigned, owned, pending), false, '预存在未分配');
  assert.equal(workspaceRegistrationAllowed('/root/33/../34', assigned, owned, pending), false, '点段逃逸');
  assert.equal(workspaceRegistrationAllowed('/', assigned, owned, pending), false, '根目录拒绝');
  assert.equal(workspaceRegistrationAllowed('/root/33', ['__deny__'], owned, pending), false, '哨兵不作为分配项');
  assert.equal(workspaceRegistrationAllowed('/root/33/fresh', [], [], []), false, '无任何凭据时拒绝');
});

test('directoryEntryVisible：祖先导航只保留通往授权根的条目', () => {
  const roots = ['/workspaces/visible'];
  assert.equal(directoryEntryVisible('/workspaces/visible', roots), true, '授权根本身');
  assert.equal(directoryEntryVisible('/workspaces/visible/sub', roots), true, '授权根内');
  assert.equal(directoryEntryVisible('/workspaces', roots), true, '祖先（通往授权根）');
  assert.equal(directoryEntryVisible('/', roots), true, '根祖先');
  assert.equal(directoryEntryVisible('/workspaces/other', roots), false, '无关兄弟目录');
  assert.equal(directoryEntryVisible('/root/33', roots), false, '无关子树');
});
