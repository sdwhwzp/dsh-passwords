// POST /gateway/api/fs/delete-directory：目录选择器删除按钮的后端契约测试。
//
// 授权模型：仅主用户（requireAdmin）；子用户 403。
// 安全约束：realpath 防逃逸、必须目录、敏感基列表（部署根/数据库/DSH 目录/
// SSH 凭据/OS 系统目录）及其子路径、文件系统根与用户主目录本身、审计留痕。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';

import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer } from '../src/gateway.js';
import type { PlatformConfig } from '../src/config.js';

let appDir: string;
let rootDir: string;
let db: Database;
let gateway: http.Server;
let upstream: http.Server;
let gatewayPort = 0;
let adminCookie = '';
let subuserCookie = '';

function post(url: string, body: unknown, cookie: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: gatewayPort,
        method: 'POST',
        path: url,
        headers: { cookie, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const del = (target: string, cookie = adminCookie) => post('/gateway/api/fs/delete-directory', { path: target }, cookie);

before(async () => {
  appDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-fsdel-app-'));
  rootDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-fsdel-root-'));
  mkdirSync(path.join(appDir, 'data'));
  // 待删目录：嵌套内容 + 隐藏目录（模拟 /root 下的测试工作区）
  mkdirSync(path.join(rootDir, 'e2e-target', 'nested'), { recursive: true });
  writeFileSync(path.join(rootDir, 'e2e-target', 'nested', 'file.txt'), 'x');
  mkdirSync(path.join(rootDir, '.e2e-hidden', 'inner'), { recursive: true });
  writeFileSync(path.join(rootDir, 'plain-file.txt'), 'not a directory');
  // 部署目录内的真实文件/目录（敏感基列表的测试目标必须存在：realpath 先行）
  writeFileSync(path.join(appDir, '.env'), 'SETUP_KEY=x');
  mkdirSync(path.join(appDir, 'dist'));
  mkdirSync(path.join(appDir, 'deploy-backups'));

  const dbPath = path.join(appDir, 'data', 'test.db');
  db = new Database(dbPath, createFieldCrypto('testkey', 'testkey'));
  db.init();
  const admin = db.createUser('admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');
  const subuser = db.createUser('subuser', '$2a$10$dummyhashdummyhashdummyhashdu');
  db.setPermissions(subuser.id, {
    allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    banned: false, sandboxMode: null,
  });

  upstream = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const config: PlatformConfig = {
    setupKey: 'test-setup-key', dbPath, dbEncKey: 'testkey',
    gateway: {
      host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstreamPort}`,
      tls: null, redirectPort: null, publicHost: '', domain: 'localhost', autoTls: false,
      acmeEmail: '', acmeStaging: false,
    },
    jwtSecret: 'test-secret', internalSecret: 'test-internal',
    patch: { dshRoot: '', restartService: '' },
    endpointRules: [],
  };
  const tokenFor = (user: { id: number; username: string }) =>
    `dsh_gateway_token=${jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, config.jwtSecret, { expiresIn: '12h' })}`;
  adminCookie = tokenFor(admin);
  subuserCookie = tokenFor(subuser);

  gateway = createGatewayServer(config, new AuthService(config, db), db);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  gatewayPort = (gateway.address() as { port: number }).port;
});

after(() => {
  gateway?.close();
  upstream?.close();
  try {
    rmSync(appDir, { recursive: true, force: true });
    rmSync(rootDir, { recursive: true, force: true });
  } catch {
    /* Windows 文件占用：忽略 */
  }
});

test('仅主用户：子用户调用 403，未登录 401', async () => {
  const sub = await del(path.join(rootDir, 'e2e-target'), subuserCookie);
  assert.equal(sub.status, 403);
  assert.equal(sub.json.ok, false);
  const anon = await post('/gateway/api/fs/delete-directory', { path: rootDir }, '');
  assert.equal(anon.status, 401);
  // 目录必须仍然存在（谁都没删成）
  assert.equal(existsSync(path.join(rootDir, 'e2e-target')), true);
});

test('主用户递归删除普通目录（含嵌套内容）并审计留痕', async () => {
  const target = path.join(rootDir, 'e2e-target');
  const res = await del(target);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.ok, true);
  assert.equal(res.json.deleted, target);
  assert.equal(existsSync(target), false);
});

test('主用户可删除隐藏目录（. 开头）', async () => {
  const target = path.join(rootDir, '.e2e-hidden');
  const res = await del(target);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(existsSync(target), false);
});

test('非目录返回 400；不存在返回 404；空路径返回 400', async () => {
  const fileTarget = path.join(rootDir, 'plain-file.txt');
  assert.equal((await del(fileTarget)).status, 400);
  assert.equal((await del(path.join(rootDir, 'no-such-dir'))).status, 404);
  assert.equal((await del('')).status, 400);
  // ../ 逃逸解析到不存在的路径 → 404；存在与否不改变“不许探测敏感目录”的语义
  assert.equal((await del(path.join(rootDir, 'no-such', '..', 'no-such'))).status, 404);
});

test('敏感目录不可删除：部署根、数据库、部署目录内子目录（.env 同级与 dist）', async () => {
  for (const target of [appDir, path.join(appDir, 'data'), path.join(appDir, 'dist'), appDir + path.sep + 'deploy-backups']) {
    const res = await del(target);
    assert.equal(res.status, 403, `${target} 应当被敏感目录保护：${JSON.stringify(res.json)}`);
    assert.equal(res.json.code, 'FORBIDDEN');
  }
});

test('文件系统根与用户主目录本身不可删除', async () => {
  assert.equal((await del(path.parse(rootDir).root)).status, 403);
  assert.equal((await del(os.homedir())).status, 403);
});

test('路径遍历变体：/../ 指向部署目录内的目标被敏感基列表拦截', async () => {
  const sneaky = path.join(appDir, '..', path.basename(appDir), 'data');
  const res = await del(sneaky);
  assert.equal(res.status, 403, JSON.stringify(res.json));
});

test('路由白名单：未知 /gateway/api/fs/* 子路径不透传到上游（404）', async () => {
  const res = await post('/gateway/api/fs/other', { path: rootDir }, adminCookie);
  assert.equal(res.status, 404);
});
