// SQLite 数据层：Node 内置 node:sqlite（零外部数据库依赖）
// 表结构：users / platform_settings / audit_logs / login_attempts / ip_throttle /
// user_permissions / user_usage / messages / user_workspaces / user_session_grants /
// workspace_cleanup_intents / media_assets / message_media
//
// 静态加密（见 src/encrypt.ts）：
//   - users.username         → AES-256-GCM 密文存储；username_hash（HMAC）做等值索引
//   - audit_logs 的 username/ip/user_agent/detail → AES-256-GCM 密文存储
//   - login_attempts         → 只存 username_hash/ip_hash（HMAC，不可逆）
//   密码始终只存 bcrypt 哈希（不可逆，无明文，无需加密）。
//   旧明文数据在 init() 时一次性自动迁移为密文（幂等，检测 v1:/h1: 前缀）。
//
// 性能：预处理语句按 SQL 文本缓存（每个代理请求都要查询会话，
// 避免逐请求重复编译 SQL 的开销）。
//
// 聊天媒体元数据（media_assets / message_media）：
//   - 文件本体由网关写在私有目录，DB 只保存元数据与 storage_key；
//     storage_key / sha256 属于内部字段，绝不进入 MessageRow（消息投影只给
//     不透明媒体 ID + 展示元数据）。
//   - 生命周期：pending（已签发上传，文件未就绪）→ ready（校验通过）
//     → 过期清理 / 删除；失败或放弃的 pending 由网关删除并回收 storage_key。
//   - 一个媒体只能被一条消息占用（message_media.media_id 上有 UNIQUE 索引），
//     绑定与消息创建在同一事务内完成，任一校验失败整体回滚。
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { FieldCrypto } from './encrypt.js';
import { normalizePath } from './permissions.js';

type UserRole = 'admin' | 'user';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  /** 改密时 +1：旧 JWT（签入时的版本号）立即失效 */
  credential_version: number;
  created_at: string;
  last_login_at: string | null;
}

/** 用户列表条目（已解密的展示字段） */
export interface UserListRow {
  id: number;
  username: string;
  role: UserRole;
  created_at: string;
  last_login_at: string | null;
}

interface AuditLogRow {
  id: number;
  event_type: string;
  username: string | null;
  ip: string | null;
  user_agent: string | null;
  detail: string | null;
  created_at: string;
}

/** 子用户权限（对应 user_permissions 表；缺行 = 默认全量权限） */
export interface UserPermissionsRow {
  user_id: number;
  allowed_folders: string[];
  hourly_token_limit: number | null;
  daily_minutes_limit: number | null;
  allow_upload: boolean;
  allow_git_download: boolean;
  allow_workspace_create: boolean;
  allow_ssh: boolean;
  /** NULL = 不限制；[] = 禁止全部 agent preset */
  allowed_agent_presets: string[] | null;
  /** NULL = 不限制；[] = 禁止全部 provider/model */
  allowed_models: string[] | null;
  /** 聊天媒体（sticker/image/video）开关；默认关闭，文本消息不受影响 */
  allow_chat_media: boolean;
  banned: boolean;
  sandbox_mode: string | null;
  disabled_sessions: string[];
  updated_at: string;
}

/**
 * 删除联动的清理意图（对应 workspace_cleanup_intents 表）：目录已物理删除但
 * DB 清理事务回滚时，保存可信的服务端派生元数据，使重试在进程重启、内存缓存
 * 清空、上游注册表条目已消失（仅剩会话 grants）后仍能收敛。
 */
export interface WorkspaceCleanupIntent {
  /** 记录时经 normalizeForMatch 规范化的被删根路径。 */
  root: string;
  /** 首次删除时收集到的、属于该目录树的会话 ID（去重、长度校验）。 */
  sessionIds: string[];
  /** 发起删除的主用户（仅审计与失效范围用；准入仍由端点 requireAdmin 把关）。 */
  ownerUserId: number;
}

/** 用户用量（对应 user_usage 表） */
interface UsageRow {
  user_id: number;
  day: string;
  first_seen_at: string | null;
  last_active_at: string | null;
  active_seconds: number;
  hourly_window_start: string | null;
  hourly_tokens: number;
}

/** 留言/聊天消息的媒体附件元数据（只输出安全字段，不含 storage_key/sha256/状态） */
export interface MessageMediaRow {
  id: string;
  kind: 'sticker' | 'image' | 'video';
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  /** 上传时提供的原始文件名（仅展示；文件本体始终以不透明 ID 落盘） */
  original_name: string;
  /** 同条消息内顺序（客户端按此排序渲染） */
  sort_order: number;
  caption: string | null;
}

export interface MessageRow {
  id: number;
  sender_id: number;
  sender_name: string;
  recipient_id: number | null;
  content: string;
  tags: string[];
  created_at: string;
  media: MessageMediaRow[];
}

/**
 * 媒体对象的安全投影（网关上传/下载接口用）：包含 storage_key / sha256 等
 * 内部字段的完整行只允许数据层内部或明确的网关切面读取。
 */
export interface MediaAssetRow {
  id: string;
  owner_id: number;
  original_name: string;
  /** 创建/上传者的数据库列名（内部行保持原始列名，避免批量映射时二次拷贝） */
  kind: 'sticker' | 'image' | 'video';
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  state: string;
  expires_at: string | null;
}

/**
 * 媒体对象（含 storage_key / sha256）。仅供数据层内部与网关的文件读写使用；
 * 业务投影用 toMediaAssetRow()。
 */
export interface MediaAssetInternalRow extends MediaAssetRow {
  storage_key: string;
  sha256: string;
}

/** 可写入的媒体状态（pending = 已签发上传但文件未就绪） */
export type MediaState = 'pending' | 'ready' | 'failed';

export const MEDIA_KINDS = ['sticker', 'image', 'video'] as const;
export const MEDIA_STATES = ['pending', 'ready', 'failed'] as const;

/** 过期清理结果：调用方按 storageKeys 删除文件本体 */
export interface MediaRemovalPlan {
  media_ids: string[];
  storage_keys: string[];
}

/** 已可用（ready 且未过期）媒体对象的安全投影 */
export interface OwnedMediaRow {
  id: string;
  kind: 'sticker' | 'image' | 'video';
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
}

/** 清理动作因「媒体已被消息占用」而无法执行时的稳定错误码 */
export const MEDIA_IN_USE = 'MEDIA_IN_USE';
/** 清理动作目标不存在时的稳定错误码 */
export const MEDIA_NOT_FOUND = 'MEDIA_NOT_FOUND';

export class MediaError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'MediaError';
  }
}

const MEDIA_SELECT_SQL =
  'SELECT id, owner_id, storage_key, original_name, media_kind AS kind, mime_type, byte_size, sha256, width, height, duration_ms, state, expires_at FROM media_assets';

/** DB 行 → 安全投影（剔除 storage_key / sha256 与内部列） */
function toMediaAssetRow(row: MediaAssetInternalRow): MediaAssetRow {
  return {
    id: row.id,
    owner_id: row.owner_id,
    original_name: row.original_name,
    kind: row.kind,
    mime_type: row.mime_type,
    byte_size: Number(row.byte_size),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
    state: String(row.state),
    expires_at: row.expires_at,
  };
}

