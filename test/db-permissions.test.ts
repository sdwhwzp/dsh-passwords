import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Database, PermissionStateConflictError, SessionGrantsConflictError } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';

test('会话归属原子持久化、不可转移且拒绝非法 ID', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-session-grants-'));
  const dbPath = path.join(tempDir, 'grants.db');
  const crypto = createFieldCrypto('test-key', 'test-key');
  const db = new Database(dbPath, crypto);
  try {
    db.init();
    const first = db.createUser('first-user', '$2a$10$dummyhashdummyhashdummyhashdu');
    const second = db.createUser('second-user', '$2a$10$dummyhashdummyhashdummyhashdu');

    assert.equal(db.claimSessionOwner('s-one', first.id), first.id);
    assert.equal(db.claimSessionOwner('s-two', first.id), first.id);
    assert.equal(db.claimSessionOwner('s-one', second.id), first.id, '已有归属不得被其他用户转移');
    assert.throws(() => db.claimSessionOwner('', first.id), /Invalid session id/);
    assert.throws(() => db.claimSessionOwner('x'.repeat(201), first.id), /Invalid session id/);
    assert.deepEqual(
      db.listSessionOwners().map((row) => [row.session_id, row.user_id]),
      [['s-one', first.id], ['s-two', first.id]],
    );
    db.close();

    const reopened = new Database(dbPath, crypto);
    try {
      reopened.init();
      assert.equal(reopened.getSessionOwner('s-one'), first.id, '重启后归属必须持久化');
      assert.equal(reopened.getSessionOwner('s-two'), first.id);
    } finally {
      reopened.close();
    }
  } finally {
    try { db.close(); } catch { /* already closed for reopen assertion */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SSH alias 认领按用户隔离、互斥并在重启后保留', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-ssh-owner-'));
  const dbPath = path.join(tempDir, 'owners.db');
  const crypto = createFieldCrypto('test-key', 'test-key');
  const db = new Database(dbPath, crypto);
  try {
    db.init();
    const first = db.createUser('ssh-owner-first', '$2a$10$dummyhashdummyhashdummyhashdu');
    const second = db.createUser('ssh-owner-second', '$2a$10$dummyhashdummyhashdummyhashdu');
    assert.equal(db.claimSshHost('work-host', first.id), true);
    assert.equal(db.claimSshHost('work-host', second.id), false, '同一 alias 不得跨子用户认领');
    assert.equal(db.getSshHostOwner('work-host'), first.id);
    assert.deepEqual(db.listSshHostAliases(first.id), ['work-host']);
    assert.equal(db.claimSshHost('second-host', second.id), true);
    assert.deepEqual(db.listClaimedSshHostAliases(), ['second-host', 'work-host']);
    db.releaseSshHost('work-host', second.id);
    assert.equal(db.getSshHostOwner('work-host'), first.id, '非 owner 不得释放 alias');
    db.close();

    const reopened = new Database(dbPath, crypto);
    try {
      reopened.init();
      assert.equal(reopened.getSshHostOwner('work-host'), first.id, '认领关系必须跨重启持久化');
      assert.deepEqual(reopened.listClaimedSshHostAliases(), ['second-host', 'work-host']);
      reopened.releaseSshHost('work-host', first.id);
      assert.equal(reopened.getSshHostOwner('work-host'), null);
    } finally {
      reopened.close();
    }
  } finally {
    try { db.close(); } catch { /* closed for reopen assertion */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('极旧 user_permissions 表缺少上传与 git 列时会补齐并默认关闭', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-db-legacy-upload-'));
  const dbPath = path.join(tempDir, 'legacy-upload.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE user_permissions (
      user_id INTEGER PRIMARY KEY,
      allowed_folders TEXT,
      hourly_token_limit INTEGER,
      daily_minutes_limit INTEGER,
      banned INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO user_permissions (user_id, allowed_folders) VALUES (7, '["/srv/project"]');
  `);
  raw.close();

  const db = new Database(dbPath, createFieldCrypto('test-key', 'test-key'));
  try {
    db.init();
    const migrated = db.getPermissions(7);
    assert.equal(migrated?.allow_upload, false);
    assert.equal(migrated?.allow_git_download, false);
    assert.equal(migrated?.allow_ssh, false);
  } finally {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('旧 user_permissions 表会迁移 WebSocket 授权列，并保留现有权限', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-db-'));
  const dbPath = path.join(tempDir, 'legacy.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE user_permissions (
      user_id INTEGER PRIMARY KEY,
      allowed_folders TEXT,
      hourly_token_limit INTEGER,
      daily_minutes_limit INTEGER,
      allow_upload INTEGER NOT NULL DEFAULT 1,
      allow_git_download INTEGER NOT NULL DEFAULT 0,
      banned INTEGER NOT NULL DEFAULT 0,
      sandbox_mode TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO user_permissions
      (user_id, allowed_folders, hourly_token_limit, daily_minutes_limit, allow_upload, allow_git_download, banned, sandbox_mode)
    VALUES (7, '["/srv/project"]', 10, 20, 1, 1, 0, 'workspace-write');
  `);
  raw.close();

  const db = new Database(dbPath, createFieldCrypto('test-key', 'test-key'));
  try {
    db.init();
    const migrated = db.getPermissions(7);
    assert.deepEqual(migrated, {
      user_id: 7,
      allowed_folders: ['/srv/project'],
      hourly_token_limit: 10,
      daily_minutes_limit: 20,
      monthly_budget_micros: 0,
      allow_upload: true,
      allow_git_download: true,
      allow_workspace_create: false,
      allow_ssh: false,
      allowed_agent_presets: null,
    allowed_models: null,
      allow_chat_media: false,
      banned: false,
      sandbox_mode: 'workspace-write',
      disabled_sessions: [],
      updated_at: migrated?.updated_at,
    });

    db.setPermissions(7, {
      allowedFolders: ['/srv/project'],
      hourlyTokenLimit: 10,
      dailyMinutesLimit: 20,
      allowUpload: true,
      allowGitDownload: true,
      allowWorkspaceCreate: false,
      allowedAgentPresets: ['system/default'],
      banned: false,
      sandboxMode: 'workspace-write',
      disabledSessions: [],
    });
    db.setPermissions(7, {
      allowedFolders: ['/srv/project'],
      hourlyTokenLimit: 10,
      dailyMinutesLimit: 20,
      allowUpload: true,
      allowGitDownload: true,
      allowWorkspaceCreate: false,
      banned: false,
      sandboxMode: 'workspace-write',
      disabledSessions: [],
    });
    assert.equal(db.getPermissions(7)?.allow_ssh, false, '省略 SSH 权限时保留既有关闭状态');
    assert.deepEqual(db.getPermissions(7)?.allowed_agent_presets, ['system/default']);
    db.setPermissions(7, {
      allowedFolders: ['/srv/project'],
      hourlyTokenLimit: 10,
      dailyMinutesLimit: 20,
      allowUpload: true,
      allowGitDownload: true,
      allowWorkspaceCreate: false,
      allowedAgentPresets: null,
      banned: false,
      sandboxMode: 'workspace-write',
      disabledSessions: [],
    });
    assert.equal(db.getPermissions(7)?.allowed_agent_presets, null, 'NULL 必须保留不限制的兼容语义');

    db.setPermissions(7, {
      allowedFolders: ['/srv/project'],
      hourlyTokenLimit: 10,
      dailyMinutesLimit: 20,
      allowUpload: true,
      allowGitDownload: true,
      allowWorkspaceCreate: false,
      banned: false,
    });
    assert.equal(db.getPermissions(7)?.sandbox_mode, 'workspace-write', '省略 sandboxMode 不得清除既有策略');
    assert.deepEqual(db.getPermissions(7)?.disabled_sessions, [], '省略 disabledSessions 应保留当前集合');

    db.setPermissions(7, {
      allowedFolders: ['/srv/project'],
      hourlyTokenLimit: 10,
      dailyMinutesLimit: 20,
      allowUpload: true,
      allowGitDownload: true,
      allowWorkspaceCreate: false,
      banned: false,
      disabledSessions: ['disabled-session'],
    });
    db.setPermissions(7, {
      allowedFolders: ['/srv/project'],
      hourlyTokenLimit: 10,
      dailyMinutesLimit: 20,
      allowUpload: true,
      allowGitDownload: true,
      allowWorkspaceCreate: false,
      banned: false,
    });
    assert.deepEqual(db.getPermissions(7)?.disabled_sessions, ['disabled-session'], '省略 disabledSessions 不得恢复被禁用会话');
  } finally {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const GRANT_CAS_HASH = '$2a$10$dummyhashdummyhashdummyhashdu';

/** 会话授权写入的基线校验：管理员草稿读取之后子用户 session/create 追加的 grant
 *  绝不能被 DELETE+INSERT 覆盖；冲突必须整体回滚（含同一事务里的其它权限字段）。 */
test('Issue #25：会话授权基线不匹配时原子拒绝，不覆盖并发新增 grant', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-grant-cas-'));
  const dbPath = path.join(tempDir, 'cas.db');
  const crypto = createFieldCrypto('test-key', 'test-key');
  const db = new Database(dbPath, crypto);
  const base = {
    allowedFolders: ['/srv/project'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: false,
    allowGitDownload: false,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
  };
  try {
    db.init();
    const user = db.createUser('grant-cas-user', GRANT_CAS_HASH);
    db.setPermissions(user.id, { ...base, allowedSessionIds: ['s-one'] });
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-one']);

    // 管理员持有旧草稿期间，子用户 session/create 并发追加了一个 grant
    db.replaceUserSessionGrants(user.id, ['s-one', 's-concurrent']);

    assert.throws(
      () => db.setPermissions(user.id, {
        ...base,
        allowedFolders: ['/srv/other'],
        allowedSessionIds: ['s-one'],
        expectedAllowedSessionIds: ['s-one'],
      }),
      (error: unknown) => error instanceof SessionGrantsConflictError,
      '基线不匹配必须抛出具名冲突错误',
    );
    assert.deepEqual(
      db.listUserSessionGrants(user.id),
      ['s-concurrent', 's-one'],
      '冲突必须保留并发新增的 grant',
    );
    assert.deepEqual(
      db.getPermissions(user.id)?.allowed_folders,
      ['/srv/project'],
      '冲突必须回滚整个事务，不能落下部分权限改动',
    );

    // 基线一致（或调用方未声明基线）时才允许替换
    db.setPermissions(user.id, {
      ...base,
      allowedSessionIds: ['s-one'],
      expectedAllowedSessionIds: ['s-one', 's-concurrent'],
    });
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-one'], '基线一致时替换必须生效');
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/** 禁用会话写入的基线校验：旧权限草稿不能恢复并发新增的禁用项。 */
test('权限行并发修改时整笔保存回滚，不恢复已撤销的 SSH 权限', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-permission-cas-'));
  const db = new Database(path.join(tempDir, 'permissions.db'), createFieldCrypto('test-key', 'test-key'));
  try {
    db.init();
    const user = db.createUser('permission-cas-user', GRANT_CAS_HASH);
    const base = {
      allowedFolders: ['/srv/project'], hourlyTokenLimit: 100, dailyMinutesLimit: null,
      allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
      allowSsh: true, banned: false, sandboxMode: null,
    };
    db.setPermissions(user.id, base);
    const stale = db.getPermissions(user.id);
    assert.ok(stale);
    db.setPermissions(user.id, { ...base, allowSsh: false });
    assert.throws(() => db.setPermissions(user.id, {
      ...base, allowedFolders: ['/srv/changed'], expectedPermissionState: stale,
    }), (error: unknown) => error instanceof PermissionStateConflictError);
    assert.equal(db.getPermissions(user.id)?.allow_ssh, false);
    assert.deepEqual(db.getPermissions(user.id)?.allowed_folders, ['/srv/project']);
    db.setPermissions(user.id, {
      ...base, allowSsh: false, allowedFolders: ['/srv/changed'], expectedPermissionState: db.getPermissions(user.id),
    });
    assert.deepEqual(db.getPermissions(user.id)?.allowed_folders, ['/srv/changed']);
  } finally {
    try { db.close(); } catch { /* already closed */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Issue #25：禁用会话基线不匹配时原子拒绝，不恢复并发禁用变更', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-disabled-cas-'));
  const dbPath = path.join(tempDir, 'disabled-cas.db');
  const crypto = createFieldCrypto('test-key', 'test-key');
  const db = new Database(dbPath, crypto);
  const base = {
    allowedFolders: ['/srv/project'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: false,
    allowGitDownload: false,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
  };
  try {
    db.init();
    const user = db.createUser('disabled-cas-user', GRANT_CAS_HASH);
    db.setPermissions(user.id, { ...base, disabledSessions: ['s-one'] });
    db.setPermissions(user.id, { ...base, disabledSessions: ['s-one', 's-two'] });

    assert.throws(
      () => db.setPermissions(user.id, {
        ...base,
        allowedFolders: ['/srv/other'],
        disabledSessions: ['s-one'],
        expectedDisabledSessions: ['s-one'],
      }),
      (error: unknown) => error instanceof SessionGrantsConflictError && error.scope === 'disabled_sessions',
      '禁用会话基线不匹配必须抛出带 scope 的具名冲突错误',
    );
    assert.deepEqual(db.getPermissions(user.id)?.disabled_sessions, ['s-one', 's-two']);
    assert.deepEqual(db.getPermissions(user.id)?.allowed_folders, ['/srv/project'], '冲突必须回滚其它权限字段');

    db.setPermissions(user.id, {
      ...base,
      disabledSessions: ['s-one'],
      expectedDisabledSessions: ['s-one', 's-two'],
    });
    assert.deepEqual(db.getPermissions(user.id)?.disabled_sessions, ['s-one'], '基线一致时替换必须生效');
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/** 沙盒收紧后的回收只删除被撤销的 ID：请求 `await` 期间并发追加的 grant 不得被整表替换抹掉。 */
test('Issue #25：显式会话授权和迁移标记在同一权限事务提交', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-grant-seeded-'));
  const dbPath = path.join(tempDir, 'seeded.db');
  const db = new Database(dbPath, createFieldCrypto('test-key', 'test-key'));
  try {
    db.init();
    const user = db.createUser('grant-seeded-user', GRANT_CAS_HASH);
    db.setPermissions(user.id, {
      allowedFolders: ['/srv/project'],
      hourlyTokenLimit: null,
      dailyMinutesLimit: null,
      allowUpload: false,
      allowGitDownload: false,
      allowWorkspaceCreate: false,
      banned: false,
      sandboxMode: null,
      disabledSessions: [],
      allowedSessionIds: ['s-one'],
      sessionGrantsSeeded: true,
    });
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-one']);
    assert.equal(db.isSessionGrantsSeeded(user.id), true, '提交显式 grant 时必须同步阻止旧数据种子覆盖');
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/** 沙盒收紧后的回收只删除被撤销的 ID：请求 `await` 期间并发追加的 grant 不得被整表替换抹掉。 */
test('Issue #25：按 ID 回收 grant 不影响其它并发授权', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-grant-delete-'));
  const dbPath = path.join(tempDir, 'delete.db');
  const crypto = createFieldCrypto('test-key', 'test-key');
  const db = new Database(dbPath, crypto);
  try {
    db.init();
    const user = db.createUser('grant-delete-user', GRANT_CAS_HASH);
    db.replaceUserSessionGrants(user.id, ['s-one', 's-two']);

    db.deleteUserSessionGrants(user.id, ['s-one', 'not-granted', '', 'x'.repeat(201)]);
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-two'], '只删除显式给出的已授权 ID');

    db.deleteUserSessionGrants(user.id, []);
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-two'], '空集合必须是无副作用的 no-op');

    db.deleteUserSessionGrants(user.id, ['s-two']);
    assert.deepEqual(db.listUserSessionGrants(user.id), []);
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * 追加式授权（最小原子 API）：只新增一条，不重写整表，因此与 replaceUserSessionGrants
 * 的「整表替换」语义必须保持可区分；重复追加幂等，非法 ID 无副作用。
 */
test('追加会话授权：单条 OR IGNORE 追加、重复幂等、非法 ID 无副作用', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-grant-add-'));
  const dbPath = path.join(tempDir, 'grant-add.db');
  const crypto = createFieldCrypto('test-key', 'test-key');
  const db = new Database(dbPath, crypto);
  try {
    db.init();
    const user = db.createUser('grant-add-user', GRANT_CAS_HASH);
    const other = db.createUser('grant-add-other', GRANT_CAS_HASH);

    assert.equal(db.addUserSessionGrant(user.id, 's-one'), true, '首次追加必须报告新增');
    assert.equal(db.addUserSessionGrant(user.id, 's-two'), true);
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-one', 's-two'], '追加不得影响已有授权');
    assert.equal(db.hasUserSessionGrant(other.id, 's-two'), false, '追加不得跨用户泄露');

    assert.equal(db.addUserSessionGrant(user.id, 's-one'), false, '重复追加必须是幂等 no-op');
    assert.equal(db.addUserSessionGrant(user.id, 's-two'), false);
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-one', 's-two'], '重复追加不得改变集合');

    // 整表替换仍是显式操作：替换后才不会有旧授权残留
    db.replaceUserSessionGrants(user.id, ['s-three']);
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-three'], '整表替换语义必须保留');
    assert.equal(db.addUserSessionGrant(user.id, 's-four'), true);
    // listUserSessionGrants 按 session_id 升序返回
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-four', 's-three']);

    assert.equal(db.addUserSessionGrant(user.id, ''), false, '空串不是合法会话 ID');
    assert.equal(db.addUserSessionGrant(user.id, 'x'.repeat(201)), false, '超长 ID 必须被拒绝');
    assert.equal(db.addUserSessionGrant(user.id, 123 as unknown as string), false, '非字符串必须被拒绝');
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-four', 's-three'], '非法 ID 必须无副作用');

    db.close();
    const reopened = new Database(dbPath, crypto);
    try {
      reopened.init();
      assert.deepEqual(reopened.listUserSessionGrants(user.id), ['s-four', 's-three'], '追加必须持久化');
    } finally {
      reopened.close();
    }
  } finally {
    try { db.close(); } catch { /* 重开后已关闭 */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * Issue #19 旧数据种子化：首次 OR IGNORE 追加并置于同一持写锁事务里置位标记，
 * 之后（标记已置位）整体 no-op。种子集合外的既有授权、迁移期间并发追加的授权
 * 都不得被抹掉（禁止 DELETE+INSERT）。
 */
test('seedUserSessionGrants：首次 OR IGNORE 追加并置位，已 seed 后 no-op', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-grant-seed-'));
  const dbPath = path.join(tempDir, 'grant-seed.db');
  const crypto = createFieldCrypto('test-key', 'test-key');
  const db = new Database(dbPath, crypto);
  const base = {
    allowedFolders: ['/srv/project'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: false,
    allowGitDownload: false,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
  };
  try {
    db.init();
    const user = db.createUser('grant-seed-user', GRANT_CAS_HASH);
    // 管理员已显式授权 s-admin（同时创建了种子化标记要落在上面的权限行）
    db.setPermissions(user.id, { ...base, allowedSessionIds: ['s-admin'] });
    assert.equal(db.isSessionGrantsSeeded(user.id), false, '显式整表授权不等于完成旧数据种子化');

    // 种子集合不含 s-admin，且自身有重复项与非法项：既不删既有授权，也不写入非法 ID
    assert.equal(db.seedUserSessionGrants(user.id, ['s-visible', 's-visible', '', 'x'.repeat(201)]), true);
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-admin', 's-visible'], '种子化必须追加而非整表替换');
    assert.equal(db.isSessionGrantsSeeded(user.id), true, '种子化必须与授权同事务置位迁移标记');

    // 已 seed：整体 no-op，种子集合之外新出现的会话不得再被自动授权
    assert.equal(db.seedUserSessionGrants(user.id, ['s-later']), false);
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-admin', 's-visible']);

    // 幂等：迁移期间并发追加的授权也不会被后续 seed 调用抹掉
    db.addUserSessionGrant(user.id, 's-concurrent');
    assert.equal(db.seedUserSessionGrants(user.id, ['s-visible']), false);
    assert.equal(db.seedUserSessionGrants(user.id, []), false, '空集合在已 seed 后同样是 no-op');
    assert.deepEqual(db.listUserSessionGrants(user.id), ['s-admin', 's-concurrent', 's-visible']);

    // 无会话可迁移也属于「完成种子化」：置位后不再自动授权
    const emptyUser = db.createUser('grant-seed-empty-user', GRANT_CAS_HASH);
    db.setPermissions(emptyUser.id, { ...base, allowedSessionIds: [] });
    assert.equal(db.seedUserSessionGrants(emptyUser.id, ['', 'x'.repeat(201)]), true);
    assert.deepEqual(db.listUserSessionGrants(emptyUser.id), []);
    assert.equal(db.isSessionGrantsSeeded(emptyUser.id), true);
    assert.equal(db.seedUserSessionGrants(emptyUser.id, ['s-visible']), false, '置位后不得再追加');
    assert.deepEqual(db.listUserSessionGrants(emptyUser.id), []);

    db.close();
    const reopened = new Database(dbPath, crypto);
    try {
      reopened.init();
      assert.equal(reopened.isSessionGrantsSeeded(user.id), true, '迁移标记必须持久化');
      assert.deepEqual(
        reopened.listUserSessionGrants(user.id),
        ['s-admin', 's-concurrent', 's-visible'],
        '种子化结果必须持久化',
      );
    } finally {
      reopened.close();
    }
  } finally {
    try { db.close(); } catch { /* 重开后已关闭 */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * 缺 user_permissions 行的用户默认拒绝全部目录：种子化不得隐式补出权限行
 * （补出来的行 allowed_folders 为 NULL，读取侧按「空白名单 = 不限目录」解释，
 * 等于借迁移放大权限），也不得只写一半授权。
 */
test('seedUserSessionGrants：缺权限行时 fail-closed 整体 no-op，不补权限行', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-grant-seed-norow-'));
  const dbPath = path.join(tempDir, 'grant-seed-norow.db');
  const db = new Database(dbPath, createFieldCrypto('test-key', 'test-key'));
  try {
    db.init();
    const user = db.createUser('grant-seed-norow-user', GRANT_CAS_HASH);
    assert.equal(db.getPermissions(user.id), null, '前置条件：该用户没有权限行');

    assert.equal(db.seedUserSessionGrants(user.id, ['s-visible']), false);
    assert.deepEqual(db.listUserSessionGrants(user.id), [], '无法置位时不得留下部分写入的授权');
    assert.equal(db.getPermissions(user.id), null, '不得隐式创建权限行（会把 deny-all 放大为不限目录）');
    assert.equal(db.isSessionGrantsSeeded(user.id), false);

    // 反复调用保持同一 no-op，不累积状态
    assert.equal(db.seedUserSessionGrants(user.id, ['s-visible', 's-later']), false);
    assert.deepEqual(db.listUserSessionGrants(user.id), []);
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});
