import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import type { PlatformConfig } from '../src/config.js';

let tempDir: string;
let db: Database;
let auth: AuthService;

before(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-seed-'));
  const dbPath = path.join(tempDir, 'test.db');
  db = new Database(dbPath, createFieldCrypto('test-key', 'test-key'));
  db.init();
  db.createUser('admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');
  const config: PlatformConfig = {
    setupKey: 'test-setup-key', dbPath, dbEncKey: 'test-key',
    gateway: {
      host: '127.0.0.1', port: 0, upstream: 'http://127.0.0.1:1',
      tls: null, redirectPort: null, publicHost: '', domain: 'localhost', autoTls: false,
      acmeEmail: '', acmeStaging: false,
    },
    jwtSecret: 'test-secret', internalSecret: 'test-internal',
    patch: { dshRoot: '', restartService: '' }, webSocket: { sshEndpoints: [] },
  };
  auth = new AuthService(config, db);
});

after(() => {
  db?.close();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows cleanup is best effort */ }
});

test('新建子用户不会被播种成一个 preset 都不许用的死号', async () => {
  // [] 的语义是"允许零个 preset"，而 provision 与 mergedPermissions 都不带这个
  // 字段，setPermissions 遇 undefined 保留旧值 —— 播种 [] 会让账号在目录和预算
  // 都开通之后，每一条 session/prompt 仍被 preset 闸门 403。
  await auth.addSubUser(
    { id: '1', username: 'admin', role: 'admin' },
    'fresh-user',
    'Passw0rd!fresh',
  );
  const created = db.getUserByUsername('fresh-user');
  assert.notEqual(created, null);
  assert.equal(db.getPermissions(created!.id)?.allowed_agent_presets, null);
});

test('建号窗口期仍然 fail-closed：目录拒绝 + 预算为零', async () => {
  const created = db.getUserByUsername('fresh-user');
  const permissions = db.getPermissions(created!.id);
  assert.deepEqual(permissions?.allowed_folders, ['__deny__']);
  assert.equal(permissions?.monthly_budget_micros, 0);
});
