import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Component, createElement, type ComponentProps, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DshPasswordsCard } from '../src/client/card.tsx';
import { api } from '../src/client/api.ts';

type CardProps = { t: (key: string, params?: Record<string, unknown>) => string };

class CardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? 'card-crashed' : this.props.children;
  }
}

function loginResponse() {
  const response = new Response('<!doctype html><title>Login</title>', {
    headers: { 'content-type': 'text/html' },
  });
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: 'https://example.test/gateway/login' },
  });
  return response;
}

async function mountCard(t: TestContext, overrides: Record<string, () => Response> = {}, payloadOverrides: Record<string, unknown> = {}, mode: 'settings' | 'accounts' = 'settings') {
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  let renderer: ReactTestRenderer | undefined;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setInterval(callback: () => void, delay: number) {
        intervals.set(++nextTimer, { callback, delay });
        return nextTimer;
      },
      clearInterval(id: number) { intervals.delete(id); },
      setTimeout,
      confirm: () => true,
    },
  });
  t.after(async () => {
    try {
      await act(async () => { renderer?.unmount(); });
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
    assert.equal(intervals.size, 0);
  });
  t.mock.method(console, 'error', () => {});
  const me = { id: 1, username: 'test-admin', role: 'admin' };
  const payloads: Record<string, unknown> = {
    '/api/dsh-passwords/state': { me, users: [] },
    '/gateway/api/overview': { me, users: [], availableWebSocketPaths: [] },
    '/api/dsh-passwords/workspaces': { workspaces: [] },
    '/api/dsh-passwords/patch/status': {
      status: { settingsHostMode: true, whitelist: true, workspaceSearch: true },
    },
    '/api/dsh-passwords/budgets': { budgets: [] },
    ...payloadOverrides,
  };
  if (mode === 'accounts' && !('/api/dsh-passwords/state' in payloadOverrides)) {
    const overview = payloads['/gateway/api/overview'] as { users: unknown[] };
    payloads['/api/dsh-passwords/state'] = { me, users: overview.users };
  }
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    requests.push({ input, init });
    if (overrides[input]) return overrides[input]();
    assert.ok(input in payloads, `Unexpected request: ${input}`);
    return Response.json(payloads[input]);
  });
  const translate: CardProps['t'] = (key) => key === 'err.NOT_AUTHENTICATED'
    ? 'Session expired' : key;
  await act(async () => {
    renderer = create(createElement(CardBoundary, {
      children: createElement(DshPasswordsCard, {
        t: translate,
        mode,
        loadState: () => api('/api/dsh-passwords/state'),
      }),
    }));
  });
  return {
    renderer: renderer!,
    text: () => JSON.stringify(renderer!.toJSON()),
    requests,
    async refresh() {
      const timer = [...intervals.values()].find(({ delay }) => delay === 30_000);
      assert.ok(timer, 'Card must retain its refresh timer');
      await act(async () => { timer.callback(); });
    },
  };
}

async function mountPermissionsCard(t: TestContext, overrides: Record<string, () => Response> = {}, payloads: Record<string, unknown> = {}) {
  const card = await mountCard(t, overrides, {
    '/api/dsh-passwords/state': { me: { id: 1, username: 'test-admin', role: 'admin' }, users: [{ id: 2, username: 'subuser', role: 'user' }] },
    ...payloads,
  }, 'accounts');
  const edit = card.renderer.root.findAllByType('button').find(button => button.props['aria-label'] === 'accountsEdit · subuser');
  assert.ok(edit, 'the account editor entry must be available');
  await act(async () => { edit.props.onClick(); });
  return card;
}

test('settings card renders account and patch controls for a healthy response', async (t) => {
  const card = await mountCard(t);
  assert.match(card.text(), /test-admin/);
  assert.match(card.text(), /patchOk/);
  assert.doesNotMatch(card.text(), /card-crashed/);
});

test('settings card reports workspace inventory failures and recovers on refresh', async (t) => {
  const responses: Record<string, () => Response> = {
    '/api/dsh-passwords/workspaces': () => Response.json({
      ok: false,
      code: 'WORKSPACE_UNAVAILABLE',
      error: 'The workspace service is temporarily unavailable; try again later',
    }, { status: 502 }),
  };
  const card = await mountCard(t, responses, {}, 'accounts');
  assert.match(card.text(), /The workspace service is temporarily unavailable/);
  assert.doesNotMatch(card.text(), /card-crashed/);

  delete responses['/api/dsh-passwords/workspaces'];
  await card.refresh();
  assert.doesNotMatch(card.text(), /The workspace service is temporarily unavailable|card-crashed/);
});

