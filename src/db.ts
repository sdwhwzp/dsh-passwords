// Account and quota repository with SQLite and MySQL storage drivers.
// 表结构：users / platform_settings / audit_logs / login_attempts
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
import { mkdirSync } from 'node:fs';
import path from 'node:path';
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
  allowed_websocket_paths: string[];
  /** Null preserves unrestricted legacy accounts; an empty array denies every preset. */
  allowed_agent_presets: string[] | null;
  banned: boolean;
  sandbox_mode: string | null;
  disabled_sessions: string[];
  updated_at: string;
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
export interface MessageRow {
  id: number;
  sender_id: number;
  sender_name: string;
  recipient_id: number | null;
  content: string;
  tags: string[];
  created_at: string;
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
}

/** Durable model selection owned by one DSH session. */
export interface SessionModelSelectionRow {
  session_id: string;
  provider: string;
  model: string;
  reasoning_effort: string | null;
  updated_at: string;
}


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
  monthly_budget_micros INTEGER NOT NULL DEFAULT 0, -- 人民币微元；NULL = 不限（仅管理员）
  allow_upload       INTEGER NOT NULL DEFAULT 1,
  allow_git_download INTEGER NOT NULL DEFAULT 0,
  allow_workspace_create INTEGER NOT NULL DEFAULT 0,
  allowed_websocket_paths TEXT NOT NULL DEFAULT '[]',
  allowed_agent_presets TEXT,
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
  session_id TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_session_owners_user ON session_owners(user_id);
