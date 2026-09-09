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
import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PropsLocale, Translate } from '@deepseek-ai/dsh-client-ui-slots';
import { publishChatEntryChanged } from './events';
import { submitLogoutNavigation } from './account-logout';
import { LocalWorkspacePanel } from './local-workspace';
import { ManagedFilesPanel } from './managed-files';
import { api } from './api';

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
      monthlyBudgetMicros: number | null;
      allowUpload: boolean;
      allowGitDownload: boolean;
      allowSsh: boolean;
      banned: boolean;
      sandboxMode: string | null;
      disabledSessions: string[];
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
  monthlyBudget: string;
  upload: boolean;
  git: boolean;
  ssh: boolean;
  banned: boolean;
  sandbox: string;
  disabledSessions: string[];
}

/** Validate the patch status response before presenting a healthy state. */
export function readPatchState(response: unknown): PatchState | null {
  if (typeof response !== 'object' || response === null || !('status' in response)) return null;
  const status = response.status;
  if (
    typeof status !== 'object' || status === null ||
    !('settingsHostMode' in status) || typeof status.settingsHostMode !== 'boolean' ||
    !('whitelist' in status) || typeof status.whitelist !== 'boolean' ||
    !('workspaceSearch' in status) || typeof status.workspaceSearch !== 'boolean'
  ) return null;
  return status as PatchState;
}

interface BudgetStatus {
  userId: number;
  month: string;
  usedMicros: number;
  budgetMicros: number | null;
  remainingMicros: number | null;
  ratio: number;
  warning: boolean;
  exhausted: boolean;
}

interface WorkspaceInfo {
  path: string;
  title: string;
  sessions: Array<{ id: string; title: string }>;
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

/** 圆形头像里的首字母；空用户名（数据未到）回退为 '?'。 */
function initial(name: string): string {
  return (name.trim().charAt(0) || '?').toUpperCase();
}

/**
 * 表单字段：标签在输入框上方，完整校验规则作为字段下方的提示行。
 * @param label 字段名（短标签）
 * @param control 输入控件
 * @param hint 字段下方的规则提示；省略则不渲染提示行
 * @param wide 是否占满整行（默认按网格自动分栏）
 * @returns 包裹标签、控件与提示行的 label 元素
 */
function field(label: string, control: ReactNode, hint?: string, wide?: boolean): ReactNode {
  return h(
    'label',
    { className: wide === true ? 'dshpw-field wide' : 'dshpw-field' },
    h('span', { className: 'dshpw-field-label' }, label),
    control,
    hint === undefined ? null : h('span', { className: 'dshpw-field-hint' }, hint),
  );
}

/** 本地时间格式化（ISO → 可读的 YYYY-MM-DD HH:mm） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}



/** 错误文案：有 code 走本地词典，未知 code / 无 code 回退服务端文案。
 *  词典项含占位符（{minutes}/{count} 等）时客户端无参数可填，回退服务端已插值文案。 */
function errText(error: unknown, tr: (key: string, params?: Record<string, string | number>) => string): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    if (code) {
      const key = `err.${code}`;
      const localized = tr(key);
      if (localized !== key && !localized.includes('{')) return localized;
    }
    return error.message;
  }
  return tr('opFailed');
}

interface DshPasswordsCardProps extends PropsLocale<'dshpw'> {
  loadState(): Promise<StateData>;
}