test('settings card reports degraded remote settings when every patch flag is false', async (t) => {
  const card = await mountCard(t, {}, {
    '/api/dsh-passwords/patch/status': {
      status: { settingsHostMode: false, whitelist: false, workspaceSearch: false },
    },
  });
  assert.match(card.text(), /test-admin/);
  assert.match(card.text(), /patchBad/);
  assert.doesNotMatch(card.text(), /patchUnknown|card-crashed/);
});

test('account editor synchronizes the SSH permission beside upload and save API', async (t) => {
  const card = await mountCard(t, {
    '/gateway/api/permissions': () => Response.json({ ok: true }),
  }, {
    '/gateway/api/overview': {
      me: { id: 1, username: 'test-admin', role: 'admin' },
      availableWebSocketPaths: [],
      users: [{
        id: 2,
        username: 'subuser',
        role: 'user',
        permissions: {
          allowedFolders: [],
          hourlyTokenLimit: null,
          dailyMinutesLimit: null,
          allowUpload: false,
          allowGitDownload: false,
          allowWorkspaceCreate: false,
          allowSsh: false,
          allowedAgentPresets: [],
          banned: false,
          sandboxMode: null,
          disabledSessions: [],
          allowedSessionIds: [],
        },
        usage: null,
      }],
    },
  }, 'accounts');
  await act(async () => { card.renderer.root.findAllByType('button').find(b => b.props['aria-label'] === 'accountsEdit · subuser')!.props.onClick(); });
  const sshLabel = card.renderer.root.findAllByType('label').find((label) => label.children.some((child) => child === 'permsSsh'));
  assert.ok(sshLabel, 'SSH 权限开关必须出现在上传权限附近');
  const checkbox = sshLabel!.findByType('input');
  assert.equal(checkbox.props.checked, false);
  await act(async () => { checkbox.props.onChange({ target: { checked: true } }); });
  const saveButton = card.renderer.root.findAllByType('button').find((button) => button.children.some((child) => child === 'permsSave'));
  assert.ok(saveButton);
  await act(async () => { saveButton!.props.onClick(); });
  const permissionRequest = card.requests.find((request) => request.input === '/gateway/api/permissions');
  assert.ok(permissionRequest);
  assert.equal(JSON.parse(String(permissionRequest!.init?.body)).allowSsh, true);
  const saved = card.renderer.root.findAll((node) => node.props.role === 'status' && node.children.includes('permsSaved'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.parent?.props.className, 'dshpw-perm-foot');
  await act(async () => { checkbox.props.onChange({ target: { checked: false } }); });
  assert.equal(card.renderer.root.findAll((node) => node.props.role === 'status' && node.children.includes('permsSaved')).length, 0);
});

test('account editor synchronizes the large request body permission to the visible checkbox and save API', async (t) => {
  const card = await mountCard(t, {
    '/gateway/api/permissions': () => Response.json({ ok: true }),
  }, {
    '/gateway/api/overview': {
      me: { id: 1, username: 'test-admin', role: 'admin' },
      availableWebSocketPaths: [],
      users: [{
        id: 2,
        username: 'subuser',
        role: 'user',
        permissions: {
          allowedFolders: [],
          hourlyTokenLimit: null,
          dailyMinutesLimit: null,
          allowUpload: false,
          allowGitDownload: false,
          allowWorkspaceCreate: false,
          allowSsh: false,
          allowedAgentPresets: [],
          banned: false,
          sandboxMode: null,
          disabledSessions: [],
          allowedSessionIds: [],
        },
        usage: null,
      }],
    },
  }, 'accounts');
  await act(async () => { card.renderer.root.findAllByType('button').find(b => b.props['aria-label'] === 'accountsEdit · subuser')!.props.onClick(); });
  const uploadLabel = card.renderer.root.findAllByType('label').find((label) => label.children.some((child) => child === 'permsUpload'));
  assert.ok(uploadLabel, '大请求体权限开关必须出现在子用户权限卡片');
  const checkbox = uploadLabel!.findByType('input');
  assert.equal(checkbox.props.checked, false, '前端必须反映后端 allowUpload=false（64 MiB 档位）');
  await act(async () => { checkbox.props.onChange({ target: { checked: true } }); });
  const saveButton = card.renderer.root.findAllByType('button').find((button) => button.children.some((child) => child === 'permsSave'));
  assert.ok(saveButton, '子用户权限卡片必须存在保存按钮');
  await act(async () => { saveButton!.props.onClick(); });
  const permissionRequest = card.requests.find((request) => request.input === '/gateway/api/permissions');
  assert.ok(permissionRequest, '保存必须调用权限 API');
  assert.equal(JSON.parse(String(permissionRequest!.init?.body)).allowUpload, true, '保存必须提交 allowUpload');
});

test('settings card synchronizes the SSH permission beside upload and save API', async (t) => {
  const card = await mountPermissionsCard(t, {
    '/gateway/api/permissions': () => Response.json({ ok: true }),
  }, {
    '/gateway/api/overview': {
      me: { id: 1, username: 'test-admin', role: 'admin' },
      users: [{
        id: 2,
        username: 'subuser',
        role: 'user',
        permissions: {
          allowedFolders: [],
          hourlyTokenLimit: null,
          dailyMinutesLimit: null,
          allowUpload: false,
          allowGitDownload: false,
          allowWorkspaceCreate: false,
          allowSsh: false,
          allowedAgentPresets: [],
          banned: false,
          sandboxMode: null,
          disabledSessions: [],
          allowedSessionIds: [],
        },
        usage: null,
      }],
    },
  });
  const sshLabel = card.renderer.root.findAllByType('label').find((label) => label.children.some((child) => child === 'permsSsh'));
  assert.ok(sshLabel, 'SSH 权限开关必须出现在上传权限附近');
  const checkbox = sshLabel!.findByType('input');
  assert.equal(checkbox.props.checked, false);
  assert.equal(checkbox.props['aria-label'], 'permsSsh');
  await act(async () => { checkbox.props.onChange({ target: { checked: true } }); });
  const saveButton = card.renderer.root.findAllByType('button').find((button) => button.children.some((child) => child === 'permsSave'));
  assert.ok(saveButton);
  await act(async () => { saveButton!.props.onClick(); });
  const permissionRequest = card.requests.find((request) => request.input === '/gateway/api/permissions');
  assert.ok(permissionRequest);
  const permissionBody = JSON.parse(String(permissionRequest!.init?.body)) as Record<string, unknown>;
  assert.equal(permissionBody.allowSsh, true);
  assert.equal('expectedDisabledSessions' in permissionBody, false, '仅修改 SSH 时不得提交无关的禁用会话 CAS 基线');
});

test('settings card synchronizes an explicitly changed session permission with its CAS baseline', async (t) => {
  const card = await mountPermissionsCard(t, {
    '/gateway/api/permissions': () => Response.json({ ok: true, allowedSessionIds: [], disabledSessions: ['session-visible'] }),
  }, {
    '/gateway/api/overview': {
      me: { id: 1, username: 'test-admin', role: 'admin' },
      users: [{
        id: 2, username: 'subuser', role: 'user',
        permissions: {
          allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
          allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false, allowSsh: false,
          allowedAgentPresets: [], banned: false, sandboxMode: null,
          disabledSessions: ['session-visible'], allowedSessionIds: ['session-visible'],
        }, usage: null,
      }],
    },
    '/api/dsh-passwords/workspaces': {
      workspaces: [{
        path: '/work/visible',
        title: 'Visible workspace',
        sessions: [{ id: 'session-visible', title: 'Visible session' }],
      }],
    },
  });
  const sessionLabel = card.renderer.root.findAllByProps({ className: 'dshpw-session-check' })
    .find((label) => label.findAllByType('input').length === 1);
  assert.ok(sessionLabel, '会话授权开关必须可见');
  await act(async () => { sessionLabel!.findByType('input').props.onChange({ target: { checked: false } }); });
  const saveButton = card.renderer.root.findAllByType('button').find((button) => button.children.some((child) => child === 'permsSave'));
  assert.ok(saveButton);
  await act(async () => { saveButton!.props.onClick(); });
  const permissionRequest = card.requests.find((request) => request.input === '/gateway/api/permissions');
  assert.ok(permissionRequest);
  const permissionBody = JSON.parse(String(permissionRequest!.init?.body)) as Record<string, unknown>;
  assert.deepEqual(permissionBody.expectedDisabledSessions, ['session-visible']);
  assert.deepEqual(permissionBody.allowedSessionIds, []);
});

test('settings card stays mounted when login expires during refresh', async (t) => {
  const responses: Record<string, () => Response> = {};
  const card = await mountCard(t, responses);
  responses['/api/dsh-passwords/state'] = loginResponse;
  responses['/api/dsh-passwords/patch/status'] = loginResponse;
  await card.refresh();
  assert.doesNotMatch(card.text(), /card-crashed/);
  assert.match(card.text(), /Session expired/);
  assert.match(card.text(), /patchUnknown/);
  assert.match(card.text(), /test-admin/);
});

for (const [label, payload] of [
  ['missing', {}],
  ['null', { status: null }],
  ['malformed', { status: { settingsHostMode: 'true', whitelist: true, workspaceSearch: true } }],
] as const) {
  test(`settings card shows unknown for ${label} patch status`, async (t) => {
    const card = await mountCard(t, {
      '/api/dsh-passwords/patch/status': () => Response.json(payload),
    });
    assert.doesNotMatch(card.text(), /card-crashed/);
    assert.match(card.text(), /patchUnknown/);
    assert.match(card.text(), /test-admin/);
  });
}


test('settings link replaces the full directory and does not fetch every account permission', async (t) => {
  const card = await mountCard(t);
  assert.equal(card.renderer.root.findAllByType('a').find(a => a.props.href === '/gateway/accounts')?.props.target, '_blank');
  assert.equal(card.requests.some(r => r.input === '/gateway/api/overview'), false);
  assert.equal(card.renderer.root.findAllByType('table').length, 0);
});

test('account directory paginates 205 accounts, searches and opens only the selected editor', async (t) => {
  const users = Array.from({ length: 205 }, (_, i) => ({ id: i + 2, username: `user-${String(i).padStart(3, '0')}`, role: 'user', created_at: '2026-09-10T00:00:00Z', last_login_at: null }));
  const permissions = { allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null, monthlyBudgetMicros: 10000000, allowUpload: false, allowGitDownload: false, allowSsh: false, banned: false, sandboxMode: null, disabledSessions: [] };
  const card = await mountCard(t, {}, {
    '/api/dsh-passwords/state': { me: { username: 'test-admin', role: 'admin' }, users },
    '/gateway/api/overview': { me: { id: 1, username: 'test-admin', role: 'admin' }, users: users.map(u => ({ ...u, permissions: { ...permissions, banned: u.id === 202 }, usage: null })) },
  }, 'accounts');
  const rows = () => card.renderer.root.findAllByType('tr').filter(r => r.props['data-account-id']);
  assert.equal(rows().length, 25);
  assert.equal(card.renderer.root.findAllByType('dialog').length, 0);
  const button = (label: string) => card.renderer.root.findAllByType('button').find(b => b.children.includes(label))!;
  await act(async () => button('accountsNext').props.onClick());
  assert.equal(rows()[0].props['data-account-id'], 27);
  const search = card.renderer.root.findByProps({ type: 'search' });
  await act(async () => search.props.onChange({ target: { value: 'user-200' } }));
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].props['data-account-id'], 202);
  await act(async () => card.renderer.root.findByProps({ 'aria-label': 'accountsEdit · user-200' }).props.onClick());
  assert.equal(card.renderer.root.findAllByType('dialog').length, 1);
  assert.equal(card.renderer.root.findAllByProps({ className: 'dshpw-perm' }).length, 1);
  await act(async () => card.renderer.root.findByProps({ 'aria-label': 'accountsClose' }).props.onClick());
  assert.equal(card.renderer.root.findAllByType('dialog').length, 0);
  assert.equal(rows().length, 1);
});

