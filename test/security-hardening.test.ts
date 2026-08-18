// 全量审计修复的回归测试（commit 后补）：每条对应审计报告的一项修复契约。
//
//   C-1  %2F 编码路径：授权判定与上游转发必须用同一规范化路径
//   H-1  过滤分支缓冲超限：fail-closed 502，绝不透传未过滤内容
//   H-2  自身插件写操作同源校验：跨源 Origin → 403
//   M-1  setup 竞态：setupInitialAdmin 原子化，并发/重复初始化只能成功一次
//   M-10 会话缓存失效内部接口：仅回环 + 内部密钥
//   M-13 allowedFolders 空条目/根目录条目拒绝（=全盘放行语义漏洞）
//   L-4  CSR 必须同时携带 CN 与 SAN（subjectAltName OID 2.5.29.17）
//   M-5  聊天游标倒退检测（服务端 DB 重建基线重建，不计未读）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'node:crypto';

import { createGatewayServer } from '../src/gateway.js';
import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { buildCsr } from '../src/acme.js';
import { isCursorReset, type ChatMessage } from '../src/client/chat.tsx';
import type { PlatformConfig } from '../src/config.js';

let tempDir: string;
let db: Database;
let crypto: ReturnType<typeof createFieldCrypto>;
let upstream: http.Server;
let gateway: http.Server;
let gatewayPort = 0;
let adminCookie = '';
let subuserCookie = '';
let subuserId = 0;
/** 上游最近一次收到的路径（已解码视角，mock 直接取 req.url） */
let lastUpstreamUrl = '';
const upstreamUrls: string[] = [];

function startMockUpstream(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      lastUpstreamUrl = req.url ?? '';
      upstreamUrls.push(lastUpstreamUrl);
      if ((req.url ?? '').startsWith('/api/session.list') && req.headers['x-test-mode'] === 'big') {
        // 16MiB+ 超限响应：chunked 写 17MB（不设 content-length，同 dsh 行为）
        res.writeHead(200, { 'content-type': 'application/json' });
        const chunk = Buffer.alloc(1024 * 1024, 0x61); // 'a'
        let written = 0;
        const writeMore = () => {
          for (let i = 0; i < 4 && written < 17 * 1024 * 1024; i++) {
            res.write(chunk);
            written += chunk.length;
          }
          if (written < 17 * 1024 * 1024) {
            setImmediate(writeMore);
          } else {
            res.end();
          }
        };
        writeMore();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method, url: req.url }));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function gatewayReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  cookie = adminCookie,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: gatewayPort,
        method,
        path: url,
        headers: {
          cookie,
          'content-type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-harden-'));
  crypto = createFieldCrypto('testkey', 'testkey');
  db = new Database(path.join(tempDir, 'test.db'), crypto);
  db.init();
  // 主用户 + 子用户（子用户无 user_permissions 行 = 默认权限）
  db.createUser('admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');
  const sub = db.createUser('subuser', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  subuserId = sub.id;

  upstream = await startMockUpstream();
  const upstreamPort = (upstream.address() as { port: number }).port;

  const config: PlatformConfig = {
    setupKey: 'test-setup-key',
    dbPath: path.join(tempDir, 'test.db'),
    dbEncKey: 'testkey',
    gateway: {
      host: '127.0.0.1',
      port: 0,
      upstream: `http://127.0.0.1:${upstreamPort}`,
      tls: null,
      redirectPort: null,
      publicHost: '',
      domain: 'localhost',
      autoTls: false,
      acmeEmail: '',
      acmeStaging: false,
    },
    jwtSecret: 'test-secret',
    internalSecret: 'test-internal-secret',
    patch: { dshRoot: '', restartService: '' },
  };

  const auth = new AuthService(config, db);
  gateway = createGatewayServer(config, auth, db);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
  gatewayPort = (gateway.address() as { port: number }).port;

  const sign = (id: number, username: string) =>
    jwt.sign({ sub: String(id), username, cv: 0 }, config.jwtSecret, { expiresIn: '12h' });
  adminCookie = `dsh_gateway_token=${sign(1, 'admin')}`;
  subuserCookie = `dsh_gateway_token=${sign(subuserId, 'subuser')}`;
});

after(() => {
  gateway?.close();
  upstream?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* 文件锁未释放：系统临时目录回收 */
  }
});

// ── C-1：编码路径在授权判定与转发间必须同口径 ─────────────────

test('C-1：受限子用户经 %2F 编码路径调用会话 RPC 被 403（授权判定解码）', async () => {
  upstreamUrls.length = 0;
  const r = await gatewayReq('POST', '/api%2Fsession%2Fhistory', {}, subuserCookie, '{}');
  assert.equal(r.status, 403, '编码路径不得绕过会话归属检查');
  assert.ok(!upstreamUrls.includes('/api/session/history'), '请求不得转发到上游');
});

test('C-1：主用户经 %2F 编码路径转发为解码后的规范路径（判定与转发同口径）', async () => {
  upstreamUrls.length = 0;
  const r = await gatewayReq('POST', '/api%2Fsession%2Fhistory', {}, adminCookie, '{}');
  assert.equal(r.status, 200);
  assert.ok(upstreamUrls.includes('/api/session/history'), '上游应收到解码归一化后的路径');
});

