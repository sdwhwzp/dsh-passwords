// Discussion #6 实施项 1-6 的端到端回归测试：
//   1. 主用户 session.list 收割会话注册表 → 无归属旧会话可扫描
//   2. 扫描/分配仅主用户可用（子用户 403）
//   3. 分配：单会话/按工作区批量、白名单校验、未知会话拒绝
//   4. 分配后子用户 session.list 只含自己会话（含会话作用域 RPC 跨用户 403）
//   5. 消息投递口径：子用户默认私信主用户、禁跨子用户私信、禁广播；
//      主用户广播需显式声明；他人私信不可见
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import zlib from 'node:zlib';

import { createGatewayServer } from '../src/gateway.js';
import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import type { PlatformConfig } from '../src/config.js';

let tempDir: string;
let db: Database;
let upstream: http.Server;
let gateway: http.Server;
let gatewayPort = 0;
let adminId = 0;
let subAId = 0;
let subBId = 0;
let subRId = 0;
let adminCookie = '';
let subACookie = '';
let subBCookie = '';
let subRCookie = '';

/** 上游会话清单（全量，任何用户都返回同一份；网关按身份过滤） */
const SESSION_LIST = {
  ok: true,
  result: {
    value: [
      { sessionId: 's-a', cwd: '/root/11', title: 'A' },
      { sessionId: 's-b', cwd: '/root/21', title: 'B' },
      { sessionId: 's-c', cwd: '/root/33', title: 'C' },
    ],
  },
};

/** gzip 收割回归用清单：多一个仅经 gzip 响应出现的会话 */
const SESSION_LIST_GZIP = {
  ok: true,
  result: {
    value: [
      ...SESSION_LIST.result.value,
      { sessionId: 's-gz', cwd: '/root/44', title: 'GZ' },
    ],
  },
};