type MountedCard = Awaited<ReturnType<typeof mountCard>>;

/** 一个含单个会话的工作区：allowedFolders=[] 时默认全部工作区开启，会话开关可见。 */
const permissionWorkspaces = {
  workspaces: [{
    path: '/work/alpha',
    title: 'Alpha',
    sessions: [{ id: 'sess-1', title: 'Session 1' }],
  }],
};

function subuserOverview(allowedSessionIds: string[]) {
  return {
    me: { id: 1, username: 'test-admin', role: 'admin' },
    users: [{
      id: 2,
      username: 'subuser',
      role: 'user',
      permissions: {
        allowedFolders: [],
        hourlyTokenLimit: null,
        dailyMinutesLimit: null,
        allowUpload: false,
        allowGitDownload: false,
        allowWorkspaceCreate: false,
        allowSsh: false,
        allowedAgentPresets: [],
        banned: false,
        sandboxMode: null,
        disabledSessions: [],
        allowedSessionIds,
      },
      usage: null,
    }],
  };
}

function saveButton(card: MountedCard) {
  return card.renderer.root.findAllByType('button')
    .find((button) => button.children.some((child) => child === 'permsSave'));
}

function sessionCheckbox(card: MountedCard) {
  const label = card.renderer.root
    .findAllByProps({ className: 'dshpw-session-check' })
    .find((node) => node.findAllByType('input').length === 1);
  assert.ok(label, '已启用工作区必须渲染会话授权开关');
  return label!.findByType('input');
}

