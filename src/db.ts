// Account and quota repository with SQLite and MySQL storage drivers.
// 表结构：users / platform_settings / audit_logs / login_attempts / … /
// media_assets / message_media
//
// 聊天媒体元数据（media_assets / message_media）：
//   - 文件本体由网关写在私有目录，DB 只保存元数据与 storage_key；
//     storage_key / sha256 属于内部字段，绝不进入 MessageRow（消息投影只给
//     不透明媒体 ID + 展示元数据）。
//   - 生命周期：pending（已签发上传，文件未就绪）→ ready（校验通过）
//     → 过期清理 / 删除；失败或放弃的 pending 由网关删除并回收 storage_key。
//   - 一个媒体只能被一条消息占用（message_media.media_id 上有 UNIQUE 索引），
//     绑定与消息创建在同一事务内完成，任一校验失败整体回滚。
//   - 两种驱动共用同一套语句；仅 `INSERT OR IGNORE` / `INSERT IGNORE`、
//     `LIMIT -1` 与 PRAGMA 索引探测按驱动分支（其余方言由 mysql-worker 翻译）。
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
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { normalizePath } from './permissions.js';
import type { FieldCrypto } from './encrypt.js';
import {
  MysqlSyncConnection,
  type MysqlConnectionOptions,
  type SqlConnection,
  type SqlStatement,
} from './mysql-sync.js';

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
  /** Monthly model-spend allowance in integer CNY micros; null means unlimited. */
  monthly_budget_micros: number | null;
  allow_upload: boolean;
  allow_git_download: boolean;
  allow_workspace_create: boolean;
  allow_ssh: boolean;
  /** Null preserves unrestricted legacy accounts; an empty array denies every preset. */
  allowed_agent_presets: string[] | null;
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

/** 留言/聊天消息（含发送者用户名，列表时联表带出） */
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
    owner_id: Number(row.owner_id),
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
/** pending 阶段的占位存储键（同一 upload id 仍受 PK 约束） */
const PLACEHOLDER_STORAGE_KEY_PREFIX = '__pending__:';

/** 时间列归一：SQLite 的 datetime('now') 与 MySQL DATETIME 读出形态统一为 ISO。 */
function toIsoTimestamp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  return raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
}