function startMockUpstream(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if ((req.url ?? '').startsWith('/api/session.list') && req.headers['x-test-mode'] === 'gzip-list') {
        const body = zlib.gzipSync(JSON.stringify(SESSION_LIST_GZIP));
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(body);
        return;
      }
      if ((req.url ?? '').startsWith('/api/session.list')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(SESSION_LIST));
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
  cookie: string,
  body?: string,
  headers?: Record<string, string>,
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
          ...(body !== undefined
            ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
            : {}),
          ...(headers ?? {}),
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

function json<T>(r: { status: number; body: string }): T {
  return JSON.parse(r.body) as T;
}

before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-d6-'));
  db = new Database(path.join(tempDir, 'test.db'), createFieldCrypto('testkey', 'testkey'));
  db.init();
  const admin = db.createUser('admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');
  adminId = admin.id;
  const subA = db.createUser('suba', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  subAId = subA.id;
  const subB = db.createUser('subb', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  subBId = subB.id;
  const subR = db.createUser('subr', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  subRId = subR.id;
  // subr 受限：只允许 /root/21（用于分配时的白名单校验回归）
  db.setPermissions(subRId, {
    allowedFolders: ['/root/21'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: true,
    allowGitDownload: false,
    banned: false,
    sandboxMode: null,
  });

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
    internalSecret: 'test-internal',
    patch: { dshRoot: '', restartService: '' },
  };

  const auth = new AuthService(config, db);
  gateway = createGatewayServer(config, auth, db);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
  gatewayPort = (gateway.address() as { port: number }).port;

  const sign = (id: number, username: string) =>
    `dsh_gateway_token=${jwt.sign({ sub: String(id), username, cv: 0 }, config.jwtSecret, { expiresIn: '12h' })}`;
  adminCookie = sign(adminId, 'admin');
  subACookie = sign(subAId, 'suba');
  subBCookie = sign(subBId, 'subb');
  subRCookie = sign(subRId, 'subr');
});

after(() => {
  gateway?.close();
  upstream?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* 忽略：Windows 上 node:sqlite 文件句柄可能未释放 */
  }
});

test('D6-1：主用户 session.list 收割注册表 → 无归属清单含全部旧会话', async () => {
  const list = await gatewayReq('POST', '/api/session.list', adminCookie, '{}');
  assert.equal(list.status, 200, '主用户会话列表正常');
  // 主用户列表原样回放：3 条全在
  const parsed = json<{ result: { value: Array<{ sessionId: string }> } }>(list);
  assert.equal(parsed.result.value.length, 3);

  const un = await gatewayReq('GET', '/gateway/api/session-ownership/unassigned', adminCookie);
  assert.equal(un.status, 200);
  const body = json<{ ok: boolean; sessions: Array<{ sessionId: string; cwd: string | null; title: string | null }> }>(un);
  assert.equal(body.ok, true);
  const ids = body.sessions.map((s) => s.sessionId).sort();
  assert.deepEqual(ids, ['s-a', 's-b', 's-c'], '无归属清单 = 全部未分配会话');
  const a = body.sessions.find((s) => s.sessionId === 's-a');
  assert.equal(a?.cwd, '/root/11', '注册表携带 cwd');
  assert.equal(a?.title, 'A', '注册表携带 title');
});

test('D6-2：扫描与分配仅主用户可用（子用户 403）', async () => {
  const un = await gatewayReq('GET', '/gateway/api/session-ownership/unassigned', subACookie);
  assert.equal(un.status, 403, '子用户不能扫描无归属会话');
  const asg = await gatewayReq(
    'POST',
    '/gateway/api/session-ownership/assign',
    subACookie,
    JSON.stringify({ sessionIds: ['s-a'], userId: subBId }),
  );
  assert.equal(asg.status, 403, '子用户不能分配会话');
});

test('D6-3：分配流程——合法/白名单/未知会话/非法用户', async () => {
  // 合法：s-a → suba（无限制用户）
  const r1 = await gatewayReq(
    'POST',
    '/gateway/api/session-ownership/assign',
    adminCookie,
    JSON.stringify({ sessionIds: ['s-a'], userId: subAId }),
  );
  assert.equal(r1.status, 200);
  const b1 = json<{ results: Array<{ sessionId: string; ok: boolean; error?: string }> }>(r1);
  assert.deepEqual(b1.results, [{ sessionId: 's-a', ok: true }], 's-a 分配成功');

  // 白名单命中：s-b（/root/21）→ subr（允许 /root/21）
  const r2 = await gatewayReq(
    'POST',
    '/gateway/api/session-ownership/assign',
    adminCookie,
    JSON.stringify({ sessionIds: ['s-b'], userId: subRId }),
  );
  const b2 = json<{ results: Array<{ sessionId: string; ok: boolean; error?: string }> }>(r2);
  assert.equal(b2.results[0]?.ok, true, '白名单内目录分配成功');

  // 白名单拒绝：s-c（/root/33）→ subr（只允许 /root/21）
  const r3 = await gatewayReq(
    'POST',
    '/gateway/api/session-ownership/assign',
    adminCookie,
    JSON.stringify({ sessionIds: ['s-c'], userId: subRId }),
  );
  const b3 = json<{ results: Array<{ sessionId: string; ok: boolean; error?: string }> }>(r3);
  assert.equal(b3.results[0]?.ok, false, '白名单外目录拒绝分配');
  assert.equal(b3.results[0]?.error, 'FOLDER_NOT_ALLOWED');

  // 未知会话：未登记 id 拒绝（不写垃圾归属行）
  const r4 = await gatewayReq(
    'POST',
    '/gateway/api/session-ownership/assign',
    adminCookie,
    JSON.stringify({ sessionIds: ['s-unknown'], userId: subAId }),
  );
  const b4 = json<{ results: Array<{ sessionId: string; ok: boolean; error?: string }> }>(r4);
  assert.equal(b4.results[0]?.ok, false);
  assert.equal(b4.results[0]?.error, 'SESSION_UNKNOWN');

  // 非法用户 id
  const r5 = await gatewayReq(
    'POST',
    '/gateway/api/session-ownership/assign',
    adminCookie,
    JSON.stringify({ sessionIds: ['s-a'], userId: 999999 }),
  );
  assert.equal(r5.status, 404, '目标用户不存在 → 404');
  const r6 = await gatewayReq(
    'POST',
    '/gateway/api/session-ownership/assign',
    adminCookie,
    JSON.stringify({ sessionIds: ['s-a'], userId: 'abc' }),
  );
  assert.equal(r6.status, 400, '非法 userId → 400');

  // 分配后无归属清单收缩：s-a、s-b 已分配，只剩 s-c
  const un = await gatewayReq('GET', '/gateway/api/session-ownership/unassigned', adminCookie);
  const unBody = json<{ sessions: Array<{ sessionId: string }> }>(un);
  assert.deepEqual(unBody.sessions.map((s) => s.sessionId), ['s-c'], '无归属清单只剩余 s-c');
});

test('D6-4：分配后子用户 session.list 只含自己会话', async () => {
  const ra = await gatewayReq('POST', '/api/session.list', subACookie, '{}');
  const ba = json<{ result: { value: Array<{ sessionId: string }> } }>(ra);
  assert.deepEqual(
    ba.result.value.map((i) => i.sessionId),
    ['s-a'],
    'suba 只看到分配给自己的会话',
  );

  const rb = await gatewayReq('POST', '/api/session.list', subBCookie, '{}');
  const bb = json<{ result: { value: Array<{ sessionId: string }> } }>(rb);
  assert.deepEqual(bb.result.value, [], 'subb 无任何归属会话（未分配一律隐藏，fail-closed）');

  const radmin = await gatewayReq('POST', '/api/session.list', adminCookie, '{}');
  const badmin = json<{ result: { value: Array<{ sessionId: string }> } }>(radmin);
  assert.equal(badmin.result.value.length, 3, '主用户列表不受限（全量原样）');
});

test('D6-5：会话作用域 RPC 归属校验（跨用户 403，本人放行）', async () => {
  const steal = await gatewayReq(
    'POST',
    '/api/session.history',
    subBCookie,
    JSON.stringify({ sessionId: 's-a' }),
  );
  assert.equal(steal.status, 403, 'subb 猜中 suba 的 sessionId 读历史 → 403');

  const own = await gatewayReq(
    'POST',
    '/api/session.history',
    subACookie,
    JSON.stringify({ sessionId: 's-a' }),
  );
  assert.equal(own.status, 200, '归属本人 → 正常转发上游');
  const ownBody = json<{ ok: boolean }>(own);
  assert.equal(ownBody.ok, true);
});

test('D6-6：消息投递口径——子用户默认私信主用户、禁跨子用户、禁广播', async () => {
  // 子用户不带收件人 → 自动私信主用户
  const r1 = await gatewayReq(
    'POST',
    '/gateway/api/messages',
    subACookie,
    JSON.stringify({ content: 'to-admin-default' }),
  );
  assert.equal(r1.status, 200);
  const b1 = json<{ message: { recipient_id: number | null } }>(r1);
  assert.equal(b1.message.recipient_id, adminId, '子用户默认投递给主用户');

  // 子用户 → 子用户：403
  const r2 = await gatewayReq(
    'POST',
    '/gateway/api/messages',
    subACookie,
    JSON.stringify({ content: 'cross', recipientId: subBId }),
  );
  assert.equal(r2.status, 403);
  assert.equal(json<{ code: string }>(r2).code, 'FORBIDDEN_RECIPIENT', '跨子用户私信被拦');

  // 子用户广播：403
  const r3 = await gatewayReq(
    'POST',
    '/gateway/api/messages',
    subACookie,
    JSON.stringify({ content: 'spam', broadcast: true }),
  );
  assert.equal(r3.status, 403);
  assert.equal(json<{ code: string }>(r3).code, 'FORBIDDEN_BROADCAST', '子用户广播被拦');

  // 主用户不选收件人也不声明广播：400（防误发全员）
  const r4 = await gatewayReq('POST', '/gateway/api/messages', adminCookie, JSON.stringify({ content: 'oops' }));
  assert.equal(r4.status, 400);
  assert.equal(json<{ code: string }>(r4).code, 'SELECT_RECIPIENT');

  // 主用户显式广播：200，recipient_id = null
  const r5 = await gatewayReq(
    'POST',
    '/gateway/api/messages',
    adminCookie,
    JSON.stringify({ content: 'hello-all', broadcast: true }),
  );
  assert.equal(r5.status, 200);
  const b5 = json<{ message: { recipient_id: number | null } }>(r5);
  assert.equal(b5.message.recipient_id, null, '显式广播 recipient 为 null');
});

test('D6-7：消息可见性——他人私信不可见，广播与发给自己的可见', async () => {
  // suba → admin 的私信：subb 不可见，admin 可见
  const rb = await gatewayReq('GET', '/gateway/api/messages', subBCookie);
  const bb = json<{ messages: Array<{ content: string }> }>(rb);
  assert.ok(
    !bb.messages.some((m) => m.content === 'to-admin-default'),
    'subb 看不到 suba→admin 的私信',
  );
  assert.ok(
    bb.messages.some((m) => m.content === 'hello-all'),
    'subb 能看到主用户显式广播',
  );

  const ra = await gatewayReq('GET', '/gateway/api/messages', adminCookie);
  const ba = json<{ messages: Array<{ content: string }> }>(ra);
  assert.ok(
    ba.messages.some((m) => m.content === 'to-admin-default'),
    'admin 能看到发给自己的私信',
  );
});

test('D6-8：recipientId 与 broadcast 同时给出 → 400（歧义拒绝，不静默降级）', async () => {
  const r = await gatewayReq(
    'POST',
    '/gateway/api/messages',
    adminCookie,
    JSON.stringify({ content: 'ambiguous', recipientId: subAId, broadcast: true }),
  );
  assert.equal(r.status, 400);
  assert.equal(json<{ code: string }>(r).code, 'INVALID', '互斥参数组合必须拒绝');
});

test('D6-9：已归属会话默认拒绝重分配（ALREADY_OWNED），force 显式允许', async () => {
  // s-a 在 D6-3 已分配给 suba；不 force 分配给别人 → ALREADY_OWNED
  const r1 = await gatewayReq(
    'POST',
    '/gateway/api/session-ownership/assign',
    adminCookie,
    JSON.stringify({ sessionIds: ['s-a'], userId: subBId }),
  );
  const b1 = json<{ results: Array<{ sessionId: string; ok: boolean; error?: string }> }>(r1);
  assert.equal(b1.results[0]?.ok, false);
  assert.equal(b1.results[0]?.error, 'ALREADY_OWNED', '未 force 不得静默改派');

  // force=true → 显式重分配成功
  const r2 = await gatewayReq(
    'POST',
    '/gateway/api/session-ownership/assign',
    adminCookie,
    JSON.stringify({ sessionIds: ['s-a'], userId: subBId, force: true }),
  );
  const b2 = json<{ results: Array<{ sessionId: string; ok: boolean; error?: string }> }>(r2);
  assert.equal(b2.results[0]?.ok, true, 'force 重分配成功');

  // 主用户不可作为分配目标
  const r3 = await gatewayReq(
    'POST',
    '/gateway/api/session-ownership/assign',
    adminCookie,
    JSON.stringify({ sessionIds: ['s-c'], userId: adminId }),
  );
  assert.equal(r3.status, 400, '不能把会话分配给主用户');
});

test('D6-10：重复 sessionId 去重——结果与归属各只处理一次', async () => {
  const r = await gatewayReq(
    'POST',
    '/gateway/api/session-ownership/assign',
    adminCookie,
    JSON.stringify({ sessionIds: ['s-c', 's-c', 's-c'], userId: subAId }),
  );
  const b = json<{ results: Array<{ sessionId: string; ok: boolean }> }>(r);
  assert.equal(b.results.length, 1, '重复 id 只产生一条结果');
  assert.equal(b.results[0]?.ok, true);
});

test('D6-11：主用户 session.list gzip 响应原样回放且完成注册表收割', async () => {
  const r = await gatewayReq('POST', '/api/session.list', adminCookie, '{}', { 'x-test-mode': 'gzip-list' });
  assert.equal(r.status, 200);
  // 主用户列表原样回放：响应仍是 gzip 原字节（这里按 utf8 读必然非 JSON，只验状态与头）
  const un = await gatewayReq('GET', '/gateway/api/session-ownership/unassigned', adminCookie);
  const body = json<{ sessions: Array<{ sessionId: string }> }>(un);
  assert.ok(
    body.sessions.some((s) => s.sessionId === 's-gz'),
    'gzip 响应中的会话也被收割进注册表',
  );
});