function permissionBodies(card: MountedCard): Array<Record<string, unknown>> {
  return card.requests
    .filter((request) => request.input === '/gateway/api/permissions')
    .map((request) => JSON.parse(String(request.init?.body)) as Record<string, unknown>);
}

async function savePermissions(card: MountedCard) {
  const save = saveButton(card);
  assert.ok(save, '子用户权限卡片必须存在保存按钮');
  await act(async () => { save!.props.onClick(); });
}

test('saving a workspace-only change omits allowedSessionIds so server grants survive', async (t) => {
  const card = await mountPermissionsCard(t, {
    '/gateway/api/permissions': () => Response.json({ ok: true }),
  }, {
    '/gateway/api/overview': subuserOverview([]),
    '/api/dsh-passwords/workspaces': permissionWorkspaces,
  });
  const workspaceSwitch = card.renderer.root
    .findAllByProps({ className: 'dshpw-switch dshpw-workspace-switch' })
    .find((node) => node.findAllByType('input').length === 1);
  assert.ok(workspaceSwitch, '工作区开关必须渲染');
  await act(async () => {
    workspaceSwitch!.findByType('input').props.onChange({ target: { checked: false } });
  });
  await savePermissions(card);
  const [body] = permissionBodies(card);
  assert.ok(body, '保存必须调用权限 API');
  assert.equal('allowedSessionIds' in body!, false, '未编辑会话时不得提交 allowedSessionIds');
  assert.equal('disabledSessions' in body!, false, '未编辑会话时不得覆盖并发更新的禁用集合');
});

