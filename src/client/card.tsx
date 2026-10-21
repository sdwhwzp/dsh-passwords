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
import { AccountsTable, AccountDialog, type AccountAction } from './accounts-table';

export interface UserInfo {
  id: number;
  username: string;
  role: 'admin' | 'user';
  created_at: string;
  last_login_at: string | null;
}

type StatusTone = 'neutral' | 'success' | 'warning' | 'danger';
interface AgentPresetInfo { id: string; trust: 'system' | 'user'; isDefault: boolean; name?: string; description?: string; broken?: string }

type DshpwCardProps = PropsLocale<'dshpw'>;

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
  /**
   * DSH LLM 注册表投影（`session/modelCatalog`），由网关按当前主用户过滤后透传。
   * 模型稳定 ID 为 `provider/model`。旧服务端不返回时视为“目录不可用”，
   * 前端保留已保存的 allowlist 并标为失效项，不静默放宽。
   */
  modelCatalog?: {
    default?: { provider: string; model: string };
    groups?: Array<{
      id: string;
      name?: string;
      models?: Array<{ id: string; name?: string; description?: string }>;
    }>;
    failures?: Array<{ id: string; name?: string; message?: string }>;
  } | null;
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
      allowWorkspaceCreate?: boolean;
      allowedAgentPresets?: string[] | null;
      allowedModels?: string[] | null;
      allowedSessionIds?: string[];
      ownedSessionIds?: string[];
      /** 聊天媒体（表情包/图片/视频）开关；旧服务端不返回时按 false 处理 */
      allowChatMedia?: boolean;
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
  workspaceCreate: boolean;
  chatMedia: boolean;
  banned: boolean;
  sandbox: string;
  disabledSessions: string[];
  /** 服务端快照中的禁用会话集合；保存时作为 CAS 基线提交。 */
  disabledSessionsBaseline: string[];
  allowedSessionIds: string[];
  /** 是否显式编辑过会话授权。false 时保存不提交 allowedSessionIds，避免仅切换
   *  工作区等其它字段就把服务端 grants 清空并 markSessionGrantsSeeded。 */
  sessionsTouched: boolean;
  agentPresets: string[] | null;
  /** NULL = 不限；[] = 禁用全部；非空 = allowlist（均为 provider/model 稳定 ID） */
  models: string[] | null;
  touched: Set<keyof PermDraft>;
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

export interface BudgetStatus {
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

/** 目录浏览器的一个直接子目录项（服务端已过滤文件与敏感路径）。 */
export interface DirectoryPickerEntry {
  name: string;
  path: string;
  /** 服务端判定该项是否可作为落点（文件系统根/盘符根为 false，只能进入）。 */
  selectable: boolean;
}

/** GET /gateway/api/directory-picker/list 的统一响应。 */
export interface DirectoryPickerListing {
  ok: true;
  /** 当前目录绝对路径；null = 盘符列表等无当前目录的起点。 */
  currentPath: string | null;
  /** 父目录；null = 已在根/起点。 */
  parentPath: string | null;
  /** 当前目录本身是否可作为落点；currentPath 为 null 时恒 false。 */
  selectable: boolean;
  entries: DirectoryPickerEntry[];
  /** 子目录过多被有界截断；仅作提示，不影响可选性。 */
  truncated: boolean;
}

/** 面板阶段：有辨识 union，避免 status/error 等可相互矛盾的松散字段。 */
type PickerListing =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: DirectoryPickerListing };

interface PickerState {
  listing: PickerListing;
}

/** 展平后的模型目录项：`id` 为提交给网关的稳定 ID（provider/model） */
export interface ModelCatalogEntry {
  id: string;
  provider: string;
  providerName: string;
  model: string;
  name: string;
}

/** 稳定 ID 口径与网关/数据库一致：`provider/model`；provider 无斜杠，
 *  model 允许含 `/`（官方 openrouter/baseten 等目录的模型 ID 普遍含斜杠） */
const MODEL_ID_RE = /^[^/\s]{1,100}\/[^\s]{1,200}$/;

/** 模型目录可用状态：unavailable = 服务端未返回目录（不能据此清空 allowlist） */
export type ModelCatalogStatus = 'ready' | 'unavailable';

/**
 * 可选数据请求（工作区、Agent 预设）的句柄：独立中止控制器 + 有限超时。
 * 它不参与主刷新守卫的完成条件，所以挂起的上游不会冻结整个刷新流程。
 */
type OptionalRequest = {
  controller: AbortController;
  timedOut: boolean;
  timeout: ReturnType<typeof setTimeout>;
};

type RequiredRefreshRequest = OptionalRequest;

/** 可选数据请求的有限超时（毫秒）：超时后主动中止并转入错误态，而非无限等待。 */
const OPTIONAL_REQUEST_TIMEOUT_MS = 5000;
/** 目录浏览可能访问网络盘或大型目录，单独给出有界但足够的预算。 */
const DIRECTORY_PICKER_REQUEST_TIMEOUT_MS = 30_000;
/** 工作区展示会触发冷枚举，允许覆盖观测到的 40-90 秒冷路径。 */
const WORKSPACE_REQUEST_TIMEOUT_MS = 120_000;
/** 状态与权限快照是刷新主链；墙钟到期后必须释放刷新守卫。 */
const REQUIRED_REFRESH_TIMEOUT_MS = 10000;

/**
 * 展平 overview 里的模型目录为可勾选列表。
 * 非法 ID（缺 provider/model、含空白）直接跳过：它不可能被网关接受，
 * 也不应出现在选择列表里；已保存的旧 ID 由 stale 逻辑单独保留。
 */
export function readModelCatalog(overview: PermOverview | null): {
  entries: ModelCatalogEntry[];
  status: ModelCatalogStatus;
} {
  const catalog = overview?.modelCatalog;
  const groups = catalog?.groups;
  if (!Array.isArray(groups)) return { entries: [], status: 'unavailable' };
  const entries: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (typeof group?.id !== 'string' || !Array.isArray(group.models)) continue;
    const providerName = typeof group.name === 'string' && group.name !== '' ? group.name : group.id;
    for (const model of group.models) {
      if (typeof model?.id !== 'string') continue;
      const id = `${group.id}/${model.id}`;
      if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        provider: group.id,
        providerName,
        model: model.id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
      });
    }
  }
  return { entries, status: 'ready' };
}

/** 读取官方 session/modelCatalog 的 server-response 信封。 */
export function readModelCatalogResponse(response: unknown): {
  entries: ModelCatalogEntry[];
  status: ModelCatalogStatus;
} {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    return { entries: [], status: 'unavailable' };
  }
  const result = (response as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return { entries: [], status: 'unavailable' };
  }
  const row = result as { ok?: unknown; value?: unknown };
  if (row.ok !== true || typeof row.value !== 'object' || row.value === null || Array.isArray(row.value)) {
    return { entries: [], status: 'unavailable' };
  }
  return readModelCatalog({ modelCatalog: row.value as PermOverview['modelCatalog'] } as PermOverview);
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


function StatusPill(props: { tone?: StatusTone; children?: ReactNode }) {
  return h('span', { className: `dshpw-status dshpw-status-${props.tone ?? 'neutral'}` }, props.children);
}

function SectionHeader(props: { label: ReactNode; status?: ReactNode; tone?: StatusTone }) {
  return h(
    'div',
    { className: 'dshpw-section-head' },
    h('div', { className: 'dshpw-section-title' }, h('span', { className: 'dshpw-label' }, props.label)),
    props.status === undefined ? null : h(StatusPill, { tone: props.tone, children: props.status }),
  );
}

/** 错误文案：有 code 走本地词典，未知 code / 无 code 回退服务端文案。
 *  词典项含占位符（{minutes}/{count} 等）时客户端无参数可填，回退服务端已插值文案。 */