/** 已配对的用户本机工作区。敏感展示字段从数据库读取时已解密。 */
export interface LocalWorkspaceRow {
  id: string;
  user_id: number;
  device_name: string;
  workspace_name: string;
  remote_root: string;
  placeholder_path: string;
  platform: string;
  shell_enabled: boolean;
  /** Whether this pairing may capture the computer's screen and drive its input. */
  desktop_control_enabled: boolean;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

/** 由平台在宿主机上为子用户托管的专属工作区。 */
export interface ManagedWorkspaceRow {
  user_id: number;
  path: string;
  created_at: string;
}

/** Immutable account ownership of one DSH session. */
export interface SessionOwnerRow {
  session_id: string;
  user_id: number;
  created_at: string;
  /** Agent preset the Host resolved for this session, null before it was observed. */
  agent_preset: string | null;
}

/** Durable model selection owned by one DSH session. */
export interface SessionModelSelectionRow {
  session_id: string;
  provider: string;
  model: string;
  reasoning_effort: string | null;
  updated_at: string;
}


/** Persistent mobile login; only the refresh secret digest is stored. */
export interface MobileSessionRow {
  id: string;
  user_id: number;
  token_hash: string;
  credential_version: number;
  created_at_ms: number;
  active_until_ms: number;
  expires_at_ms: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mobile_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  credential_version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  active_until_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mobile_sessions_user ON mobile_sessions(user_id);

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
  monthly_budget_micros INTEGER NOT NULL DEFAULT 0, -- 人民币微元；NULL = 不限（仅管理员）
  allow_upload       INTEGER NOT NULL DEFAULT 1,
  allow_git_download INTEGER NOT NULL DEFAULT 0,
  allow_workspace_create INTEGER NOT NULL DEFAULT 0,
  allow_ssh INTEGER NOT NULL DEFAULT 0,
  allowed_websocket_paths TEXT NOT NULL DEFAULT '[]',
  allowed_agent_presets TEXT,
  allow_chat_media    INTEGER NOT NULL DEFAULT 0,   -- 平台留言 sticker/image/video
  banned             INTEGER NOT NULL DEFAULT 0,
  sandbox_mode       TEXT,                          -- NULL = 不更改；read-only/workspace-write/danger-full-access
  disabled_sessions  TEXT NOT NULL DEFAULT '[]',    -- 已开启工作区内逐会话关闭的 sessionId JSON 数组
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ssh_host_owners (
  alias              TEXT PRIMARY KEY,
  user_id            INTEGER NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ssh_host_owners_user ON ssh_host_owners(user_id);
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
CREATE TABLE IF NOT EXISTS local_workspaces (
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL,
  token_hash       TEXT NOT NULL UNIQUE,
  device_name      TEXT NOT NULL,
  workspace_name   TEXT NOT NULL,
  remote_root      TEXT NOT NULL,
  placeholder_path TEXT NOT NULL UNIQUE,
  platform         TEXT NOT NULL,
  shell_enabled    INTEGER NOT NULL DEFAULT 0,
  desktop_control_enabled INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_local_workspaces_user ON local_workspaces(user_id, revoked_at);
CREATE TABLE IF NOT EXISTS managed_workspaces (
  user_id    INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS session_owners (
  session_id   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  agent_preset TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_owners_user ON session_owners(user_id);
CREATE TABLE IF NOT EXISTS session_model_selections (
  session_id       TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  reasoning_effort TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
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
 * 旧库 message_media 去重迁移（仅 SQLite；MySQL 建表即带 UNIQUE）：历史索引非唯一，
 * 同一媒体可能已被多条消息引用。每个 media_id 只保留最早的一条关系，随后把索引
 * 升级为 UNIQUE。幂等：索引已是 UNIQUE 时直接返回。
 */
function migrateMessageMediaUniqueness(db: SqlConnection): void {
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

/**
 * 排序规则用 utf8mb4_unicode_ci，而非 MySQL 8 的默认 utf8mb4_0900_ai_ci：后者是 MySQL 8
 * 专有，MariaDB 解析到即报 Unknown collation，而 init() 每次启动都重跑整段建表语句，
 * `IF NOT EXISTS` 不能绕开。utf8mb4_unicode_ci 在 MySQL 8 与 MariaDB 10.11 上都存在，
 * 因此同一份代码在两种服务端上通用。
 */
const MYSQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS mobile_sessions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  credential_version INT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  active_until_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  KEY idx_mobile_sessions_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username           TEXT NOT NULL,
  username_hash      VARCHAR(128),
  password_hash      VARCHAR(255) NOT NULL,
  role               VARCHAR(16) NOT NULL DEFAULT 'user',
  credential_version INT NOT NULL DEFAULT 0,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at      DATETIME(3),
  UNIQUE KEY idx_users_hash (username_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS platform_settings (
  k VARCHAR(191) PRIMARY KEY,
  v TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(191) NOT NULL,
  username   TEXT,
  ip         TEXT,
  user_agent TEXT,
  detail     MEDIUMTEXT,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS login_attempts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username_hash VARCHAR(128) NOT NULL,
  ip_hash       VARCHAR(128) NOT NULL,
  failed_count  INT NOT NULL DEFAULT 0,
  locked_until  DATETIME(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY idx_login_identity (username_hash, ip_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ip_throttle (
  ip_hash         VARCHAR(128) PRIMARY KEY,
  failed_count    INT NOT NULL DEFAULT 0,
  window_started  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  throttled_until DATETIME(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id               INT UNSIGNED PRIMARY KEY,
  allowed_folders       MEDIUMTEXT,
  hourly_token_limit    BIGINT,
  daily_minutes_limit   INT,
  monthly_budget_micros BIGINT NOT NULL DEFAULT 0,
  allow_upload          TINYINT NOT NULL DEFAULT 1,
  allow_git_download    TINYINT NOT NULL DEFAULT 0,
  allow_workspace_create TINYINT NOT NULL DEFAULT 0,
  allow_ssh TINYINT NOT NULL DEFAULT 0,
  allowed_websocket_paths MEDIUMTEXT NOT NULL,
  allowed_agent_presets MEDIUMTEXT,
  allow_chat_media      TINYINT NOT NULL DEFAULT 0,
  banned                TINYINT NOT NULL DEFAULT 0,
  sandbox_mode          VARCHAR(64),
  disabled_sessions     MEDIUMTEXT NOT NULL,
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ssh_host_owners (
  alias VARCHAR(256) COLLATE utf8mb4_bin PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ssh_host_owners_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS user_usage (
  user_id             INT UNSIGNED NOT NULL,
  day                 CHAR(10) NOT NULL,
  first_seen_at       DATETIME(3),
  last_active_at      DATETIME(3),
  active_seconds      INT NOT NULL DEFAULT 0,
  hourly_window_start DATETIME(3),
  hourly_tokens       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS messages (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sender_id    INT UNSIGNED NOT NULL,
  recipient_id INT UNSIGNED,
  content      MEDIUMTEXT NOT NULL,
  tags         MEDIUMTEXT NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_messages_created (id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS local_workspaces (
  id               VARCHAR(200) PRIMARY KEY,
  user_id          INT UNSIGNED NOT NULL,
  token_hash       VARCHAR(128) NOT NULL UNIQUE,
  device_name      TEXT NOT NULL,
  workspace_name   TEXT NOT NULL,
  remote_root      TEXT NOT NULL,
  placeholder_path VARCHAR(768) NOT NULL UNIQUE,
  platform         VARCHAR(64) NOT NULL,
  shell_enabled    TINYINT NOT NULL DEFAULT 0,
  desktop_control_enabled TINYINT NOT NULL DEFAULT 0,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at       DATETIME(3),
  KEY idx_local_workspaces_user (user_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS managed_workspaces (
  user_id    INT UNSIGNED PRIMARY KEY,
  path       VARCHAR(768) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS session_owners (
  session_id   VARCHAR(200) PRIMARY KEY,
  user_id      INT UNSIGNED NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  agent_preset VARCHAR(200),
  KEY idx_session_owners_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS workspace_cleanup_intents (
  root           VARCHAR(768) PRIMARY KEY,
  session_ids    MEDIUMTEXT NOT NULL,
  owner_user_id  INT UNSIGNED NOT NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS session_model_selections (
  session_id       VARCHAR(200) PRIMARY KEY,
  provider         VARCHAR(512) NOT NULL,
  model            VARCHAR(512) NOT NULL,
  reasoning_effort VARCHAR(191),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS media_assets (
  id              VARCHAR(128) PRIMARY KEY,
  owner_id        INT UNSIGNED NOT NULL,
  storage_key     VARCHAR(512) NOT NULL UNIQUE,
  original_name   VARCHAR(255) NOT NULL,
  media_kind      VARCHAR(16) NOT NULL,
  mime_type       VARCHAR(128) NOT NULL,
  byte_size       BIGINT NOT NULL,
  sha256          VARCHAR(128) NOT NULL,
  width           INT,
  height          INT,
  duration_ms     INT,
  state           VARCHAR(16) NOT NULL DEFAULT 'ready',
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at      DATETIME(3),
  KEY idx_media_assets_owner (owner_id, created_at),
  KEY idx_media_assets_state_expires (state, expires_at),
  KEY idx_media_assets_owner_state (owner_id, state, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS message_media (
  message_id      BIGINT UNSIGNED NOT NULL,
  media_id        VARCHAR(128) NOT NULL,
  sort_order      INT NOT NULL DEFAULT 0,
  caption         TEXT,
  PRIMARY KEY (message_id, media_id),
  UNIQUE KEY idx_message_media_media (media_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

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
  private db: SqlConnection;
  private crypto: FieldCrypto;
  private readonly mysql: boolean;
  private readonly setupLockName: string | null;
  /** 预处理语句缓存：按 SQL 文本复用，避免每次请求重复编译 */
  private stmts = new Map<string, SqlStatement>();

  constructor(target: string | MysqlConnectionOptions, crypto: FieldCrypto) {
    this.mysql = typeof target !== 'string';
    this.setupLockName = typeof target === 'string' ? null : `dsh-passwords:${target.database}:initial-admin`;
    if (typeof target === 'string') {
      mkdirSync(path.dirname(target), { recursive: true });
      this.db = new DatabaseSync(target) as unknown as SqlConnection;
    } else {
      this.db = new MysqlSyncConnection(target);
    }
    this.crypto = crypto;
    // SQLite 下网关进程与 dsh 插件进程共享一个文件，写锁竞争时等待而不是立刻报错。
    if (!this.mysql) this.db.exec('PRAGMA busy_timeout = 5000');
  }

  private stmt(sql: string): SqlStatement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Convert an application ISO instant to the active driver's timestamp representation. */
  private dateTime(value: string | Date): string {
    const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    return this.mysql ? iso.slice(0, 23).replace('T', ' ') : iso;
  }

  /** 显式释放数据库连接（测试/一次性工具使用；常驻服务由进程退出回收）。 */
  close(): void {
    this.stmts.clear();
    this.db.close();
  }

  /** 建表（幂等）+ 旧明文数据一次性迁移为密文 */
  init(): void {
    if (this.mysql) {
      this.db.exec(MYSQL_SCHEMA);
      this.migrateRoles();
      this.migratePermissions();
      this.migrateSessionOwners();
      this.migrateLocalWorkspaces();
      this.migrateUsers();
      this.migrateAuditLogs();
      this.setSetting('mysql_schema_version', '1');
      this.setSetting('enc_migrated_v1', '1');
      return;
    }
    // 删除内容清零，防止已删除的明文残留在空闲页可被文件扫描恢复
    this.db.exec('PRAGMA secure_delete = ON');
    this.db.exec(SCHEMA);
    // SCHEMA 里的 message_media 唯一索引对所有库无差别执行：旧库若已有同名
    // 非唯一索引，CREATE INDEX IF NOT EXISTS 不会升级它，需显式重建（且去重）。
    migrateMessageMediaUniqueness(this.db);
    this.migrateRoles();
    this.migratePermissions();
    this.migrateSessionOwners();
    this.migrateLocalWorkspaces();
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
    if (!this.mysql) {
      const cols = this.stmt('PRAGMA table_info(users)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'role')) {
        this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
      }
      if (!cols.some((c) => c.name === 'credential_version')) {
        this.db.exec('ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0');
      }
    }
    // 若库中还没有主用户（老数据迁移/异常状态），把最早创建的账号提为主用户；
    // 其余账号保持子用户角色。判断只看 role 字段，与账号叫什么名字无关。
    const hasAdmin = this.stmt("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
    if (!hasAdmin) {
      if (this.mysql) {
        this.db.exec("UPDATE users SET role = 'admin' WHERE id = (SELECT first_id FROM (SELECT MIN(id) AS first_id FROM users) AS first_user)");
      } else {
        this.db.exec("UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users)");
      }
    }
  }

  // ── 迁移：user_permissions 补后续版本列（均可重复执行） ─────────────────
  private migratePermissions(): void {
    const names = new Set(
      this.mysql
        ? (this.stmt('SHOW COLUMNS FROM user_permissions').all() as { Field: string }[]).map((column) => column.Field)
        : (this.stmt('PRAGMA table_info(user_permissions)').all() as { name: string }[]).map((column) => column.name),
    );
    const add = (name: string, sqliteDefinition: string, mysqlDefinition: string) => {
      if (names.has(name)) return;
      this.db.exec(`ALTER TABLE user_permissions ADD COLUMN ${name} ${this.mysql ? mysqlDefinition : sqliteDefinition}`);
      names.add(name);
    };
    add('allow_upload', 'INTEGER NOT NULL DEFAULT 0', 'TINYINT NOT NULL DEFAULT 0');
    add('allow_git_download', 'INTEGER NOT NULL DEFAULT 0', 'TINYINT NOT NULL DEFAULT 0');
    add('allow_ssh', 'INTEGER NOT NULL DEFAULT 0', 'TINYINT NOT NULL DEFAULT 0');
    add('allow_workspace_create', 'INTEGER NOT NULL DEFAULT 0', 'TINYINT NOT NULL DEFAULT 0');
    add('allowed_websocket_paths', "TEXT NOT NULL DEFAULT '[]'", 'MEDIUMTEXT NULL');
    add('allowed_agent_presets', 'TEXT', 'MEDIUMTEXT');
    add('sandbox_mode', 'TEXT', 'VARCHAR(64)');
    add('disabled_sessions', "TEXT NOT NULL DEFAULT '[]'", 'MEDIUMTEXT NULL');
    add('monthly_budget_micros', 'INTEGER NOT NULL DEFAULT 0', 'BIGINT NOT NULL DEFAULT 0');
    // allow_chat_media：独立于 allow_upload 的聊天媒体开关，默认关闭。
    add('allow_chat_media', 'INTEGER NOT NULL DEFAULT 0', 'TINYINT NOT NULL DEFAULT 0');
    // 旧库/手工 SQL 可能留下 NULL：统一折叠为 0，保证 getPermissions 永远返回布尔值。
    this.db.exec('UPDATE user_permissions SET allow_chat_media = 0 WHERE allow_chat_media IS NULL');
  }

  // ── 迁移：local_workspaces 补 desktop_control_enabled 列（可重复执行） ─────
  private migrateLocalWorkspaces(): void {
    const names = new Set(
      this.mysql
        ? (this.stmt('SHOW COLUMNS FROM local_workspaces').all() as { Field: string }[]).map((column) => column.Field)
        : (this.stmt('PRAGMA table_info(local_workspaces)').all() as { name: string }[]).map((column) => column.name),
    );
    if (names.has('desktop_control_enabled')) return;
    // Existing pairings default to off: the grant is new, so no companion has
    // ever presented it and no user has ever been asked for it.
    this.db.exec(
      `ALTER TABLE local_workspaces ADD COLUMN desktop_control_enabled ${
        this.mysql ? 'TINYINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0'
      }`,
    );
  }

  // ── 迁移：session_owners 补 agent_preset 列（可重复执行） ─────────────────
  private migrateSessionOwners(): void {
    const names = new Set(
      this.mysql
        ? (this.stmt('SHOW COLUMNS FROM session_owners').all() as { Field: string }[]).map((column) => column.Field)
        : (this.stmt('PRAGMA table_info(session_owners)').all() as { name: string }[]).map((column) => column.name),
    );
    if (names.has('agent_preset')) return;
    this.db.exec(
      `ALTER TABLE session_owners ADD COLUMN agent_preset ${this.mysql ? 'VARCHAR(200)' : 'TEXT'}`,
    );
  }

  // ── 迁移：users.username 明文 → 密文 + username_hash ──────────
  private migrateUsers(): boolean {
    if (!this.mysql) {
      const cols = this.stmt('PRAGMA table_info(users)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'username_hash')) {
        this.db.exec('ALTER TABLE users ADD COLUMN username_hash TEXT');
      }
      // 索引必须在列存在之后创建（旧库无此列时不能在建表阶段引用它）
      this.db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_hash ON users(username_hash) WHERE username_hash IS NOT NULL',
      );
    }
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
    if (this.mysql) return false;
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
    if (this.setupLockName !== null) {
      const lock = this.stmt('SELECT GET_LOCK(?, 10) AS acquired').get(this.setupLockName) as
        | { acquired: number }
        | undefined;
      if (Number(lock?.acquired) !== 1) throw new Error('获取 MySQL 首次配置锁超时');
    }
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
    } finally {
      if (this.setupLockName !== null) {
        this.stmt('SELECT RELEASE_LOCK(?) AS released').get(this.setupLockName);
      }
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
   * 删除用户（级联）：权限、用量、本机/托管工作区、移动会话、登录失败记录、
   * 该用户发出的/收到的消息关系与该用户拥有的媒体元数据。
   *
   * 文件本体归网关管：调用方先用 peekUserMediaRemoval(userId) 取待删 storage keys，
   * deleteUser 之后按键删文件；否则由 pruneMedia() 回收无主文件。
   */
  deleteUser(id: number): void {
    // 两种驱动均未声明外键约束，关联行需手动级联清理：
    // 权限、用量、留言（发件人/收件人）以及登录失败记录。
    const user = this.getUserById(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (user) {
        this.stmt('DELETE FROM login_attempts WHERE username_hash = ?').run(this.crypto.lookupHash(user.username));
      }

      this.stmt('DELETE FROM user_permissions WHERE user_id = ?').run(id);
      this.stmt('DELETE FROM ssh_host_owners WHERE user_id = ?').run(id);
      this.stmt('DELETE FROM user_usage WHERE user_id = ?').run(id);
      // 媒体：先删关系再删资产，否则 message_media 会留下指向已删资产的孤儿行
      // （孤儿关系会让 mediaAttachedToAnyMessage 永远为真，永久阻断删除/GC）。
      this.deleteMediaRelationsOfUser(id);
      this.stmt('DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?').run(id, id);
      this.stmt('DELETE FROM media_assets WHERE owner_id = ?').run(id);
      this.stmt('DELETE FROM local_workspaces WHERE user_id = ?').run(id);
      this.stmt('DELETE FROM mobile_sessions WHERE user_id = ?').run(id);
      this.stmt('DELETE FROM managed_workspaces WHERE user_id = ?').run(id);
      this.stmt('DELETE FROM users WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

  /** Insert an authenticated device session without persisting the refresh secret. */
  createMobileSession(row: MobileSessionRow, maximum: number, now: number, replaceId?: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.mysql) this.stmt('SELECT id FROM users WHERE id = ? FOR UPDATE').get(row.user_id);
      if (replaceId !== undefined) this.stmt('DELETE FROM mobile_sessions WHERE id = ? AND user_id = ?').run(replaceId, row.user_id);
      this.stmt('DELETE FROM mobile_sessions WHERE user_id = ? AND (active_until_ms <= ? OR expires_at_ms <= ?)').run(row.user_id, now, now);
      this.stmt('DELETE FROM mobile_sessions WHERE user_id = ? AND credential_version <> ?').run(row.user_id, row.credential_version);
      const count = this.stmt('SELECT COUNT(*) AS count FROM mobile_sessions WHERE user_id = ?').get(row.user_id) as { count: number };
      if (Number(count.count) >= maximum) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.stmt(`INSERT INTO mobile_sessions
        (id, user_id, token_hash, credential_version, created_at_ms, active_until_ms, expires_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.user_id, row.token_hash, row.credential_version, row.created_at_ms, row.active_until_ms, row.expires_at_ms);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Read one device session; callers enforce its account and expiration. */
  getMobileSession(id: string): MobileSessionRow | null {
    const row = this.stmt('SELECT * FROM mobile_sessions WHERE id = ?').get(id) as MobileSessionRow | undefined;
    return row ? { ...row, user_id: Number(row.user_id), credential_version: Number(row.credential_version), created_at_ms: Number(row.created_at_ms), active_until_ms: Number(row.active_until_ms), expires_at_ms: Number(row.expires_at_ms) } : null;
  }

  /** Extend only a still-valid device session; concurrent logout cannot recreate it. */
  touchMobileSession(id: string, now: number, activeUntil: number): boolean {
    const result = this.stmt(`UPDATE mobile_sessions SET active_until_ms = CASE WHEN active_until_ms > ? THEN active_until_ms ELSE ? END
      WHERE id = ? AND active_until_ms > ? AND expires_at_ms > ?`).run(activeUntil, activeUntil, id, now, now);
    if (Number(result.changes) === 1) return true;
    const row = this.getMobileSession(id);
    return row !== null && row.active_until_ms > now && row.expires_at_ms > now;
  }

  /** Revoke a device login permanently, including its issued access tokens. */
  deleteMobileSession(id: string): void {
    this.stmt('DELETE FROM mobile_sessions WHERE id = ?').run(id);
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
          const threshold = this.stmt('SELECT MAX(id) - ? AS id FROM audit_logs').get(
            Database.AUDIT_MAX_ROWS,
          ) as { id: number | null } | undefined;
          if (threshold?.id !== null && threshold?.id !== undefined) {
            this.stmt('DELETE FROM audit_logs WHERE id <= ?').run(threshold.id);
          }
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
      this.dateTime(until),
      this.crypto.lookupHash(username),
    );
  }

  lockLoginAttempt(username: string, ip: string, until: Date): void {
    this.stmt(
      `INSERT INTO login_attempts (username_hash, ip_hash, failed_count, locked_until, updated_at) VALUES (?, ?, 0, ?, datetime('now'))
       ON CONFLICT(username_hash, ip_hash) DO UPDATE SET
         locked_until = excluded.locked_until,
         updated_at = datetime('now')`,
    ).run(this.crypto.lookupHash(username), this.crypto.lookupHash(ip), this.dateTime(until));
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
        this.dateTime(now),
      );
      return 1;
    }
    const windowExpired = now.getTime() - existing.window_started.getTime() > windowMs;
    const throttleExpired = existing.throttled_until !== null && existing.throttled_until.getTime() <= now.getTime();
    if (windowExpired || throttleExpired) {
      this.stmt(
        "UPDATE ip_throttle SET failed_count = 1, window_started = ?, throttled_until = NULL, updated_at = datetime('now') WHERE ip_hash = ?",
      ).run(this.dateTime(now), hash);
      return 1;
    }
    this.stmt("UPDATE ip_throttle SET failed_count = failed_count + 1, updated_at = datetime('now') WHERE ip_hash = ?").run(hash);
    return existing.failed_count + 1;
  }

  /** 节流该 IP：窗口内失败达阈值后设置过期时间（期间拒绝一切登录尝试） */
  throttleIp(ip: string, until: Date): void {
    this.stmt('UPDATE ip_throttle SET throttled_until = ?, updated_at = datetime(\'now\') WHERE ip_hash = ?').run(
      this.dateTime(until),
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
      'SELECT user_id, allowed_folders, hourly_token_limit, daily_minutes_limit, monthly_budget_micros, allow_upload, allow_git_download, allow_workspace_create, allow_ssh, allowed_agent_presets, allow_chat_media, banned, sandbox_mode, disabled_sessions, updated_at FROM user_permissions WHERE user_id = ?',
    ).get(userId) as
      | {
          user_id: number;
          allowed_folders: string | null;
          hourly_token_limit: number | null;
          daily_minutes_limit: number | null;
          monthly_budget_micros: number | null;
          allow_upload: number;
          allow_git_download: number;
          allow_workspace_create: number;
      allow_ssh: number;
          allowed_agent_presets: string | null;
          allow_chat_media: number | null;
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
      monthly_budget_micros: row.monthly_budget_micros,
      allow_upload: row.allow_upload === 1,
      allow_git_download: row.allow_git_download === 1,
      allow_workspace_create: row.allow_workspace_create === 1,
      allow_ssh: row.allow_ssh === 1,
      allowed_agent_presets: row.allowed_agent_presets === null ? null : parseJsonArray(row.allowed_agent_presets),
      allow_chat_media: Number(row.allow_chat_media) === 1,
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
      monthlyBudgetMicros?: number | null;
      allowUpload: boolean;
      allowGitDownload: boolean;
      allowWorkspaceCreate?: boolean;
      allowSsh?: boolean;
      allowedAgentPresets?: string[] | null;
      allowChatMedia?: boolean;
      banned: boolean;
      sandboxMode?: string | null;
      disabledSessions?: string[];
    },
  ): void {
    // 防御性清洗：空串/当前目录/根目录条目在 folderAllowed 里语义=全盘允许
    // （fail-open 陷阱）——网关端点已拒绝，数据层再兑底一次。
    const allowedFolders = sanitizeAllowedFolders(perms.allowedFolders);
    const existing = this.getPermissions(userId);
    const disabledSessions = [...new Set((perms.disabledSessions ?? existing?.disabled_sessions ?? []).filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(0, 2000);
    const allowWorkspaceCreate = perms.allowWorkspaceCreate ?? existing?.allow_workspace_create ?? false;
    const allowedAgentPresets = perms.allowedAgentPresets === undefined
      ? existing?.allowed_agent_presets ?? null
      : perms.allowedAgentPresets === null
        ? null
        : [...new Set(perms.allowedAgentPresets.filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 512))];
    const allowChatMedia = perms.allowChatMedia ?? existing?.allow_chat_media ?? false;
    this.stmt(
      `INSERT INTO user_permissions (user_id, allowed_folders, hourly_token_limit, daily_minutes_limit, monthly_budget_micros, allow_upload, allow_git_download, allow_workspace_create, allow_ssh, allowed_websocket_paths, allowed_agent_presets, allow_chat_media, banned, sandbox_mode, disabled_sessions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         allowed_folders = excluded.allowed_folders,
         hourly_token_limit = excluded.hourly_token_limit,
         daily_minutes_limit = excluded.daily_minutes_limit,
         monthly_budget_micros = excluded.monthly_budget_micros,
         allow_upload = excluded.allow_upload,
         allow_git_download = excluded.allow_git_download,
         allow_workspace_create = excluded.allow_workspace_create,
         allow_ssh = excluded.allow_ssh,
         allowed_websocket_paths = excluded.allowed_websocket_paths,
         allowed_agent_presets = excluded.allowed_agent_presets,
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
      perms.monthlyBudgetMicros ?? existing?.monthly_budget_micros ?? 0,
      perms.allowUpload ? 1 : 0,
      perms.allowGitDownload ? 1 : 0,
      allowWorkspaceCreate ? 1 : 0,
      (perms.allowSsh ?? existing?.allow_ssh ?? false) ? 1 : 0,
      '[]',
      allowedAgentPresets === null ? null : JSON.stringify(allowedAgentPresets),
      allowChatMedia ? 1 : 0,
      perms.banned ? 1 : 0,
      perms.sandboxMode === undefined ? existing?.sandbox_mode ?? null : perms.sandboxMode,
      JSON.stringify(disabledSessions),
    );
    if (perms.banned) this.stmt('DELETE FROM mobile_sessions WHERE user_id = ?').run(userId);
  }

  // ── SSH host alias 归属 ─────────────────────────
  /** 未登记的 alias 属于历史/管理员全局配置，不自动对外共享。 */
  getSshHostOwner(alias: string): number | null {
    const row = this.stmt('SELECT user_id FROM ssh_host_owners WHERE alias = ?').get(alias) as { user_id: number } | undefined;
    return row?.user_id ?? null;
  }

  listSshHostAliases(userId: number): string[] {
    return (this.stmt('SELECT alias FROM ssh_host_owners WHERE user_id = ? ORDER BY alias').all(userId) as { alias: string }[]).map((row) => row.alias);
  }

  /** All claimed legacy aliases, excluded from the administrator's unclaimed-host migration. */
  listClaimedSshHostAliases(): string[] {
    return (this.stmt('SELECT alias FROM ssh_host_owners ORDER BY alias').all() as { alias: string }[]).map((row) => row.alias);
  }

  claimSshHost(alias: string, userId: number): boolean {
    if (typeof alias !== 'string' || alias.length === 0 || alias.length > 256) return false;
    this.stmt(this.mysql ? 'INSERT IGNORE INTO ssh_host_owners (alias, user_id) VALUES (?, ?)' : 'INSERT OR IGNORE INTO ssh_host_owners (alias, user_id) VALUES (?, ?)').run(alias, userId);
    return this.getSshHostOwner(alias) === userId;
  }

  releaseSshHost(alias: string, userId: number): void {
    this.stmt('DELETE FROM ssh_host_owners WHERE alias = ? AND user_id = ?').run(alias, userId);
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
      const deleteWorkspaceRow = this.stmt('DELETE FROM managed_workspaces WHERE user_id = ? AND path = ?');
      const ownershipRows = this.stmt('SELECT user_id AS user_id, path AS path FROM managed_workspaces').all() as Array<{
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
        // Keep immutable ownership so deleted workspaces cannot make old sessions adoptable.
        const disabledByUser = new Map<number, Set<string>>();
        for (const row of this.listSessionOwners()) {
          if (!doomedSessions.has(row.session_id)) continue;
          const disabled = disabledByUser.get(row.user_id)
            ?? new Set(this.getPermissions(row.user_id)?.disabled_sessions ?? []);
          if (!disabled.has(row.session_id)) removedGrants += 1;
          disabled.add(row.session_id);
          disabledByUser.set(row.user_id, disabled);
          invalidate.add(row.user_id);
        }
        for (const [userId, disabled] of disabledByUser) {
          this.stmt("UPDATE user_permissions SET disabled_sessions = ?, updated_at = datetime('now') WHERE user_id = ?").run(JSON.stringify([...disabled]), userId);
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

  /** 返回这些会话的所属账号 ID，供清理失败时关闭相关连接；不修改归属记录。 */
  listSessionOwnerUserIds(sessionIds: readonly string[]): number[] {
    const wanted = [...new Set(
      sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200),
    )].slice(0, 2000);
    if (wanted.length === 0) return [];
    const found = new Set<number>();
    for (let index = 0; index < wanted.length; index += 256) {
      const chunk = wanted.slice(index, index + 256);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.stmt(
        `SELECT DISTINCT user_id AS user_id FROM session_owners WHERE session_id IN (${placeholders})`,
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
    const nowDatabase = this.dateTime(nowIso);
    const existing = this.getUsage(userId, day);
    if (!existing) {
      this.stmt(
        'INSERT INTO user_usage (user_id, day, first_seen_at, last_active_at, active_seconds, hourly_window_start, hourly_tokens) VALUES (?, ?, ?, ?, 0, ?, 0)',
      ).run(userId, day, nowDatabase, nowDatabase, nowDatabase);
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
    ).run(nowDatabase, delta, userId, day);
    return this.getUsage(userId, day)!;
  }

  /** 累计 token 用量（小时窗口起点不在当前窗口时自动重置计数） */
  addTokens(userId: number, day: string, tokens: number, nowIso: string): UsageRow {
    const nowDatabase = this.dateTime(nowIso);
    const existing = this.getUsage(userId, day);
    if (!existing) {
      this.stmt(
        'INSERT INTO user_usage (user_id, day, first_seen_at, last_active_at, active_seconds, hourly_window_start, hourly_tokens) VALUES (?, ?, ?, ?, 0, ?, ?)',
      ).run(userId, day, nowDatabase, nowDatabase, nowDatabase, tokens);
      return this.getUsage(userId, day)!;
    }
    const windowStart = existing.hourly_window_start ?? nowIso;
    const windowAge = new Date(nowIso).getTime() - new Date(windowStart).getTime();
    if (windowAge >= 3600_000) {
      this.stmt(
        'UPDATE user_usage SET hourly_window_start = ?, hourly_tokens = ? WHERE user_id = ? AND day = ?',
      ).run(nowDatabase, tokens, userId, day);
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

  // ── 用户本机工作区 ────────────────────────────────────────

  /** 记录或刷新一个子用户的宿主机专属工作区路径。 */
  setManagedWorkspace(userId: number, workspacePath: string): void {
    this.stmt(
      `INSERT INTO managed_workspaces (user_id, path) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET path = excluded.path`,
    ).run(userId, workspacePath);
  }

  /** 读取一个子用户的宿主机专属工作区。 */
  getManagedWorkspace(userId: number): ManagedWorkspaceRow | null {
    const row = this.stmt(
      'SELECT user_id, path, created_at FROM managed_workspaces WHERE user_id = ?',
    ).get(userId) as ManagedWorkspaceRow | undefined;
    return row ?? null;
  }

  /** 启动恢复与所有权判定使用的全部宿主机专属工作区。 */
  listManagedWorkspaces(): ManagedWorkspaceRow[] {
    return this.stmt(
      'SELECT user_id, path, created_at FROM managed_workspaces ORDER BY user_id ASC',
    ).all() as unknown as ManagedWorkspaceRow[];
  }

  /** 删除一条托管记录；不触碰宿主机目录。 */
  deleteManagedWorkspace(userId: number): void {
    this.stmt('DELETE FROM managed_workspaces WHERE user_id = ?').run(userId);
  }

  /** 返回包含目标路径的宿主机专属工作区所有者；普通路径返回 null。 */
  managedWorkspaceOwnerForPath(candidate: string): number | null {
    const resolved = path.resolve(candidate);
    for (const workspace of this.listManagedWorkspaces()) {
      const root = path.resolve(workspace.path);
      const relative = path.relative(root, resolved);
      if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
        return workspace.user_id;
      }
    }
    return null;
  }

  // ── 会话租户归属 ──────────────────────────────────────────

  /**
   * Claim an unowned session for one account and return its immutable owner.
   * Existing ownership wins so a forged or reused session id cannot be moved
   * between accounts. Rows intentionally survive user deletion.
   */
  claimSessionOwner(sessionId: string, userId: number): number {
    if (sessionId.length === 0 || sessionId.length > 200) throw new Error('Invalid session id');
    this.stmt(
      `INSERT INTO session_owners (session_id, user_id) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET user_id = session_owners.user_id`,
    ).run(sessionId, userId);
    const owner = this.getSessionOwner(sessionId);
    if (owner === null) throw new Error('Session ownership write could not be read');
    return owner;
  }

  /** Return one session's account owner, or null before legacy adoption. */
  getSessionOwner(sessionId: string): number | null {
    const row = this.stmt(
      'SELECT user_id FROM session_owners WHERE session_id = ?',
    ).get(sessionId) as { user_id: number } | undefined;
    return row === undefined ? null : Number(row.user_id);
  }

  /** Load the durable ownership index used by the gateway. */
  listSessionOwners(): SessionOwnerRow[] {
    const rows = this.stmt(
      'SELECT session_id, user_id, created_at, agent_preset FROM session_owners ORDER BY created_at ASC, session_id ASC',
    ).all() as unknown as SessionOwnerRow[];
    return rows.map((row) => ({ ...row, user_id: Number(row.user_id) }));
  }

  /**
   * Record the agent preset the Host resolved for one owned session. The gateway
   * authorizes every later prompt against this value, so it must outlive the
   * process that observed the session being created.
   */
  setSessionAgentPreset(sessionId: string, agentPreset: string): void {
    if (sessionId.length === 0 || sessionId.length > 200) throw new Error('Invalid session id');
    if (agentPreset.length === 0 || agentPreset.length > 200) throw new Error('Invalid agent preset id');
    this.stmt('UPDATE session_owners SET agent_preset = ? WHERE session_id = ?').run(agentPreset, sessionId);
  }

  /** Persist one resolved model selection without changing the deployment default. */
  setSessionModelSelection(
    sessionId: string,
    selection: { provider: string; model: string; reasoningEffort?: string },
  ): void {
    if (sessionId.length === 0 || sessionId.length > 200) throw new Error('Invalid session id');
    if (selection.provider.length === 0 || selection.provider.length > 512) throw new Error('Invalid provider id');
    if (selection.model.length === 0 || selection.model.length > 512) throw new Error('Invalid model id');
    if (selection.reasoningEffort !== undefined && (selection.reasoningEffort.length === 0 || selection.reasoningEffort.length > 191)) {
      throw new Error('Invalid reasoning effort');
    }
    this.stmt(
      `INSERT INTO session_model_selections (session_id, provider, model, reasoning_effort)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         model = excluded.model,
         reasoning_effort = excluded.reasoning_effort,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(sessionId, selection.provider, selection.model, selection.reasoningEffort ?? null);
  }

  /** Read the last successful model switch for one session. */
  getSessionModelSelection(sessionId: string): {
    provider: string;
    model: string;
    reasoningEffort?: string;
  } | null {
    if (sessionId.length === 0 || sessionId.length > 200) throw new Error('Invalid session id');
    const row = this.stmt(
      'SELECT session_id, provider, model, reasoning_effort, updated_at FROM session_model_selections WHERE session_id = ?',
    ).get(sessionId) as SessionModelSelectionRow | undefined;
    if (row === undefined) return null;
    return {
      provider: row.provider,
      model: row.model,
      ...row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort },
    };
  }

  /** 持久化一次成功配对；令牌只保存不可逆等值散列。 */
  createLocalWorkspace(input: {
    id: string;
    userId: number;
    token: string;
    deviceName: string;
    workspaceName: string;
    remoteRoot: string;
    placeholderPath: string;
    platform: string;
    shellEnabled: boolean;
    desktopControl: boolean;
  }): LocalWorkspaceRow {
    this.stmt(
      `INSERT INTO local_workspaces
       (id, user_id, token_hash, device_name, workspace_name, remote_root, placeholder_path, platform, shell_enabled,
        desktop_control_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.userId,
      this.localWorkspaceTokenHash(input.token),
      this.crypto.encrypt(input.deviceName),
      this.crypto.encrypt(input.workspaceName),
      this.crypto.encrypt(input.remoteRoot),
      input.placeholderPath,
      input.platform,
      input.shellEnabled ? 1 : 0,
      input.desktopControl ? 1 : 0,
    );
    const row = this.getLocalWorkspace(input.id);
    if (row === null) throw new Error('本机工作区配对写入后无法读取');
    return row;
  }

  /**
   * Roll back a just-created device-confirmation row when its original socket
   * disconnects before the token can be delivered. This is intentionally
   * owner-scoped and is only called while the Hub still treats the row as
   * provisional; established pairings are removed through revoke instead.
   */
  deleteProvisionalLocalWorkspace(userId: number, id: string): boolean {
    const result = this.stmt(
      'DELETE FROM local_workspaces WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    ).run(id, userId);
    return Number(result.changes) > 0;
  }

  /** 用长期设备令牌恢复一个未撤销的配对。 */
  authenticateLocalWorkspace(token: string): LocalWorkspaceRow | null {
    const row = this.stmt(
      'SELECT * FROM local_workspaces WHERE token_hash = ? AND revoked_at IS NULL',
    ).get(this.localWorkspaceTokenHash(token));
    return row === undefined ? null : this.mapLocalWorkspace(row);
  }

  /** 按稳定 id 读取一个配对，包括已撤销记录。 */
  getLocalWorkspace(id: string): LocalWorkspaceRow | null {
    const row = this.stmt('SELECT * FROM local_workspaces WHERE id = ?').get(id);
    return row === undefined ? null : this.mapLocalWorkspace(row);
  }

  /** 当前用户可管理的未撤销本机工作区。 */
  listLocalWorkspacesForUser(userId: number): LocalWorkspaceRow[] {
    return this.mapLocalWorkspaces(
      this.stmt(
        'SELECT * FROM local_workspaces WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      ).all(userId),
    );
  }

  /** 启动恢复使用的全部未撤销配对。 */
  listLocalWorkspaces(): LocalWorkspaceRow[] {
    return this.mapLocalWorkspaces(
      this.stmt('SELECT * FROM local_workspaces WHERE revoked_at IS NULL ORDER BY created_at ASC').all(),
    );
  }

  /**
   * Move one active pairing from its recorded placeholder to a stable path.
   * The expected old path makes concurrent startup restores a compare-and-swap;
   * SQLite and MySQL both expose the affected-row count through `SqlRunResult`.
   */
  migrateLocalWorkspacePlaceholderPath(
    id: string,
    userId: number,
    expectedPath: string,
    stablePath: string,
  ): boolean {
    const result = this.stmt(
      `UPDATE local_workspaces
       SET placeholder_path = ?
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND placeholder_path = ?`,
    ).run(stablePath, id, userId, expectedPath);
    return Number(result.changes) > 0;
  }

  /** 刷新伴随连接上报的展示事实，并记录最近在线时间。 */
  touchLocalWorkspace(
    id: string,
    input: {
      deviceName: string;
      workspaceName: string;
      remoteRoot: string;
      platform: string;
      shellEnabled: boolean;
      desktopControl: boolean;
    },
  ): void {
    this.stmt(
      `UPDATE local_workspaces
       SET device_name = ?, workspace_name = ?, remote_root = ?, platform = ?, shell_enabled = ?,
           desktop_control_enabled = ?, last_seen_at = datetime('now')
       WHERE id = ? AND revoked_at IS NULL`,
    ).run(
      this.crypto.encrypt(input.deviceName),
      this.crypto.encrypt(input.workspaceName),
      this.crypto.encrypt(input.remoteRoot),
      input.platform,
      input.shellEnabled ? 1 : 0,
      input.desktopControl ? 1 : 0,
      id,
    );
  }

  /** 撤销当前用户拥有的配对；重复撤销是幂等的。 */
  revokeLocalWorkspace(userId: number, id: string): boolean {
    const result = this.stmt(
      "UPDATE local_workspaces SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    ).run(id, userId);
    return Number(result.changes) > 0;
  }

  /** 子用户只能访问自己配对的远程占位目录；普通宿主目录不受此规则影响。 */
  localWorkspacePathAllowed(userId: number, candidate: string): boolean {
    const owner = this.localWorkspaceOwnerForPath(candidate);
    return owner === null || owner === userId;
  }

  /** 返回包含目标路径的未撤销本机工作区所有者；普通宿主路径返回 null。 */
  localWorkspaceOwnerForPath(candidate: string): number | null {
    const resolved = path.resolve(candidate);
    for (const workspace of this.listLocalWorkspaces()) {
      const root = path.resolve(workspace.placeholder_path);
      const relative = path.relative(root, resolved);
      if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
        return workspace.user_id;
      }
    }
    return null;
  }

  private localWorkspaceTokenHash(token: string): string {
    return this.crypto.lookupHash(`local-workspace:${token}`);
  }

  private mapLocalWorkspaces(rows: unknown): LocalWorkspaceRow[] {
    return (rows as Record<string, unknown>[]).map((row) => this.mapLocalWorkspace(row));
  }

  private mapLocalWorkspace(value: unknown): LocalWorkspaceRow {
    const row = value as {
      id: string;
      user_id: number;
      device_name: string;
      workspace_name: string;
      remote_root: string;
      placeholder_path: string;
      platform: string;
      shell_enabled: number;
      desktop_control_enabled: number;
      created_at: string;
      last_seen_at: string;
      revoked_at: string | null;
    };
    return {
      id: row.id,
      user_id: Number(row.user_id),
      device_name: this.crypto.decrypt(row.device_name) ?? '',
      workspace_name: this.crypto.decrypt(row.workspace_name) ?? '',
      remote_root: this.crypto.decrypt(row.remote_root) ?? '',
      placeholder_path: row.placeholder_path,
      platform: row.platform,
      shell_enabled: row.shell_enabled === 1,
      desktop_control_enabled: row.desktop_control_enabled === 1,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      revoked_at: row.revoked_at,
    };
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
      media: this.listMessageMedia(Number(row.id)),
    }));
  }

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
   * 消息媒体投影：只输出 ready 且未过期、且文件必须与消息同属一个所有者的资产。
   * **不输出 storage_key / sha256 / state**，访问媒体必须走「消息 ID → 不透明媒体 ID」
   * 的二次鉴权链路。
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

  /**
   * 回收这些消息上不再被引用的媒体元数据（调用方须已开启事务）：
   * 返回待删 storage keys，调用方按需删除文件。
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
    const orphaned = rows.filter((row) => !this.mediaAttachedToAnyMessage(String(row.id)));
    for (const row of orphaned) this.stmt('DELETE FROM media_assets WHERE id = ?').run(row.id);
    return {
      media_ids: orphaned.map((row) => String(row.id)),
      storage_keys: orphaned.map((row) => String(row.storage_key)).filter((key) => key !== ''),
    };
  }

  /** 留言写入计数：每 100 条修剪一次最旧记录（留言表长期运行也会无限增长） */
  private messageInsertCount = 0;
  private static readonly MESSAGES_MAX_ROWS = 2_000;
  private static readonly MESSAGES_PRUNE_EVERY = 100;

  /**
   * 消息历史修剪：每 100 条修剪一次最旧记录，同时清理 message_media 关系与
   * 不再被引用的媒体资产。返回本次需要删除的 storage keys（可忽略；
   * 媒体访问按消息鉴权，残留文件不可寻址）。
   *
   * 删除集合用 OFFSET 取「第 2000 条之后的旧记录」而不是 `id <= MAX(id) - 2000`：
   * 后者的前提是 id 连续，但消息 id 会因删除用户、手工整理而出现空洞。
   */
  private maybePruneMessages(): MediaRemovalPlan {
    this.messageInsertCount++;
    if (this.messageInsertCount % Database.MESSAGES_PRUNE_EVERY !== 0) {
      return { media_ids: [], storage_keys: [] };
    }
    try {
      // SQLite 用 LIMIT -1 表示“不限”；MySQL 无此写法，按手册用最大值代替。
      const doomed = this.stmt(
        this.mysql
          ? 'SELECT id FROM messages ORDER BY id DESC LIMIT 18446744073709551615 OFFSET ?'
          : 'SELECT id FROM messages ORDER BY id DESC LIMIT -1 OFFSET ?',
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

  // ── 媒体对象（聊天媒体上传/绑定/清理） ─────────────────────────

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
    const nowText = this.mediaTime(options.now ?? new Date());
    const pendingCutoff = this.mediaTime(options.pendingCutoff);
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

  /**
   * 媒体时间列的写入形态：接受 Date / ISO / 'YYYY-MM-DD HH:MM:SS'，统一输出
   * 'YYYY-MM-DD HH:MM:SS'（UTC）——与 SQLite 的 datetime('now') 文本可比，
   * 也是 MySQL DATETIME 接受的字面量（worker 以 timezone 'Z' 连接）。
   */
  private mediaTime(value: string | Date | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const raw = value.trim();
      if (raw === '') return null;
      return raw.includes('T') ? raw.slice(0, 19).replace('T', ' ') : raw;
    }
    const ms = value.getTime();
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  }

  /** 内部完整行读取（含 storage_key/sha256）；不对外暴露 */
  private selectMediaAsset(id: string): MediaAssetInternalRow | null {
    const row = this.stmt(`${MEDIA_SELECT_SQL} WHERE id = ?`).get(id) as MediaAssetInternalRow | undefined;
    if (!row) return null;
    return { ...row, expires_at: toIsoTimestamp(row.expires_at) };
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
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MEDIA_NAME_MAX);
    const sha256 = (typeof asset.sha256 === 'string' ? asset.sha256 : '').slice(0, MEDIA_SHA256_MAX);
    const effectiveKey = storageKey === '' ? `${PLACEHOLDER_STORAGE_KEY_PREFIX}${asset.id}` : storageKey;
    // 撞 id 或 storage_key（并发重复上传/重复签发同一 upload id）：绝不覆盖旧行
    const result = this.stmt(
      `${this.mysql ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO'} media_assets (id, owner_id, storage_key, original_name, media_kind, mime_type, byte_size, sha256, width, height, duration_ms, state, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      asset.id, asset.ownerId, effectiveKey, originalName, kind, mime, size, sha256,
      this.normalizeMediaDimension(asset.width), this.normalizeMediaDimension(asset.height),
      this.normalizeMediaDuration(asset.durationMs), state, this.mediaTime(asset.expiresAt),
    );
    if (Number(result.changes) === 0) {
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
   * 返回迁移后的投影；null = 资产不存在或状态不对。
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
      update.expiresAt === undefined ? this.mediaTime(row.expires_at) : this.mediaTime(update.expiresAt),
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
    const row = this.selectMediaAsset(id);
    return row === null ? null : { ...row, owner_id: Number(row.owner_id) };
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
    let sql = `SELECT id, media_kind AS kind, mime_type, byte_size, width, height, duration_ms
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
   * 写锁（SQLite BEGIN IMMEDIATE / MySQL 事务）+ idx_message_media_media 唯一索引
   * 共同保证不会重复占用。
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


  /** 平台主用户 id（首个 admin）；平台必有主用户，缺失说明数据损坏 */
  findAdminId(): number | null {
    const row = this.stmt("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get() as
      | { id: number }
      | undefined;
    return row ? Number(row.id) : null;
  }


  /** 登录失败/节流表修剪：防随机用户名+轮换 IP 喷洒让表无界增长 */
  pruneStaleSecurityRows(days = 7): void {
    const cutoff = this.dateTime(new Date(Date.now() - Math.max(days, 1) * 24 * 60 * 60 * 1000));
    this.stmt('DELETE FROM login_attempts WHERE updated_at < ?').run(cutoff);
    this.stmt('DELETE FROM ip_throttle WHERE updated_at < ?').run(cutoff);
  }

}