CREATE TABLE IF NOT EXISTS session_model_selections (
  session_id       TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  reasoning_effort TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

`;

const MYSQL_SCHEMA = `
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS platform_settings (
  k VARCHAR(191) PRIMARY KEY,
  v TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(191) NOT NULL,
  username   TEXT,
  ip         TEXT,
  user_agent TEXT,
  detail     MEDIUMTEXT,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS login_attempts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username_hash VARCHAR(128) NOT NULL,
  ip_hash       VARCHAR(128) NOT NULL,
  failed_count  INT NOT NULL DEFAULT 0,
  locked_until  DATETIME(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY idx_login_identity (username_hash, ip_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS ip_throttle (
  ip_hash         VARCHAR(128) PRIMARY KEY,
  failed_count    INT NOT NULL DEFAULT 0,
  window_started  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  throttled_until DATETIME(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id               INT UNSIGNED PRIMARY KEY,
  allowed_folders       MEDIUMTEXT,
  hourly_token_limit    BIGINT,
  daily_minutes_limit   INT,
  monthly_budget_micros BIGINT NOT NULL DEFAULT 0,
  allow_upload          TINYINT NOT NULL DEFAULT 1,
  allow_git_download    TINYINT NOT NULL DEFAULT 0,
  allow_workspace_create TINYINT NOT NULL DEFAULT 0,
  allowed_websocket_paths MEDIUMTEXT NOT NULL,
  allowed_agent_presets MEDIUMTEXT,
  banned                TINYINT NOT NULL DEFAULT 0,
  sandbox_mode          VARCHAR(64),
  disabled_sessions     MEDIUMTEXT NOT NULL,
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS user_usage (
  user_id             INT UNSIGNED NOT NULL,
  day                 CHAR(10) NOT NULL,
  first_seen_at       DATETIME(3),
  last_active_at      DATETIME(3),
  active_seconds      INT NOT NULL DEFAULT 0,
  hourly_window_start DATETIME(3),
  hourly_tokens       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS messages (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sender_id    INT UNSIGNED NOT NULL,
  recipient_id INT UNSIGNED,
  content      MEDIUMTEXT NOT NULL,
  tags         MEDIUMTEXT NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_messages_created (id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
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
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at       DATETIME(3),
  KEY idx_local_workspaces_user (user_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS managed_workspaces (
  user_id    INT UNSIGNED PRIMARY KEY,
  path       VARCHAR(768) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS session_owners (
  session_id VARCHAR(200) PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_session_owners_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS session_model_selections (
  session_id       VARCHAR(200) PRIMARY KEY,
  provider         VARCHAR(512) NOT NULL,
  model            VARCHAR(512) NOT NULL,
  reasoning_effort VARCHAR(191),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
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
      this.migrateUsers();
      this.migrateAuditLogs();
      this.setSetting('mysql_schema_version', '1');
      this.setSetting('enc_migrated_v1', '1');
      return;
    }
    // 删除内容清零，防止已删除的明文残留在空闲页可被文件扫描恢复
    this.db.exec('PRAGMA secure_delete = ON');
    this.db.exec(SCHEMA);
    this.migrateRoles();
    this.migratePermissions();
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
    add('allow_workspace_create', 'INTEGER NOT NULL DEFAULT 0', 'TINYINT NOT NULL DEFAULT 0');
    add('allowed_websocket_paths', "TEXT NOT NULL DEFAULT '[]'", 'MEDIUMTEXT NULL');
    add('allowed_agent_presets', 'TEXT', 'MEDIUMTEXT');
    add('sandbox_mode', 'TEXT', 'VARCHAR(64)');
    add('disabled_sessions', "TEXT NOT NULL DEFAULT '[]'", 'MEDIUMTEXT NULL');
    add('monthly_budget_micros', 'INTEGER NOT NULL DEFAULT 0', 'BIGINT NOT NULL DEFAULT 0');
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
      this.stmt('DELETE FROM user_usage WHERE user_id = ?').run(id);
      this.stmt('DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?').run(id, id);
      this.stmt('DELETE FROM local_workspaces WHERE user_id = ?').run(id);
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
      'SELECT user_id, allowed_folders, hourly_token_limit, daily_minutes_limit, monthly_budget_micros, allow_upload, allow_git_download, allow_workspace_create, allowed_websocket_paths, allowed_agent_presets, banned, sandbox_mode, disabled_sessions, updated_at FROM user_permissions WHERE user_id = ?',
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
          allowed_websocket_paths: string | null;
          allowed_agent_presets: string | null;
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
      allowed_websocket_paths: parseJsonArray(row.allowed_websocket_paths),
      allowed_agent_presets: row.allowed_agent_presets === null ? null : parseJsonArray(row.allowed_agent_presets),
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
      allowedWebSocketPaths?: string[];
      allowedAgentPresets?: string[] | null;
      banned: boolean;
      sandboxMode: string | null;
      disabledSessions?: string[];
    },
  ): void {
    // 防御性清洗：空串/当前目录/根目录条目在 folderAllowed 里语义=全盘允许
    // （fail-open 陷阱）——网关端点已拒绝，数据层再兑底一次。
    const allowedFolders = sanitizeAllowedFolders(perms.allowedFolders);
    const disabledSessions = [...new Set((perms.disabledSessions ?? []).filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(0, 2000);
    const existing = this.getPermissions(userId);
    const allowWorkspaceCreate = perms.allowWorkspaceCreate ?? existing?.allow_workspace_create ?? false;
    const allowedWebSocketPaths = perms.allowedWebSocketPaths === undefined
      ? existing?.allowed_websocket_paths ?? []
      : [...new Set(perms.allowedWebSocketPaths.filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 512))];
    const allowedAgentPresets = perms.allowedAgentPresets === undefined
      ? existing?.allowed_agent_presets ?? null
      : perms.allowedAgentPresets === null
        ? null
        : [...new Set(perms.allowedAgentPresets.filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 512))];
    this.stmt(
      `INSERT INTO user_permissions (user_id, allowed_folders, hourly_token_limit, daily_minutes_limit, monthly_budget_micros, allow_upload, allow_git_download, allow_workspace_create, allowed_websocket_paths, allowed_agent_presets, banned, sandbox_mode, disabled_sessions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         allowed_folders = excluded.allowed_folders,
         hourly_token_limit = excluded.hourly_token_limit,
         daily_minutes_limit = excluded.daily_minutes_limit,
         monthly_budget_micros = excluded.monthly_budget_micros,
         allow_upload = excluded.allow_upload,
         allow_git_download = excluded.allow_git_download,
         allow_workspace_create = excluded.allow_workspace_create,
         allowed_websocket_paths = excluded.allowed_websocket_paths,
         allowed_agent_presets = excluded.allowed_agent_presets,
         banned = excluded.banned,
         sandbox_mode = excluded.sandbox_mode,
         disabled_sessions = excluded.disabled_sessions,
         updated_at = datetime('now')`,
    ).run(
      userId,
      JSON.stringify(allowedFolders),
      perms.hourlyTokenLimit,
      perms.dailyMinutesLimit,
      perms.monthlyBudgetMicros ?? 0,
      perms.allowUpload ? 1 : 0,
      perms.allowGitDownload ? 1 : 0,
      allowWorkspaceCreate ? 1 : 0,
      JSON.stringify(allowedWebSocketPaths),
      allowedAgentPresets === null ? null : JSON.stringify(allowedAgentPresets),
      perms.banned ? 1 : 0,
      perms.sandboxMode,
      JSON.stringify(disabledSessions),
    );
  }

  // ── 用户用量（时间 / token 配额） ─────────────────────────
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
      'SELECT session_id, user_id, created_at FROM session_owners ORDER BY created_at ASC, session_id ASC',
    ).all() as unknown as SessionOwnerRow[];
    return rows.map((row) => ({ ...row, user_id: Number(row.user_id) }));
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
  }): LocalWorkspaceRow {
    this.stmt(
      `INSERT INTO local_workspaces
       (id, user_id, token_hash, device_name, workspace_name, remote_root, placeholder_path, platform, shell_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    input: { deviceName: string; workspaceName: string; remoteRoot: string; platform: string; shellEnabled: boolean },
  ): void {
    this.stmt(
      `UPDATE local_workspaces
       SET device_name = ?, workspace_name = ?, remote_root = ?, platform = ?, shell_enabled = ?,
           last_seen_at = datetime('now')
       WHERE id = ? AND revoked_at IS NULL`,
    ).run(
      this.crypto.encrypt(input.deviceName),
      this.crypto.encrypt(input.workspaceName),
      this.crypto.encrypt(input.remoteRoot),
      input.platform,
      input.shellEnabled ? 1 : 0,
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
    }));
  }

  /** 留言写入计数：每 100 条修剪一次最旧记录（留言表长期运行也会无限增长） */
  private messageInsertCount = 0;
  private static readonly MESSAGES_MAX_ROWS = 2_000;
  private static readonly MESSAGES_PRUNE_EVERY = 100;

  addMessage(senderId: number, recipientId: number | null, content: string, tags: string[]): MessageRow {
    const result = this.stmt('INSERT INTO messages (sender_id, recipient_id, content, tags) VALUES (?, ?, ?, ?)').run(
      senderId,
      recipientId,
      content,
      JSON.stringify(tags),
    );
    this.messageInsertCount++;
    if (this.messageInsertCount % Database.MESSAGES_PRUNE_EVERY === 0) {
      try {
        const threshold = this.stmt('SELECT MAX(id) - ? AS id FROM messages').get(
          Database.MESSAGES_MAX_ROWS,
        ) as { id: number | null } | undefined;
        if (threshold?.id !== null && threshold?.id !== undefined) {
          this.stmt('DELETE FROM messages WHERE id <= ?').run(threshold.id);
        }
      } catch (error) {
        // 修剪失败（磁盘满/数据库锁）：记录告警——留言表会持续增长，不能静默
        console.warn('[dsh-passwords] 留言修剪失败（表可能持续增长）:', String(error));
      }
    }
    const sender = this.getUserById(senderId);
    return {
      id: Number(result.lastInsertRowid),
      sender_id: senderId,
      sender_name: sender?.username ?? '',
      recipient_id: recipientId,
      content,
      tags,
      created_at: new Date().toISOString(),
    };
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