function apiErrorDetails(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof Error)) return null;
  const details = (error as Error & { details?: unknown }).details;
  return typeof details === 'object' && details !== null && !Array.isArray(details)
    ? details as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
}

/**
 * 严格解析目录浏览响应（服务端已过滤文件/敏感路径）：任何必需字段缺失或类型
 * 不符都视为契约违规 → 返回 null（调用方转错误态），绝不猜测兼容字段。
 */
function parseDirectoryListing(value: unknown): DirectoryPickerListing | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true) return null;
  const currentPath = row.currentPath === null || typeof row.currentPath === 'string' ? row.currentPath : undefined;
  const parentPath = row.parentPath === null || typeof row.parentPath === 'string' ? row.parentPath : undefined;
  if (currentPath === undefined || parentPath === undefined) return null;
  if (typeof row.selectable !== 'boolean' || typeof row.truncated !== 'boolean') return null;
  if (!Array.isArray(row.entries)) return null;
  const entries: DirectoryPickerEntry[] = [];
  for (const raw of row.entries) {
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== 'string' || typeof entry.path !== 'string' || typeof entry.selectable !== 'boolean') return null;
    entries.push({ name: entry.name, path: entry.path, selectable: entry.selectable });
  }
  return { ok: true, currentPath, parentPath, selectable: row.selectable, entries, truncated: row.truncated };
}

/** 面板状态键：每个子用户一个目录浏览器。 */
function pickerKey(userId: number): string {
  return `${userId}`;
}

/** 面板 DOM id：与触发按钮的 aria-controls 对应。 */
function pickerPanelId(userId: number): string {
  return `dshpw-dir-picker-${userId}`;
}

/** 绝对路径 → 面包屑（根 → 当前）。只接受服务端返回的规范化绝对路径（POSIX 或盘符）。 */
function pathCrumbs(path: string | null): Array<{ label: string; path: string }> {
  if (path === null || path === '') return [];
  const crumbs: Array<{ label: string; path: string }> = [];
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    const drive = path.slice(0, 2);
    let base = `${drive}\\`;
    crumbs.push({ label: drive, path: base });
    for (const part of path.slice(2).split(/[\\/]+/).filter((segment) => segment !== '')) {
      base = base.endsWith('\\') ? `${base}${part}` : `${base}\\${part}`;
      crumbs.push({ label: part, path: base });
    }
    return crumbs;
  }
  if (path.startsWith('/')) {
    let base = '/';
    crumbs.push({ label: '/', path: '/' });
    for (const part of path.split('/').filter((segment) => segment !== '')) {
      base = base === '/' ? `/${part}` : `${base}/${part}`;
      crumbs.push({ label: part, path: base });
    }
    return crumbs;
  }
  // 服务端只返回绝对路径；异常输入退化为单段当前路径，不构造祖先。
  return [{ label: path, path }];
}

// 依赖内联 SVG 图标（仓库无 lucide 依赖、无共享 React icon helper 时的最小实现）。
const ICON_CHEVRON_UP = 'M4 9.5 8 5.5l4 4';
const ICON_CHEVRON_RIGHT = 'M6 4l4 4-4 4';
const ICON_X = 'M4.5 4.5l7 7M11.5 4.5l-7 7';