test('saving an SSH-only change omits allowedSessionIds', async (t) => {
  const card = await mountPermissionsCard(t, {
    '/gateway/api/permissions': () => Response.json({ ok: true }),
  }, {
    '/gateway/api/overview': subuserOverview(['sess-1']),
    '/api/dsh-passwords/workspaces': permissionWorkspaces,
  });
  const sshLabel = card.renderer.root.findAllByType('label')
    .find((label) => label.children.some((child) => child === 'permsSsh'));
  assert.ok(sshLabel, 'SSH 权限开关必须渲染');
  await act(async () => {
    sshLabel!.findByType('input').props.onChange({ target: { checked: true } });
  });
  await savePermissions(card);
  const [body] = permissionBodies(card);
  assert.ok(body);
  assert.equal(body!.allowSsh, true);
  for (const field of ['allowedFolders', 'hourlyTokenLimit', 'dailyMinutesLimit', 'sandboxMode', 'banned', 'allowedModels']) {
    assert.equal(field in body!, false, `仅修改 SSH 时不得提交陈旧的 ${field}`);
  }
  assert.equal('allowedSessionIds' in body!, false, '未编辑会话时不得提交 allowedSessionIds');
  assert.equal('disabledSessions' in body!, false, '未编辑会话时不得覆盖并发更新的禁用集合');
});

test('saving after toggling a session submits the session allowlist', async (t) => {
  const card = await mountPermissionsCard(t, {
    '/gateway/api/permissions': () => Response.json({ ok: true }),
  }, {
    '/gateway/api/overview': subuserOverview([]),
    '/api/dsh-passwords/workspaces': permissionWorkspaces,
  });
  const checkbox = sessionCheckbox(card);
  assert.equal(checkbox.props.checked, false);
  await act(async () => {
    checkbox.props.onChange({ target: { checked: true } });
  });
  await savePermissions(card);
  const [body] = permissionBodies(card);
  assert.ok(body);
  assert.deepEqual(body!.allowedSessionIds, ['sess-1']);
});

