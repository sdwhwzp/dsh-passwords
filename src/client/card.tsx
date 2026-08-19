// dsh-passwords 设置卡片：内容平铺展示（独立 settings.section 分区，不再折叠）。
// 内容：
//   - 当前身份（账号 + 角色徽章）
//   - 远程设置补丁：状态（所有用户可见）+ "重载补丁"按钮（仅主用户；F-02）
//   - 用户管理：改密/改名/子用户分配（主用户 admin 可管理所有，子用户只能改自己）
// 数据面：/api/dsh-passwords/*（网关注入的 JWT cookie 鉴权）。
//
// 语言：卡片词典注册在 locale 命名空间 'dshpw'（见 locales.ts），文字跟随
// dsh 设置里的语言（Settings → General → Language）。t seat 由注册时的
// `locale: 'dshpw'` 声明注入。
import { createElement as h, useEffect, useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { publishChatEntryChanged } from './events';

export interface UserInfo {
  id: number;
  username: string;
  role: 'admin' | 'user';
  created_at: string;
  last_login_at: string | null;
}

export interface StateData {
  me: { username: string; role: 'admin' | 'user' };
  users: UserInfo[];
  /** 当前账号的聊天入口显示偏好；旧服务端未返回时默认开启。 */
  chatEnabled?: boolean;
}

export interface PatchState {
  settingsHostMode: boolean;
  whitelist: boolean;
  workspaceSearch: boolean;
}

export interface PermOverview {
  me: { id: number; username: string; role: 'admin' | 'user' };
  users: Array<{
    id: number;
    username: string;
    role: 'admin' | 'user';
    permissions: {
      allowedFolders: string[];
      hourlyTokenLimit: number | null;
      dailyMinutesLimit: number | null;
      allowUpload: boolean;
      allowGitDownload: boolean;
      banned: boolean;
      sandboxMode: string | null;
    };
    usage: {
      day: string;
      activeSeconds: number;
      hourlyTokens: number;
      firstSeenAt: string | null;
      lastActiveAt: string | null;
    } | null;
  }>;
}

interface PermDraft {
  folders: string[];
  token: string;
  minutes: string;
  upload: boolean;
  git: boolean;
  banned: boolean;
  sandbox: string;
}

/** 与 host 侧一致的最小密码策略（本机提示用，最终以服务端校验为准） */
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

/**
 * 严格非负整数解析（限额输入用）：
 *   空串 → null（=不限）；纯数字 → 整数；其余（1e3/0x10/12.5/-1/超大值）→ NaN（非法）。
 * 之前用 Number('1e3')=1000 / Number('0x10')=16 会静默接受科学计数与十六进制。
 * Number.isSafeInteger 同时封顶 2^53-1，低于 SQLite 64 位上限，防精度失真。
 */
export function parseLimit(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return Number.NaN;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : Number.NaN;
}

/** 本地时间格式化（ISO → 可读的 YYYY-MM-DD HH:mm） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type ApiError = { error?: string; code?: string };

function api<T>(path: string, body?: unknown): Promise<T> {
  return fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    const data = (await res.json().catch(() => ({}))) as ApiError & T;
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      // 携带服务端稳定错误码：errText 优先按码本地化（跟随 dsh 语言）
      (err as Error & { code?: string }).code = data.code;
      throw err;
    }
    return data as T;
  });
}

/** 错误文案：有 code 走本地词典，未知 code / 无 code 回退服务端文案 */
function errText(error: unknown, tr: (key: string, params?: Record<string, string | number>) => string): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    if (code) {
      const key = `err.${code}`;
      const localized = tr(key);
      if (localized !== key) return localized;
    }
    return error.message;
  }
  return tr('opFailed');
}