function dirIcon(d: string) {
  return h(
    'svg',
    { className: 'dshpw-dir-icon', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    h('path', { d, stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  );
}

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

/**
 * 目录浏览器面板：可聚焦（tabIndex=-1）并在挂载后把焦点移入面板，
 * 使键盘用户能用 Escape 关闭，也避免打开面板时把焦点丢到 body。
 * react-test-renderer 无真实宿主实例（ref 恒为 null），此处静默跳过。
 */
function DirectoryPanel(props: {
  id: string;
  label: string;
  onEscape: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<{ focus?: () => void } | null>(null);
  useEffect(() => {
    panelRef.current?.focus?.();
  }, []);
  return h(
    'div',
    {
      id: props.id,
      className: 'dshpw-dir-picker',
      role: 'group',
      'aria-label': props.label,
      tabIndex: -1,
      ref: panelRef,
      onKeyDown: (event: { key?: string }) => {
        if (event.key === 'Escape') props.onEscape();
      },
    },
    props.children,
  );
}

interface DshPasswordsCardProps extends PropsLocale<'dshpw'> {
  loadState(): Promise<StateData>;
  mode?: 'settings' | 'accounts';
}

export function DshPasswordsCard(props: DshPasswordsCardProps) {
  const t = props.t;
  const accounts = props.mode === 'accounts';
  const [editor, setEditor] = useState<{ action: AccountAction | 'create'; user?: UserInfo } | null>(null);
  // errText 需要接收动态 key（err.<code>），而 dshpw 词典 t 的 key 是受限联合类型：
  // 这里包一层宽松签名适配器（运行时行为不变）
  const trErr: Translate = (key, params) => t(key as never, params);

  const [data, setData] = useState<StateData | null>(null);
  const [patchState, setPatchState] = useState<PatchState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgePassword, setPurgePassword] = useState('');
  const [purgeConfirmed, setPurgeConfirmed] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const purgeClicksRef = useRef({ count: 0, firstAt: 0 });

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
  const [agentPresets, setAgentPresets] = useState<AgentPresetInfo[]>([]);
  const [agentPresetStatus, setAgentPresetStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogEntry[]>([]);
  const [modelCatalogStatus, setModelCatalogStatus] = useState<ModelCatalogStatus>('unavailable');
  const [overview, setOverview] = useState<PermOverview | null>(null);
  const [permDrafts, setPermDrafts] = useState<Record<number, PermDraft>>({});
  const [permsNotice, setPermsNotice] = useState<Record<number, string>>({});
  const [budgets, setBudgets] = useState<Record<number, BudgetStatus>>({});
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspaceStatus, setWorkspaceStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [workspaceError, setWorkspaceError] = useState('');
  // 目录浏览器面板状态与在飞请求（按子用户键）。
  // 每次导航取消上一轮请求，旧响应到达时 signal 已中止 → 丢弃，不覆盖新路径。
  const [dirPickers, setDirPickers] = useState<Record<string, PickerState>>({});
  const pickerRequestsRef = useRef<Map<string, OptionalRequest>>(new Map());
  // 正在编辑中的子用户草稿：dirty 时 30s 自动刷新不覆盖本地未保存的修改
  const dirtyUsersRef = useRef<Set<number>>(new Set());
  // dirty 集合的可渲染副本：权限卡片据此显示“未保存”标记（ref 变化不触发重绘）
  const [dirtyUsers, setDirtyUsers] = useState<readonly number[]>([]);
  // 刷新 in-flight 守卫：慢网络下 30s 定时 + 操作后手动 refresh 不重叠。
  // 若刷新期间又有请求，排队在当前响应结束后补跑，避免旧快照覆盖乐观分配结果。
  const refreshingRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  // 工作区 / Agent 预设是可选数据：各自持有独立的 in-flight 句柄，
  // 新一轮请求会取消上一轮，避免慢上游的旧响应覆盖新数据。
  const workspaceRequestRef = useRef<OptionalRequest | null>(null);
  const presetRequestRef = useRef<OptionalRequest | null>(null);
  // 模型目录 RPC 是 overview 里的可选上游：同样需要可被新一轮刷新 / 卸载取消。
  const catalogRequestRef = useRef<OptionalRequest | null>(null);
  const requiredRefreshRef = useRef<RequiredRefreshRequest | null>(null);
  // patch/status 与 update/status 是轻量独立请求：各自持有可取消句柄 + 有限超时，
  // 新一轮刷新会取消上一轮，慢上游的旧响应不会覆盖新状态，卸载时统一清理。
  const patchStatusRequestRef = useRef<OptionalRequest | null>(null);
  const updateStatusRequestRef = useRef<OptionalRequest | null>(null);
  const disposedRef = useRef(false);

  /** 取消并清空一个在飞的可选请求句柄（被新一轮刷新取代 / 卸载 / 走到 ready 分支）。 */
  const cancelOptional = (ref: { current: OptionalRequest | null }) => {
    const request = ref.current;
    if (!request) return;
    ref.current = null;
    request.controller.abort();
    clearTimeout(request.timeout);
  };

  /**
   * 加载可选数据：独立 AbortController + 有限超时。
   * - 被新一轮刷新取代（abort 但未超时）：丢弃结果，不触碰状态。
   * - 超时中止：转交 onError(error, true)，由调用方转入错误态。
   * 该 Promise 不进入 refresh 的主链，pending 它不会阻塞整体刷新。
   */
  const loadOptional = <T,>(
    ref: { current: OptionalRequest | null },
    path: string,
    body: unknown,
    onResult: (result: T) => void,
    onError: (error: unknown, timedOut: boolean) => void,
    timeoutMs = OPTIONAL_REQUEST_TIMEOUT_MS,
    replaceInFlight = true,
  ) => {
    if (replaceInFlight) cancelOptional(ref);
    const request: OptionalRequest = {
      controller: new AbortController(),
      timedOut: false,
      timeout: setTimeout(() => {
        request.timedOut = true;
        request.controller.abort();
      }, timeoutMs),
    };
    ref.current = request;
    api<T>(path, body, request.controller.signal)
      .then((result) => {
        if (request.controller.signal.aborted && !request.timedOut) return;
        onResult(result);
      })
      .catch((error: unknown) => {
        if (request.controller.signal.aborted && !request.timedOut) return;
        onError(error, request.timedOut);
      })
      .finally(() => {
        clearTimeout(request.timeout);
        if (ref.current === request) ref.current = null;
      });
  };

  /** Release the refresh guard even if a native state RPC never settles. */
  const loadRequiredState = (request: RequiredRefreshRequest): Promise<StateData> => {
    const signal = request.controller.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(request.timedOut ? new Error(t('permsRefreshTimeout')) : signal.reason);
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => props.loadState()).then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  };

  const loadRequired = <T,>(path: string, request: RequiredRefreshRequest): Promise<T> =>
    api<T>(path, undefined, request.controller.signal).catch((error: unknown) => {
      if (request.timedOut) throw new Error(t('permsRefreshTimeout'));
      throw error;
    });

  const loadWorkspaces = () => {
    // 冷枚举请求在飞时复用它；否则 30s 轮询会叠加昂贵枚举，并丢失旧句柄导致
    // 卸载时无法清理其 AbortController 和超时计时器。
    if (workspaceRequestRef.current) return;
    setWorkspaceStatus((status) => (status === 'ready' ? status : 'loading'));
    setWorkspaceError('');
    loadOptional<{ workspaces: WorkspaceInfo[] }>(
      workspaceRequestRef,
      '/api/dsh-passwords/workspaces',
      undefined,
      (result) => {
        setWorkspaces(result.workspaces ?? []);
        setWorkspaceStatus('ready');
      },
      (error, timedOut) => {
        const message = timedOut ? t('permsWorkspacesTimeout') : errText(error, trErr);
        setWorkspaceError(message);
        setWorkspaceStatus('error');
      },
      WORKSPACE_REQUEST_TIMEOUT_MS,
    );
  };

  const loadAgentPresets = () => {
    loadOptional<{ presets: AgentPresetInfo[] }>(
      presetRequestRef,
      '/api/dsh-passwords/agent-presets',
      undefined,
      (result) => {
        setAgentPresets(result.presets ?? []);
        setAgentPresetStatus('ready');
      },
      () => setAgentPresetStatus('unavailable'),
    );
  };

  const refresh = () => {
    if (disposedRef.current) return;
    if (refreshingRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshingRef.current = true;
    const previous = requiredRefreshRef.current;
    if (previous) {
      previous.controller.abort();
      clearTimeout(previous.timeout);
    }
    const request: RequiredRefreshRequest = {
      controller: new AbortController(),
      timedOut: false,
      timeout: setTimeout(() => {
        request.timedOut = true;
        request.controller.abort();
      }, REQUIRED_REFRESH_TIMEOUT_MS),
    };
    requiredRefreshRef.current = request;
    const active = (): boolean => !disposedRef.current && !request.controller.signal.aborted;
    // state 与 overview 是必需链：无论上游如何挂住，墙钟到期都必须释放守卫。
    loadRequiredState(request)
      .then((d) => {
        if (!active()) return undefined;
        setData(d);
        setError('');
        if (d.me?.role !== 'admin' || !accounts) return undefined;
        return loadRequired<PermOverview>('/gateway/api/overview', request)
          .then((o) => {
            if (!active()) return undefined;
            // overview 是权限快照；modelCatalog 只有在网关此前观察到官方 RPC 时才会
            // 内嵌。首次进入设置页主动调用无参数的官方 RPC，避免依赖主界面先打开模型选择器。
            const overviewCatalog = readModelCatalog(o);
            // Render the permission snapshot independently of the optional model catalog.
            // A stalled upstream catalog request must not make the whole settings card disappear.
            setOverview(o);
            void api<{ budgets: BudgetStatus[] }>('/api/dsh-passwords/budgets').then((result) => setBudgets(Object.fromEntries(result.budgets.map((row) => [row.userId, row])))).catch(() => setBudgets({}));
            if (overviewCatalog.status === 'ready') {
              // overview 已内嵌目录：无需再发 RPC，并取消上一轮仍在飞的目录请求。
              cancelOptional(catalogRequestRef);
              setModelCatalog(overviewCatalog.entries);
              setModelCatalogStatus(overviewCatalog.status);
            } else {
              // 官方 RPC 也是可选上游：独立句柄 + 有限超时。新一轮刷新 / 卸载会
              // 取消它；失败只回落到 overview 的空目录，不阻塞主链。
              loadOptional<unknown>(
                catalogRequestRef,
                '/api/session/modelCatalog',
                {
                  type: 'client-request',
                  rpcId: `dshpw-model-catalog-${Date.now()}`,
                  method: 'session/modelCatalog',
                  payload: { args: {} },
                },
                (raw) => {
                  const catalog = readModelCatalogResponse(raw);
                  setModelCatalog(catalog.entries);
                  setModelCatalogStatus(catalog.status);
                },
                () => {
                  setModelCatalog(overviewCatalog.entries);
                  setModelCatalogStatus(overviewCatalog.status);
                },
              );
            }

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
                  workspaceCreate: u.permissions.allowWorkspaceCreate === true,
                  agentPresets: u.permissions.allowedAgentPresets == null ? null : [...u.permissions.allowedAgentPresets],
                  models: u.permissions.allowedModels == null ? null : [...u.permissions.allowedModels],
                  chatMedia: u.permissions.allowChatMedia === true,
                  banned: u.permissions.banned,
                  sandbox: u.permissions.sandboxMode ?? '',
                  disabledSessions: [...(u.permissions.disabledSessions ?? [])],
                  disabledSessionsBaseline: [...(u.permissions.disabledSessions ?? [])],
                  allowedSessionIds: [...(u.permissions.allowedSessionIds ?? [])],
                  sessionsTouched: false,
                  touched: new Set(),
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
            // 工作区与 Agent 预设是可选数据：独立加载，不进入主刷新守卫的完成
            // 条件。它们各自带中止控制器 + 有限超时，慢或挂起的上游既能被新一轮
            // 刷新取消，也不会把 refreshingRef 永久锁住而冻结整体刷新。
            loadWorkspaces();
            loadAgentPresets();
          })
          .catch((error: unknown) => {
            if (request.timedOut || request.controller.signal.aborted) throw error;
            setOverview(null);
            // 目录随 overview 失败：不能沿用上一次快照把已下架的模型当成仍可勾选
            setModelCatalog([]);
            setModelCatalogStatus('unavailable');
            // overview 非超时失败（5xx / 业务错误）必须可见，不能静默停在旧快照。
            setError(errText(error, trErr));
          });
      })
      .catch((e) => {
        if (disposedRef.current || (request.controller.signal.aborted && !request.timedOut)) return;
        setError(errText(e, trErr));
      })
      .finally(() => {
        clearTimeout(request.timeout);
        if (requiredRefreshRef.current === request) requiredRefreshRef.current = null;
        refreshingRef.current = false;
        if (refreshQueuedRef.current && !disposedRef.current) {
          refreshQueuedRef.current = false;
          refresh();
        }
      });
    // patch 状态独立于主链（轻量 + 失败只影响状态展示）：独立 AbortController +
    // 有限超时 + 新一轮刷新取消上一轮，旧响应不会覆盖新状态。
    if (!accounts) loadOptional<unknown>(
      patchStatusRequestRef,
      '/api/dsh-passwords/patch/status',
      undefined,
      (r) => setPatchState(readPatchState(r)),
      () => setPatchState(null),
    );
  };

  // 密码门已是独立设置分区页（settings.section），无需折叠：
  // 进入分区即渲染全部内容，并每 30 秒自动刷新（主用户在别处修改子用户
  // 权限/工作区后，页面自动同步最新状态）
  useEffect(() => {
    // effect 重跑（StrictMode 双调用 / 依赖变化）时复位：否则上一次卸载标记会
    // 让本实例的 refresh 永久短路，整张卡片停止更新。
    disposedRef.current = false;
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      disposedRef.current = true;
      window.clearInterval(timer);
      // 卸载时取消所有仍未完成的请求（含 overview 完成后才创建的可选请求），
      // 避免卸载后迟到响应写入状态。
      cancelOptional(workspaceRequestRef);
      cancelOptional(presetRequestRef);
      cancelOptional(catalogRequestRef);
      cancelOptional(patchStatusRequestRef);
      cancelOptional(updateStatusRequestRef);
      for (const request of pickerRequestsRef.current.values()) {
        request.controller.abort();
        clearTimeout(request.timeout);
      }
      pickerRequestsRef.current.clear();
      const required = requiredRefreshRef.current;
      if (required) {
        requiredRefreshRef.current = null;
        required.controller.abort();
        clearTimeout(required.timeout);
      }
    };
  }, []);

  const isAdmin = data?.me?.role === 'admin';
  const me = data?.me?.username ?? '';
  const chatEnabled = data?.chatEnabled ?? true;

  const run = async (
    fn: () => Promise<unknown>,
    okMessage: string,
    afterSuccess?: () => Promise<void>,
    // 成功文案投递目标：不传则进页面底部全局提示栏；传了则只投递到指定 sink
    // （如权限块内的就地确认条），不再重复刷全局提示。
    noticeSink?: (message: string) => void,
    errorSink?: (error: unknown) => Promise<void> | void,
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
      if (noticeSink !== undefined) noticeSink(customNotice ?? okMessage);
      else setNotice(customNotice ?? okMessage);
      if (afterSuccess) {
        await afterSuccess();
        return;
      }
      if (accounts) { setEditor(null); clearForm(); }
      refresh();
    } catch (e) {
      try {
        if (errorSink !== undefined) await errorSink(e);
        else setError(errText(e, trErr));
      } catch (syncError) {
        setError(errText(syncError, trErr));
      }
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

  const clearPurgeForm = () => {
    setPurgePassword('');
    setPurgeConfirmed(false);
  };

  const closePurge = () => {
    setPurgeOpen(false);
    clearPurgeForm();
    setPurgeBusy(false);
  };

  const handleAvatarClick = () => {
    if (!isAdmin || purgeBusy) return;
    const now = Date.now();
    const current = purgeClicksRef.current;
    if (current.firstAt === 0 || now - current.firstAt > 3000) {
      purgeClicksRef.current = { count: 1, firstAt: now };
      return;
    }
    const count = current.count + 1;
    if (count >= 10) {
      purgeClicksRef.current = { count: 0, firstAt: 0 };
      setPurgeOpen(true);
      clearPurgeForm();
      setError('');
      setNotice('');
      return;
    }
    purgeClicksRef.current = { count, firstAt: now };
  };

  const purgeEverything = async () => {
    if (purgeBusy) return;
    if (purgePassword === '') {
      setError(t('purgePasswordRequired'));
      return;
    }
    if (!purgeConfirmed) {
      setError(t('purgeConfirmRequired'));
      return;
    }
    setPurgeBusy(true);
    setError('');
    try {
      await api('/gateway/api/dsh-passwords/purge', { password: purgePassword, confirm: true });
      closePurge();
      setNotice(t('purgeStarted'));
      window.setTimeout(() => window.location.assign('/gateway/login'), 1200);
    } catch (e) {
      clearPurgeForm();
      setError(errText(e, trErr));
      setPurgeBusy(false);
    }
  };

  /** 空闲窗剩余毫秒 → 模板需要的分钟数 */
  const idleMinutes = (ms: number): string => String(Math.max(1, Math.ceil(ms / 60000)));

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
    setPermsNotice((prev) => ({ ...prev, [userId]: '' }));
    dirtyUsersRef.current.add(userId);
    setDirtyUsers([...dirtyUsersRef.current]);
    setPermDrafts((prev) => {
      const current = prev[userId];
      if (!current) return prev;
      const touched = new Set(current.touched);
      for (const key of Object.keys(patch) as Array<keyof PermDraft>) touched.add(key);
      return { ...prev, [userId]: { ...current, ...patch, touched } };
    });
  };

  const enabledFolderSet = (draft: PermDraft): Set<string> => {
    if (draft.folders.includes('__deny__')) return new Set();
    if (draft.folders.length === 0) return new Set(workspaces.map((workspace) => workspace.path));
    return new Set(draft.folders);
  };

  const sessionsForUser = (workspace: WorkspaceInfo, userId: number) => {
    const owned = overview?.users.find(user => user.id === userId)?.permissions.ownedSessionIds;
    return workspace.sessions.filter(session => owned === undefined || owned.includes(session.id));
  };

  const toggleWorkspace = (userId: number, workspace: WorkspaceInfo, enabled: boolean) => {
    const draft = permDrafts[userId];
    if (!draft) return;
    const enabledFolders = enabledFolderSet(draft);
    if (enabled) enabledFolders.add(workspace.path);
    else enabledFolders.delete(workspace.path);
    const workspaceSessionIds = new Set(sessionsForUser(workspace, userId).map((session) => session.id));
    setDraft(userId, {
      folders: enabledFolders.size === 0 ? ['__deny__'] : [...enabledFolders],
      disabledSessions: draft.disabledSessions.filter((id) => !workspaceSessionIds.has(id)),
    });
  };

  const toggleSession = (userId: number, sessionId: string, enabled: boolean) => {
    const draft = permDrafts[userId];
    if (!draft) return;
    const allowed = new Set(draft.allowedSessionIds);
    const disabled = new Set(draft.disabledSessions);
    if (enabled) {
      allowed.add(sessionId);
      disabled.delete(sessionId);
    } else {
      allowed.delete(sessionId);
      disabled.add(sessionId);
    }
    setDraft(userId, {
      allowedSessionIds: [...allowed],
      disabledSessions: [...disabled],
      sessionsTouched: true,
    });
  };

  /** 某个子用户草稿里仍然启用、但已不在当前目录中的模型 ID（失效项）。
   *  这些 ID 必须保留并显示为禁用项：静默剔除会在下次保存时把“受限”变成
   *  “不限”/缩小 allowlist，用户看不出权限被改过。 */
  const staleModels = (draft: PermDraft): string[] => {
    if (draft.models === null) return [];
    const known = new Set(modelCatalog.map((entry) => entry.id));
    return draft.models.filter((id) => !known.has(id));
  };

  /** 切换单个模型：从 NULL（不限）进入逐项选择时，以当前目录为初始集合，
   *  避免主用户一取消“不限制”就把子用户的全部模型静默清空。 */
  const toggleModel = (userId: number, modelId: string, enabled: boolean) => {
    const draft = permDrafts[userId];
    if (!draft) return;
    const current = draft.models === null
      ? new Set(modelCatalog.map((entry) => entry.id))
      : new Set(draft.models);
    if (enabled) current.add(modelId);
    else current.delete(modelId);
    setDraft(userId, { models: [...current] });
  };

  // ── 可读取目录：目录浏览器（不可自由编辑）──
  // 已选目录以只读 chips 展示；只能通过 /gateway/api/directory-picker/list 逐级
  // 浏览并选择。不存在手打自由路径的入口。
  const setPicker = (key: string, state: PickerState | null) => {
    setDirPickers((prev) => {
      if (state === null) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: state };
    });
  };

  const cancelPickerRequest = (key: string) => {
    const request = pickerRequestsRef.current.get(key);
    if (!request) return;
    pickerRequestsRef.current.delete(key);
    request.controller.abort();
    clearTimeout(request.timeout);
  };

  /**
   * 加载某目录的直接子目录。每次导航取消同一键上一轮在飞请求并挂新的
   * AbortController + 有限超时；被取代中止的旧响应直接丢弃，不覆盖新路径。
   * path === null 时请求默认起点（不带 query）。
   */
  const loadDirectory = (key: string, path: string | null) => {
    cancelPickerRequest(key);
    const timedOutState: PickerState = { listing: { kind: 'error', message: t('permsDirTimeout') } };
    const request: OptionalRequest = {
      controller: new AbortController(),
      timedOut: false,
      timeout: setTimeout(() => {
        request.timedOut = true;
        request.controller.abort();
        // 超时立即转错误态，不依赖底层 fetch 是否响应 abort（保持与其它可选请求一致）。
        // 若已被新一轮导航取代，cancelPickerRequest 已清除本计时器，不会走到这里。
        setPicker(key, timedOutState);
      }, DIRECTORY_PICKER_REQUEST_TIMEOUT_MS),
    };
    pickerRequestsRef.current.set(key, request);
    const { controller } = request;
    setPicker(key, { listing: { kind: 'loading' } });
    const query = path === null ? '' : `?path=${encodeURIComponent(path)}`;
    api<unknown>(`/gateway/api/directory-picker/list${query}`, undefined, controller.signal)
      .then((raw) => {
        // 身份守卫：同一键已挂新一轮请求（或被关闭）→ 旧响应直接丢弃，不覆盖新路径。
        if (pickerRequestsRef.current.get(key) !== request) return;
        if (request.timedOut) {
          setPicker(key, timedOutState);
          return;
        }
        const data = parseDirectoryListing(raw);
        setPicker(key, data === null
          ? { listing: { kind: 'error', message: t('permsDirInvalid') } }
          : { listing: { kind: 'ready', data } });
      })
      .catch((loadError: unknown) => {
        if (pickerRequestsRef.current.get(key) !== request) return;
        setPicker(key, request.timedOut
          ? timedOutState
          : { listing: { kind: 'error', message: errText(loadError, trErr) } });
      })
      .finally(() => {
        clearTimeout(request.timeout);
        if (pickerRequestsRef.current.get(key) === request) pickerRequestsRef.current.delete(key);
      });
  };

  const openPicker = (userId: number) => {
    loadDirectory(pickerKey(userId), null);
  };

  const closePicker = (userId: number) => {
    const key = pickerKey(userId);
    cancelPickerRequest(key);
    setPicker(key, null);
  };

  /** 可读取目录：从当前有效集合出发加入。`__deny__` ⇒ 空集，`[]` ⇒ 全部工作区
   * （与工作区开关一致）；加入后即从“所有目录/已禁止”切到具体 array（该次编辑为
   * 显式变更，会标记 folders touched）。*/
  const addReadFolder = (userId: number, path: string) => {
    if (path === '') return;
    const draft = permDrafts[userId];
    if (!draft) return;
    const current = enabledFolderSet(draft);
    if (current.has(path)) return;
    current.add(path);
    setDraft(userId, { folders: [...current] });
  };

  /** 移除一个可读目录；移除最后一个提交 ['__deny__']（= 无读取权限，fail-closed）。 */
  const removeReadFolder = (userId: number, path: string) => {
    const draft = permDrafts[userId];
    if (!draft) return;
    const remaining = draft.folders.filter((folder) => folder !== path && folder !== '__deny__');
    setDraft(userId, { folders: remaining.length > 0 ? remaining : ['__deny__'] });
  };

  const selectDirectory = (userId: number, path: string) => {
    if (path === '') return;
    addReadFolder(userId, path);
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
        .flatMap((workspace) => sessionsForUser(workspace, userId).map((session) => session.id)),
    );
    setPermsNotice((prev) => ({ ...prev, [userId]: '' }));
    // 会话授权只在被显式编辑过时才提交：网关把「提交了 allowedSessionIds」视为
    // 一次性会话集合迁移（清空 grants 并 markSessionGrantsSeeded）。仅切换工作区等
    // 其它字段却提交 stale 草稿（哪怕是 []）会清空子用户 grants，也会覆盖
    // 网关期间新增的 grant。显式取消全部会话仍提交 []（fail-closed，不退化为不提交）。
    const sessionsTouched = d.sessionsTouched;
    void run(
      () =>
        api<{
          allowedFolders?: string[];
          allowedSessionIds?: string[];
          disabledSessions?: string[];
          sandboxRevokedSessionIds?: string[];
        }>('/gateway/api/permissions', {
          userId,
          ...(d.touched.has('folders') ? { allowedFolders: d.folders } : {}),

          ...(d.touched.has('token') ? { hourlyTokenLimit: tokenNum } : {}),
          ...(d.touched.has('monthlyBudget') ? { monthlyBudgetYuan: d.monthlyBudget.trim() } : {}),
          ...(d.touched.has('minutes') ? { dailyMinutesLimit: minutesNum } : {}),
          ...(d.touched.has('upload') ? { allowUpload: d.upload } : {}),
          ...(d.touched.has('git') ? { allowGitDownload: d.git } : {}),
          ...(d.touched.has('ssh') ? { allowSsh: d.ssh } : {}),
          ...(d.touched.has('workspaceCreate') ? { allowWorkspaceCreate: d.workspaceCreate } : {}),
          ...(d.touched.has('ssh') ? { allowSsh: d.ssh } : {}),
          ...(d.touched.has('agentPresets') ? { allowedAgentPresets: d.agentPresets } : {}),
          // NULL = 不限；[] = 禁用全部；非空 = allowlist。保持三态语义原样提交。
          ...(d.touched.has('models') ? { allowedModels: d.models } : {}),
          ...(d.touched.has('chatMedia') ? { allowChatMedia: d.chatMedia } : {}),
          ...(d.touched.has('banned') ? { banned: d.banned } : {}),
          ...(d.touched.has('sandbox') ? { sandboxMode: d.sandbox === '' ? null : d.sandbox } : {}),
          ...(sessionsTouched ? {
            disabledSessions: d.disabledSessions,
            expectedDisabledSessions: d.disabledSessionsBaseline,
            allowedSessionIds: d.allowedSessionIds,
          } : {}),
        }).then((saved: { allowedFolders?: string[]; allowedSessionIds?: string[]; disabledSessions?: string[]; sandboxRevokedSessionIds?: string[] }) => {
          // 先采用服务端规范化结果，再执行刷新；避免保存成功后短暂显示旧草稿。
          setPermDrafts((prev) => {
            const current = prev[userId];
            if (!current) return prev;
            const next: PermDraft = {
              ...current,
              folders: saved.allowedFolders ?? current.folders,
              // 标记在成功响应里复位：此后再次保存（未再编辑会话）不应重新提交集合。
              sessionsTouched: false,
              touched: new Set(),
            };
            // 未提交会话集合时，响应里的会话字段是网关快照，可能落后于本地；
            // 不合并以免用陈旧值覆盖，交由下一次非 dirty 刷新同步。
            if (sessionsTouched) {
              next.allowedSessionIds = saved.allowedSessionIds ?? current.allowedSessionIds;
              next.disabledSessions = saved.disabledSessions ?? current.disabledSessions;
            }
            const revoked = new Set(saved.sandboxRevokedSessionIds ?? []);
            if (revoked.size > 0) {
              next.allowedSessionIds = next.allowedSessionIds.filter((id) => !revoked.has(id));
            }
            next.disabledSessionsBaseline = saved.disabledSessions ?? current.disabledSessionsBaseline;
            return { ...prev, [userId]: next };
          });
          dirtyUsersRef.current.delete(userId);
          setDirtyUsers([...dirtyUsersRef.current]);
          const revokedCount = saved.sandboxRevokedSessionIds?.length ?? 0;
          return revokedCount > 0
            ? { notice: t('permsSandboxRevoked', { count: revokedCount }) }
            : undefined;
        }),
      t('permsSaved'),
      async () => { refresh(); },
      (message) => setPermsNotice((prev) => ({ ...prev, [userId]: message })),
      async (error: unknown) => {
        const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
        const details = apiErrorDetails(error);
        if (code === 'DISABLED_SESSIONS_CONFLICT' || code === 'SESSION_GRANTS_CONFLICT' || code === 'PERMISSIONS_CONFLICT') {
          const serverDisabled = stringArray(details?.disabledSessions);
          const serverAllowed = stringArray(details?.allowedSessionIds);
          const latest = await api<PermOverview>('/gateway/api/overview');
          const user = latest.users.find((item) => item.id === userId);
          if (!user) throw new Error('Target user no longer exists');
          const workspaceResult = await api<{ workspaces: WorkspaceInfo[] }>('/api/dsh-passwords/workspaces');
          setOverview(latest);
          setWorkspaces(workspaceResult.workspaces ?? []);
          setWorkspaceStatus('ready');
          setWorkspaceError('');
          setPermDrafts((prev) => {
            const current = prev[userId];
            if (!current) return prev;
            const touched = new Set(current.touched);
            touched.delete('sessionsTouched');
            touched.delete('disabledSessions');
            touched.delete('disabledSessionsBaseline');
            touched.delete('allowedSessionIds');
            return { ...prev, [userId]: {
              ...current,
              sessionsTouched: false,
              disabledSessions: serverDisabled ?? user.permissions.disabledSessions,
              disabledSessionsBaseline: serverDisabled ?? user.permissions.disabledSessions,
              allowedSessionIds: serverAllowed ?? user.permissions.allowedSessionIds ?? [],
              touched,
            } };
          });
          setPermsNotice((prev) => ({
            ...prev,
            [userId]: code === 'DISABLED_SESSIONS_CONFLICT' ? t('permsDisabledConflict')
              : code === 'PERMISSIONS_CONFLICT' ? t('permsStateConflict') : t('permsSessionConflict'),
          }));
          return;
        }
        setError(errText(error, trErr));
      },
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

  // 已选可读取目录 chips。
  const renderChip = (userId: number, path: string) => {
    const removeLabel = t('permsReadRemove', { path });
    return h(
      'span',
      { key: path, className: 'dshpw-chip dshpw-read-chip' },
      h('span', { className: 'dshpw-chip-path dshpw-read-path', title: path }, path),
      h('button', {
        type: 'button',
        className: 'dshpw-chip-remove dshpw-read-remove',
        disabled: busy,
        'aria-label': removeLabel,
        title: removeLabel,
        onClick: () => removeReadFolder(userId, path),
      }, dirIcon(ICON_X)),
    );
  };

  // 目录浏览器：面包屑 + 上一级 + 关闭 + 仅直接子目录。
  // 加载/错误态下所有选择入口禁用；行内“选择”只看服务端 selectable。
  const renderDirectoryBrowser = (userId: number) => {
    const key = pickerKey(userId);
    const state = dirPickers[key];
    if (state === undefined) return null;
    const listing = state.listing;
    const data = listing.kind === 'ready' ? listing.data : null;
    const navigating = listing.kind === 'loading';
    const separator = data !== null && data.currentPath !== null && data.currentPath.includes('\\') ? '\\' : '/';
    const crumbs = pathCrumbs(data === null ? null : data.currentPath);
    return h(
      DirectoryPanel,
      {
        id: pickerPanelId(userId),
        label: t('permsDirBrowser'),
        onEscape: () => closePicker(userId),
        children: [
          h(
            'div',
            { className: 'dshpw-dir-picker-head' },
            h(
              'nav',
              { className: 'dshpw-dir-picker-crumbs', 'aria-label': t('permsDirPath') },
              crumbs.length === 0
                ? h('span', { className: 'dshpw-dir-picker-current' }, t('permsDirPath'))
                : crumbs.map((crumb, index) =>
                    h(
                      'span',
                      { key: crumb.path, className: 'dshpw-dir-picker-seg' },
                      index > 0 ? h('span', { className: 'dshpw-dir-picker-sep' }, separator) : null,
                      index === crumbs.length - 1
                        ? h('span', { className: 'dshpw-dir-picker-current' }, crumb.label)
                        : h('button', {
                            type: 'button',
                            className: 'dshpw-dir-picker-crumb',
                            disabled: busy || navigating,
                            onClick: () => loadDirectory(key, crumb.path),
                          }, crumb.label),
                    ),
                  ),
            ),
            h('button', {
              type: 'button',
              className: 'dshpw-dir-picker-tool dshpw-dir-picker-parent',
              disabled: busy || data === null || data.parentPath === null,
              'aria-label': t('permsDirParent'),
              title: t('permsDirParent'),
              onClick: () => { if (data !== null && data.parentPath !== null) loadDirectory(key, data.parentPath); },
            }, dirIcon(ICON_CHEVRON_UP)),
            h('button', {
              type: 'button',
              className: 'dshpw-dir-picker-tool dshpw-dir-picker-close',
              'aria-label': t('permsDirClose'),
              title: t('permsDirClose'),
              onClick: () => closePicker(userId),
            }, dirIcon(ICON_X)),
          ),
          h('button', {
            type: 'button',
            className: 'dshpw-btn dshpw-dir-picker-select-current',
            disabled: busy || data === null || data.selectable !== true || data.currentPath === null,
            onClick: () => { if (data !== null && data.currentPath !== null) selectDirectory(userId, data.currentPath); },
          }, t('permsDirSelectCurrent')),
          h(
            'div',
            { className: 'dshpw-dir-picker-body' },
            listing.kind === 'loading'
              ? h('div', { className: 'dshpw-hint', role: 'status' }, t('permsDirLoading'))
              : listing.kind === 'error'
                ? h('div', { className: 'dshpw-hint', role: 'alert' }, `${t('permsDirError')}: ${listing.message}`)
                : [
                    listing.data.truncated
                      ? h('div', { className: 'dshpw-hint', key: 'truncated' }, t('permsDirTruncated'))
                      : null,
                    listing.data.entries.length === 0
                      ? h('div', { className: 'dshpw-hint', key: 'empty' }, t('permsDirEmpty'))
                      : h(
                          'div',
                          { className: 'dshpw-dir-picker-list', key: 'list' },
                          ...listing.data.entries.map((entry) =>
                            h(
                              'div',
                              { className: 'dshpw-dir-picker-row', key: entry.path },
                              h('span', { className: 'dshpw-dir-picker-name', title: entry.path }, entry.name),
                              h(
                                'span',
                                { className: 'dshpw-dir-picker-actions' },
                                h('button', {
                                  type: 'button',
                                  className: 'dshpw-btn dshpw-dir-picker-enter',
                                  disabled: busy,
                                  onClick: () => loadDirectory(key, entry.path),
                                }, t('permsDirEnter')),
                                h('button', {
                                  type: 'button',
                                  className: 'dshpw-btn dshpw-dir-picker-select',
                                  disabled: busy || entry.selectable !== true,
                                  onClick: () => selectDirectory(userId, entry.path),
                                }, t('permsDirSelect')),
                              ),
                            ),
                          ),
                        ),
                  ],
          ),
        ],
      },
    );
  };

  // 可读取目录：目录浏览器选择，编辑 allowedFolders。
  //   · ['__deny__'] = 无读权限（不是 [] 无限）；
  //   · [] = 所有目录，保留现值不转换；一旦加入即切到具体 array；
  //   · 移除最后一个提交 ['__deny__']。
  //   开启「新建工作区权限」后，也以这些目录作为创建文件夹/工作区的范围。
  const renderReadFolders = (userId: number, draft: PermDraft) => {
    const denyAll = draft.folders.includes('__deny__');
    const unrestricted = !denyAll && draft.folders.length === 0;
    const concrete = draft.folders.filter((folder) => folder !== '__deny__');
    const open = dirPickers[pickerKey(userId)] !== undefined;
    return h(
      'div',
      { className: 'dshpw-read-folders' },
      h('label', { className: 'dshpw-label' }, t('permsReadTitle')),
      denyAll
        ? h('div', { className: 'dshpw-hint' }, t('permsReadEmpty'))
        : unrestricted
          ? h('div', { className: 'dshpw-hint' }, t('permsReadUnrestricted'))
          : h('div', { className: 'dshpw-chip-row' }, ...concrete.map((folder) => renderChip(userId, folder))),
      h(
        'div',
        { className: 'dshpw-row' },
        h('button', {
          type: 'button',
          className: 'dshpw-btn dshpw-read-add',
          disabled: busy,
          'aria-expanded': open,
          'aria-controls': pickerPanelId(userId),
          onClick: () => { if (open) closePicker(userId); else openPicker(userId); },
        }, t('permsReadAdd')),
      ),
      renderDirectoryBrowser(userId),
      h('small', { className: 'dshpw-hint' }, t('permsReadDesc')),
    );
  };

  const patchOk =
    patchState !== null &&
    patchState.settingsHostMode &&
    patchState.whitelist &&
    patchState.workspaceSearch;
  const patchText =
    patchState === null ? t('patchUnknown') : patchOk ? t('patchOk') : t('patchBad');
  const managedUsers = overview?.users.filter((u) => u.role === 'user') ?? [];
  const clearForm = () => {
    setPwCurrent(''); setPwNew(''); setPwConfirm(''); setNameNew(''); setAddName(''); setAddPw('');
  };
  const openEditor = (user: UserInfo | undefined, action: AccountAction | 'create') => {
    clearForm(); setError(''); setNotice('');
    setPwTarget(user?.username ?? ''); setNameTarget(user?.username ?? '');
    setEditor({ user, action });
  };
  const closeEditor = () => {
    if (busy) return;
    const id = editor?.user?.id;
    const dirty = (id !== undefined && dirtyUsersRef.current.has(id)) || pwCurrent || pwNew || pwConfirm || nameNew || addName || addPw;
    if (dirty && !window.confirm(t('accountsDiscard'))) return;
    if (id !== undefined) dirtyUsersRef.current.delete(id);
    setDirtyUsers([...dirtyUsersRef.current]);
    setEditor(null); clearForm(); refresh();
  };
  const passwordForm =
    // ── 修改密码 ──
    h(
      'div',
      { className: 'dshpw-section' },
      h('div', { className: 'dshpw-section-head' }, h('span', { className: 'dshpw-label' }, t('chgPw'))),
      h(
        'div',
        { className: 'dshpw-fields' },
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
    );
  const renameForm =
    // ── 修改用户名 ──
    h(
      'div',
      { className: 'dshpw-section' },
      h('div', { className: 'dshpw-section-head' }, h('span', { className: 'dshpw-label' }, t('chgName'))),
      h(
        'div',
        { className: 'dshpw-fields' },
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
        h('button', { className: 'dshpw-btn', disabled: busy, onClick: rename }, t('saveName')),
      ),
    );
  const createForm =
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
        );
  const permissionsForm =
    // ── 子用户权限（仅主用户） ──
    isAdmin &&
      overview !== null &&
      h(
        'div',
        { className: 'dshpw-section' },
        h('span', { className: 'dshpw-label' }, t('perms')),
        h('div', { className: 'dshpw-hint' }, t('permsHint')),
        ...overview.users
          .filter((u) => u.role === 'user' && u.id === editor?.user?.id)
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
                    workspaceStatus === 'loading' ? t('permsWorkspacesLoading')
                      : workspaceStatus === 'error' ? `${t('permsWorkspacesUnavailable')}: ${workspaceError}`
                      : workspaces.length === 0
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
                              ...(sessionsForUser(workspace, u.id).length === 0
                                ? [h('span', { className: 'dshpw-hint' }, t('permsNoSessions'))]
                                : sessionsForUser(workspace, u.id).map((session) =>
                                    h(
                                      'label',
                                      { className: 'dshpw-session-check', key: session.id },
                                      h('input', {
                                        type: 'checkbox',
                                        checked: d.allowedSessionIds.includes(session.id) && !d.disabledSessions.includes(session.id),
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
              renderReadFolders(u.id, d),
              agentPresetStatus === 'unavailable'
                ? h(
                    'div',
                    { className: 'dshpw-row' },
                    h('div', { className: 'dshpw-label' }, t('permsAgentPresets')),
                    h('div', { className: 'dshpw-hint' }, t('permsAgentPresetsUnavailable')),
                  )
                : agentPresets.length > 0
                ? h(
                    'div',
                    { className: 'dshpw-row' },
                    h('div', { className: 'dshpw-label' }, t('permsAgentPresets')),
                    h(
                      'label',
                      { className: 'dshpw-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: d.agentPresets === null,
                        disabled: busy,
                        onChange: (e: { target: { checked: boolean } }) =>
                          setDraft(u.id, { agentPresets: e.target.checked ? null : [] }),
                      }),
                      t('permsAgentPresetsUnrestricted'),
                    ),
                    ...(d.agentPresets === null
                      ? []
                      : agentPresets.map((preset) =>
                          h(
                            'label',
                            { className: 'dshpw-check', key: preset.id },
                            h('input', {
                              type: 'checkbox',
                              checked: (d.agentPresets ?? []).includes(preset.id),
                              disabled: busy || preset.broken !== undefined,
                              onChange: (e: { target: { checked: boolean } }) => {
                                const next = new Set(d.agentPresets ?? []);
                                if (e.target.checked) next.add(preset.id);
                                else next.delete(preset.id);
                                setDraft(u.id, { agentPresets: [...next] });
                              },
                            }),
                            h(
                              'span',
                              null,
                              preset.name || preset.id,
                              preset.broken !== undefined ? ` (${t('permsAgentPresetBroken')})` : '',
                            ),
                          ),
                        )),
                  )
                : null,
              // ── 可用模型 allowlist（NULL=不限 / []=禁用全部 / 非空=白名单）──
              // 目录来自 overview；失败或缺失时保留草稿并标为不可用，
              // 绝不因为“看不到目录”而把已有 allowlist 显示成“不限制”。
              h(
                'div',
                { className: 'dshpw-row' },
                h('div', { className: 'dshpw-label' }, t('permsModels')),
                modelCatalogStatus === 'unavailable'
                  ? h('div', { className: 'dshpw-hint' }, t('permsModelsUnavailable'))
                  : null,
                h(
                  'label',
                  { className: 'dshpw-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: d.models === null,
                    disabled: busy || modelCatalogStatus === 'unavailable',
                    onChange: (e: { target: { checked: boolean } }) => {
                      // 取消“不限制”时以现有行为为准：目录可用则默认全选（
                      // 至少可预期），目录不可用则给出空白名单（=禁用全部），
                      // 两种情况都在 UI 上显式可见，不静默放宽。
                      setDraft(u.id, {
                        models: e.target.checked
                          ? null
                          : modelCatalog.map((entry) => entry.id),
                      });
                    },
                  }),
                  t('permsModelsUnrestricted'),
                ),
                d.models === null
                  ? null
                  : h('div', { className: 'dshpw-hint' }, t('permsModelsHint')),
                d.models !== null && d.models.length === 0
                  ? h('div', { className: 'dshpw-hint' }, t('permsModelsDenyAll'))
                  : null,
                d.models === null || modelCatalogStatus === 'unavailable'
                  ? null
                  : h(
                      'div',
                      { className: 'dshpw-model-list' },
                      ...modelCatalog.map((entry) =>
                        h(
                          'label',
                          { className: 'dshpw-check', key: entry.id },
                          h('input', {
                            type: 'checkbox',
                            checked: (d.models ?? []).includes(entry.id),
                            disabled: busy,
                            onChange: (e: { target: { checked: boolean } }) =>
                              toggleModel(u.id, entry.id, e.target.checked),
                          }),
                          h(
                            'span',
                            null,
                            `${entry.name} · ${entry.providerName}`,
                            h('small', { className: 'dshpw-hint' }, ` ${entry.id}`),
                          ),
                        ),
                      ),
                    ),
                // 失效项：仍启用但已不在目录中。保留勾选状态并禁用，
                // 保存时原样提交（服务端会拒绝/保留，由此主用户知道需要处理）。
                ...(modelCatalogStatus === 'ready' && d.models !== null && staleModels(d).length > 0
                  ? [
                      h('div', { className: 'dshpw-hint', key: 'stale-hint' }, t('permsModelsStale')),
                      ...staleModels(d).map((id) =>
                        h(
                          'label',
                          { className: 'dshpw-check', key: id },
                          h('input', { type: 'checkbox', checked: true, disabled: true, readOnly: true }),
                          h('span', null, id, ` (${t('permsModelsRetired')})`),
                        ),
                      ),
                    ]
                  : []),
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
                    type: 'checkbox',
                    checked: d.ssh,
                    disabled: busy,
                    'aria-label': t('permsSsh'),
                    onChange: (e: { target: { checked: boolean } }) => setDraft(u.id, { ssh: e.target.checked }),
                  }), t('permsSsh')),
                h('label', { className: 'dshpw-check', title: t('permsChatMediaDesc') },
                  h('input', {
                    type: 'checkbox', checked: d.chatMedia,
                    onChange: (e: { target: { checked: boolean } }) => setDraft(u.id, { chatMedia: e.target.checked }),
                  }), t('permsChatMedia')),
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
                permsNotice[u.id] ? h('span', { className: 'dshpw-ok', role: 'status' }, permsNotice[u.id]) : null,
                dirtyUsers.includes(u.id) ? h('span', { className: 'dshpw-chip warn' }, t('unsaved')) : null,
                h(
                  'button',
                  { className: 'dshpw-btn', disabled: busy, onClick: () => savePermissions(u.id) },
                  t('permsSave'),
                ),
              ),
            );
          }),
      );

  if (accounts) {
    const title = editor?.action === 'create' ? t('addSubTitle')
      : `${editor?.user?.username ?? ''} · ${editor?.action === 'permissions' ? t('perms') : editor?.action === 'password' ? t('chgPw') : t('chgName')}`;
    return h('div', { className: 'dshpw-accounts-root' },
      error && editor === null ? h('div', { className: 'dshpw-banner err', role: 'alert' }, error) : null,
      notice ? h('div', { className: 'dshpw-banner ok', role: 'status' }, notice) : null,
      workspaceStatus === 'error' && editor === null ? h('div', { className: 'dshpw-banner err', role: 'alert' }, workspaceError) : null,
      data === null ? h('p', { role: 'status' }, t('accountsLoading')) : !isAdmin ? h('p', { role: 'alert' }, t('accountsAdminOnly')) :
        h(AccountsTable, { t, users: data.users, overview, budgets, me, busy, refresh, create: () => openEditor(undefined, 'create'), edit: openEditor, remove: (user) => removeUser(user.username) }),
      isAdmin && editor !== null ? h(AccountDialog, { title, closeLabel: t('accountsClose'), close: closeEditor, children: h('div', { className: 'dshpw-dialog-body' },
        error ? h('div', { className: 'dshpw-banner err', role: 'alert' }, error) : null,
        editor.action === 'create' ? createForm : editor.action === 'password' ? passwordForm : editor.action === 'rename' ? renameForm : permissionsForm) }) : null);
  }

  const body = h('div', { className: 'dshpw-body' },
    // ── 当前身份（头像 + 账号 + 角色徽章；主用户另附账号总数） ──
    h(
      'div',
      { className: 'dshpw-identity' },
      isAdmin ? h('button', { className: 'dshpw-avatar dshpw-avatar-trigger', type: 'button', title: t('purgeTitle'), 'aria-label': t('purgeTitle'), onClick: handleAvatarClick, disabled: purgeBusy }, initial(me))
        : h('span', { className: 'dshpw-avatar', 'aria-hidden': 'true' }, initial(me)),
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
    purgeOpen && isAdmin
      ? h(
          'div',
          { className: 'dshpw-purge', role: 'alertdialog', 'aria-live': 'assertive' },
          h('strong', null, t('purgeTitle')),
          h('p', { className: 'dshpw-purge-warning' }, t('purgeWarning')),
          h('input', {
            className: 'dshpw-input',
            type: 'password',
            autoComplete: 'current-password',
            placeholder: t('purgePasswordPh'),
            value: purgePassword,
            disabled: purgeBusy,
            onChange: (e: { target: { value: string } }) => setPurgePassword(e.target.value),
          }),
          h(
            'label',
            { className: 'dshpw-check' },
            h('input', {
              type: 'checkbox',
              checked: purgeConfirmed,
              disabled: purgeBusy,
              onChange: (e: { target: { checked: boolean } }) => setPurgeConfirmed(e.target.checked),
            }),
            t('purgeConfirmLabel'),
          ),
          h(
            'div',
            { className: 'dshpw-purge-actions' },
            h('button', { className: 'dshpw-btn danger', disabled: purgeBusy, onClick: purgeEverything }, t('purgeSubmit')),
            h('button', { className: 'dshpw-btn', disabled: purgeBusy, onClick: closePurge }, t('purgeCancel')),
          ),
        )
      : null,
    // 操作结果紧跟身份区展示，长表单下方的按钮点击后无需回到页尾查看
    error !== '' && h('div', { className: 'dshpw-banner err', role: 'alert' }, error),
    notice !== '' && h('div', { className: 'dshpw-banner ok', role: 'status' }, notice),
    isAdmin ? h('div', { className: 'dshpw-section dshpw-action-row' },
      h('span', { className: 'dshpw-hint dshpw-action-copy' }, t('accountsDescription')),
      h('a', { className: 'dshpw-btn', href: '/gateway/accounts', target: '_blank', rel: 'noopener noreferrer' }, t('accountsOpen'))) : null,
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

    passwordForm,
    renameForm,
  );
  return h('div', { className: 'dshpw-card' }, body);
}