for (const [code, notice] of [
  ['SESSION_GRANTS_CONFLICT', 'permsSessionConflict'],
  ['PERMISSIONS_CONFLICT', 'permsStateConflict'],
] as const) {
  test(`${code} rebases the current grant and the next save omits session fields`, async (t) => {
    let saves = 0;
    const card = await mountPermissionsCard(t, {
      '/gateway/api/permissions': () => {
        saves += 1;
        return saves === 1
          ? Response.json({ ok: false, code, error: 'conflict', allowedSessionIds: ['sess-1'] }, { status: 409 })
          : Response.json({ ok: true, allowedSessionIds: ['sess-1'], disabledSessions: [] });
      },
    }, {
      '/gateway/api/overview': subuserOverview(['sess-1']),
      '/api/dsh-passwords/workspaces': permissionWorkspaces,
    });
    const checkbox = sessionCheckbox(card);
    await act(async () => { checkbox.props.onChange({ target: { checked: false } }); });
    await savePermissions(card);
    assert.match(card.text(), new RegExp(notice));
    assert.equal(sessionCheckbox(card).props.checked, true, '最新服务端 grant 应恢复为已勾选');
    await savePermissions(card);
    const bodies = permissionBodies(card);
    assert.equal('allowedSessionIds' in bodies[1]!, false);
    assert.equal('disabledSessions' in bodies[1]!, false);
  });
}

test('sandbox-revoked session grants are removed from the draft and reported inline', async (t) => {
  let overviewCalls = 0;
  const card = await mountPermissionsCard(t, {
    '/gateway/api/permissions': () => Response.json({
      ok: true,
      allowedSessionIds: [],
      disabledSessions: [],
      sandboxRevokedSessionIds: ['sess-1'],
    }),
    '/gateway/api/overview': () => Response.json(subuserOverview(overviewCalls++ === 0 ? ['sess-1'] : [])),
  }, {
    '/api/dsh-passwords/workspaces': permissionWorkspaces,
  });
  await savePermissions(card);
  await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
  assert.equal(sessionCheckbox(card).props.checked, false);
  assert.match(card.text(), /permsSandboxRevoked/);
});

test('saving after revoking every session still submits an explicit empty allowlist', async (t) => {
  const card = await mountPermissionsCard(t, {
    '/gateway/api/permissions': () => Response.json({ ok: true }),
  }, {
    '/gateway/api/overview': subuserOverview(['sess-1']),
    '/api/dsh-passwords/workspaces': permissionWorkspaces,
  });
  const checkbox = sessionCheckbox(card);
  assert.equal(checkbox.props.checked, true);
  await act(async () => {
    checkbox.props.onChange({ target: { checked: false } });
  });
  await savePermissions(card);
  const [body] = permissionBodies(card);
  assert.ok(body);
  assert.deepEqual(body!.allowedSessionIds, [], '显式取消全部会话仍须提交 []（fail-closed）');
});

test('the session touch marker resets after a successful save', async (t) => {
  const card = await mountPermissionsCard(t, {
    '/gateway/api/permissions': () => Response.json({ ok: true }),
  }, {
    '/gateway/api/overview': subuserOverview([]),
    '/api/dsh-passwords/workspaces': permissionWorkspaces,
  });
  const checkbox = sessionCheckbox(card);
  await act(async () => {
    checkbox.props.onChange({ target: { checked: true } });
  });
  await savePermissions(card);

  const sshLabel = card.renderer.root.findAllByType('label')
    .find((label) => label.children.some((child) => child === 'permsSsh'));
  assert.ok(sshLabel);
  await act(async () => {
    sshLabel!.findByType('input').props.onChange({ target: { checked: true } });
  });
  await savePermissions(card);

  const bodies = permissionBodies(card);
  assert.equal(bodies.length, 2, '两次保存都必须调用权限 API');
  assert.deepEqual(bodies[0].allowedSessionIds, ['sess-1']);
  assert.equal('allowedSessionIds' in bodies[1], false, '保存成功后未再编辑会话则不再提交集合');
});

test('refresh during a dirty draft preserves local session edits', async (t) => {
  const card = await mountPermissionsCard(t, {
    '/gateway/api/permissions': () => Response.json({ ok: true }),
  }, {
    '/gateway/api/overview': subuserOverview([]),
    '/api/dsh-passwords/workspaces': permissionWorkspaces,
  });
  const checkbox = sessionCheckbox(card);
  await act(async () => {
    checkbox.props.onChange({ target: { checked: true } });
  });
  await card.refresh();
  assert.equal(sessionCheckbox(card).props.checked, true, '刷新不得覆盖未保存的会话编辑');
  await savePermissions(card);
  const [body] = permissionBodies(card);
  assert.ok(body);
  assert.deepEqual(body!.allowedSessionIds, ['sess-1']);
});

test('pinned deployments expose no automatic update controls or requests', async (t) => {
  const card = await mountCard(t);
  assert.equal(card.renderer.root.findAllByProps({ className: 'dshpw-btn dshpw-update-apply' }).length, 0);
  assert.equal(card.requests.some(({ input }) => input.includes('/update/')), false);
});