// ── H-2：自身插件写操作同源校验 ───────────────────────────────

test('H-2：跨源 Origin 写自身插件路由被 403 且不转发', async () => {
  upstreamUrls.length = 0;
  const r = await gatewayReq(
    'POST',
    '/api/dsh-passwords/password',
    { origin: 'https://evil.example' },
    adminCookie,
    '{}',
  );
  assert.equal(r.status, 403);
  assert.equal(upstreamUrls.length, 0, '跨源请求不得到达上游');
});

test('H-2：同源 Origin 写自身插件路由放行', async () => {
  upstreamUrls.length = 0;
  const r = await gatewayReq(
    'POST',
    '/api/dsh-passwords/password',
    { origin: `http://127.0.0.1:${gatewayPort}` },
    adminCookie,
    '{}',
  );
  assert.equal(r.status, 200);
  assert.equal(upstreamUrls.length, 1, '同源请求应正常转发');
});

// ── H-1：安全过滤分支缓冲超限 fail-closed ─────────────────────

test('H-1：受限子用户 session.list 响应超 16MiB → 502（不透传未过滤内容）', async () => {
  const r = await gatewayReq(
    'POST',
    '/api/session.list',
    { 'x-test-mode': 'big' },
    subuserCookie,
    '{}',
  );
  assert.equal(r.status, 502);
});

// ── M-1：setup 竞态原子化 ─────────────────────────────────────

test('M-1：setupInitialAdmin 只允许成功一次，重复调用返回 null', () => {
  const raceDb = new Database(path.join(tempDir, 'race.db'), crypto);
  raceDb.init();
  const first = raceDb.setupInitialAdmin('owner', 'hash-1');
  assert.ok(first !== null, '首次初始化应创建主用户');
  assert.equal(first.role, 'admin');
  assert.equal(raceDb.countUsers(), 1);
  const second = raceDb.setupInitialAdmin('owner2', 'hash-2');
  assert.equal(second, null, '重复初始化必须失败（原子判定）');
  assert.equal(raceDb.countUsers(), 1, '不得创建第二个主用户');
  raceDb.close();
});

// ── M-10：会话缓存失效内部接口鉴权 ────────────────────────────

test('M-10：session-invalidate 内部接口错误密钥 → 403', async () => {
  const r = await gatewayReq(
    'POST',
    '/gateway/internal/session-invalidate',
    { 'x-internal-secret': 'wrong-secret' },
    '',
    JSON.stringify({ userId: 1 }),
  );
  assert.equal(r.status, 403);
});

test('M-10：session-invalidate 内部接口正确密钥 → 200', async () => {
  const r = await gatewayReq(
    'POST',
    '/gateway/internal/session-invalidate',
    { 'x-internal-secret': 'test-internal-secret' },
    '',
    JSON.stringify({ userId: 1 }),
  );
  assert.equal(r.status, 200);
});

// ── M-13：allowedFolders 拒绝全盘放行语义条目 ─────────────────

test('M-13：allowedFolders 含空字符串 → 400', async () => {
  const r = await gatewayReq(
    'POST',
    '/gateway/api/permissions',
    {},
    adminCookie,
    JSON.stringify({ userId: subuserId, allowedFolders: [''] }),
  );
  assert.equal(r.status, 400);
});

test('M-13：allowedFolders 含根目录 → 400', async () => {
  const r = await gatewayReq(
    'POST',
    '/gateway/api/permissions',
    {},
    adminCookie,
    JSON.stringify({ userId: subuserId, allowedFolders: ['/'] }),
  );
  assert.equal(r.status, 400);
});

test('M-13：allowedFolders 合法绝对路径 → 200', async () => {
  const r = await gatewayReq(
    'POST',
    '/gateway/api/permissions',
    {},
    adminCookie,
    JSON.stringify({ userId: subuserId, allowedFolders: ['/workspaces/a'] }),
  );
  assert.equal(r.status, 200);
});

// ── L-4：CSR 含 CN + SAN ──────────────────────────────────────

test('L-4：buildCsr 同时写入 CN 与 subjectAltName（OID 2.5.29.17）', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = buildCsr(privateKey, 'example.com');
  assert.ok(der.includes(Buffer.from([0x55, 0x1d, 0x11])), 'CSR 必须包含 SAN OID');
  assert.ok(der.includes(Buffer.from('example.com', 'utf8')), 'CSR 必须包含域名');
});

// ── M-5：聊天游标倒退检测（纯函数） ───────────────────────────

const chatMsg = (id: number): ChatMessage => ({
  id,
  sender_id: 1,
  sender_name: 'u',
  recipient_id: null,
  content: 'x',
  tags: [],
  created_at: new Date().toISOString(),
});

test('M-5：返回 id ≤ 游标 = 游标倒退（DB 重建）', () => {
  assert.equal(isCursorReset(10, [chatMsg(9), chatMsg(10)]), true);
  assert.equal(isCursorReset(10, [chatMsg(11)]), false);
  assert.equal(isCursorReset(0, [chatMsg(1)]), false, '无基线时不视为倒退');
  assert.equal(isCursorReset(10, []), false, '空响应不是倒退信号');
});
