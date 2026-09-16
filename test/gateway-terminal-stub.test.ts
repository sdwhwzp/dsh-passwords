// 子用户 terminal/list 空成功伪装：顶栏「重试恢复终端」横幅的根因修复。
//
// 官方客户端 TerminalRecovery 组件挂载时调 POST /api/terminal/list 恢复终端；
// 子用户被 403 → restore() reject → 顶栏常驻重试按钮。修复：list 是 terminal
// 命名空间唯一只读安全的 RPC，对子用户回 value=[] 的成功响应（rpcId 原样回显），
// 其余 terminal RPC（create/follow/write/…）保持 fail-closed 403。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import jwt from 'jsonwebtoken';

import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer } from '../src/gateway.js';
import type { PlatformConfig } from '../src/config.js';

let appDir: string;
let db: Database;
let gateway: http.Server;
let upstream: http.Server;
let upstreamHits: string[] = [];
let gatewayPort = 0;
let adminCookie = '';
let subuserCookie = '';

function post(url: string, body: unknown, cookie: string): Promise<{ status: number; json: Record<string, unknown>; body: string }> {
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
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            /* 403 页面等非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json, body: text });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const envelope = (rpcId: string, method: string, args: Record<string, unknown>) => ({
  type: 'client-request', rpcId, method, payload: { args },
});

before(async () => {
  appDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-termstub-app-'));
  mkdirSync(path.join(appDir, 'data'));
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

  upstream = http.createServer((req, res) => {
    upstreamHits.push(String(req.url));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: 'upstream', result: { ok: true, value: [] } }));
  });
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
  } catch {
    /* Windows 文件占用：忽略 */
  }
});

test('子用户 terminal/list → 200 空成功（value 必须是裸数组，rpcId 原样回显）', async () => {
  upstreamHits = [];
  const res = await post('/api/terminal/list', envelope('rpc-restore-1', 'terminal/list', { sessionId: 'session-x' }), subuserCookie);
  assert.equal(res.status, 200, `必须回 200 而不是 403：${res.body.slice(0, 120)}`);
  assert.equal(res.json.type, 'server-response');
  assert.equal(res.json.rpcId, 'rpc-restore-1', 'rpcId 必须逐字回显（客户端硬校验不匹配即抛错）');
  const result = res.json.result as { ok?: unknown; value?: unknown } | undefined;
  assert.equal(result?.ok, true);
  assert.deepEqual(result?.value, [], 'value 必须是裸数组 []（schema 是 z.array，非数组会抛错）');
  assert.equal(upstreamHits.length, 0, '伪装响应不得到达上游');
});

test('子用户其余 terminal RPC 仍 fail-closed 403（create/follow/write/shells）', async () => {
  for (const method of ['create', 'follow', 'write', 'shells', 'environment', 'close', 'rename', 'resize']) {
    upstreamHits = [];
    const res = await post(`/api/terminal/${method}`, envelope(`rpc-${method}`, `terminal/${method}`, { agentId: 'a' }), subuserCookie);
    assert.equal(res.status, 403, `terminal/${method} 必须保持 403`);
    assert.equal(upstreamHits.length, 0, `terminal/${method} 不得到达上游`);
  }
});

test('主用户 terminal/list 正常透传到上游（不受伪装影响）', async () => {
  upstreamHits = [];
  const res = await post('/api/terminal/list', envelope('rpc-admin-1', 'terminal/list', { sessionId: 'session-x' }), adminCookie);
  assert.equal(res.status, 200);
  assert.equal(upstreamHits.some((url) => url.includes('/api/terminal/list')), true, '主用户请求必须到达上游');
});

test('子用户 terminal/list 请求体畸形（拿不到 rpcId）→ 回退常规 403', async () => {
  const malformed = await new Promise<{ status: number }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: gatewayPort, method: 'POST', path: '/api/terminal/list',
        headers: { cookie: subuserCookie, 'content-type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end('not-json');
  });
  assert.equal(malformed.status, 403, '拿不到 rpcId 时不得伪造成功，回退 403');
});
