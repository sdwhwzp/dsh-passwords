// dsh-passwords 设置卡片：可折叠（与官方 PluginCard 同形态：header 按钮 +
// aria-expanded + 展开才渲染 body）。内容：
//   - 远程设置补丁：状态（所有用户可见）+ "重载补丁"按钮（仅主用户；F-02）
//   - 用户管理：改密/改名/子用户分配（主用户 admin 可管理所有，子用户只能改自己）
// 数据面：/api/dsh-passwords/*（网关注入的 JWT cookie 鉴权）。
//
// 语言：卡片词典注册在 locale 命名空间 'dshpw'（见 locales.ts），文字跟随
// dsh 设置里的语言（Settings → General → Language）。t seat 由注册时的
// `locale: 'dshpw'` 声明注入。
import { createElement as h, useEffect, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

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
}

export interface PatchState {
  settingsHostMode: boolean;
  whitelist: boolean;
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

  const refresh = () => {
    api<StateData>('/api/dsh-passwords/state')
      .then((d) => {
        setData(d);
        setError('');
        if (d.me?.role === 'admin') {
          api<PermOverview>('/gateway/api/overview')
            .then((o) => {
              setOverview(o);
              // 只初始化新出现的用户 draft，已存在的本地编辑（admin 正在改的权限/限额）保留
              setPermDrafts((prev) => {
                const drafts: Record<number, PermDraft> = { ...prev };
                for (const u of o.users) {
                  if (u.role === 'user' && !(u.id in drafts)) {
                    drafts[u.id] = {
                      folders: [...(u.permissions.allowedFolders ?? [])],
                      token: u.permissions.hourlyTokenLimit === null ? '' : String(u.permissions.hourlyTokenLimit),
                      minutes: u.permissions.dailyMinutesLimit === null ? '' : String(u.permissions.dailyMinutesLimit),
                      upload: u.permissions.allowUpload,
                      git: u.permissions.allowGitDownload,
                      banned: u.permissions.banned,
                      sandbox: u.permissions.sandboxMode ?? '',
                    };
                  }
                }
                return drafts;
              });
              api<{ workspaces: Array<{ path: string; title: string }> }>('/api/dsh-passwords/workspaces')
                .then((r) => setWorkspaces(r.workspaces ?? []))
                .catch(() => setWorkspaces([]));
            })
            .catch(() => setOverview(null));
        }
      })
      .catch((e) => setError(errText(e, trErr)));
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

  const run = async (fn: () => Promise<void>, okMessage: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      setNotice(okMessage);
      refresh();
    } catch (e) {
      setError(errText(e, trErr));
    } finally {
      setBusy(false);
    }
  };

  /** 重载补丁（仅主用户：服务端 F-02 限 admin + 10 分钟冷却；子用户不显示按钮） */
  const reloadPatch = () => {
    void run(async () => {
      await api('/api/dsh-passwords/patch/reload', {});
      // 给网关留出应用补丁 + 重启 dsh 的时间，再刷新页面拿到新代码
      window.setTimeout(() => {
        window.location.reload();
      }, 6000);
    }, t('reloading'));
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
    void run(
      () => api('/api/dsh-passwords/username', { target: nameTarget || me, username: nameNew }),
      t('nameChanged'),
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
    setPermDrafts((prev) => ({ ...prev, [userId]: { ...prev[userId], ...patch } }));
  };

  const savePermissions = (userId: number) => {
    const d = permDrafts[userId];
    if (!d) return;
    // 非法/小数/负数输入不能静默转 null（=不限）：校验后给出提示
    const tokenNum = d.token.trim() === '' ? null : Number(d.token);
    const minutesNum = d.minutes.trim() === '' ? null : Number(d.minutes);
    if (tokenNum !== null && (!Number.isInteger(tokenNum) || tokenNum < 0)) {
      setError(t('err.INVALID'));
      return;
    }
    if (minutesNum !== null && (!Number.isInteger(minutesNum) || minutesNum < 0)) {
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

  const patchOk = patchState !== null && patchState.settingsHostMode && patchState.whitelist;
  const patchText =
    patchState === null ? t('patchUnknown') : patchOk ? t('patchOk') : t('patchBad');

  const body = h(
    'div',
    { className: 'dshpw-body' },
    // ── 当前身份（原折叠头里的账号信息，独立分区后直接展示） ──
    h(
      'div',
      { className: 'dshpw-row' },
      h('span', { className: 'dshpw-label', style: { marginBottom: 0 } }, t('desc'), ' '),
      h('strong', null, me || '—'),
      isAdmin
        ? h('span', { className: 'dshpw-badge admin' }, t('owner'))
        : h('span', { className: 'dshpw-badge' }, t('subuser')),
    ),
    // ── 远程设置：状态 + 重载 ──
    h(
      'div',
      { className: 'dshpw-section' },
      h('span', { className: 'dshpw-label' }, t('patch')),
      h(
        'div',
        { className: 'dshpw-row' },
        h('span', { className: patchOk ? 'dshpw-ok' : 'dshpw-error' }, patchText),
        // F-02：重载补丁会重启 dsh 网页服务，仅主用户可触发；子用户只读状态
        isAdmin &&
          h('button', { className: 'dshpw-btn', disabled: busy, onClick: reloadPatch }, t('reloadPatch')),
      ),
      h('div', { className: 'dshpw-hint' }, t('patchHint1'), ' ', t('patchHint2')),
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
          autoComplete: 'current-password',
          placeholder: t('currentPwPh'),
          value: pwCurrent,
          onChange: (e: { target: { value: string } }) => setPwCurrent(e.target.value),
        }),
      h('input', {
        className: 'dshpw-input',
        type: 'password',
        autoComplete: 'new-password',
        placeholder: t('newPwPh'),
        value: pwNew,
        onChange: (e: { target: { value: string } }) => setPwNew(e.target.value),
      }),
      h('input', {
        className: 'dshpw-input',
        type: 'password',
        autoComplete: 'new-password',
        placeholder: t('confirmPwPh'),
        value: pwConfirm,
        onChange: (e: { target: { value: string } }) => setPwConfirm(e.target.value),
      }),
      h(
        'div',
        { className: 'dshpw-row' },
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
        placeholder: t('newNamePh'),
        value: nameNew,
        onChange: (e: { target: { value: string } }) => setNameNew(e.target.value),
      }),
      h(
        'div',
        { className: 'dshpw-row' },
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
          { className: 'dshpw-row' },
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
                  type: 'number',
                  min: 0,
                  placeholder: t('permsToken'),
                  value: d.token,
                  onChange: (e: { target: { value: string } }) => setDraft(u.id, { token: e.target.value }),
                }),
                h('input', {
                  className: 'dshpw-input',
                  type: 'number',
                  min: 0,
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
                { className: 'dshpw-row' },
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
