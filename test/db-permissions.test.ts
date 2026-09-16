import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';

test('Issue #19：显式会话 grant 原子持久化、隔离且拒绝非法 ID', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-session-grants-'));
  const dbPath = path.join(tempDir, 'grants.db');
  const crypto = createFieldCrypto('test-key', 'test-key');
  const db = new Database(dbPath, crypto);
  try {
    db.init();
    const first = db.createUser('first-user', '$2a$10$dummyhashdummyhashdummyhashdu');
    const second = db.createUser('second-user', '$2a$10$dummyhashdummyhashdummyhashdu');

    db.replaceUserSessionGrants(first.id, ['s-one', 's-one', '', 'x'.repeat(201), 's-two']);
    assert.deepEqual(db.listUserSessionGrants(first.id), ['s-one', 's-two']);
    assert.equal(db.hasUserSessionGrant(first.id, 's-one'), true);
    assert.equal(db.hasUserSessionGrant(second.id, 's-one'), false, '授权不得跨用户泄露');

    db.replaceUserSessionGrants(first.id, ['s-three']);
    assert.deepEqual(db.listUserSessionGrants(first.id), ['s-three'], '替换必须移除旧授权');
    db.close();

    const reopened = new Database(dbPath, crypto);
    try {
      reopened.init();
      assert.deepEqual(reopened.listUserSessionGrants(first.id), ['s-three'], '重启后授权必须持久化');
    } finally {
      reopened.close();
    }
  } finally {
    try { db.close(); } catch { /* already closed for reopen assertion */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SSH alias 归属读写 API 已退役（表仅为旧库迁移保留）', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-ssh-owner-'));
  const dbPath = path.join(tempDir, 'owners.db');
  const crypto = createFieldCrypto('test-key', 'test-key');
  const db = new Database(dbPath, crypto);
  try {
    db.init();
    // 退役后不得再暴露逐 alias 归属读写能力（改由主用户登记的端点表统一管）
    assert.equal(typeof (db as unknown as Record<string, unknown>).claimSshHost, 'undefined');
    assert.equal(typeof (db as unknown as Record<string, unknown>).getSshHostOwner, 'undefined');
    assert.equal(typeof (db as unknown as Record<string, unknown>).listSshHostAliases, 'undefined');
    assert.equal(typeof (db as unknown as Record<string, unknown>).releaseSshHost, 'undefined');
  } finally {
    try { db.close(); } catch { /* already closed */ }
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

test('旧 user_permissions 表会迁移缺失列，并保留现有权限', () => {
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

test('删除用户级联清理工作区所有权；启动迁移清除孤儿所有权行', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-orphan-ownership-'));
  const dbPath = path.join(tempDir, 'orphan.db');
  const crypto = createFieldCrypto('test-key', 'test-key');
  const db = new Database(dbPath, crypto);
  try {
    db.init();
    const gone = db.createUser('gone-user', '$2a$10$dummyhashdummyhashdummyhashdu');
    const keeper = db.createUser('keeper-user', '$2a$10$dummyhashdummyhashdummyhashdu');
    db.addUserWorkspace(gone.id, '/srv/gone-ws');
    db.addUserWorkspace(keeper.id, '/srv/keeper-ws');
    db.replaceUserSessionGrants(gone.id, ['s-gone']);
    db.setPermissions(gone.id, {
      allowedFolders: ['/srv/gone-ws'], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
      banned: false, sandboxMode: null, disabledSessions: [],
    });

    // deleteUser 必须带走所有权/授权/权限行：残留会被当作「另一子用户的所有权」
    // 阻断 baseline 可见性与该目录的登记/创建（112233 事故根因）。
    db.deleteUser(gone.id);
    assert.deepEqual(db.listWorkspaceOwners().map((o) => o.path), ['/srv/keeper-ws'], '删除用户必须级联清理其所有权行');
    assert.deepEqual(db.listUserSessionGrants(gone.id), []);
    assert.equal(db.getPermissions(gone.id), null);

    // 历史残留（旧版 deleteUser 未清理）由 init() 迁移幂等清除；权限/授权行
    // 不在迁移清理范围（旧库可能先导权限行后建用户，不能误删）。
    (db as unknown as { db: DatabaseSync }).db.exec(
      "INSERT INTO user_workspaces (user_id, path) VALUES (9999, '/srv/legacy-orphan')",
    );
    (db as unknown as { db: DatabaseSync }).db.exec(
      "INSERT INTO user_session_grants (user_id, session_id) VALUES (9999, 's-orphan')",
    );
    db.close();
    const reopened = new Database(dbPath, crypto);
    try {
      reopened.init();
      assert.deepEqual(
        reopened.listWorkspaceOwners().map((o) => o.path).sort(),
        ['/srv/keeper-ws'],
        'init 迁移必须清除已删除用户残留的所有权行',
      );
      assert.deepEqual(
        reopened.listUserSessionGrants(9999),
        ['s-orphan'],
        '迁移不得误删孤儿授权行（无害且可能来自旧库分步导入）',
      );
    } finally {
      reopened.close();
    }
  } finally {
    try { db.close(); } catch { /* 用例内已关闭并重开 */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});