export function DshPasswordsCard(props: PropsLocale<'dshpw'>) {
  const t = props.t;
  // errText 需要接收动态 key（err.<code>），而 dshpw 词典 t 的 key 是受限联合类型：
  // 这里包一层宽松签名适配器（运行时行为不变）
  const trErr = (key: string, params?: Record<string, string | number>) => t(key as never, params);

  const [data, setData] = useState<StateData | null>(null);
  const [patchState, setPatchState] = useState<PatchState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // 改密表单
  const [pwTarget, setPwTarget] = useState('');
  // F-06：自助改密需验证当前密码（主用户重置他人时无需）
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  // 改名表单
  const [nameTarget, setNameTarget] = useState('');
  const [nameNew, setNameNew] = useState('');
  // 新增子用户表单
  const [addName, setAddName] = useState('');
  const [addPw, setAddPw] = useState('');
  // 权限管理（仅主用户）
  const [overview, setOverview] = useState<PermOverview | null>(null);
  const [permDrafts, setPermDrafts] = useState<Record<number, PermDraft>>({});
  const [workspaces, setWorkspaces] = useState<Array<{ path: string; title: string }>>([]);
  // 正在编辑中的子用户草稿：dirty 时 30s 自动刷新不覆盖本地未保存的修改
  const dirtyUsersRef = useRef<Set<number>>(new Set());
  // 刷新 in-flight 守卫：慢网络下 30s 定时 + 操作后手动 refresh 可能重叠，
  // 上一轮未返回时跳过本轮（3 个轻量 API，重叠只会无益重发）
  const refreshingRef = useRef(false);

  const refresh = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    // in-flight 守卫覆盖整个 state→overview→workspaces 链（而非只覆盖 patch/status）：
    // 否则慢网络下 overview 未返回时守卫已被 patch/status 提前释放，30s 定时又会叠一轮。
    api<StateData>('/api/dsh-passwords/state')
      .then((d) => {
        setData(d);
        setError('');
        if (d.me?.role !== 'admin') return undefined;
        return api<PermOverview>('/gateway/api/overview')
          .then((o) => {
            setOverview(o);
            // 草稿同步：新用户初始化；未在编辑（dirty）中的草稿用服务端最新值覆盖
            // （注释承诺的“主用户在别处修改后页面自动同步最新状态”真正生效）；
            // 已删除的用户清草稿；正在编辑的用户保留本地未保存修改。
            setPermDrafts((prev) => {
              const drafts: Record<number, PermDraft> = { ...prev };
              const live = new Set<number>();
              for (const u of o.users) {
                if (u.role !== 'user') continue;
                live.add(u.id);
                const fresh: PermDraft = {
                  folders: [...(u.permissions.allowedFolders ?? [])],
                  token: u.permissions.hourlyTokenLimit === null ? '' : String(u.permissions.hourlyTokenLimit),
                  minutes: u.permissions.dailyMinutesLimit === null ? '' : String(u.permissions.dailyMinutesLimit),
                  upload: u.permissions.allowUpload,
                  git: u.permissions.allowGitDownload,
                  banned: u.permissions.banned,
                  sandbox: u.permissions.sandboxMode ?? '',
                };
                if (!(u.id in drafts) || !dirtyUsersRef.current.has(u.id)) {
                  drafts[u.id] = fresh;
                }
              }
              for (const id of Object.keys(drafts)) {
                if (!live.has(Number(id))) delete drafts[Number(id)];
              }
              return drafts;
            });
            return api<{ workspaces: Array<{ path: string; title: string }> }>('/api/dsh-passwords/workspaces')
              .then((r) => setWorkspaces(r.workspaces ?? []))
              .catch(() => setWorkspaces([]));
          })
          .catch(() => setOverview(null));
      })
      .catch((e) => setError(errText(e, trErr)))
      .finally(() => {
        refreshingRef.current = false;
      });
    // patch 状态独立于主链（轻量 + 失败只影响状态展示）
    api<{ status: PatchState | null }>('/api/dsh-passwords/patch/status')
      .then((r) => setPatchState(r.status))
      .catch(() => setPatchState(null));
  };

  // 密码门已是独立设置分区页（settings.section），无需折叠：
  // 进入分区即渲染全部内容，并每 30 秒自动刷新（主用户在别处修改子用户
  // 权限/工作区后，页面自动同步最新状态）
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const isAdmin = data?.me?.role === 'admin';
  const me = data?.me?.username ?? '';
  const chatEnabled = data?.chatEnabled ?? true;

  const run = async (fn: () => Promise<void>, okMessage: string, afterSuccess?: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      // 先显示成功/进行中提示：重载补丁的恢复轮询可能持续数秒，不能等到页面
      // 即将刷新才反馈；聊天开关也能立即给出确认。
      setNotice(okMessage);
      if (afterSuccess) {
        await afterSuccess();
        return;
      }
      refresh();
    } catch (e) {
      setError(errText(e, trErr));
    } finally {
      setBusy(false);
    }
  };

  /** 重载补丁（仅主用户）：发送请求后轮询网关恢复，不固定等待 6 秒。 */
  const reloadPatch = () => {
    void run(
      () => api('/api/dsh-passwords/patch/reload', {}),
      t('reloading'),
      async () => {
        // 给 apply + 服务重启一个最短启动窗口；之后每 400ms 探测一次，
        // 服务恢复即刷新，网络慢时不会过早刷新到旧页面，也不会固定卡 6 秒。
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            // 探测真实 dsh 上游页面而非网关自有 overview：只有网页服务恢复，
            // 这里才会返回成功，避免网关本身仍在但 dsh 还没重启完就刷新旧插件。
            const response = await fetch(`/?reload=${String(Date.now())}`, {
              cache: 'no-store',
              credentials: 'same-origin',
            });
            if (response.ok) {
              window.location.reload();
              return;
            }
          } catch {
            // dsh 网页服务重启窗口：继续探测
          }
          await new Promise((resolve) => window.setTimeout(resolve, 400));
        }
        throw new Error(t('patchReloadTimeout'));
      },
    );
  };

  /** 聊天入口按账号跨设备同步；保存成功后立即通知 overlay，无需刷新页面。 */
  const toggleChatEntry = () => {
    const enabled = !chatEnabled;
    void run(
      () => api('/api/dsh-passwords/chat-enabled', { enabled }),
      t('chatToggleSaved'),
      async () => {
        publishChatEntryChanged(enabled);
        setData((prev) => (prev ? { ...prev, chatEnabled: enabled } : prev));
      },
    );
  };

  const changePassword = () => {
    if (pwNew !== pwConfirm) return setError(t('pwMismatch'));
    if (!PASSWORD_RE.test(pwNew)) return setError(t('pwPolicy'));
    const target = pwTarget || me;
    const isSelf = target === me;
    // F-06：改自己必须填当前密码（服务端也会校验，这里前端先拦空值）
    if (isSelf && pwCurrent === '') return setError(t('needCurrentPw'));
    void run(
      () =>
        api('/api/dsh-passwords/password', {
          target,
          password: pwNew,
          ...(isSelf ? { currentPassword: pwCurrent } : {}),
        }),
      t('pwChanged'),
    );
  };

  const rename = () => {
    if (!USERNAME_RE.test(nameNew)) return setError(t('namePolicy'));
    const target = nameTarget || me;
    const isSelf = target === me;
    void run(
      () => api('/api/dsh-passwords/username', { target, username: nameNew }),
      isSelf ? t('nameChangedSelf') : t('nameChanged'),
      isSelf
        ? async () => {
            // 改名后旧 JWT 已按 credential_version 失效：主动 POST logout 清理服务端
            // 吊销状态，再跳登录页；即使注销请求因重启/网络失败，也必须跳走，
            // 避免用户停留在一个注定失效的设置页。
            await fetch('/gateway/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
            window.location.assign('/gateway/login');
          }
        : undefined,
    );
  };

  const addSubUser = () => {
    if (!USERNAME_RE.test(addName)) return setError(t('namePolicy'));
    if (!PASSWORD_RE.test(addPw)) return setError(t('pwPolicy'));
    void run(() => api('/api/dsh-passwords/users', { username: addName, password: addPw }), t('subCreated'));
  };

  const removeUser = (username: string) => {
    if (!window.confirm(t('delConfirm', { username }))) return;
    void run(() => api('/api/dsh-passwords/users/remove', { target: username }), t('deleted'));
  };

  // 权限草稿更新 + 保存（仅主用户）
  const setDraft = (userId: number, patch: Partial<PermDraft>) => {
    dirtyUsersRef.current.add(userId);
    setPermDrafts((prev) => ({ ...prev, [userId]: { ...prev[userId], ...patch } }));
  };

  const savePermissions = (userId: number) => {
    const d = permDrafts[userId];
    if (!d) return;
    // 非法输入不能静默转 null（=不限）：parseLimit 拒绝小数/负数/科学计数/十六进制/超大值
    const tokenNum = parseLimit(d.token);
    const minutesNum = parseLimit(d.minutes);
    if (tokenNum !== null && !Number.isInteger(tokenNum)) {
      setError(t('err.INVALID'));
      return;
    }
    if (minutesNum !== null && !Number.isInteger(minutesNum)) {
      setError(t('err.INVALID'));
      return;
    }
    void run(
      () =>
        api('/gateway/api/permissions', {
          userId,
          allowedFolders: d.folders,
          hourlyTokenLimit: tokenNum,
          dailyMinutesLimit: minutesNum,
          allowUpload: d.upload,
          allowGitDownload: d.git,
          banned: d.banned,
          sandboxMode: d.sandbox === '' ? null : d.sandbox,
        }).then(() => {
          // 保存成功：草稿与服务端一致，解除 dirty（后续 30s 刷新可覆盖）
          dirtyUsersRef.current.delete(userId);
        }),
      t('permsSaved'),
    );
  };

  // 管理员的目标用户下拉：列出全部用户（默认自己，即当前账号在列表中的那一项）
  const targetSelect = (value: string, onChange: (v: string) => void) =>
    isAdmin
      ? h(
          'select',
          {
            className: 'dshpw-input',
            value: value || me,
            onChange: (e: { target: { value: string } }) => onChange(e.target.value),
          },
          ...(data?.users ?? []).map((u) =>
            h(
              'option',
              { key: u.id, value: u.username },
              `${u.username}（${u.role === 'admin' ? t('owner') : t('subuser')}）`,
            ),
          ),
        )
      : null;

  const patchOk =
    patchState !== null &&
    patchState.settingsHostMode &&
    patchState.whitelist &&
    patchState.workspaceSearch;
  const patchText =
    patchState === null ? t('patchUnknown') : patchOk ? t('patchOk') : t('patchBad');

  const body = h(
    'div',
    { className: 'dshpw-body' },
    // ── 当前身份（原折叠头里的账号信息，独立分区后直接展示） ──
    h(
      'div',
      { className: 'dshpw-row' },
      h('span', null, t('identity')),
      h('strong', null, me || '—'),
      isAdmin
        ? h('span', { className: 'dshpw-badge admin' }, t('owner'))
        : h('span', { className: 'dshpw-badge' }, t('subuser')),
    ),
    // ── 聊天入口：按当前账号跨设备同步的显示偏好 ──
    h(
      'div',
      { className: 'dshpw-section dshpw-preference' },
      h('div', { className: 'dshpw-section-head' }, h('span', { className: 'dshpw-label' }, t('chatToggle'))),
      h(
        'label',
        { className: 'dshpw-switch' },
        h(
          'span',
          { className: 'dshpw-switch-copy' },
          h('strong', null, t('chatToggleDesc')),
          h('small', null, t('chatToggleHint')),
        ),
        h(
          'span',
          { className: 'dshpw-switch-control' },
          h('input', {
            type: 'checkbox',
            checked: chatEnabled,
            disabled: busy || data === null,
            onChange: toggleChatEntry,
            'aria-label': t('chatToggleDesc'),
          }),
          h('span', { className: 'dshpw-switch-track', 'aria-hidden': 'true' }, h('span', { className: 'dshpw-switch-thumb' })),
        ),
      ),
    ),
    // ── 远程设置：状态 + 重载 ──
    h(
      'div',
      { className: 'dshpw-section' },
      h(
        'div',
        { className: 'dshpw-section-head' },
        h('span', { className: 'dshpw-label' }, t('patch')),
        h('span', { className: patchOk ? 'dshpw-ok' : 'dshpw-error' }, patchText),
      ),
      h(
        'div',
        { className: 'dshpw-action-row' },
        h('span', { className: 'dshpw-hint dshpw-action-copy' }, t('patchHint1')),
        // F-02：重载补丁会重启 dsh 网页服务，仅主用户可触发；子用户只读状态
        isAdmin &&
          h('button', { className: 'dshpw-btn', disabled: busy, onClick: reloadPatch }, t('reloadPatch')),
      ),
      h('div', { className: 'dshpw-hint' }, t('patchHint2')),
    ),

    // ── 修改密码 ──
    h(
      'div',
      { className: 'dshpw-section' },
      h('span', { className: 'dshpw-label' }, t('chgPw')),
      isAdmin && h('span', { className: 'dshpw-hint' }, t('targetUser')),
      targetSelect(pwTarget, setPwTarget),
      // F-06：改自己需先验证当前密码（管理员改他人无需）
      (pwTarget === '' || pwTarget === me) &&
        h('input', {
          className: 'dshpw-input',
          type: 'password',
          // 使用标准 current-password 语义，让密码管理器能正确识别当前密码；
          // 侧栏搜索框的防自动填充由 dsh 补丁单独处理，不再牺牲这里的兼容性。
          autoComplete: 'current-password',
          name: 'current-password',
          placeholder: t('currentPwPh'),
          value: pwCurrent,
          onChange: (e: { target: { value: string } }) => setPwCurrent(e.target.value),
        }),
      h('input', {
        className: 'dshpw-input',
        type: 'password',
        autoComplete: 'new-password',
        name: 'new-password',
        placeholder: t('newPwPh'),
        value: pwNew,
        onChange: (e: { target: { value: string } }) => setPwNew(e.target.value),
      }),
      h('input', {
        className: 'dshpw-input',
        type: 'password',
        autoComplete: 'new-password',
        name: 'confirm-password',
        placeholder: t('confirmPwPh'),
        value: pwConfirm,
        onChange: (e: { target: { value: string } }) => setPwConfirm(e.target.value),
      }),
      h(
        'div',
        { className: 'dshpw-action-row dshpw-form-actions' },
        h('button', { className: 'dshpw-btn', disabled: busy, onClick: changePassword }, t('savePw')),
      ),
    ),

    // ── 修改用户名 ──
    h(
      'div',
      { className: 'dshpw-section' },
      h('span', { className: 'dshpw-label' }, t('chgName')),
      isAdmin && h('span', { className: 'dshpw-hint' }, t('targetUser')),
      targetSelect(nameTarget, setNameTarget),
      h('input', {
        className: 'dshpw-input',
        autoComplete: 'off',
        name: 'dshpw-newname',
        placeholder: t('newNamePh'),
        value: nameNew,
        onChange: (e: { target: { value: string } }) => setNameNew(e.target.value),
      }),
      h(
        'div',
        { className: 'dshpw-action-row dshpw-form-actions' },
        h('button', { className: 'dshpw-btn', disabled: busy, onClick: rename }, t('saveName')),
      ),
      h('div', { className: 'dshpw-hint' }, t('nameHint')),
    ),

    // ── 子用户管理（仅主用户） ──
    isAdmin &&
      h(
        'div',
        { className: 'dshpw-section' },
        h('span', { className: 'dshpw-label' }, t('subusers')),
        ...(data?.users ?? []).map((u) =>
          h(
            'div',
            { className: 'dshpw-user', key: u.id },
            h(
              'span',
              null,
              u.username,
              u.role === 'admin'
                ? h('span', { className: 'dshpw-badge admin' }, t('owner'))
                : h('span', { className: 'dshpw-badge' }, t('subuser')),
              u.last_login_at ? h('span', { className: 'dshpw-hint' }, t('lastLogin', { time: fmtTime(u.last_login_at) })) : null,
            ),
            u.username !== me &&
              h('button', { className: 'dshpw-btn danger', disabled: busy, onClick: () => removeUser(u.username) }, t('remove')),
          ),
        ),
        h('input', {
          className: 'dshpw-input',
          autoComplete: 'off',
          name: 'dshpw-subname',
          placeholder: t('subNamePh'),
          value: addName,
          onChange: (e: { target: { value: string } }) => setAddName(e.target.value),
        }),
        h('input', {
          className: 'dshpw-input',
          type: 'password',
          autoComplete: 'new-password',
          placeholder: t('subPwPh'),
          value: addPw,
          onChange: (e: { target: { value: string } }) => setAddPw(e.target.value),
        }),
        h(
          'div',
          { className: 'dshpw-action-row dshpw-form-actions' },
          h('button', { className: 'dshpw-btn', disabled: busy, onClick: addSubUser }, t('addSub')),
        ),
        h('div', { className: 'dshpw-hint' }, t('subHint')),
      ),

    // ── 子用户权限（仅主用户） ──
    isAdmin &&
      overview !== null &&
      h(
        'div',
        { className: 'dshpw-section' },
        h('span', { className: 'dshpw-label' }, t('perms')),
        h('div', { className: 'dshpw-hint' }, t('permsHint')),
        ...overview.users
          .filter((u) => u.role === 'user')
          .map((u) => {
            const d = permDrafts[u.id];
            if (!d) return null;
            return h(
              'div',
              { className: 'dshpw-perm', key: u.id },
              h(
                'div',
                { className: 'dshpw-perm-head' },
                h('strong', null, u.username),
                u.usage
                  ? h(
                      'span',
                      { className: 'dshpw-hint' },
                      `${t('usageTime')} ${Math.round(u.usage.activeSeconds / 60)}m · ${t('usageTokens')} ${u.usage.hourlyTokens}`,
                    )
                  : null,
                u.permissions.banned ? h('span', { className: 'dshpw-badge' }, t('banned')) : null,
              ),
              h(
                'select',
                {
                  className: 'dshpw-input',
                  value: d.folders[0] ?? '',
                  'aria-label': t('permsFolders'),
                  title: d.folders.join('\n'),
                  onChange: (e: { target: { value: string } }) =>
                    setDraft(u.id, { folders: e.target.value === '' ? [] : [e.target.value] }),
                },
                h('option', { value: '' }, t('permsAll')),
                h('option', { value: '__deny__' }, t('permsDenyAll')),
                ...((() => {
                  const paths = Array.from(new Set([...workspaces.map((w) => w.path), ...d.folders]));
                  return paths
                    .filter((p) => p !== '__deny__')
                    .map((p) => {
                      const ws = workspaces.find((w) => w.path === p);
                      return h('option', { key: p, value: p }, ws?.title || p);
                    });
                })()),
              ),
              d.folders.length > 1
                ? h('div', { className: 'dshpw-hint' }, t('permsFoldersMulti', { n: String(d.folders.length) }))
                : null,
              h(
                'select',
                {
                  className: 'dshpw-input',
                  value: d.sandbox,
                  'aria-label': t('permsSandbox'),
                  onChange: (e: { target: { value: string } }) => setDraft(u.id, { sandbox: e.target.value }),
                },
                h('option', { value: '' }, t('sandboxNone')),
                h('option', { value: 'read-only' }, t('sandboxReadOnly')),
                h('option', { value: 'workspace-write' }, t('sandboxWorkspace')),
                h('option', { value: 'danger-full-access' }, t('sandboxFull')),
              ),
              h(
                'div',
                { className: 'dshpw-row' },
                h('input', {
                  className: 'dshpw-input',
                  type: 'text',
                  inputMode: 'numeric',
                  pattern: '[0-9]*',
                  autoComplete: 'off',
                  name: 'dshpw-tokenlimit',
                  placeholder: t('permsToken'),
                  value: d.token,
                  onChange: (e: { target: { value: string } }) => setDraft(u.id, { token: e.target.value }),
                }),
                h('input', {
                  className: 'dshpw-input',
                  type: 'text',
                  inputMode: 'numeric',
                  pattern: '[0-9]*',
                  autoComplete: 'off',
                  name: 'dshpw-minlimit',
                  placeholder: t('permsMinutes'),
                  value: d.minutes,
                  onChange: (e: { target: { value: string } }) => setDraft(u.id, { minutes: e.target.value }),
                }),
              ),
              h(
                'div',
                { className: 'dshpw-row' },
                h(
                  'label',
                  { className: 'dshpw-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: d.upload,
                    onChange: (e: { target: { checked: boolean } }) => setDraft(u.id, { upload: e.target.checked }),
                  }),
                  t('permsUpload'),
                ),
                h(
                  'label',
                  { className: 'dshpw-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: d.git,
                    onChange: (e: { target: { checked: boolean } }) => setDraft(u.id, { git: e.target.checked }),
                  }),
                  t('permsGit'),
                ),
                h(
                  'label',
                  { className: 'dshpw-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: d.banned,
                    onChange: (e: { target: { checked: boolean } }) => setDraft(u.id, { banned: e.target.checked }),
                  }),
                  t('permsBanned'),
                ),
              ),
              h(
                'div',
                { className: 'dshpw-action-row dshpw-form-actions' },
                h(
                  'button',
                  { className: 'dshpw-btn', disabled: busy, onClick: () => savePermissions(u.id) },
                  t('permsSave'),
                ),
              ),
            );
          }),
      ),

    error && h('div', { className: 'dshpw-error' }, error),
    notice && h('div', { className: 'dshpw-ok' }, notice),
  );

  return h('div', { className: 'dshpw-card' }, body);
}