export function DshPasswordsCard(props: DshPasswordsCardProps) {
  const t = props.t;
  // errText 需要接收动态 key（err.<code>），而 dshpw 词典 t 的 key 是受限联合类型：
  // 这里包一层宽松签名适配器（运行时行为不变）
  const trErr: Translate = (key, params) => t(key as never, params);

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
  const [budgets, setBudgets] = useState<Record<number, BudgetStatus>>({});
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  // 正在编辑中的子用户草稿：dirty 时 30s 自动刷新不覆盖本地未保存的修改
  const dirtyUsersRef = useRef<Set<number>>(new Set());
  // dirty 集合的可渲染副本：权限卡片据此显示“未保存”标记（ref 变化不触发重绘）
  const [dirtyUsers, setDirtyUsers] = useState<readonly number[]>([]);
  // 刷新 in-flight 守卫：慢网络下 30s 定时 + 操作后手动 refresh 不重叠。
  // 若刷新期间又有请求，排队在当前响应结束后补跑，避免旧快照覆盖乐观分配结果。
  const refreshingRef = useRef(false);
  const refreshQueuedRef = useRef(false);

  const refresh = () => {
    if (refreshingRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshingRef.current = true;
    // in-flight 守卫覆盖整个 state→overview→workspaces 链（而非只覆盖 patch/status）：
    // 否则慢网络下 overview 未返回时守卫已被 patch/status 提前释放，30s 定时又会叠一轮。
    props.loadState()
      .then((d) => {
        setData(d);
        setError('');
        if (d.me?.role !== 'admin') return undefined;
        return api<PermOverview>('/gateway/api/overview')
          .then((o) => {
            setOverview(o);
            void api<{ budgets: BudgetStatus[] }>('/api/dsh-passwords/budgets')
              .then((result) => setBudgets(Object.fromEntries(result.budgets.map((row) => [row.userId, row]))))
              .catch(() => setBudgets({}));
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
                  monthlyBudget: ((u.permissions.monthlyBudgetMicros ?? 0) / 1_000_000).toFixed(2),
                  upload: u.permissions.allowUpload,
                  git: u.permissions.allowGitDownload,
                  ssh: u.permissions.allowSsh,
                  banned: u.permissions.banned,
                  sandbox: u.permissions.sandboxMode ?? '',
                  disabledSessions: [...(u.permissions.disabledSessions ?? [])],
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
            return api<{ workspaces: WorkspaceInfo[] }>('/api/dsh-passwords/workspaces')
              .then((r) => {
                if (!refreshQueuedRef.current) setWorkspaces(r.workspaces ?? []);
              })
              .catch((e) => {
                if (!refreshQueuedRef.current) {
                  setWorkspaces([]);
                  setError(errText(e, trErr));
                }
              });
          })
          .catch(() => setOverview(null));
      })
      .catch((e) => setError(errText(e, trErr)))
      .finally(() => {
        refreshingRef.current = false;
        if (refreshQueuedRef.current) {
          refreshQueuedRef.current = false;
          refresh();
        }
      });
    // patch 状态独立于主链（轻量 + 失败只影响状态展示）
    api<unknown>('/api/dsh-passwords/patch/status')
      .then((r) => setPatchState(readPatchState(r)))
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

  const run = async (
    fn: () => Promise<unknown>,
    okMessage: string,
    afterSuccess?: () => Promise<void>,
  ) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await fn();
      const customNotice =
        result !== null && typeof result === 'object' && 'notice' in result && typeof result.notice === 'string'
          ? result.notice
          : null;
      setNotice(customNotice ?? okMessage);
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
            submitLogoutNavigation();
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
    setDirtyUsers([...dirtyUsersRef.current]);
    setPermDrafts((prev) => ({ ...prev, [userId]: { ...prev[userId], ...patch } }));
  };

  const enabledFolderSet = (draft: PermDraft): Set<string> => {
    if (draft.folders.includes('__deny__')) return new Set();
    if (draft.folders.length === 0) return new Set(workspaces.map((workspace) => workspace.path));
    return new Set(draft.folders);
  };

  const toggleWorkspace = (userId: number, workspace: WorkspaceInfo, enabled: boolean) => {
    const draft = permDrafts[userId];
    if (!draft) return;
    const enabledFolders = enabledFolderSet(draft);
    if (enabled) enabledFolders.add(workspace.path);
    else enabledFolders.delete(workspace.path);
    const workspaceSessionIds = new Set(workspace.sessions.map((session) => session.id));
    setDraft(userId, {
      folders: enabledFolders.size === 0 ? ['__deny__'] : [...enabledFolders],
      disabledSessions: draft.disabledSessions.filter((id) => !workspaceSessionIds.has(id)),
    });
  };

  const toggleSession = (userId: number, sessionId: string, enabled: boolean) => {
    const draft = permDrafts[userId];
    if (!draft) return;
    const disabled = new Set(draft.disabledSessions);
    if (enabled) disabled.delete(sessionId);
    else disabled.add(sessionId);
    setDraft(userId, { disabledSessions: [...disabled] });
  };

  const savePermissions = (userId: number) => {
    const d = permDrafts[userId];
    if (!d) return;
    // 非法输入不能静默转 null（=不限）：parseLimit 拒绝小数/负数/科学计数/十六进制/超大值
    const tokenNum = parseLimit(d.token);
    const minutesNum = parseLimit(d.minutes);
    if (!/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(d.monthlyBudget.trim())) {
      setError(t('err.INVALID'));
      return;
    }
    if (tokenNum !== null && !Number.isInteger(tokenNum)) {
      setError(t('err.INVALID'));
      return;
    }
    if (minutesNum !== null && !Number.isInteger(minutesNum)) {
      setError(t('err.INVALID'));
      return;
    }
    const enabledFolders = enabledFolderSet(d);
    const liveEnabledSessions = new Set(
      workspaces
        .filter((workspace) => enabledFolders.has(workspace.path))
        .flatMap((workspace) => workspace.sessions.map((session) => session.id)),
    );
    void run(
      () =>
        api('/gateway/api/permissions', {
          userId,
          allowedFolders: d.folders,
          hourlyTokenLimit: tokenNum,
          dailyMinutesLimit: minutesNum,
          monthlyBudgetYuan: d.monthlyBudget.trim(),
          allowUpload: d.upload,
          allowGitDownload: d.git,
          allowSsh: d.ssh,
          banned: d.banned,
          sandboxMode: d.sandbox === '' ? null : d.sandbox,
          disabledSessions: d.disabledSessions.filter((id) => liveEnabledSessions.has(id)),
        }).then(() => {
          // 保存成功：草稿与服务端一致，解除 dirty（后续 30s 刷新可覆盖）
          dirtyUsersRef.current.delete(userId);
          setDirtyUsers([...dirtyUsersRef.current]);
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
    // ── 当前身份（头像 + 账号 + 角色徽章；主用户另附账号总数） ──
    h(
      'div',
      { className: 'dshpw-identity' },
      h('span', { className: 'dshpw-avatar', 'aria-hidden': 'true' }, initial(me)),
      h(
        'span',
        { className: 'dshpw-identity-copy' },
        h('span', { className: 'dshpw-identity-cap' }, t('identity')),
        h(
          'span',
          { className: 'dshpw-identity-name' },
          me || '—',
          isAdmin
            ? h('span', { className: 'dshpw-badge admin' }, t('owner'))
            : h('span', { className: 'dshpw-badge' }, t('subuser')),
        ),
      ),
    ),
    // 操作结果紧跟身份区展示，长表单下方的按钮点击后无需回到页尾查看
    error !== '' && h('div', { className: 'dshpw-banner err', role: 'alert' }, error),
    notice !== '' && h('div', { className: 'dshpw-banner ok', role: 'status' }, notice),
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
    h(LocalWorkspacePanel, {
      t: trErr,
      busy,
      setBusy,
      setError,
      setNotice,
    }),
    data?.me?.role === 'user' && h(ManagedFilesPanel, {
      t: trErr,
      busy,
      setBusy,
      setError,
      setNotice,
    }),
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
      h('div', { className: 'dshpw-section-head' }, h('span', { className: 'dshpw-label' }, t('chgPw'))),
      h(
        'div',
        { className: 'dshpw-fields' },
        isAdmin ? field(t('targetUser'), targetSelect(pwTarget, setPwTarget)) : null,
        // F-06：改自己需先验证当前密码（管理员改他人无需）
        (pwTarget === '' || pwTarget === me)
          ? field(
              t('fieldCurrentPw'),
              h('input', {
                className: 'dshpw-input',
                type: 'password',
                // 使用标准 current-password 语义，让密码管理器能正确识别当前密码；
                // 侧栏搜索框的防自动填充由 dsh 补丁单独处理，不再牺牲这里的兼容性。
                autoComplete: 'current-password',
                name: 'current-password',
                value: pwCurrent,
                onChange: (e: { target: { value: string } }) => setPwCurrent(e.target.value),
              }),
            )
          : null,
        field(
          t('fieldNewPw'),
          h('input', {
            className: 'dshpw-input',
            type: 'password',
            autoComplete: 'new-password',
            name: 'new-password',
            value: pwNew,
            onChange: (e: { target: { value: string } }) => setPwNew(e.target.value),
          }),
          t('pwPolicy'),
        ),
        field(
          t('fieldConfirmPw'),
          h('input', {
            className: 'dshpw-input',
            type: 'password',
            autoComplete: 'new-password',
            name: 'confirm-password',
            value: pwConfirm,
            onChange: (e: { target: { value: string } }) => setPwConfirm(e.target.value),
          }),
        ),
      ),
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
      h('div', { className: 'dshpw-section-head' }, h('span', { className: 'dshpw-label' }, t('chgName'))),
      h(
        'div',
        { className: 'dshpw-fields' },
        isAdmin ? field(t('targetUser'), targetSelect(nameTarget, setNameTarget)) : null,
        field(
          t('fieldNewName'),
          h('input', {
            className: 'dshpw-input',
            autoComplete: 'off',
            name: 'dshpw-newname',
            value: nameNew,
            onChange: (e: { target: { value: string } }) => setNameNew(e.target.value),
          }),
          t('namePolicy'),
        ),
      ),
      h(
        'div',
        { className: 'dshpw-action-row dshpw-form-actions' },
        h('span', { className: 'dshpw-hint dshpw-action-copy' }, t('nameHint')),
        h('button', { className: 'dshpw-btn', disabled: busy, onClick: rename }, t('saveName')),
      ),
    ),

    // ── 子用户管理（仅主用户） ──
    isAdmin &&
      h(
        'div',
        { className: 'dshpw-section' },
        h(
          'div',
          { className: 'dshpw-section-head' },
          h('span', { className: 'dshpw-label' }, t('subusers')),
          h('span', { className: 'dshpw-hint' }, t('usersCount', { count: data?.users.length ?? 0 })),
        ),
        h(
          'div',
          { className: 'dshpw-users' },
          ...(data?.users ?? []).map((u) =>
            h(
              'div',
              { className: 'dshpw-user', key: u.id },
              h('span', { className: 'dshpw-avatar sm', 'aria-hidden': 'true' }, initial(u.username)),
              h(
                'span',
                { className: 'dshpw-user-copy' },
                h(
                  'span',
                  { className: 'dshpw-user-name' },
                  u.username,
                  u.role === 'admin'
                    ? h('span', { className: 'dshpw-badge admin' }, t('owner'))
                    : h('span', { className: 'dshpw-badge' }, t('subuser')),
                  u.username === me ? h('span', { className: 'dshpw-chip' }, t('selfTag')) : null,
                ),
                h(
                  'span',
                  { className: 'dshpw-user-meta' },
                  u.last_login_at ? t('lastLogin', { time: fmtTime(u.last_login_at) }) : t('neverLoggedIn'),
                ),
              ),
              u.username !== me &&
                h(
                  'button',
                  { className: 'dshpw-btn danger sm', disabled: busy, onClick: () => removeUser(u.username) },
                  t('remove'),
                ),
            ),
          ),
        ),
        (data?.users ?? []).every((u) => u.role !== 'user')
          ? h('div', { className: 'dshpw-empty' }, t('noSubusers'))
          : null,
        h(
          'div',
          { className: 'dshpw-subpanel' },
          h('span', { className: 'dshpw-subpanel-title' }, t('addSubTitle')),
          h(
            'div',
            { className: 'dshpw-fields' },
            field(
              t('fieldSubName'),
              h('input', {
                className: 'dshpw-input',
                autoComplete: 'off',
                name: 'dshpw-subname',
                value: addName,
                onChange: (e: { target: { value: string } }) => setAddName(e.target.value),
              }),
              t('namePolicy'),
            ),
            field(
              t('fieldSubPw'),
              h('input', {
                className: 'dshpw-input',
                type: 'password',
                autoComplete: 'new-password',
                value: addPw,
                onChange: (e: { target: { value: string } }) => setAddPw(e.target.value),
              }),
              t('pwPolicy'),
            ),
          ),
          h(
            'div',
            { className: 'dshpw-action-row dshpw-form-actions' },
            h('span', { className: 'dshpw-hint dshpw-action-copy' }, t('subHint')),
            h('button', { className: 'dshpw-btn', disabled: busy, onClick: addSubUser }, t('addSub')),
          ),
        ),
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
            const budget = budgets[u.id];
            return h(
              'div',
              { className: 'dshpw-perm', key: u.id },
              h(
                'div',
                { className: 'dshpw-perm-head' },
                h('span', { className: 'dshpw-avatar sm', 'aria-hidden': 'true' }, initial(u.username)),
                h('strong', null, u.username),
                h(
                  'span',
                  { className: 'dshpw-perm-chips' },
                  u.usage
                    ? h(
                        'span',
                        { className: 'dshpw-chip' },
                        `${t('usageTime')} ${Math.round(u.usage.activeSeconds / 60)}m · ${t('usageTokens')} ${u.usage.hourlyTokens}`,
                      )
                    : null,
                  u.permissions.banned ? h('span', { className: 'dshpw-chip danger' }, t('banned')) : null,
                ),
              ),
              h(
                'div',
                { className: 'dshpw-perm-body' },
              budget !== undefined
                ? h(
                    'div',
                    { className: 'dshpw-budget' },
                    budget.budgetMicros === null
                      ? null
                      : h(
                          'div',
                          {
                            className: `dshpw-budget-bar${budget.exhausted ? ' over' : budget.warning ? ' warn' : ''}`,
                          },
                          h('span', {
                            style: { width: `${Math.min(100, Math.max(0, Math.round(budget.ratio * 100)))}%` },
                          }),
                        ),
                    h(
                      'span',
                      { className: budget.exhausted ? 'dshpw-error' : budget.warning ? 'dshpw-warn' : 'dshpw-hint' },
                      `${t('budgetUsed')} ¥${(budget.usedMicros / 1_000_000).toFixed(2)} · ${t('budgetRemaining')} ¥${((budget.remainingMicros ?? 0) / 1_000_000).toFixed(2)}${budget.warning ? ` · ${t('budgetWarning')}` : ''}`,
                    ),
                  )
                : null,
              // 工作区默认全开的部署不需要逐条勾选：折叠起来，摘要行给出开启数
              h(
                'details',
                { className: 'dshpw-fold' },
                h(
                  'summary',
                  { className: 'dshpw-fold-summary' },
                  h('span', { className: 'dshpw-label' }, t('permsFolders')),
                  h(
                    'span',
                    { className: 'dshpw-hint' },
                    workspaces.length === 0
                      ? t('permsNoWorkspaces')
                      : t('permsFoldersSummary', {
                          enabled: workspaces.filter((workspace) => enabledFolderSet(d).has(workspace.path)).length,
                          total: workspaces.length,
                        }),
                  ),
                ),
              workspaces.length === 0
                ? null
                : h(
                    'div',
                    { className: 'dshpw-fold-body dshpw-workspaces' },
                    ...workspaces.map((workspace) => {
                      const enabled = enabledFolderSet(d).has(workspace.path);
                      return h(
                        'div',
                        { className: 'dshpw-workspace', key: workspace.path },
                        h(
                          'label',
                          { className: 'dshpw-switch dshpw-workspace-switch' },
                          h(
                            'span',
                            { className: 'dshpw-switch-copy' },
                            h('strong', null, workspace.title || workspace.path),
                            h('small', null, workspace.path),
                          ),
                          h(
                            'span',
                            { className: 'dshpw-switch-control' },
                            h('input', {
                              type: 'checkbox',
                              checked: enabled,
                              disabled: busy,
                              onChange: (e: { target: { checked: boolean } }) =>
                                toggleWorkspace(u.id, workspace, e.target.checked),
                              'aria-label': workspace.title || workspace.path,
                            }),
                            h('span', { className: 'dshpw-switch-track', 'aria-hidden': 'true' },
                              h('span', { className: 'dshpw-switch-thumb' }),
                            ),
                          ),
                        ),
                        enabled
                          ? h(
                              'div',
                              { className: 'dshpw-session-list' },
                              ...(workspace.sessions.length === 0
                                ? [h('span', { className: 'dshpw-hint' }, t('permsNoSessions'))]
                                : workspace.sessions.map((session) =>
                                    h(
                                      'label',
                                      { className: 'dshpw-session-check', key: session.id },
                                      h('input', {
                                        type: 'checkbox',
                                        checked: !d.disabledSessions.includes(session.id),
                                        disabled: busy,
                                        onChange: (e: { target: { checked: boolean } }) =>
                                          toggleSession(u.id, session.id, e.target.checked),
                                      }),
                                      h('span', null, session.title || session.id),
                                    ),
                                  )),
                            )
                          : null,
                      );
                    }),
                  ),
              ),
              h(
                'div',
                { className: 'dshpw-fields' },
                field(
                  t('permsSandbox'),
                  h(
                    'select',
                    {
                      className: 'dshpw-input',
                      value: d.sandbox,
                      onChange: (e: { target: { value: string } }) => setDraft(u.id, { sandbox: e.target.value }),
                    },
                    h('option', { value: '' }, t('sandboxNone')),
                    h('option', { value: 'read-only' }, t('sandboxReadOnly')),
                    h('option', { value: 'workspace-write' }, t('sandboxWorkspace')),
                    h('option', { value: 'danger-full-access' }, t('sandboxFull')),
                  ),
                ),
                field(
                  t('fieldTokenLimit'),
                  h('input', {
                    className: 'dshpw-input',
                    type: 'text',
                    inputMode: 'numeric',
                    pattern: '[0-9]*',
                    autoComplete: 'off',
                    name: 'dshpw-tokenlimit',
                    value: d.token,
                    onChange: (e: { target: { value: string } }) => setDraft(u.id, { token: e.target.value }),
                  }),
                  t('fieldUnlimited'),
                ),
                field(
                  t('fieldMinutesLimit'),
                  h('input', {
                    className: 'dshpw-input',
                    type: 'text',
                    inputMode: 'numeric',
                    pattern: '[0-9]*',
                    autoComplete: 'off',
                    name: 'dshpw-minlimit',
                    value: d.minutes,
                    onChange: (e: { target: { value: string } }) => setDraft(u.id, { minutes: e.target.value }),
                  }),
                  t('fieldUnlimited'),
                ),
                field(
                  t('fieldMonthlyBudget'),
                  h('input', {
                    className: 'dshpw-input',
                    type: 'text',
                    inputMode: 'decimal',
                    pattern: '[0-9]+([.][0-9]{1,2})?',
                    autoComplete: 'off',
                    name: 'dshpw-monthly-budget',
                    value: d.monthlyBudget,
                    onChange: (e: { target: { value: string } }) => setDraft(u.id, { monthlyBudget: e.target.value }),
                  }),
                  t('fieldBudgetHint'),
                ),
              ),
              h(
                'div',
                { className: 'dshpw-checks' },
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
                h('label', { className: 'dshpw-check' },
                  h('input', {
                    type: 'checkbox', checked: d.ssh,
                    onChange: (e: { target: { checked: boolean } }) => setDraft(u.id, { ssh: e.target.checked }),
                  }), t('permsSsh')),
                h(
                  'label',
                  { className: 'dshpw-check danger' },
                  h('input', {
                    type: 'checkbox',
                    checked: d.banned,
                    onChange: (e: { target: { checked: boolean } }) => setDraft(u.id, { banned: e.target.checked }),
                  }),
                  t('permsBanned'),
                ),
              ),
              ),
              h(
                'div',
                { className: 'dshpw-perm-foot' },
                dirtyUsers.includes(u.id) ? h('span', { className: 'dshpw-chip warn' }, t('unsaved')) : null,
                h(
                  'button',
                  { className: 'dshpw-btn', disabled: busy, onClick: () => savePermissions(u.id) },
                  t('permsSave'),
                ),
              ),
            );
          }),
      ),


  );

  return h('div', { className: 'dshpw-card' }, body);
}