/** 硬上限：防止异常调用方写入超大 ID/文件名拖爆单行（正常上传远低于此） */
const MEDIA_ID_MAX = 128;
const MEDIA_STORAGE_KEY_MAX = 512;
const MEDIA_NAME_MAX = 255;
const MEDIA_MIME_MAX = 128;
const MEDIA_SHA256_MAX = 128;
const MEDIA_BYTE_SIZE_MAX = 512 * 1024 * 1024;
const MEDIA_DIMENSION_MAX = 100_000;
const MEDIA_DURATION_MAX = 24 * 60 * 60 * 1000;
/** datetime('now') 口径：24 小时内不会与其他行重名的存储键（同一 upload id 仍受 PK 约束） */
const PLACEHOLDER_STORAGE_KEY_PREFIX = '__pending__:';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT    NOT NULL,
  username_hash      TEXT,
  password_hash      TEXT    NOT NULL,
  role               TEXT    NOT NULL DEFAULT 'user',
  credential_version INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at      TEXT
);
CREATE TABLE IF NOT EXISTS platform_settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  username   TEXT,
  ip         TEXT,
  user_agent TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE TABLE IF NOT EXISTS login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username_hash TEXT NOT NULL,
  ip_hash       TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(username_hash, ip_hash)
);
CREATE TABLE IF NOT EXISTS ip_throttle (
  ip_hash        TEXT PRIMARY KEY,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  window_started TEXT NOT NULL DEFAULT (datetime('now')),
  throttled_until TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id            INTEGER PRIMARY KEY,
  allowed_folders    TEXT,                          -- JSON 字符串数组（绝对路径）
  hourly_token_limit INTEGER,                       -- NULL = 不限
  daily_minutes_limit INTEGER,                      -- NULL = 不限
  allow_upload       INTEGER NOT NULL DEFAULT 0, -- 是否提升子用户请求体上限到 300 MiB
  allow_git_download INTEGER NOT NULL DEFAULT 0,
  allow_workspace_create INTEGER NOT NULL DEFAULT 0,
  allow_ssh          INTEGER NOT NULL DEFAULT 0,       -- 子用户 SSH 端点开关（管已登记的 HTTP/WS 端点）
  allowed_agent_presets TEXT,                         -- NULL = unrestricted；JSON agent preset ID 白名单
  allowed_models      TEXT,                         -- NULL = unrestricted；JSON provider/model allowlist
  allow_chat_media    INTEGER NOT NULL DEFAULT 0,   -- 平台留言 sticker/image/video
  banned             INTEGER NOT NULL DEFAULT 0,
  sandbox_mode       TEXT,                          -- NULL = 不更改；read-only/workspace-write/danger-full-access
  disabled_sessions  TEXT NOT NULL DEFAULT '[]',    -- 已开启工作区内逐会话关闭的 sessionId JSON 数组
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_usage (
  user_id             INTEGER,
  day                 TEXT,                          -- YYYY-MM-DD（本地时区）
  first_seen_at       TEXT,                          -- 当日首次使用时间（ISO）
  last_active_at      TEXT,                          -- 最近活跃时间（ISO，用于累计活跃跨度）
  active_seconds      INTEGER NOT NULL DEFAULT 0,
  hourly_window_start TEXT,                          -- 当前小时窗口起点（ISO）
  hourly_tokens       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id    INTEGER NOT NULL,
  recipient_id INTEGER,                              -- NULL = 广播给所有人
  content      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',           -- JSON 字符串数组
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(id DESC);
CREATE TABLE IF NOT EXISTS user_workspaces (
  user_id    INTEGER NOT NULL,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, path)
);
CREATE INDEX IF NOT EXISTS idx_user_workspaces_path ON user_workspaces(path);
CREATE TABLE IF NOT EXISTS user_session_grants (
  user_id    INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_user_session_grants_session ON user_session_grants(session_id);
-- 删除联动失败后的清理意图（跨重启的重试凭证）：只在目录已物理删除且 DB 清理
-- 事务回滚时写入；记录受信的 realpath/归一化根 + 受影响会话 + 操作者。重试准入
-- 只认与记录根同一路径的请求（共用 pathWithinDeletedTree/samePathForMatch），
-- 且必须先过敏感目录检查；DB 清理成功后才删除对应行。
CREATE TABLE IF NOT EXISTS workspace_cleanup_intents (
  root          TEXT PRIMARY KEY,
  session_ids   TEXT NOT NULL DEFAULT '[]',
  owner_user_id INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS media_assets (
  id              TEXT PRIMARY KEY,
  owner_id        INTEGER NOT NULL,
  storage_key     TEXT NOT NULL UNIQUE,
  original_name   TEXT NOT NULL,
  media_kind      TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  width           INTEGER,
  height          INTEGER,
  duration_ms     INTEGER,
  state           TEXT NOT NULL DEFAULT 'ready',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_assets_owner ON media_assets(owner_id, created_at DESC);
-- 生命周期/清理查询（owner + ready + 未过期、过期扫描、pending 扫描）走索引；
-- 同时兜住旧库（索引此前缺失）的幂等补齐。
CREATE INDEX IF NOT EXISTS idx_media_assets_state_expires ON media_assets(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_owner_state ON media_assets(owner_id, state, created_at DESC);
CREATE TABLE IF NOT EXISTS message_media (
  message_id      INTEGER NOT NULL,
  media_id        TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  caption         TEXT,
  PRIMARY KEY (message_id, media_id)
);
-- 一个媒体对象只能被一条消息占用：UNIQUE 是「重复占用」的最终防线
-- （应用层先 SELECT 再 INSERT，并发下仍可能双写，靠索引拒绝第二条关系）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_media_media ON message_media(media_id);

`;

/**
 * 旧库 message_media 去重迁移：历史索引非唯一，同一媒体可能已被多条消息引用。
 * 每个 media_id 只保留最早的一条关系（其余行继续留在表中，但不再作为“占用”
 * 依据，避免删除历史消息时误删仍被引用的关系行）；随后把索引升级为 UNIQUE。
 * 幂等：索引已是 UNIQUE 时直接返回；此函数在 init() 里于 SCHEMA 之后执行，
 * 因此新建库不会走到重建分支。
 */
function migrateMessageMediaUniqueness(db: DatabaseSync): void {
  const indexes = db.prepare('PRAGMA index_list(message_media)').all() as {
    name: string;
    unique: number;
  }[];
  const occupied = indexes.find((idx) => idx.name === 'idx_message_media_media');
  if (occupied?.unique === 1) return;
  if (occupied) db.exec('DROP INDEX idx_message_media_media');
  db.exec(`DELETE FROM message_media WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM message_media GROUP BY media_id
  )`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_message_media_media ON message_media(media_id)');
}

/** SQLite 时间列归一：datetime('now') 返回 'YYYY-MM-DD HH:MM:SS'，统一为 ISO。 */
function toIsoTimestamp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  return raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
}

/** 安全解析 JSON 字符串数组（权限目录 / 留言标签）；损坏时返回空数组 */
function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 权限目录 JSON 的严格解析：
 *   - NULL 表示旧库/缺省配置，保持“未限制”兼容语义；
 *   - 非空但损坏或包含非字符串元素表示权限数据损坏，必须“禁止所有”，
 *     不能把损坏值降级为空数组后放开全盘访问。
 */
function parseAllowedFolders(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) return ['__deny__'];
    return sanitizeAllowedFolders(parsed);
  } catch {
    return ['__deny__'];
  }
}

function sanitizeAllowedFolders(folders: string[]): string[] {
  if (folders.length === 0) return [];
  if (folders.includes('__deny__')) return ['__deny__'];
  const cleaned = folders.map((folder) => folder.trim().replace(/\\/g, '/'));
  const invalid = cleaned.some((folder) => {
    const absolute = folder.startsWith('/') || /^[A-Za-z]:\//.test(folder);
    if (folder === '' || !absolute) return true;
    if (/(^|\/)\.\.?($|\/)/.test(folder)) return true;
    const normalized = path.posix.normalize(folder);
    return normalized === '.' || normalized === '/' || /^[a-z]:\/$/i.test(normalized);
  });
  return invalid ? ['__deny__'] : cleaned;
}

/**
 * 删除联动/重试准入共用的路径树包含判定（网关与 DB 清理必须同口径，否则
 * 「重试准入认为有残留引用，DB 清理却匹配不到」会各说各话）：
 * 字符串归一（盘符根保留）+ 段边界 + 尽力 realpath（路径已删除时用父目录
 * realpath + 末段回退，符号链接/junction 别名也能归位）+ Windows 大小写不敏感；
 * '/ws' 不命中 '/ws2'。实现在 db.ts 而不是 gateway.ts：gateway 已依赖 db.ts，
 * 反向 import 会形成循环。
 */
export function normalizeForMatch(candidate: string): string {
  const normalized = normalizePath(candidate);
  // 盘符根（C:/）不能去尾斜杠，否则段边界判定失效。
  if (/^[a-z]:\/+$/.test(normalized)) return normalized[0] + ':/';
  const trimmed = normalized.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function foldPathCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** realpath 优先；路径已删除时用「父目录 realpath + 末段」尽力归位；最后退回字符串归一。 */
export function canonicalForMatch(candidate: string): string {
  try {
    return normalizePath(realpathSync(candidate));
  } catch {
    try {
      return normalizePath(path.join(realpathSync(path.dirname(candidate)), path.basename(candidate)));
    } catch {
      return normalizePath(candidate);
    }
  }
}

function isWithinKey(candidateKey: string, rootKey: string): boolean {
  if (rootKey === '' || rootKey === '.') return false;
  if (rootKey === '/' || /^[a-z]:\/$/.test(rootKey)) return candidateKey === rootKey || candidateKey.startsWith(rootKey);
  return candidateKey === rootKey || candidateKey.startsWith(rootKey + '/');
}

export function pathWithinDeletedTree(candidate: string, root: string): boolean {
  if (isWithinKey(foldPathCase(normalizeForMatch(candidate)), foldPathCase(normalizeForMatch(root)))) return true;
  return isWithinKey(
    foldPathCase(normalizeForMatch(canonicalForMatch(candidate))),
    foldPathCase(normalizeForMatch(canonicalForMatch(root))),
  );
}

/** 双向包含 = 同一路径（别名/大小写/分隔符形态不同也算）。 */
export function samePathForMatch(a: string, b: string): boolean {
  return pathWithinDeletedTree(a, b) && pathWithinDeletedTree(b, a);
}

/**
 * 密文判定（users.username / audit_logs 各列共用）：不能只看 v1: 前缀——
 * 明文值恰好以 v1: 开头时会被误判为密文。只有同时满足
 * “v1: 前缀 + 合法 base64 + 长度 ≥ 28（iv12+tag16）”才视为密文。
 */
function looksLikeCipher(s: string): boolean {
  if (!s.startsWith('v1:')) return false;
  try {
    return Buffer.from(s.slice(3), 'base64').length >= 28;
  } catch {
    return false;
  }
}

export class Database {
  private db: DatabaseSync;
  private crypto: FieldCrypto;
  /** 预处理语句缓存：按 SQL 文本复用，避免每次请求重复编译 */
  private stmts = new Map<string, StatementSync>();

  constructor(dbPath: string, crypto: FieldCrypto) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.crypto = crypto;
    // 网关进程与 dsh 插件进程共享同一个库文件：写锁竞争时等待而不是立刻报错
    this.db.exec('PRAGMA busy_timeout = 5000');
    // WAL 允许网关读请求与插件写入并行，降低双进程共享 SQLite 时的锁竞争。
    // 运行时检测结果由 health/启动日志暴露，若文件系统不支持则保留 SQLite 默认模式。
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // 某些只读/特殊挂载环境不支持 WAL，不阻断启动。
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** 显式释放 SQLite 文件句柄（测试/一次性工具使用；常驻服务由进程退出回收）。 */
  close(): void {
    this.stmts.clear();
    this.db.close();
  }

  /** 建表（幂等）+ 旧明文数据一次性迁移为密文 */
  init(): void {
    // 删除内容清零，防止已删除的明文残留在空闲页可被文件扫描恢复
    this.db.exec('PRAGMA secure_delete = ON');
    this.db.exec(SCHEMA);
    // SCHEMA 里的 message_media 唯一索引对所有库无差别执行：旧库若已有同名
    // 非唯一索引，CREATE INDEX IF NOT EXISTS 不会升级它，需显式重建（且去重）。
    migrateMessageMediaUniqueness(this.db);
    this.migrateRoles();
    this.migratePermissions();
    this.purgeOrphanOwnershipRows();
    const changedUsers = this.migrateUsers();
    const changedAudit = this.migrateAuditLogs();
    const changedAttempts = this.migrateLoginAttempts();
    const changed = changedUsers || changedAudit || changedAttempts;
    // 密文比明文长：UPDATE 会写新页，旧页上的明文留在空闲页里。
    // VACUUM 重写整个文件，彻底清除可被 raw 扫描恢复的残留明文。
    // 用 platform_settings 标记确保每个库只执行一次（旧库即使本次
    // 迁移无变化也会补一次 VACUUM）。
    const vacuumed = this.getSetting('enc_migrated_v1') === '1';
    if (changed || !vacuumed) {
      this.db.exec('VACUUM');
      this.setSetting('enc_migrated_v1', '1');
    }
  }

  // ── 迁移：role / credential_version 列补齐 + 首个用户升级为主用户 ──
  private migrateRoles(): void {
    const cols = this.stmt('PRAGMA table_info(users)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'role')) {
      this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    }
    if (!cols.some((c) => c.name === 'credential_version')) {
      this.db.exec('ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0');
    }
    // 若库中还没有主用户（老数据迁移/异常状态），把最早创建的账号提为主用户；
    // 其余账号保持子用户角色。判断只看 role 字段，与账号叫什么名字无关。
    const hasAdmin = this.stmt("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
    if (!hasAdmin) {
      this.db.exec("UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users)");
    }
  }

  // ── 迁移：清理已删除用户残留的孤儿所有权行 ──────────────────────
  // 历史 deleteUser 不清理 user_workspaces，残留行会被当作「另一子用户的
  // 所有权」阻断 baseline 可见性与该目录的登记/创建。幂等：每次启动扫一次。
  // 只清所有权：孤儿权限/授权行无人可读（无害），且旧库迁移场景可能存在
 // 「先导权限行、后建用户」的历史数据，不能误删。
  private purgeOrphanOwnershipRows(): void {
    this.db.exec('DELETE FROM user_workspaces WHERE user_id NOT IN (SELECT id FROM users)');
  }

  // ── 迁移：user_permissions 补 sandbox_mode / disabled_sessions 列 ─────────────────
  private migratePermissions(): void {
    // PRAGMA 只用于建列判定；不可缓存——语句缓存会让后续 ALTER 后的表结构误判
    const before = new Set(
      (this.db.prepare('PRAGMA table_info(user_permissions)').all() as { name: string }[]).map((c) => c.name),
    );
    const addColumn = (name: string, sql: string): void => {
      // 逐个重新探测：ALTER TABLE 会让先前读到的列集合过期，
      // 缓存旧集合会把已存在的列重复 ADD（SQLite 直接报错，启动失败）。
      if (before.has(name)) return;
      this.db.exec(sql);
      before.add(name);
    };
    addColumn('allow_upload', 'ALTER TABLE user_permissions ADD COLUMN allow_upload INTEGER NOT NULL DEFAULT 0');
    addColumn('allow_git_download', 'ALTER TABLE user_permissions ADD COLUMN allow_git_download INTEGER NOT NULL DEFAULT 0');
    addColumn('sandbox_mode', 'ALTER TABLE user_permissions ADD COLUMN sandbox_mode TEXT');
    addColumn(
      'disabled_sessions',
      "ALTER TABLE user_permissions ADD COLUMN disabled_sessions TEXT NOT NULL DEFAULT '[]'",
    );
    addColumn(
      'allow_workspace_create',
      'ALTER TABLE user_permissions ADD COLUMN allow_workspace_create INTEGER NOT NULL DEFAULT 0',
    );
    addColumn('allow_ssh', 'ALTER TABLE user_permissions ADD COLUMN allow_ssh INTEGER NOT NULL DEFAULT 0');
    addColumn('allowed_agent_presets', 'ALTER TABLE user_permissions ADD COLUMN allowed_agent_presets TEXT');
    // allowed_models：NULL = 不限制（新列 = 旧库全部用户保持现有行为），
    // [] = 禁止全部模型（服务端白名单维护，绝不为旧库写入非 NULL 默认值）。
    addColumn('allowed_models', 'ALTER TABLE user_permissions ADD COLUMN allowed_models TEXT');
    // allow_chat_media：独立于 allow_upload 的聊天媒体开关，默认关闭。
    addColumn('allow_chat_media', 'ALTER TABLE user_permissions ADD COLUMN allow_chat_media INTEGER NOT NULL DEFAULT 0');
    // Issue #19：显式会话授权上线前的旧数据迁移标记。列缺失=未初始化；
    // 已初始化的用户不会因后续新会话自动加入授权。
    addColumn(
      'session_grants_seeded',
      'ALTER TABLE user_permissions ADD COLUMN session_grants_seeded INTEGER NOT NULL DEFAULT 0',
    );
    this.normalizeMediaPermissionColumns();
  }

  /**
   * allow_chat_media 归一：旧库/手工 SQL 可能留下 NULL（列由外部进程补加）或
   * 0/1 之外的脏值。NULL 会让读取侧按“未授权”处理，但写入侧要与显式开关
   * 区分，统一折叠为 0，保证 getPermissions 永远返回布尔值。
   */
  private normalizeMediaPermissionColumns(): void {
    this.db.exec('UPDATE user_permissions SET allow_chat_media = 0 WHERE allow_chat_media IS NULL');
  }

  // ── 迁移：users.username 明文 → 密文 + username_hash ──────────
  private migrateUsers(): boolean {
    const cols = this.stmt('PRAGMA table_info(users)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'username_hash')) {
      this.db.exec('ALTER TABLE users ADD COLUMN username_hash TEXT');
    }
    // 索引必须在列存在之后创建（旧库无此列时不能在建表阶段引用它）
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_hash ON users(username_hash) WHERE username_hash IS NOT NULL',
    );
    const rows = this.stmt('SELECT id, username, username_hash FROM users').all() as {
      id: number;
      username: string;
      username_hash: string | null;
    }[];
    const upd = this.stmt('UPDATE users SET username = ?, username_hash = ? WHERE id = ?');
    let changed = false;
    for (const row of rows) {
      // 密文判定与 users 表同口径（looksLikeCipher）；
      // 明文恰好以 v1: 开头但不满足密文形态的（如伪造 UA）也会被加密。
      const isCipher = looksLikeCipher(row.username);
      let plain: string | null = null;
      if (isCipher) {
        const decrypted = this.crypto.decrypt(row.username);
        // 解密失败返回 '⟨无法解密⟩' 占位符：跳过该行并告警，
        // 绝不能把占位符当明文加密写回（否则原始密文被覆盖，数据永久丢失）
        if (decrypted === '⟨无法解密⟩') {
          console.error(`[dsh-passwords] 迁移跳过用户 id=${row.id}：username 解密失败（密钥不匹配或数据损坏）`);
          continue;
        }
        plain = decrypted;
      } else {
        plain = row.username;
      }
      if (!isCipher || !row.username_hash) {
        this.db.exec('BEGIN');
        try {
          upd.run(this.crypto.encrypt(plain!), this.crypto.lookupHash(plain!), row.id);
          this.db.exec('COMMIT');
          changed = true;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      }
    }
    return changed;
  }

  // ── 迁移：audit_logs 敏感列明文 → 密文 ─────────────────────────
  private migrateAuditLogs(): boolean {
    const rows = this.stmt('SELECT id, username, ip, user_agent, detail FROM audit_logs').all() as {
      id: number;
      username: string | null;
      ip: string | null;
      user_agent: string | null;
      detail: string | null;
    }[];
    const upd = this.stmt(
      'UPDATE audit_logs SET username = ?, ip = ?, user_agent = ?, detail = ? WHERE id = ?',
    );
    let changed = false;
    for (const row of rows) {
      // 与 users 表同口径的密文判定：v1: 前缀 + 合法 base64 + 长度足够才视为已加密，
      // 否则按明文加密写回（明文恰好以 v1: 开头也不会残留）
      const encIfNeeded = (v: string | null) =>
        v !== null && !looksLikeCipher(v) ? this.crypto.encrypt(v) : v;
      const username = encIfNeeded(row.username);
      const ip = encIfNeeded(row.ip);
      const userAgent = encIfNeeded(row.user_agent);
      const detail = encIfNeeded(row.detail);
      if (username !== row.username || ip !== row.ip || userAgent !== row.user_agent || detail !== row.detail) {
        this.db.exec('BEGIN');
        try {
          upd.run(username, ip, userAgent, detail, row.id);
          this.db.exec('COMMIT');
          changed = true;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      }
    }
    return changed;
  }

  // ── 迁移：login_attempts 明文 username/ip → HMAC 散列 ─────────
  private migrateLoginAttempts(): boolean {
    const cols = this.stmt('PRAGMA table_info(login_attempts)').all() as { name: string }[];
    if (cols.some((c) => c.name === 'username_hash')) return false; // 已迁移
    const rows = this.stmt(
      'SELECT username, ip, failed_count, locked_until, updated_at FROM login_attempts',
    ).all() as {
      username: string;
      ip: string | null;
      failed_count: number;
      locked_until: string | null;
      updated_at: string;
    }[];
    this.db.exec('BEGIN');
    try {
      this.db.exec(`
        CREATE TABLE login_attempts_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          username_hash TEXT NOT NULL,
          ip_hash       TEXT NOT NULL,
          failed_count INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT,
          updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(username_hash, ip_hash)
        );
      `);
      const ins = this.stmt(
        'INSERT INTO login_attempts_new (username_hash, ip_hash, failed_count, locked_until, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const row of rows) {
        ins.run(
          this.crypto.lookupHash(row.username),
          this.crypto.lookupHash(row.ip ?? ''),
          Number(row.failed_count),
          row.locked_until,
          row.updated_at,
        );
      }
      this.db.exec('DROP TABLE login_attempts');
      this.db.exec('ALTER TABLE login_attempts_new RENAME TO login_attempts');
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async health(): Promise<boolean> {
    try {
      this.stmt('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  getUserByUsername(username: string): UserRow | null {
    const hash = this.crypto.lookupHash(username);
    const row = this.stmt(
      'SELECT id, username, password_hash, role, credential_version, created_at, last_login_at FROM users WHERE username_hash = ?',
    ).get(hash) as Omit<UserRow, 'username'> & { username: string } | undefined;
    if (!row) return null;
    return { ...row, username: this.crypto.decrypt(row.username) ?? username };
  }

  getUserById(id: number): UserRow | null {
    const row = this.stmt(
      'SELECT id, username, password_hash, role, credential_version, created_at, last_login_at FROM users WHERE id = ?',
    ).get(id) as Omit<UserRow, 'username'> & { username: string } | undefined;
    if (!row) return null;
    return { ...row, username: this.crypto.decrypt(row.username) ?? '' };
  }

  /**
   * 单用户的安全投影（不含 password_hash / credential_version），
   * 供外部接口返回“自己”行时使用（F-10：state 接口不得泄露 bcrypt 哈希）。
   */
  getUserListRowById(id: number): UserListRow | null {
    const row = this.stmt(
      'SELECT id, username, role, created_at, last_login_at FROM users WHERE id = ?',
    ).get(id) as (Omit<UserListRow, 'username'> & { username: string }) | undefined;
    if (!row) return null;
    return {
      id: row.id,
      username: this.crypto.decrypt(row.username) ?? '',
      role: row.role === 'admin' ? 'admin' : 'user',
      created_at: row.created_at,
      last_login_at: row.last_login_at,
    };
  }

  /** 用户列表（用户名已解密），按创建顺序 */
  listUsers(): UserListRow[] {
    const rows = this.stmt(
      'SELECT id, username, role, created_at, last_login_at FROM users ORDER BY id ASC',
    ).all() as (Omit<UserListRow, 'username'> & { username: string })[];
    return rows.map((row) => ({
      id: row.id,
      username: this.crypto.decrypt(row.username) ?? '',
      role: row.role === 'admin' ? 'admin' : 'user',
      created_at: row.created_at,
      last_login_at: row.last_login_at,
    }));
  }

  /**
   * 与某用户有消息往来的其他用户（F-05：子用户的 state 接口只暴露这些人，
   * 避免全量用户目录泄露给低权限账号）。含主动/被动双向：我是发件人或收件人。
   */
  listMessageContacts(userId: number): UserListRow[] {
    const rows = this.stmt(
      `SELECT DISTINCT u.id, u.username, u.role, u.created_at, u.last_login_at
       FROM messages m
       JOIN users u ON u.id = m.sender_id OR u.id = m.recipient_id
       WHERE (m.sender_id = ? OR m.recipient_id = ?) AND u.id != ?`,
    ).all(userId, userId, userId) as (Omit<UserListRow, 'username'> & { username: string })[];
    return rows.map((row) => ({
      id: row.id,
      username: this.crypto.decrypt(row.username) ?? '',
      role: row.role === 'admin' ? 'admin' : 'user',
      created_at: row.created_at,
      last_login_at: row.last_login_at,
    }));
  }

  countUsers(): number {
    const row = this.stmt('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return Number(row?.n ?? 0);
  }

  createUser(username: string, passwordHash: string, role: UserRole = 'user'): UserRow {
    const result = this.stmt(
      'INSERT INTO users (username, username_hash, password_hash, role) VALUES (?, ?, ?, ?)',
    ).run(this.crypto.encrypt(username), this.crypto.lookupHash(username), passwordHash, role);
    return {
      id: Number(result.lastInsertRowid),
      username,
      password_hash: passwordHash,
      role,
      credential_version: 0,
      created_at: new Date().toISOString(),
      last_login_at: null,
    };
  }

  /** 原子地创建首个主用户；并发 setup 时仅一个调用能成功。 */
  setupInitialAdmin(username: string, passwordHash: string): UserRow | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.countUsers() > 0) {
        this.db.exec('COMMIT');
        return null;
      }
      const user = this.createUser(username, passwordHash, 'admin');
      this.setSetting('installed_at', new Date().toISOString());
      this.db.exec('COMMIT');
      return user;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 改名（用户名密文 + 等值索引一起更新；同时 bump credential_version 使旧会话全部失效） */
  updateUsername(id: number, username: string): void {
    this.stmt('UPDATE users SET username = ?, username_hash = ?, credential_version = credential_version + 1 WHERE id = ?').run(
      this.crypto.encrypt(username),
      this.crypto.lookupHash(username),
      id,
    );
  }

  /** 改密：credential_version +1，旧会话（签入时版本号）立即失效 */
  updatePasswordHash(id: number, passwordHash: string): void {
    this.stmt(
      'UPDATE users SET password_hash = ?, credential_version = credential_version + 1 WHERE id = ?',
    ).run(passwordHash, id);
  }

  /**
   * 删除用户（级联）：权限、用量、工作区所有权、授权、登录失败记录、该用户
   * 发出的/收到的消息关系与该用户拥有的媒体元数据。
   *
   * 文件本体归网关管：调用方要么先用 peekUserMediaRemoval(userId) 取待删
   * storage keys（推荐，deleteUser 之后按键删文件），要么在删除后调用
   * pruneMedia() 回收无主文件。
   */
  deleteUser(id: number): void {
    // 无外键约束（SQLite 未开 FK），关联行需手动级联清理：
    // user_workspaces 必须一并清理：残留孤儿行会被当作「另一子用户的所有权」
    // 阻断 baseline 可见性与该目录的登记/创建。
    // 媒体：先删关系再删资产，否则 message_media 会留下指向已删资产的孤儿行
    // （孤儿关系会让 mediaAttachedToAnyMessage 永远为真，永久阻断删除/GC）。
    const user = this.getUserById(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (user) {
        this.stmt('DELETE FROM login_attempts WHERE username_hash = ?').run(this.crypto.lookupHash(user.username));
      }

      this.stmt('DELETE FROM user_permissions WHERE user_id = ?').run(id);
      this.stmt('DELETE FROM user_session_grants WHERE user_id = ?').run(id);
      this.stmt('DELETE FROM user_usage WHERE user_id = ?').run(id);
      this.stmt('DELETE FROM user_workspaces WHERE user_id = ?').run(id);
      this.deleteMediaRelationsOfUser(id);
      this.stmt('DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?').run(id, id);
      this.stmt('DELETE FROM media_assets WHERE owner_id = ?').run(id);
      this.stmt('DELETE FROM users WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * 该用户拥有的媒体资产对应的待删除 storage keys（只读，不修改任何数据）。
   * 网关删除用户前先取一次，deleteUser 成功后按返回值删文件（DB 层不删文件）。
   */
  peekUserMediaRemoval(userId: number): MediaRemovalPlan {
    return this.collectMediaRemoval(
      'SELECT id, storage_key FROM media_assets WHERE owner_id = ?',
      userId,
    );
  }

  /** 删除与该用户消息相关的关系行（含“我发的”与“发给我的”）。 */
  private deleteMediaRelationsOfUser(userId: number): void {
    this.stmt(
      `DELETE FROM message_media WHERE message_id IN (
         SELECT id FROM messages WHERE sender_id = ? OR recipient_id = ?
       )`,
    ).run(userId, userId);
    this.stmt(
      `DELETE FROM message_media WHERE media_id IN (SELECT id FROM media_assets WHERE owner_id = ?)`,
    ).run(userId);
  }

  private collectMediaRemoval(sql: string, ...params: (string | number)[]): MediaRemovalPlan {
    const rows = this.stmt(sql).all(...params) as { id: string; storage_key: string }[];
    return {
      media_ids: rows.map((row) => String(row.id)),
      storage_keys: rows.map((row) => String(row.storage_key)).filter((key) => key !== ''),
    };
  }

  /**
   * 清理两类不再需要的媒体元数据（文件本体由调用方按返回的 storage keys 删除）：
   *   1. 已过期且未被任何消息占用的资产（过期可含 pending）；
   *   2. 早于 pendingCutoff 仍未完成上传的 pending 资产（未提交上传的清理）。
   * now / pendingCutoff 省略时分别取当前时间 / 不清理 pending。
   * 内部先删关系再删元数据，不会产生孤儿关系行。
   */
  pruneMedia(options: { pendingCutoff?: string | Date | null; now?: string | Date } = {}): MediaRemovalPlan {
    const nowText = this.sqliteTime(options.now ?? new Date());
    const pendingCutoff = this.sqliteTime(options.pendingCutoff);
    const expired = this.stmt(
      `SELECT id, storage_key FROM media_assets
        WHERE expires_at IS NOT NULL AND expires_at <= ?
          AND id NOT IN (SELECT media_id FROM message_media)`,
    ).all(nowText) as { id: string; storage_key: string }[];
    const stale = pendingCutoff === null
      ? []
      : (this.stmt(
          `SELECT id, storage_key FROM media_assets
            WHERE state = 'pending' AND created_at < ?
              AND id NOT IN (SELECT media_id FROM message_media)`,
        ).all(pendingCutoff) as { id: string; storage_key: string }[]);
    const targets = new Map<string, string>();
    for (const row of [...expired, ...stale]) targets.set(String(row.id), String(row.storage_key));
    if (targets.size === 0) return { media_ids: [], storage_keys: [] };
    const ids = [...targets.keys()];
    const placeholders = ids.map(() => '?').join(', ');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.stmt(`DELETE FROM message_media WHERE media_id IN (${placeholders})`).run(...ids);
      this.stmt(`DELETE FROM media_assets WHERE id IN (${placeholders})`).run(...ids);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      media_ids: ids,
      storage_keys: [...targets.values()].filter((key) => key !== ''),
    };
  }

  touchLogin(userId: number): void {
    this.stmt("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  }

  /** 登录失败锁定清理目标也同步抹掉（删除用户时调用） */
  clearLoginAttemptsOf(username: string): void {
    this.stmt('DELETE FROM login_attempts WHERE username_hash = ?').run(
      this.crypto.lookupHash(username),
    );
  }

  getSetting(key: string): string | null {
    const row = this.stmt('SELECT v FROM platform_settings WHERE k = ?').get(key) as
      | { v: string }
      | undefined;
    return row ? String(row.v) : null;
  }

  setSetting(key: string, value: string): void {
    this.stmt(
      'INSERT INTO platform_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    ).run(key, value);
  }

  // ── 网络安全审查：审计日志（敏感字段静态加密） ────────────────
  /** 审计写入计数：每 500 条修剪一次最旧记录（上限保护，防长期运行/攻击刷爆磁盘） */
  private auditInsertCount = 0;
  private static readonly AUDIT_MAX_ROWS = 50_000;
  private static readonly AUDIT_PRUNE_EVERY = 500;

  audit(
    eventType: string,
    opts: { username?: string | null; ip?: string | null; userAgent?: string | null; detail?: string | null } = {},
  ): void {
    try {
      this.stmt(
        'INSERT INTO audit_logs (event_type, username, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?)',
      ).run(
        eventType,
        this.crypto.encrypt(opts.username ?? null),
        this.crypto.encrypt(opts.ip ?? null),
        this.crypto.encrypt(opts.userAgent ?? null),
        this.crypto.encrypt(opts.detail ?? null),
      );
      this.auditInsertCount++;
      if (this.auditInsertCount % Database.AUDIT_PRUNE_EVERY === 0) {
        try {
          this.stmt('DELETE FROM audit_logs WHERE id <= (SELECT MAX(id) - ? FROM audit_logs)').run(
            Database.AUDIT_MAX_ROWS,
          );
        } catch (error) {
          // 修剪失败（磁盘满/数据库锁）：记录告警——表会持续增长，不能静默
          console.warn('[dsh-passwords] 审计日志修剪失败（表可能持续增长）:', String(error));
        }
      }
    } catch {
      // 审计写入失败不阻断主流程
    }
  }

  listAuditLogs(limit = 30): AuditLogRow[] {
    const rows = this.stmt(
      'SELECT id, event_type, username, ip, user_agent, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT ?',
    ).all(Math.min(Math.max(limit, 1), 100)) as unknown as AuditLogRow[];
    return rows.map((row) => ({
      ...row,
      username: this.crypto.decrypt(row.username),
      ip: this.crypto.decrypt(row.ip),
      user_agent: this.crypto.decrypt(row.user_agent),
      detail: this.crypto.decrypt(row.detail),
    }));
  }

  // ── 网络安全审查：防暴力破解（仅存 HMAC 散列，不含明文） ────────
  getLoginAttempt(username: string, ip: string): { failed_count: number; locked_until: Date | null } | null {
    const row = this.stmt(
      'SELECT failed_count, locked_until FROM login_attempts WHERE username_hash = ? AND ip_hash = ?',
    ).get(this.crypto.lookupHash(username), this.crypto.lookupHash(ip)) as
      | { failed_count: number; locked_until: string | null }
      | undefined;
    return row
      ? { failed_count: Number(row.failed_count), locked_until: row.locked_until ? new Date(row.locked_until) : null }
      : null;
  }

  recordLoginFailure(username: string, ip: string): number {
    this.stmt(
      `INSERT INTO login_attempts (username_hash, ip_hash, failed_count, updated_at) VALUES (?, ?, 1, datetime('now'))
       ON CONFLICT(username_hash, ip_hash) DO UPDATE SET
         failed_count = failed_count + 1,
         updated_at = datetime('now')`,
    ).run(this.crypto.lookupHash(username), this.crypto.lookupHash(ip));
    return this.getLoginAttempt(username, ip)?.failed_count ?? 1;
  }

  /** 该用户名在所有 IP 上的总失败次数（防分布式爆破：轮换 IP 绕过单 (user,ip) 锁定） */
  countFailuresByUsername(username: string): number {
    const row = this.stmt(
      'SELECT COALESCE(SUM(failed_count), 0) AS n FROM login_attempts WHERE username_hash = ?',
    ).get(this.crypto.lookupHash(username)) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** 锁定该用户名在所有 IP 上的失败记录（分布式爆破兜底） */
  lockAllAttemptsByUsername(username: string, until: Date): void {
    this.stmt("UPDATE login_attempts SET locked_until = ?, updated_at = datetime('now') WHERE username_hash = ?").run(
      until.toISOString(),
      this.crypto.lookupHash(username),
    );
  }

  lockLoginAttempt(username: string, ip: string, until: Date): void {
    this.stmt(
      `INSERT INTO login_attempts (username_hash, ip_hash, failed_count, locked_until, updated_at) VALUES (?, ?, 0, ?, datetime('now'))
       ON CONFLICT(username_hash, ip_hash) DO UPDATE SET
         locked_until = excluded.locked_until,
         updated_at = datetime('now')`,
    ).run(this.crypto.lookupHash(username), this.crypto.lookupHash(ip), until.toISOString());
  }

  resetLoginAttempts(username: string, ip: string): void {
    this.stmt('DELETE FROM login_attempts WHERE username_hash = ? AND ip_hash = ?').run(
      this.crypto.lookupHash(username),
      this.crypto.lookupHash(ip),
    );
  }

  // ── 网络安全审查：IP 级节流（防密码喷洒：单 IP 轮换多用户名） ─────
  getIpThrottle(ip: string): { failed_count: number; window_started: Date; throttled_until: Date | null } | null {
    const row = this.stmt(
      'SELECT failed_count, window_started, throttled_until FROM ip_throttle WHERE ip_hash = ?',
    ).get(this.crypto.lookupHash(ip)) as
      | { failed_count: number; window_started: string; throttled_until: string | null }
      | undefined;
    return row
      ? {
          failed_count: Number(row.failed_count),
          window_started: new Date(row.window_started),
          throttled_until: row.throttled_until ? new Date(row.throttled_until) : null,
        }
      : null;
  }

  /**
   * 记录该 IP 的一次登录失败（跨用户名累计）。窗口过期或上次节流已到期时
   * 重置计数，避免被误伤用户“试一次又续 30 分钟”。返回窗口内累计失败数。
   */
  recordIpFailure(ip: string, windowMs: number): number {
    const now = new Date();
    const hash = this.crypto.lookupHash(ip);
    const existing = this.getIpThrottle(ip);
    if (!existing) {
      this.stmt("INSERT INTO ip_throttle (ip_hash, failed_count, window_started, updated_at) VALUES (?, 1, ?, datetime('now'))").run(
        hash,
        now.toISOString(),
      );
      return 1;
    }
    const windowExpired = now.getTime() - existing.window_started.getTime() > windowMs;
    const throttleExpired = existing.throttled_until !== null && existing.throttled_until.getTime() <= now.getTime();
    if (windowExpired || throttleExpired) {
      this.stmt(
        "UPDATE ip_throttle SET failed_count = 1, window_started = ?, throttled_until = NULL, updated_at = datetime('now') WHERE ip_hash = ?",
      ).run(now.toISOString(), hash);
      return 1;
    }
    this.stmt("UPDATE ip_throttle SET failed_count = failed_count + 1, updated_at = datetime('now') WHERE ip_hash = ?").run(hash);
    return existing.failed_count + 1;
  }

  /** 节流该 IP：窗口内失败达阈值后设置过期时间（期间拒绝一切登录尝试） */
  throttleIp(ip: string, until: Date): void {
    this.stmt('UPDATE ip_throttle SET throttled_until = ?, updated_at = datetime(\'now\') WHERE ip_hash = ?').run(
      until.toISOString(),
      this.crypto.lookupHash(ip),
    );
  }

  /** 登录成功后清除该 IP 的节流记录（正常用户不再受限） */
  resetIpThrottle(ip: string): void {
    this.stmt('DELETE FROM ip_throttle WHERE ip_hash = ?').run(this.crypto.lookupHash(ip));
  }

  // ── 子用户权限（网关强制执行） ────────────────────────────
  getPermissions(userId: number): UserPermissionsRow | null {
    const row = this.stmt(
      'SELECT user_id, allowed_folders, hourly_token_limit, daily_minutes_limit, allow_upload, allow_git_download, allow_workspace_create, allow_ssh, allowed_agent_presets, allowed_models, allow_chat_media, banned, sandbox_mode, disabled_sessions, updated_at FROM user_permissions WHERE user_id = ?',
    ).get(userId) as
      | {
          user_id: number;
          allowed_folders: string | null;
          hourly_token_limit: number | null;
          daily_minutes_limit: number | null;
          allow_upload: number;
          allow_git_download: number;
          allow_workspace_create: number;
          allow_ssh: number;
          allowed_agent_presets: string | null;
          allowed_models: string | null;
          allow_chat_media: number;
          banned: number;
          sandbox_mode: string | null;
          disabled_sessions: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      user_id: row.user_id,
      allowed_folders: parseAllowedFolders(row.allowed_folders),
      hourly_token_limit: row.hourly_token_limit,
      daily_minutes_limit: row.daily_minutes_limit,
      allow_upload: row.allow_upload === 1,
      allow_git_download: row.allow_git_download === 1,
      allow_workspace_create: row.allow_workspace_create === 1,
      allow_ssh: row.allow_ssh === 1,
      allowed_agent_presets: row.allowed_agent_presets === null ? null : parseJsonArray(row.allowed_agent_presets),
      allowed_models: row.allowed_models === null ? null : parseJsonArray(row.allowed_models),
      allow_chat_media: row.allow_chat_media === 1,
      banned: row.banned === 1,
      sandbox_mode: row.sandbox_mode,
      disabled_sessions: parseJsonArray(row.disabled_sessions),
      updated_at: row.updated_at,
    };
  }

  setPermissions(
    userId: number,
    perms: {
      allowedFolders: string[];
      hourlyTokenLimit: number | null;
      dailyMinutesLimit: number | null;
      allowUpload: boolean;
      allowGitDownload: boolean;
      allowWorkspaceCreate: boolean;
      allowSsh?: boolean;
      allowedAgentPresets?: string[] | null;
      allowedModels?: string[] | null;
      allowChatMedia?: boolean;
      banned: boolean;
      sandboxMode?: string | null;
      disabledSessions?: string[];
      allowedSessionIds?: string[];
    },
  ): void {
    // 防御性清洗：空串/当前目录/根目录条目在 folderAllowed 里语义=全盘允许
    // （fail-open 陷阱）——网关端点已拒绝，数据层再兑底一次。
    const allowedFolders = sanitizeAllowedFolders(perms.allowedFolders);
    const current = this.getPermissions(userId);
    const disabledSessions = [...new Set(
      (perms.disabledSessions ?? current?.disabled_sessions ?? [])
        .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200),
    )].slice(0, 2000);
    const sandboxMode = perms.sandboxMode === undefined ? current?.sandbox_mode ?? null : perms.sandboxMode;
    const allowedSessionIds = [...new Set(
      (perms.allowedSessionIds ?? []).filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200),
    )].slice(0, 2000);
    const allowSsh = perms.allowSsh ?? current?.allow_ssh ?? false;
    const allowedAgentPresets = perms.allowedAgentPresets === undefined
      ? current?.allowed_agent_presets ?? null
      : perms.allowedAgentPresets === null
        ? null
        : [...new Set(perms.allowedAgentPresets.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(0, 256);
    const allowedModels = perms.allowedModels === undefined
      ? current?.allowed_models ?? null
      : perms.allowedModels === null
        ? null
        : [...new Set(perms.allowedModels.filter((id) => typeof id === 'string' && /^[^/\s]{1,100}\/[^\s]{1,200}$/.test(id)))].slice(0, 512);
    const allowChatMedia = perms.allowChatMedia ?? current?.allow_chat_media ?? false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.stmt(
      `INSERT INTO user_permissions (user_id, allowed_folders, hourly_token_limit, daily_minutes_limit, allow_upload, allow_git_download, allow_workspace_create, allow_ssh, allowed_agent_presets, allowed_models, allow_chat_media, banned, sandbox_mode, disabled_sessions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         allowed_folders = excluded.allowed_folders,
         hourly_token_limit = excluded.hourly_token_limit,
         daily_minutes_limit = excluded.daily_minutes_limit,
         allow_upload = excluded.allow_upload,
         allow_git_download = excluded.allow_git_download,
         allow_workspace_create = excluded.allow_workspace_create,
         allow_ssh = excluded.allow_ssh,
         allowed_agent_presets = excluded.allowed_agent_presets,
         allowed_models = excluded.allowed_models,
         allow_chat_media = excluded.allow_chat_media,
         banned = excluded.banned,
         sandbox_mode = excluded.sandbox_mode,
         disabled_sessions = excluded.disabled_sessions,
         updated_at = datetime('now')`,
    ).run(
      userId,
      JSON.stringify(allowedFolders),
      perms.hourlyTokenLimit,
      perms.dailyMinutesLimit,
      perms.allowUpload ? 1 : 0,
      perms.allowGitDownload ? 1 : 0,
      perms.allowWorkspaceCreate ? 1 : 0,
      allowSsh ? 1 : 0,
      allowedAgentPresets === null ? null : JSON.stringify(allowedAgentPresets),
      allowedModels === null ? null : JSON.stringify(allowedModels),
      allowChatMedia ? 1 : 0,
      perms.banned ? 1 : 0,
      sandboxMode,
      JSON.stringify(disabledSessions),
      );
      if (perms.allowedSessionIds !== undefined) {
        this.stmt('DELETE FROM user_session_grants WHERE user_id = ?').run(userId);
        const insertGrant = this.stmt('INSERT INTO user_session_grants (user_id, session_id) VALUES (?, ?)');
        for (const sessionId of allowedSessionIds) insertGrant.run(userId, sessionId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ── 子用户显式会话授权 ──────────────────────────
  /** 读取用户已被管理员明确授予的会话 ID；空数组表示未授予任何会话。 */
  listUserSessionGrants(userId: number): string[] {
    return (
      this.stmt('SELECT session_id FROM user_session_grants WHERE user_id = ? ORDER BY session_id').all(userId) as {
        session_id: string;
      }[]
    ).map((row) => row.session_id);
  }

  /** Issue #19 旧数据迁移标记：该用户的显式会话授权是否已初始化。
   *  未初始化时，网关会在其首次 workspace.list 成功后种子化可见既有会话。 */
  isSessionGrantsSeeded(userId: number): boolean {
    const row = this.stmt('SELECT session_grants_seeded FROM user_permissions WHERE user_id = ?').get(userId) as {
      session_grants_seeded: number;
    } | undefined;
    return row?.session_grants_seeded === 1;
  }

  markSessionGrantsSeeded(userId: number): void {
    this.stmt(
      "UPDATE user_permissions SET session_grants_seeded = 1, updated_at = datetime('now') WHERE user_id = ?",
    ).run(userId);
  }

  hasUserSessionGrant(userId: number, sessionId: string): boolean {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) return false;
    return this.stmt('SELECT 1 FROM user_session_grants WHERE user_id = ? AND session_id = ?').get(userId, sessionId) !== undefined;
  }

  /** 原子替换一个用户的全部显式会话授权；任何异常都会保留原集合。 */
  replaceUserSessionGrants(userId: number, sessionIds: string[]): void {
    const normalized = [...new Set(
      sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200),
    )].slice(0, 2000);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.stmt('DELETE FROM user_session_grants WHERE user_id = ?').run(userId);
      const insert = this.stmt('INSERT INTO user_session_grants (user_id, session_id) VALUES (?, ?)');
      for (const sessionId of normalized) insert.run(userId, sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ── 子用户创建的工作区 ─────────────────────────
  addUserWorkspace(userId: number, workspacePath: string): void {
    this.stmt(
      'INSERT OR IGNORE INTO user_workspaces (user_id, path) VALUES (?, ?)',
    ).run(userId, normalizePath(workspacePath));
  }

  addAllowedFolder(userId: number, workspacePath: string): void {
    const canonical = normalizePath(workspacePath);
    const current = this.getPermissions(userId);
    if (!current || current.allowed_folders.includes('__deny__')) {
      if (current) this.setPermissions(userId, { allowedFolders: [canonical], hourlyTokenLimit: current.hourly_token_limit, dailyMinutesLimit: current.daily_minutes_limit, allowUpload: current.allow_upload, allowGitDownload: current.allow_git_download, allowWorkspaceCreate: current.allow_workspace_create, banned: current.banned, sandboxMode: current.sandbox_mode, disabledSessions: current.disabled_sessions });
      return;
    }
    if (!current.allowed_folders.some((entry) => normalizePath(entry) === canonical)) {
      this.setPermissions(userId, { allowedFolders: [...current.allowed_folders, canonical], hourlyTokenLimit: current.hourly_token_limit, dailyMinutesLimit: current.daily_minutes_limit, allowUpload: current.allow_upload, allowGitDownload: current.allow_git_download, allowWorkspaceCreate: current.allow_workspace_create, banned: current.banned, sandboxMode: current.sandbox_mode, disabledSessions: current.disabled_sessions });
    }
  }

  listUserWorkspacePaths(userId: number): string[] {
    return (this.stmt('SELECT path FROM user_workspaces WHERE user_id = ?').all(userId) as { path: string }[]).map((row) => row.path);
  }

  listWorkspaceOwners(): Array<{ userId: number; path: string }> {
    return (this.stmt('SELECT user_id AS userId, path FROM user_workspaces').all() as Array<{ userId: number; path: string }>).map((row) => ({ ...row, path: normalizePath(row.path) }));
  }

  removeUserWorkspace(userId: number, workspacePath: string): void {
    this.stmt('DELETE FROM user_workspaces WHERE user_id = ? AND path = ?').run(userId, normalizePath(workspacePath));
  }

  renameUserWorkspace(userId: number, oldPath: string, newPath: string): void {
    this.stmt('UPDATE user_workspaces SET path = ? WHERE user_id = ? AND path = ?').run(normalizePath(newPath), userId, normalizePath(oldPath));
  }

  /**
   * 目录树删除联动清理：把被删路径树内的归属行、白名单条目与会话授权在一个事务里清掉。
   *
   * 为什么白名单删空必须回落 `__deny__`：`folderAllowed` 把空 allowed_folders 当作
   * “不限制任何目录”（fail-open）。若用户仅剩的白名单目录被删除后留下空数组，该子用户
   * 会瞬间获得全盘工作区权限；因此清空时必须写回 `__deny__` 哨兵。
   *
   * @param deletedRoot - 被删除（或即将删除）的目录；调用方保证已 realpath 规范化。
   * @param sessionIds - 明确归属该目录树的会话（注册表快照 / cwd 映射得出）。
   * @returns 需要失效内存快照与 Remote mux 的用户、以及各表清理计数。
   */
  cleanupDeletedWorkspaceTree(
    deletedRoot: string,
    sessionIds: readonly string[] = [],
  ): {
    invalidateUserIds: number[];
    removedWorkspaces: number;
    removedFolders: number;
    removedGrants: number;
  } {
    const invalidate = new Set<number>();
    let removedWorkspaces = 0;
    let removedFolders = 0;
    let removedGrants = 0;
    const doomedSessions = new Set(
      sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200),
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 归属行按数据库中的原始 path 删除，避免历史行分隔符/大小写与规范化结果不一致而漏删。
      const deleteWorkspaceRow = this.stmt('DELETE FROM user_workspaces WHERE user_id = ? AND path = ?');
      const ownershipRows = this.stmt('SELECT user_id AS user_id, path AS path FROM user_workspaces').all() as Array<{
        user_id: number;
        path: string;
      }>;
      for (const row of ownershipRows) {
        if (!pathWithinDeletedTree(row.path, deletedRoot)) continue;
        deleteWorkspaceRow.run(row.user_id, row.path);
        removedWorkspaces += 1;
        invalidate.add(row.user_id);
      }
      if (doomedSessions.size > 0) {
        const deleteGrant = this.stmt('DELETE FROM user_session_grants WHERE user_id = ? AND session_id = ?');
        const grantRows = this.stmt('SELECT user_id AS user_id, session_id AS session_id FROM user_session_grants').all() as Array<{
          user_id: number;
          session_id: string;
        }>;
        for (const row of grantRows) {
          if (!doomedSessions.has(row.session_id)) continue;
          deleteGrant.run(row.user_id, row.session_id);
          removedGrants += 1;
          invalidate.add(row.user_id);
        }
      }
      const updateFolders = this.stmt(
        "UPDATE user_permissions SET allowed_folders = ?, updated_at = datetime('now') WHERE user_id = ?",
      );
      const permissionRows = this.stmt('SELECT user_id AS user_id, allowed_folders FROM user_permissions').all() as Array<{
        user_id: number;
        allowed_folders: string | null;
      }>;
      for (const row of permissionRows) {
        // 空数组=不限制（不能动）；__deny__/损坏值保持原样（parseAllowedFolders 已 fail-closed）。
        const folders = parseAllowedFolders(row.allowed_folders);
        if (folders.length === 0 || folders.includes('__deny__')) continue;
        const kept = folders.filter((folder) => !pathWithinDeletedTree(folder, deletedRoot));
        if (kept.length === folders.length) continue;
        const next = kept.length === 0 ? ['__deny__'] : kept;
        updateFolders.run(JSON.stringify(next), row.user_id);
        removedFolders += folders.length - kept.length;
        invalidate.add(row.user_id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      // 原始错误必须优先（回滚失败不能掩盖它）：事务可能已被 SQLite 自动回滚。
      try { this.db.exec('ROLLBACK'); } catch { /* 无活动事务 */ }
      throw error;
    }
    return { invalidateUserIds: [...invalidate], removedWorkspaces, removedFolders, removedGrants };
  }

  // ── 删除联动的清理意图（跨重启的重试凭证） ───────────────
  /**
   * 记录/合并一条清理意图：仅当物理删除已完成但 DB 清理失败时调用。
   * root 由调用方保证来自服务端 realpath/归一化结果，sessionIds 只保留合法
   * 长度并去重；已有同一路径（含别名/大小写形态）的行时合并会话集，不产生第二行。
   */
  recordWorkspaceCleanupIntent(root: string, sessionIds: readonly string[], ownerUserId: number): void {
    if (typeof root !== 'string' || root === '' || root.length > 4096) {
      throw new Error('cleanup intent root invalid');
    }
    if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) {
      throw new Error('cleanup intent owner invalid');
    }
    const normalizedRoot = normalizeForMatch(root);
    const sessions = [...new Set(
      sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200),
    )].slice(0, 2000);
    // 同一路径的两个并发删除都可能在 DB 清理失败后写入意图。先拿 SQLite 写锁再
    // 查找/合并，避免 find→INSERT 的竞态把第二个请求误报为“不可重试”。
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.findWorkspaceCleanupIntent(normalizedRoot);
      if (existing !== null) {
        const merged = [...new Set([...existing.sessionIds, ...sessions])].slice(0, 2000);
        this.stmt(
          "UPDATE workspace_cleanup_intents SET session_ids = ?, owner_user_id = ?, created_at = datetime('now') WHERE root = ?",
        ).run(JSON.stringify(merged), ownerUserId, existing.root);
      } else {
        this.stmt(
          'INSERT INTO workspace_cleanup_intents (root, session_ids, owner_user_id) VALUES (?, ?, ?)',
        ).run(normalizedRoot, JSON.stringify(sessions), ownerUserId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 无活动事务 */ }
      throw error;
    }
  }

  /** 查找与给定路径同一（归一化 + 段边界 + 尽力 realpath + Windows 大小写折叠）的清理意图。 */
  findWorkspaceCleanupIntent(root: string): WorkspaceCleanupIntent | null {
    if (typeof root !== 'string' || root === '') return null;
    const rows = this.stmt(
      'SELECT root, session_ids, owner_user_id FROM workspace_cleanup_intents',
    ).all() as Array<{ root: string; session_ids: string; owner_user_id: number }>;
    for (const row of rows) {
      if (!samePathForMatch(row.root, root)) continue;
      return {
        root: row.root,
        sessionIds: parseJsonArray(row.session_ids)
          .filter((id) => id.length > 0 && id.length <= 200)
          .slice(0, 2000),
        ownerUserId: Number.isInteger(row.owner_user_id) ? row.owner_user_id : 0,
      };
    }
    return null;
  }

  /**
   * 清除与给定路径同一的清理意图（可有多行别名形态），返回删除行数。
   * 只允许在对应目录树的 DB 清理成功之后调用。
   */
  clearWorkspaceCleanupIntent(root: string): number {
    if (typeof root !== 'string' || root === '') return 0;
    const rows = this.stmt('SELECT root FROM workspace_cleanup_intents').all() as Array<{ root: string }>;
    const doomed = rows.map((row) => row.root).filter((key) => samePathForMatch(key, root));
    if (doomed.length === 0) return 0;
    const remove = this.stmt('DELETE FROM workspace_cleanup_intents WHERE root = ?');
    for (const key of doomed) remove.run(key);
    return doomed.length;
  }

  /** 持有这些显式会话授权之一的用户 ID（清理失败时补齐 mux/WS 失效范围；不修改数据）。 */
  listSessionGrantUserIds(sessionIds: readonly string[]): number[] {
    const wanted = [...new Set(
      sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200),
    )].slice(0, 2000);
    if (wanted.length === 0) return [];
    const found = new Set<number>();
    for (let index = 0; index < wanted.length; index += 256) {
      const chunk = wanted.slice(index, index + 256);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.stmt(
        `SELECT DISTINCT user_id AS user_id FROM user_session_grants WHERE session_id IN (${placeholders})`,
      ).all(...chunk) as Array<{ user_id: number }>;
      for (const row of rows) found.add(row.user_id);
    }
    return [...found];
  }

  // ── 用户用量（时间 / token 配额） ───────────────────────────
  getUsage(userId: number, day: string): UsageRow | null {
    const row = this.stmt(
      'SELECT user_id, day, first_seen_at, last_active_at, active_seconds, hourly_window_start, hourly_tokens FROM user_usage WHERE user_id = ? AND day = ?',
    ).get(userId, day) as UsageRow | undefined;
    return row ?? null;
  }

  /**
   * 记录活跃时间：从 last_active_at 起累计活跃跨度。
   * 网关 15 秒节流一次 touch；为覆盖节流间隙与网络抖动，单次最多累计 30 秒
   * （封顶语义：防止页面挂机把时长无限拉长；配合节流，正常连续使用误差很小）。
   */
  touchUsage(userId: number, day: string, nowIso: string): UsageRow {
    const existing = this.getUsage(userId, day);
    if (!existing) {
      this.stmt(
        'INSERT INTO user_usage (user_id, day, first_seen_at, last_active_at, active_seconds, hourly_window_start, hourly_tokens) VALUES (?, ?, ?, ?, 0, ?, 0)',
      ).run(userId, day, nowIso, nowIso, nowIso);
      return this.getUsage(userId, day)!;
    }
    let delta = 0;
    if (existing.last_active_at) {
      const last = new Date(existing.last_active_at).getTime();
      const now = new Date(nowIso).getTime();
      if (now > last) {
        delta = Math.round(Math.min((now - last) / 1000, 30));
      }
    }
    this.stmt(
      'UPDATE user_usage SET last_active_at = ?, active_seconds = active_seconds + ? WHERE user_id = ? AND day = ?',
    ).run(nowIso, delta, userId, day);
    return this.getUsage(userId, day)!;
  }

  /** 累计 token 用量（小时窗口起点不在当前窗口时自动重置计数） */
  addTokens(userId: number, day: string, tokens: number, nowIso: string): UsageRow {
    const existing = this.getUsage(userId, day);
    if (!existing) {
      this.stmt(
        'INSERT INTO user_usage (user_id, day, first_seen_at, last_active_at, active_seconds, hourly_window_start, hourly_tokens) VALUES (?, ?, ?, ?, 0, ?, ?)',
      ).run(userId, day, nowIso, nowIso, nowIso, tokens);
      return this.getUsage(userId, day)!;
    }
    const windowStart = existing.hourly_window_start ?? nowIso;
    const windowAge = new Date(nowIso).getTime() - new Date(windowStart).getTime();
    if (windowAge >= 3600_000) {
      this.stmt(
        'UPDATE user_usage SET hourly_window_start = ?, hourly_tokens = ? WHERE user_id = ? AND day = ?',
      ).run(nowIso, tokens, userId, day);
    } else {
      this.stmt('UPDATE user_usage SET hourly_tokens = hourly_tokens + ? WHERE user_id = ? AND day = ?').run(
        tokens,
        userId,
        day,
      );
    }
    return this.getUsage(userId, day)!;
  }

  /**
   * 重置用户用量（主用户改配额时调用）：删除该用户全部 user_usage 记录，
   * 下次使用从零重新计时/计数——"改配额 = 重新给额度"。
   */
  resetUsage(userId: number): void {
    this.stmt('DELETE FROM user_usage WHERE user_id = ?').run(userId);
  }

  // ── 留言 / 聊天 ───────────────────────────────────────────
  // ⚠ 多租户可见性必须在 SQL 层先过滤再 LIMIT：旧实现先全局 LIMIT 300 再到
  // 网关里按接收人过滤，其他用户的私信会堵住当前用户的增量拉取（复现：A 游标 1，
  // 之后 300 条他人私信占满窗口，A 的新消息 id 排在 300 条之后永远取不到）；
  // 且“全局最大 id”还会泄露全平台消息活动量，并让 reset 判断失真。
  // 可见性口径：广播（recipient_id NULL）∨ 发给我的 ∨ 我发的。
  private static readonly MESSAGE_VISIBILITY_SQL =
    '(m.recipient_id IS NULL OR m.recipient_id = ? OR m.sender_id = ?)';

  listMessagesForUser(userId: number, limit = 100): MessageRow[] {
    return this.mapMessageRows(
      this.stmt(
        `SELECT m.id, m.sender_id, u.username, m.recipient_id, m.content, m.tags, m.created_at
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE ${Database.MESSAGE_VISIBILITY_SQL}
       ORDER BY m.id DESC LIMIT ?`,
      ).all(userId, userId, Math.min(Math.max(limit, 1), 500)),
    );
  }

  /** 增量拉取：只返回 id > sinceId 且当前用户可见的消息（升序），供客户端轮询避免全量下载 */
  listMessagesAfterForUser(userId: number, sinceId: number, limit = 300): MessageRow[] {
    return this.mapMessageRows(
      this.stmt(
        `SELECT m.id, m.sender_id, u.username, m.recipient_id, m.content, m.tags, m.created_at
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE ${Database.MESSAGE_VISIBILITY_SQL} AND m.id > ?
       ORDER BY m.id ASC LIMIT ?`,
      ).all(userId, userId, sinceId, Math.min(Math.max(limit, 1), 500)),
    );
  }

  /** 当前用户可见的最大消息 id（无可见消息时 null）——增量接口用：
   *  since 超过它即游标已失效（DB 重建），按用户口径避免泄露全局消息活动量 */
  latestMessageIdForUser(userId: number): number | null {
    const row = this.stmt(
      `SELECT MAX(m.id) AS n FROM messages m WHERE ${Database.MESSAGE_VISIBILITY_SQL}`,
    ).get(userId, userId) as { n: number | null } | undefined;
    return row?.n === null || row?.n === undefined ? null : Number(row.n);
  }

  private mapMessageRows(
    rows: unknown,
  ): MessageRow[] {
    return (rows as {
      id: number;
      sender_id: number;
      username: string;
      recipient_id: number | null;
      content: string;
      tags: string;
      created_at: string;
    }[]).map((row) => ({
      id: row.id,
      sender_id: row.sender_id,
      sender_name: this.crypto.decrypt(row.username) ?? '',
      recipient_id: row.recipient_id,
      content: row.content,
      tags: parseJsonArray(row.tags),
      created_at: row.created_at,
      media: this.listMessageMedia(row.id),
    }));
  }

  /**
   * 消息媒体投影：只输出 ready 且未过期、且文件必须与消息同属一个所有者的资产。
   * 过滤口径与绑定/下载一致，避免旧数据或状态被改写后消息仍引用不可用媒体
   * （客户端会拿到永远 404/410 的 ID）。**不输出 storage_key / sha256 / state**，
   * 访问媒体必须走「消息 ID → 不透明媒体 ID」的二次鉴权链路。
   */
  private listMessageMedia(messageId: number): MessageMediaRow[] {
    return (
      this.stmt(
        `SELECT a.id, a.media_kind AS kind, a.mime_type, a.byte_size, a.width, a.height, a.duration_ms,
                a.original_name, mm.sort_order, mm.caption
           FROM message_media mm
           JOIN media_assets a ON a.id = mm.media_id
           JOIN messages m ON m.id = mm.message_id
          WHERE mm.message_id = ?
            AND a.owner_id = m.sender_id
            AND a.state = 'ready'
            AND (a.expires_at IS NULL OR a.expires_at > datetime('now'))
          ORDER BY mm.sort_order ASC, a.id ASC`,
      ).all(messageId) as unknown as MessageMediaRow[]
    ).map((row) => ({
      id: String(row.id),
      kind: row.kind,
      mime_type: String(row.mime_type),
      byte_size: Number(row.byte_size),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
      original_name: String(row.original_name),
      sort_order: Number(row.sort_order),
      caption: row.caption === null ? null : String(row.caption),
    }));
  }

  // ── 媒体对象（聊天媒体上传/绑定/清理） ─────────────────────────

  /** 可用的 storage key：非空且不含控制字符/NUL（会破坏文件路径与日志） */
  private static assertStorageKey(storageKey: string): void {
    if (
      typeof storageKey !== 'string' ||
      storageKey.length === 0 ||
      storageKey.length > MEDIA_STORAGE_KEY_MAX ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(storageKey) ||
      storageKey.includes('..')
    ) {
      throw new MediaError('存储键非法', 'INVALID_MEDIA');
    }
  }

  /** 外部可控媒体 ID：长度受限且不得包含控制字符（直接拼进 URL/SQL 绑定参数） */
  private static assertMediaId(id: string): void {
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > MEDIA_ID_MAX ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(id)
    ) {
      throw new MediaError('媒体 ID 非法', 'INVALID_MEDIA_ID');
    }
  }

  private normalizeMediaKind(kind: string): 'sticker' | 'image' | 'video' {
    if (kind === 'sticker' || kind === 'image' || kind === 'video') return kind;
    throw new MediaError('不支持的媒体类型', 'INVALID_MEDIA_KIND');
  }

  private normalizeMediaMime(mimeType: string): string {
    const mime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
    if (mime === '' || mime.length > MEDIA_MIME_MAX || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) {
      throw new MediaError('媒体 MIME 非法', 'INVALID_MEDIA_MIME');
    }
    return mime;
  }

  private normalizeMediaSize(byteSize: number): number {
    const size = Math.trunc(Number(byteSize));
    if (!Number.isFinite(size) || size <= 0 || size > MEDIA_BYTE_SIZE_MAX) {
      throw new MediaError('媒体大小非法', 'INVALID_MEDIA_SIZE');
    }
    return size;
  }

  private normalizeMediaDimension(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n <= 0 || n > MEDIA_DIMENSION_MAX) return null;
    return n;
  }

  private normalizeMediaDuration(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n < 0 || n > MEDIA_DURATION_MAX) return null;
    return n;
  }

  /** SQLite 文本时间：接受 Date / ISO / 'YYYY-MM-DD HH:MM:SS'，输出与 datetime('now') 可比的形式 */
  private sqliteTime(value: string | Date | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const raw = value.trim();
      if (raw === '') return null;
      // ISO 带毫秒/时区时截断到秒：'2026-09-15T10:00:00.123Z' → '2026-09-15 10:00:00'，
      // 与 datetime('now') 文本可比；其他字面量（如 datetime('now', '-1 hour') 的
      // 结果）原样使用。
      return raw.includes('T') ? raw.slice(0, 19).replace('T', ' ') : raw;
    }
    const ms = value.getTime();
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  }

  private normalizeMediaExpiry(expiresAt: string | Date | null | undefined): string | null {
    return this.sqliteTime(expiresAt);
  }

  /** 内部完整行读取（含 storage_key/sha256）；不对外暴露 */
  private selectMediaAsset(id: string): MediaAssetInternalRow | null {
    const row = this.stmt(`${MEDIA_SELECT_SQL} WHERE id = ?`).get(id) as MediaAssetInternalRow | undefined;
    return row ?? null;
  }

  /**
   * 创建媒体资产元数据（幂等）：`id`/`storage_key` 任一已存在都不重复插入，
   * 返回是否新建以及当前安全投影。保证同一 upload/media ID 不会被重复占用。
   *
   * state='pending' 表示已签发上传但文件尚未就绪（storageKey 允许为空，此时写入
   * 占位键，待 finalizeMediaAsset 换成真实键）；state='ready' 时 storageKey 必填。
   */
  addMediaAsset(asset: {
    id: string; ownerId: number; storageKey: string; originalName: string;
    kind: 'sticker' | 'image' | 'video'; mimeType: string; byteSize: number; sha256: string;
    width?: number | null; height?: number | null; durationMs?: number | null; expiresAt?: string | Date | null;
    state?: MediaState;
  }): { created: boolean; asset: MediaAssetRow | null } {
    Database.assertMediaId(asset.id);
    const existing = this.selectMediaAsset(asset.id);
    if (existing) return { created: false, asset: toMediaAssetRow(existing) };
    const state: MediaState = asset.state ?? 'ready';
    if (!MEDIA_STATES.includes(state)) throw new MediaError('媒体状态非法', 'INVALID_MEDIA_STATE');
    const storageKey = typeof asset.storageKey === 'string' ? asset.storageKey : '';
    if (state === 'ready') Database.assertStorageKey(storageKey);
    else if (storageKey !== '') Database.assertStorageKey(storageKey);
    const kind = this.normalizeMediaKind(asset.kind);
    const mime = this.normalizeMediaMime(asset.mimeType);
    const size = this.normalizeMediaSize(asset.byteSize);
    const originalName = (typeof asset.originalName === 'string' ? asset.originalName : '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MEDIA_NAME_MAX);
    const sha256 = (typeof asset.sha256 === 'string' ? asset.sha256 : '').slice(0, MEDIA_SHA256_MAX);
    const effectiveKey = storageKey === '' ? `${PLACEHOLDER_STORAGE_KEY_PREFIX}${asset.id}` : storageKey;
    const result = this.stmt(
      `INSERT INTO media_assets (id, owner_id, storage_key, original_name, media_kind, mime_type, byte_size, sha256, width, height, duration_ms, state, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(
      asset.id, asset.ownerId, effectiveKey, originalName, kind, mime, size, sha256,
      this.normalizeMediaDimension(asset.width), this.normalizeMediaDimension(asset.height),
      this.normalizeMediaDuration(asset.durationMs), state, this.normalizeMediaExpiry(asset.expiresAt),
    );
    if (Number(result.changes) === 0) {
      // 撞 id 或 storage_key（并发重复上传/重复签发同一 upload id）：绝不覆盖旧行
      const current = this.selectMediaAsset(asset.id);
      return { created: false, asset: current ? toMediaAssetRow(current) : null };
    }
    const created = this.selectMediaAsset(asset.id);
    return { created: true, asset: created ? toMediaAssetRow(created) : null };
  }

  /** 创建一个「已上传完成」的媒体对象元数据（addMediaAsset 的兼容薄包裹） */
  addReadyMediaAsset(asset: Parameters<Database['addMediaAsset']>[0]): { created: boolean; asset: MediaAssetRow | null } {
    return this.addMediaAsset({ ...asset, state: 'ready' });
  }

  /**
   * pending → ready：写入真实 storage key / 哈希 / 尺寸并置为 ready。
   * 仅允许从 pending 迁移（防止已 ready 的资产被二次改写指向别的文件）。
   * 返回是否迁移成功；false = 资产不存在或状态不对。
   */
  finalizeMediaAsset(
    id: string,
    update: {
      storageKey: string; sha256: string; byteSize?: number; mimeType?: string;
      width?: number | null; height?: number | null; durationMs?: number | null; expiresAt?: string | Date | null;
    },
  ): MediaAssetRow | null {
    Database.assertMediaId(id);
    Database.assertStorageKey(update.storageKey);
    const row = this.selectMediaAsset(id);
    if (!row || row.state !== 'pending') return null;
    const size = update.byteSize === undefined ? Number(row.byte_size) : this.normalizeMediaSize(update.byteSize);
    const mime = update.mimeType === undefined ? row.mime_type : this.normalizeMediaMime(update.mimeType);
    const result = this.stmt(
      `UPDATE media_assets
          SET storage_key = ?, sha256 = ?, byte_size = ?, mime_type = ?, width = ?, height = ?, duration_ms = ?,
              state = 'ready', expires_at = ?
        WHERE id = ? AND state = 'pending'`,
    ).run(
      update.storageKey, (update.sha256 ?? '').slice(0, MEDIA_SHA256_MAX), size, mime,
      this.normalizeMediaDimension(update.width ?? row.width),
      this.normalizeMediaDimension(update.height ?? row.height),
      this.normalizeMediaDuration(update.durationMs ?? row.duration_ms),
      update.expiresAt === undefined ? row.expires_at : this.normalizeMediaExpiry(update.expiresAt),
      id,
    );
    if (Number(result.changes) === 0) return null;
    const updated = this.selectMediaAsset(id);
    return updated ? toMediaAssetRow(updated) : null;
  }

  /**
   * pending → failed：上传失败/被取消。元数据保留（便于排障与去重统计），
   * 但不再是 ready，不能被绑定；文件由调用方按 storage key 删除。
   */
  markMediaFailed(id: string): MediaAssetRow | null {
    Database.assertMediaId(id);
    const result = this.stmt(
      "UPDATE media_assets SET state = 'failed' WHERE id = ? AND state = 'pending'",
    ).run(id);
    if (Number(result.changes) === 0) return null;
    const row = this.selectMediaAsset(id);
    return row ? toMediaAssetRow(row) : null;
  }

  /** 删除媒体元数据与其关系（仅限尚未被任何消息占用）。返回待删 storage keys。 */
  deleteMediaAsset(id: string): MediaRemovalPlan {
    Database.assertMediaId(id);
    if (this.mediaAttachedToAnyMessage(id)) {
      throw new MediaError('媒体已被消息占用，无法删除', MEDIA_IN_USE);
    }
    const plan = this.collectMediaRemoval('SELECT id, storage_key FROM media_assets WHERE id = ?', id);
    if (plan.media_ids.length === 0) throw new MediaError('媒体不存在', MEDIA_NOT_FOUND);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.stmt('DELETE FROM message_media WHERE media_id = ?').run(id);
      this.stmt('DELETE FROM media_assets WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return plan;
  }

  /** 媒体对象的安全投影（不含 storage_key/sha256）；不存在返回 null */
  getMediaAsset(id: string): MediaAssetRow | null {
    const row = this.selectMediaAsset(id);
    return row ? toMediaAssetRow(row) : null;
  }

  /** 媒体对象完整内容（含 storage_key/sha256）：仅供网关文件读写与清理使用 */
  getMediaAssetFile(id: string): MediaAssetInternalRow | null {
    return this.selectMediaAsset(id);
  }

  /** 批量读取：网关拼装消息/预签名下载时避免 N 次查询（顺序与入参 ids 一致，缺失项为 null） */
  getMediaAssets(ids: readonly string[]): (MediaAssetRow | null)[] {
    return ids.map((id) => this.getMediaAsset(id));
  }

  /**
   * 该用户当前可用（ready 且未过期）的媒体对象列表；
   * 传入 kind 时按类型过滤（用于上传配额统计）。
   */
  listMediaForUser(userId: number, kind?: 'sticker' | 'image' | 'video'): OwnedMediaRow[] {
    const params: (string | number)[] = [userId];
    let sql = `SELECT id, media_kind, mime_type, byte_size, width, height, duration_ms
                 FROM media_assets
                WHERE owner_id = ? AND state = 'ready'
                  AND (expires_at IS NULL OR expires_at > datetime('now'))`;
    if (kind !== undefined) {
      sql += ' AND media_kind = ?';
      params.push(this.normalizeMediaKind(kind));
    }
    sql += ' ORDER BY created_at DESC, id DESC';
    return (this.stmt(sql).all(...params) as unknown as OwnedMediaRow[]).map((row) => ({
      id: String(row.id),
      kind: row.kind,
      mime_type: String(row.mime_type),
      byte_size: Number(row.byte_size),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
    }));
  }

  /** 该用户是否拥有一个可用（ready 且未过期）的媒体对象 */
  mediaOwnedByUser(id: string, userId: number): boolean {
    if (typeof id !== 'string' || id === '') return false;
    return this.stmt(
      `SELECT 1 FROM media_assets
       WHERE id = ? AND owner_id = ? AND state = 'ready'
         AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    ).get(id, userId) !== undefined;
  }

  /** 该媒体是否已被任何消息占用（含关系行中已失效的历史引用） */
  mediaAttachedToAnyMessage(id: string): boolean {
    if (typeof id !== 'string' || id === '') return false;
    return this.stmt('SELECT 1 FROM message_media WHERE media_id = ? LIMIT 1').get(id) !== undefined;
  }

  /** 占用该媒体的消息 id（未被占用返回 null） */
  mediaMessageId(id: string): number | null {
    if (typeof id !== 'string' || id === '') return null;
    const row = this.stmt('SELECT message_id FROM message_media WHERE media_id = ? LIMIT 1').get(id) as
      | { message_id: number }
      | undefined;
    return row === undefined ? null : Number(row.message_id);
  }

  /** 某条消息当前绑定（仍在表内）的媒体 ID */
  listMessageMediaIds(messageId: number): string[] {
    return (
      this.stmt('SELECT media_id FROM message_media WHERE message_id = ? ORDER BY sort_order ASC, media_id ASC').all(
        messageId,
      ) as { media_id: string }[]
    ).map((row) => String(row.media_id));
  }

  /**
   * 把已就绪的媒体绑定到已存在的消息上。
   * 每个媒体都要满足：属于该消息发件人、ready、未过期、未被任何消息占用；
   * 任一不满足则整体抛错回滚（不产生部分绑定）。
   * 新业务请优先用 addMessageWithMedia（同一事务内建消息 + 绑定）。
   */
  attachMediaToMessage(messageId: number, mediaIds: readonly string[], ownerId?: number): void {
    const ids = this.normalizeMediaIdList(mediaIds);
    if (ids.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const message = this.stmt('SELECT sender_id FROM messages WHERE id = ?').get(messageId) as
        | { sender_id: number }
        | undefined;
      if (!message) throw new MediaError('消息不存在', 'NO_SUCH_MESSAGE');
      this.attachMediaInTransaction(messageId, ids, ownerId ?? Number(message.sender_id));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 归一化媒体 ID 列表：去空、去重、限制单条消息附件数量 */
  private static readonly MAX_MEDIA_PER_MESSAGE = 10;
  private normalizeMediaIdList(mediaIds: readonly string[]): string[] {
    const ids: string[] = [];
    for (const raw of mediaIds) {
      if (typeof raw !== 'string' || raw === '') throw new MediaError('媒体 ID 非法', 'INVALID_MEDIA_ID');
      Database.assertMediaId(raw);
      if (!ids.includes(raw)) ids.push(raw);
    }
    if (ids.length > Database.MAX_MEDIA_PER_MESSAGE) {
      throw new MediaError('单条消息附件过多', 'TOO_MANY_MEDIA');
    }
    return ids;
  }

  /**
   * 事务内绑定校验（调用方必须已开启事务）：
   * 一个媒体必须同时满足「属于 ownerId」「ready」「未过期」「未被任何消息占用」。
   * SELECT ... FOR UPDATE 不存在于 SQLite，改用 BEGIN IMMEDIATE 独占写锁 +
   * idx_message_media_media 唯一索引，两者共同保证不会重复占用。
   */
  private attachMediaInTransaction(messageId: number, ids: readonly string[], ownerId: number): void {
    const check = this.stmt(
      `SELECT id, state, expires_at, owner_id FROM media_assets
        WHERE id = ?`,
    );
    const occupied = this.stmt('SELECT message_id FROM message_media WHERE media_id = ? LIMIT 1');
    const insert = this.stmt('INSERT INTO message_media (message_id, media_id, sort_order) VALUES (?, ?, ?)');
    ids.forEach((id, index) => {
      const asset = check.get(id) as
        | { id: string; state: string; expires_at: string | null; owner_id: number }
        | undefined;
      if (!asset) throw new MediaError('媒体不存在', 'MEDIA_NOT_FOUND');
      if (Number(asset.owner_id) !== ownerId) throw new MediaError('媒体不属于当前用户', 'MEDIA_NOT_OWNED');
      if (asset.state !== 'ready') throw new MediaError('媒体尚未就绪', 'MEDIA_NOT_READY');
      if (asset.expires_at !== null) {
        const expiry = Date.parse(toIsoTimestamp(asset.expires_at) ?? '');
        if (Number.isFinite(expiry) && expiry <= Date.now()) {
          throw new MediaError('媒体已过期', 'MEDIA_EXPIRED');
        }
      }
      const holder = occupied.get(id) as { message_id: number } | undefined;
      if (holder && Number(holder.message_id) !== messageId) {
        throw new MediaError('媒体已被其他消息占用', MEDIA_IN_USE);
      }
      try {
        insert.run(messageId, id, index);
      } catch (error) {
        // 唯一索引拒绝：并发下另一条消息已占用该媒体
        throw new MediaError(`媒体已被占用: ${String(error)}`, MEDIA_IN_USE);
      }
    });
  }

  /** 留言写入计数：每 100 条修剪一次最旧记录（留言表长期运行也会无限增长） */
  private messageInsertCount = 0;
  private static readonly MESSAGES_MAX_ROWS = 2_000;
  private static readonly MESSAGES_PRUNE_EVERY = 100;

  /**
   * 发送留言（兼容入口）：不携带媒体，语义与旧实现完全一致。
   * 新代码需要附件时用 addMessageWithMedia（同一事务）。
   */
  addMessage(senderId: number, recipientId: number | null, content: string, tags: string[]): MessageRow {
    return this.addMessageWithMedia({ senderId, recipientId, content, tags });
  }

  /**
   * 发送留言 + 媒体附件（单事务原子）：媒体绑定校验（owner/ready/未过期/未占用）
   * 与消息插入同生共死，任一失败全部回滚，不会留下没有附件或没有消息的半成品。
   *
   * 返回的消息体是重新从库里读出的完整投影（含媒体元数据），可直接广播给客户端。
   */
  addMessageWithMedia(input: {
    senderId: number;
    recipientId: number | null;
    content: string;
    tags: string[];
    mediaIds?: readonly string[];
    mediaCaptions?: readonly (string | null)[];
  }): MessageRow {
    const mediaIds = this.normalizeMediaIdList(input.mediaIds ?? []);
    const tags = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)) : [];
    let messageId = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.stmt(
        'INSERT INTO messages (sender_id, recipient_id, content, tags) VALUES (?, ?, ?, ?)',
      ).run(input.senderId, input.recipientId, input.content, JSON.stringify(tags));
      messageId = Number(result.lastInsertRowid);
      if (mediaIds.length > 0) {
        this.attachMediaInTransaction(messageId, mediaIds, input.senderId);
        this.setMediaCaptions(messageId, mediaIds, input.mediaCaptions);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.maybePruneMessages();
    const stored = this.getMessageForUser(messageId, input.senderId);
    return (
      stored ?? {
        id: messageId,
        sender_id: input.senderId,
        sender_name: this.getUserById(input.senderId)?.username ?? '',
        recipient_id: input.recipientId,
        content: input.content,
        tags,
        created_at: new Date().toISOString(),
        media: [],
      }
    );
  }

  /** 写入每条附件的可选说明（空串/非字符串折叠为 NULL） */
  private setMediaCaptions(
    messageId: number,
    ids: readonly string[],
    captions: readonly (string | null)[] | undefined,
  ): void {
    if (!captions) return;
    const update = this.stmt('UPDATE message_media SET caption = ? WHERE message_id = ? AND media_id = ?');
    ids.forEach((id, index) => {
      const raw = captions[index];
      const caption = typeof raw === 'string' ? raw.trim().slice(0, 500) : '';
      update.run(caption === '' ? null : caption, messageId, id);
    });
  }

  /** 单条消息（含媒体投影），并要求当前用户可见；否则 null（不泄露他人私信存在性） */
  getMessageForUser(messageId: number, userId: number): MessageRow | null {
    const rows = this.mapMessageRows(
      this.stmt(
        `SELECT m.id, m.sender_id, u.username, m.recipient_id, m.content, m.tags, m.created_at
           FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.id = ? AND ${Database.MESSAGE_VISIBILITY_SQL}`,
      ).all(messageId, userId, userId),
    );
    return rows[0] ?? null;
  }

  /**
   * 媒体访问鉴权：媒体 ID → 占用它的消息 → 当前用户是否可见该消息。
   * 请求方拿到的只是不透明媒体 ID，必须经过这里才能拿到文件（不存在/不可见
   * 一律 null，调用方按 404 处理，不暴露“媒体是否存在”）。
   */
  getMessageMediaForUser(mediaId: string, userId: number): { message: MessageRow; media: MessageMediaRow } | null {
    if (typeof mediaId !== 'string' || mediaId === '') return null;
    const linked = this.stmt('SELECT message_id FROM message_media WHERE media_id = ? LIMIT 1').get(mediaId) as
      | { message_id: number }
      | undefined;
    if (!linked) return null;
    const message = this.getMessageForUser(Number(linked.message_id), userId);
    if (!message) return null;
    const media = message.media.find((item) => item.id === mediaId);
    return media ? { message, media } : null;
  }

  /**
   * 回收该消息上不再被引用的媒体元数据（回答“谁在删消息”的一致性问题）：
   * 删除后返回待删 storage keys，调用方按需删除文件。
   */
  private releaseMessageMedia(messageIds: readonly number[]): MediaRemovalPlan {
    if (messageIds.length === 0) return { media_ids: [], storage_keys: [] };
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.stmt(
      `SELECT DISTINCT a.id, a.storage_key
             FROM message_media mm JOIN media_assets a ON a.id = mm.media_id
            WHERE mm.message_id IN (${placeholders})`,
    ).all(...messageIds) as { id: string; storage_key: string }[];
    this.stmt(`DELETE FROM message_media WHERE message_id IN (${placeholders})`).run(...messageIds);
    const orphaned = rows.filter((row) => !this.mediaAttachedToAnyMessage(row.id));
    for (const row of orphaned) this.stmt('DELETE FROM media_assets WHERE id = ?').run(row.id);
    return {
      media_ids: orphaned.map((row) => String(row.id)),
      storage_keys: orphaned.map((row) => String(row.storage_key)).filter((key) => key !== ''),
    };
  }

  /**
   * 消息历史修剪：每 100 条修剪一次最旧记录，同时清理 message_media 关系与
   * 不再被引用的媒体资产。返回本次需要删除的 storage keys（可忽略；
   * 媒体访问按消息鉴权，残留文件不可寻址）。
   *
   * 删除集合用 OFFSET 取「第 2000 条之后的旧记录」而不是 `id <= MAX(id) - 2000`：
   * 后者的前提是 id 连续，但消息 id 会因删除用户、手工整理而出现空洞，
   * 一旦有空洞就会落到不存在的 id 上，导致修剪永久失效（表无界增长）。
   */
  private maybePruneMessages(): MediaRemovalPlan {
    this.messageInsertCount++;
    if (this.messageInsertCount % Database.MESSAGES_PRUNE_EVERY !== 0) {
      return { media_ids: [], storage_keys: [] };
    }
    try {
      const doomed = this.stmt(
        'SELECT id FROM messages ORDER BY id DESC LIMIT -1 OFFSET ?',
      ).all(Database.MESSAGES_MAX_ROWS) as { id: number }[];
      const ids = doomed.map((row) => Number(row.id));
      if (ids.length === 0) return { media_ids: [], storage_keys: [] };
      const placeholders = ids.map(() => '?').join(', ');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const plan = this.releaseMessageMedia(ids);
        this.stmt(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
        this.db.exec('COMMIT');
        return plan;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      // 修剪失败（磁盘满/数据库锁）：记录告警——留言与媒体表会持续增长，不能静默
      console.warn('[dsh-passwords] 留言修剪失败（表可能持续增长）:', String(error));
      return { media_ids: [], storage_keys: [] };
    }
  }

  /**
   * 显式清空消息历史（测试/运维用）：一并清理 message_media 关系与孤儿媒体，
   * 返回待删 storage keys。
   */
  clearMessages(): MediaRemovalPlan {
    return this.clearMessagesInternal();
  }

  private clearMessagesInternal(): MediaRemovalPlan {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ids = (this.stmt('SELECT id FROM messages').all() as { id: number }[]).map((row) => Number(row.id));
      const plan = this.releaseMessageMedia(ids);
      this.stmt('DELETE FROM messages').run();
      this.db.exec('COMMIT');
      return plan;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * 清理指向已删资产的孤儿关系行（历史库/异常中断残留）：
   * 孤儿关系会让「已被任何消息占用」误判，阻断媒体的删除与 GC。
   * 返回清理行数。
   */
  pruneOrphanedMessageMedia(): number {
    const countRows = (): number =>
      Number((this.stmt('SELECT COUNT(*) AS n FROM message_media').get() as { n: number }).n ?? 0);
    const before = countRows();
    this.stmt(
      'DELETE FROM message_media WHERE media_id NOT IN (SELECT id FROM media_assets)' +
        ' OR message_id NOT IN (SELECT id FROM messages)',
    ).run();
    return before - countRows();
  }

  /** 平台主用户 id（首个 admin）；平台必有主用户，缺失说明数据损坏 */
  findAdminId(): number | null {
    const row = this.stmt("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get() as
      | { id: number }
      | undefined;
    return row ? Number(row.id) : null;
  }


  /** 登录失败/节流表修剪：防随机用户名+轮换 IP 喷洒让表无界增长 */
  pruneStaleSecurityRows(days = 7): void {
    const cutoff = `-${Math.max(days, 1)} days`;
    this.stmt("DELETE FROM login_attempts WHERE updated_at < datetime('now', ?)").run(cutoff);
    this.stmt("DELETE FROM ip_throttle WHERE updated_at < datetime('now', ?)").run(cutoff);
  }

}
