// 回归测试（issue #1）：网关响应不得同时携带 Content-Length 与 Transfer-Encoding
//
// 根因回顾：dsh 上游以 chunked（Transfer-Encoding: chunked）返回 HTML/JSON 时，
// 网关改写路径（HTML 注入、workspace.list / session.list / session.history 过滤）
// 重算了 body 并设置了新的 content-length，但没有删掉上游的 transfer-encoding，
// Node http 服务端会把两个头原样发出 → 畸形消息 → Nginx（NPM）直接 502。
//
// 修复后契约（RFC 9110 §8.6）：
//   - 改写路径：只有 content-length，绝不带 transfer-encoding
//   - 流式透传 / JSON 解析失败回退：保留上游 transfer-encoding（chunked），
//     绝不带 content-length；任何路径都不得同时出现两者
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import jwt from 'jsonwebtoken';

import { createGatewayServer } from '../src/gateway.js';
import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import type { PlatformConfig } from '../src/config.js';

const HTML_BODY = '<html><head><title>home</title></head><body>hello</body></html>';
const HASHED_STATIC_BODY = 'export const repeatedPluginPayload = "compress-me";\n'.repeat(4_096);
const LARGE_HISTORY_CHUNK = Buffer.alloc(256 * 1024, 0x78);
const LARGE_HISTORY_BYTES = 20 * 1024 * 1024;
const OVERSIZE_HISTORY_BYTES = 32 * 1024 * 1024 + 1;
const WORKSPACES_JSON = JSON.stringify({
  ok: true,
  data: [
    { id: 'ws-1', workspaceId: 'ws-1', path: '/workspaces/a', sessionIds: ['s-owned'] },
    { id: 'ws-2', workspaceId: 'ws-2', path: '/workspaces/b', sessionIds: ['s-other'] },
  ],
});
const AT_FILE_SETTINGS_RESPONSE = {
  result: {
    ok: true,
    value: {
      enabled: true,
      ignoreFiles: ['.DS_Store'],
      workspaceIgnoreFiles: [
        { workspace: '/workspaces/a', ignoreFiles: ['own.txt'] },
        { workspace: '/workspaces/b', ignoreFiles: ['other.txt'] },
      ],
      ignorePastedMentions: true,
    },
  },
};
const MODELS_RESPONSE = {
  type: 'server-response',
  rpcId: 'models-1',
  result: {
    ok: true,
    value: {
      groups: [
        {
          id: 'codex',
          name: 'ChatGPT (Codex)',
          models: [
            { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
            { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
            { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
            { id: 'gpt-5.5', name: 'GPT-5.5' },
          ],
        },
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },
      ],
      failures: [],
    },
  },
};

let tempDir: string;
let db: Database;
let auth: AuthService;
let upstream: http.Server;
let gateway: http.Server;
let gatewayPort = 0;
let cookie = '';
let customerCookie = '';
let secondCustomerCookie = '';
let customerId = 0;
let sessionCreateCallCount = 0;
/** 会话 JWT 明文（Cookie Chaos 回归测试用：构造 Unicode 前缀的伪同名 cookie） */
let tokenValue = '';
/** 上游最后一次收到的请求头（F-15 回归测试用：验证网关 cookie 不被透传） */
let lastUpstreamHeaders: http.IncomingHttpHeaders = {};
let lastUpstreamMethod = '';
let failWorkspaceList = false;
let failSessionList = false;

/** Stream a valid large history response without retaining another full-size fixture buffer. */
function sendLargeHistory(res: http.ServerResponse, historyBytes: number): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{"ok":true,"history":"');
  let remaining = historyBytes;
  const writeMore = () => {
    while (remaining > 0 && !res.destroyed) {
      const size = Math.min(remaining, LARGE_HISTORY_CHUNK.length);
      remaining -= size;
      if (!res.write(LARGE_HISTORY_CHUNK.subarray(0, size))) {
        res.once('drain', writeMore);
        return;
      }
    }
    if (!res.destroyed) res.end('"}');
  };
  writeMore();
}

/** mock 上游：刻意不设 content-length（write 分段写），Node 会以 chunked 分帧——
 *  这正是生产环境 dsh 的行为，也是触发原 bug 的前提 */
function startMockUpstream(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      lastUpstreamHeaders = req.headers;
      lastUpstreamMethod = req.method ?? '';
      const testMode = req.headers['x-test-mode'];
      const badJson = testMode === 'bad-json';
      if ((req.url ?? '').startsWith('/html')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write(HTML_BODY.slice(0, 20)); // 无 CL 的多次 write → chunked
        res.end(HTML_BODY.slice(20));
      } else if ((req.url ?? '').startsWith('/plugins/example/client.js?rev=abc123')) {
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(HASHED_STATIC_BODY);
      } else if ((req.url ?? '').startsWith('/api/workspace.list')) {
        if (failWorkspaceList) {
          setTimeout(() => req.socket.destroy(), 25);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(badJson ? 'not-json{' : WORKSPACES_JSON);
        res.end();
      } else if ((req.url ?? '').startsWith('/api/session.list')) {
        if (failSessionList) {
          setTimeout(() => req.socket.destroy(), 25);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          type: 'server-response',
          rpcId: 'session-list',
          result: {
            ok: true,
            value: {
              items: [
                { sessionId: 's-owned', cwd: '/workspaces/a' },
                { sessionId: 's-other', cwd: '/workspaces/b' },
                { sessionId: 's-legacy-admin', cwd: '/workspaces/a' },
              ],
            },
          },
        }));
      } else if ((req.url ?? '').startsWith('/api/session.create')) {
        sessionCreateCallCount += 1;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
          const sessionId = (() => {
            const visit = (value: unknown, depth = 0): string | null => {
              if (depth > 6 || value === null || typeof value !== 'object') return null;
              const record = value as Record<string, unknown>;
              if (typeof record.sessionId === 'string') return record.sessionId;
              for (const child of Object.values(record)) {
                const found = visit(child, depth + 1);
                if (found !== null) return found;
              }
              return null;
            };
            return visit(body) ?? `generated-${String(sessionCreateCallCount)}`;
          })();
          const reply = () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            if (req.headers['x-test-mode'] === 'create-fail') {
              res.end(JSON.stringify({
                type: 'server-response',
                rpcId: 'session-create-failed',
                result: {
                  ok: false,
                  error: { code: 'session-conflict', details: { sessionId } },
                },
              }));
              return;
            }
            res.end(JSON.stringify({
              type: 'server-response',
              rpcId: 'session-create',
              result: { ok: true, value: { sessionId } },
            }));
          };
          if (req.headers['x-test-mode'] === 'create-delay') setTimeout(reply, 25);
          else reply();
        });
      } else if (/^\/api\/(?:llm|session)[.\/]models/.test(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(badJson ? '{"result":{"ok":true,"value":{"groups":[]}}}' : JSON.stringify(MODELS_RESPONSE));
        res.end();
      } else if (req.url === '/api/atFile/getSettings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(badJson ? '<!doctype html>' : JSON.stringify(AT_FILE_SETTINGS_RESPONSE));
      } else if (req.url === '/api/settings.describe') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: 'settings-describe-1',
          result: { ok: true, value: { writable: true, namespaces: [{ ns: 'llm-deepseek' }] } },
        }));
      } else if (req.url === '/api/session.search') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: 'search-1',
          result: {
            ok: true,
            value: {
              items: [
                { sessionId: 's-owned', snippet: 'customer result' },
                { sessionId: 's-other', snippet: 'administrator secret' },
              ],
              nextCursor: null,
            },
          },
        }));
      } else if (req.url === '/api/session.history') {
        if (testMode === 'history-html') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><html><head></head><body>upstream login</body></html>');
          return;
        }
        if (testMode === 'history-bad-json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('<!doctype html>');
          return;
        }
        if (testMode === 'history-bad-gzip') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
          });
          res.end('not-a-gzip-stream');
          return;
        }
        if (testMode === 'history-large') {
          sendLargeHistory(res, LARGE_HISTORY_BYTES);
          return;
        }
        if (testMode === 'history-oversize') {
          sendLargeHistory(res, OVERSIZE_HISTORY_BYTES);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, history: 'x'.repeat(16 * 1024) }));
      } else if (req.url === '/api/test-upstream-error') {
        req.socket.destroy();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(JSON.stringify({ ok: true, method: req.method, url: req.url }));
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function rawNames(rawHeaders: string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) names.push(rawHeaders[i].toLowerCase());
  return names;
}

function rawHeader(rawHeaders: string[], name: string): string {
  const index = rawHeaders.findIndex((value, offset) =>
    offset % 2 === 0 && value.toLowerCase() === name.toLowerCase());
  return index >= 0 ? rawHeaders[index + 1] ?? '' : '';
}

function gatewayReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; rawHeaders: string[]; rawBody: Buffer; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: gatewayPort, method, path: url, headers: { cookie, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          const contentEncoding = String(res.headers['content-encoding'] ?? '');
          const decoded = contentEncoding.includes('gzip') ? zlib.gunzipSync(rawBody) : rawBody;
          resolve({
            status: res.statusCode ?? 0,
            rawHeaders: res.rawHeaders,
            rawBody,
            body: decoded.toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Consume a large response incrementally so the test does not retain a second full body copy. */
function gatewayReqSize(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; rawHeaders: string[]; bodyBytes: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: gatewayPort, method, path: url, headers: { cookie, ...headers } },
      (res) => {
        let bodyBytes = 0;
        res.on('data', (chunk: Buffer) => {
          bodyBytes += chunk.length;
        });
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          rawHeaders: res.rawHeaders,
          bodyBytes,
        }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** 契约断言：响应绝不能同时出现 CL 与 TE */
function assertNoClTe(rawHeaders: string[]): void {
  const names = rawHeaders
    .filter((_, i) => i % 2 === 0)
    .map((n) => String(n).toLowerCase());
  assert.ok(
    !(names.includes('content-length') && names.includes('transfer-encoding')),
    `响应同时携带 Content-Length 与 Transfer-Encoding（Nginx 会 502）：${JSON.stringify(rawHeaders)}`,
  );
}

before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-test-'));
  db = new Database(path.join(tempDir, 'test.db'), createFieldCrypto('testkey', 'testkey'));
  db.init(); // 建表（构造函数不建表）
  const user = db.createUser('admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');
  const customer = db.createUser('customer', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  customerId = customer.id;
  db.setPermissions(customer.id, {
    allowedFolders: ['/workspaces/a'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    monthlyBudgetMicros: 0,
    allowUpload: true,
    allowGitDownload: true,
    banned: false,
    sandboxMode: 'workspace-write',
    disabledSessions: [],
  });
  db.claimSessionOwner('s-owned', customer.id);
  db.claimSessionOwner('s-other', user.id);
  const secondCustomer = db.createUser('customer-2', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(secondCustomer.id, {
    allowedFolders: ['/workspaces/a'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    monthlyBudgetMicros: 0,
    allowUpload: true,
    allowGitDownload: true,
    banned: false,
    sandboxMode: 'workspace-write',
    disabledSessions: [],
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

  auth = new AuthService(config, db);
  gateway = createGatewayServer(config, auth, db);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
  gatewayPort = (gateway.address() as { port: number }).port;

  // 直接签一个合法会话（等价于登录成功后的 cookie），cv=0 与新建用户一致
  const token = jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, config.jwtSecret, {
    expiresIn: '12h',
  });
  tokenValue = token;
  cookie = `dsh_gateway_token=${token}`;
  customerCookie = `dsh_gateway_token=${jwt.sign({
    sub: String(customer.id),
    username: customer.username,
    cv: 0,
  }, config.jwtSecret, { expiresIn: '12h' })}`;
  secondCustomerCookie = `dsh_gateway_token=${jwt.sign({
    sub: String(secondCustomer.id),
    username: secondCustomer.username,
    cv: 0,
  }, config.jwtSecret, { expiresIn: '12h' })}`;
});

after(() => {
  gateway?.close();
  upstream?.close();
  // Windows 上 node:sqlite 文件句柄保持打开（Database 无 close 接口），
  // 临时目录清理为尽力而为，失败时由系统临时目录回收
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* 忽略：文件锁未释放 */
  }
});

test('HTML 改写路径（注入脚本）：只有 content-length，无 transfer-encoding', async () => {
  const r = await gatewayReq('GET', '/html');
  assert.equal(r.status, 200);
  assertNoClTe(r.rawHeaders);
  const names = rawNames(r.rawHeaders);
  assert.ok(names.includes('content-length'), '改写路径必须带 content-length');
  assert.ok(!names.includes('transfer-encoding'), '改写路径不得带 transfer-encoding');
  assert.ok(r.body.includes('randomUUID'), 'HTML 注入脚本缺失');
  assert.ok(r.body.includes("cache: 'no-store'"), '首屏列表请求必须绕过旧账号的浏览器缓存');
  assert.match(rawHeader(r.rawHeaders, 'cache-control'), /(?:^|,)\s*private(?:,|$)/);
  assert.match(rawHeader(r.rawHeaders, 'cache-control'), /(?:^|,)\s*no-store(?:,|$)/);
  assert.match(rawHeader(r.rawHeaders, 'vary'), /(?:^|,)\s*Cookie\s*(?:,|$)/i);
  assert.ok(r.body.includes('<title>home</title>'), 'HTML 内容缺失');
});

test('带 rev 的插件静态资源流式 gzip 并长期缓存，identity 客户端保持原文', async () => {
  const compressed = await gatewayReq('GET', '/plugins/example/client.js?rev=abc123', {
    'accept-encoding': 'gzip',
  });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.body, HASHED_STATIC_BODY);
  assert.equal(rawHeader(compressed.rawHeaders, 'content-encoding'), 'gzip');
  assert.match(rawHeader(compressed.rawHeaders, 'cache-control'), /immutable/);
  assert.match(rawHeader(compressed.rawHeaders, 'vary'), /Accept-Encoding/i);
  assert.ok(compressed.rawBody.length < Buffer.byteLength(HASHED_STATIC_BODY) / 10);
  assertNoClTe(compressed.rawHeaders);

  const identity = await gatewayReq('GET', '/plugins/example/client.js?rev=abc123', {
    'accept-encoding': 'identity',
  });
  assert.equal(identity.status, 200);
  assert.equal(identity.body, HASHED_STATIC_BODY);
  assert.equal(rawHeader(identity.rawHeaders, 'content-encoding'), '');
  assert.match(rawHeader(identity.rawHeaders, 'cache-control'), /immutable/);
});

test('账号敏感列表响应禁止浏览器跨账号复用', async () => {
  for (const request of [
    ['GET', '/api/workspace.list', customerCookie],
    ['POST', '/api/workspace.list', customerCookie],
    ['GET', '/api/session.list', customerCookie],
    ['POST', '/api/session.search', customerCookie],
    ['GET', '/api/workspace.list', cookie],
    ['GET', '/api/session.list', cookie],
  ] as const) {
    const [method, url, accountCookie] = request;
    const response = await gatewayReq(method, url, {
      cookie: accountCookie,
      'content-type': 'application/json',
    }, method === 'POST' ? '{}' : undefined);
    assert.equal(response.status, 200, `${method} ${url}`);
    const cacheControl = rawHeader(response.rawHeaders, 'cache-control');
    assert.match(cacheControl, /(?:^|,)\s*private(?:,|$)/, `${method} ${url}: ${cacheControl}`);
    assert.match(cacheControl, /(?:^|,)\s*no-store(?:,|$)/, `${method} ${url}: ${cacheControl}`);
    assert.match(rawHeader(response.rawHeaders, 'vary'), /(?:^|,)\s*Cookie\s*(?:,|$)/i, `${method} ${url}`);
  }
});

test('workspace.list JSON 改写路径：只有 content-length，无 transfer-encoding', async () => {
  const r = await gatewayReq('POST', '/api/workspace.list', { 'content-type': 'application/json' });
  assert.equal(r.status, 200);
  assertNoClTe(r.rawHeaders);
  const names = rawNames(r.rawHeaders);
  assert.ok(names.includes('content-length'), '改写路径必须带 content-length');
  assert.ok(!names.includes('transfer-encoding'), '改写路径不得带 transfer-encoding');
  const parsed = JSON.parse(r.body);
  assert.deepEqual(parsed.data[0], {
    id: 'ws-1',
    workspaceId: 'ws-1',
    path: '/workspaces/a',
    sessionIds: ['s-owned'],
  });
});

test('dsh-at-file：子用户只读取获准工作区设置且不能修改共享设置', async () => {
  const read = await gatewayReq('POST', '/api/atFile/getSettings', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(read.status, 200);
  assert.deepEqual(
    JSON.parse(read.body).result.value.workspaceIgnoreFiles,
    [{ workspace: '/workspaces/a', ignoreFiles: ['own.txt'] }],
  );

  const update = await gatewayReq('POST', '/api/atFile/updateSettings', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ update: { field: 'enabled', value: false } }));
  assert.equal(update.status, 403);
});

test('dsh-at-file：搜索请求按 agentId 校验会话归属', async () => {
  const owned = await gatewayReq('POST', '/api/atFile/search', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ agentId: 's-owned' }));
  assert.equal(owned.status, 200);

  const other = await gatewayReq('POST', '/api/atFile/search', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ agentId: 's-other' }));
  assert.equal(other.status, 403);
});

test('session.create 显式 ID 只能恢复本人可见会话或成功领取真正新 ID', async () => {
  const baseline = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(baseline.status, 200);

  const before = sessionCreateCallCount;
  const other = await gatewayReq('POST', '/api/session.create', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-other' }));
  assert.equal(other.status, 403);
  assert.equal(JSON.parse(other.body).code, 'OWNER_CONFLICT');
  assert.equal(sessionCreateCallCount, before, '他人已归属 ID 不得转发上游');

  const legacy = await gatewayReq('POST', '/api/session.create', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-legacy-admin' }));
  assert.equal(legacy.status, 403);
  assert.equal(JSON.parse(legacy.body).code, 'OWNER_CONFLICT');
  assert.equal(sessionCreateCallCount, before, '未归属的旧会话不得被子账号领取');

  const own = await gatewayReq('POST', '/api/session.create', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-owned' }));
  assert.equal(own.status, 200);
  assert.equal(db.getSessionOwner('s-owned'), customerId);

  const fresh = await gatewayReq('POST', '/api/session.create', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-customer-fresh' }));
  assert.equal(fresh.status, 200);
  assert.equal(db.getSessionOwner('s-customer-fresh'), customerId);

  const failed = await gatewayReq('POST', '/api/session.create', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'x-test-mode': 'create-fail',
  }, JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-create-failed' }));
  assert.equal(failed.status, 200);
  assert.equal(JSON.parse(failed.body).result.ok, false);
  assert.equal(db.getSessionOwner('s-create-failed'), null, '上游业务失败不得预占 ID');
});

test('session.create 并发抢占只有一个账号获得所有权', async () => {
  const body = JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-concurrent-claim' });
  const before = sessionCreateCallCount;
  const [first, second] = await Promise.all([
    gatewayReq('POST', '/api/session.create', {
      cookie: customerCookie,
      'content-type': 'application/json',
      'x-test-mode': 'create-delay',
    }, body),
    gatewayReq('POST', '/api/session.create', {
      cookie: secondCustomerCookie,
      'content-type': 'application/json',
      'x-test-mode': 'create-delay',
    }, body),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 403]);
  const rejected = first.status === 403 ? first : second;
  assert.match(rawHeader(rejected.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(rejected.body).code, 'OWNER_CONFLICT');
  assert.equal(sessionCreateCallCount, before + 1, '败者必须在 Host session.create 之前被拒绝');
  assert.notEqual(db.getSessionOwner('s-concurrent-claim'), null);
});

test('agentPreset.select 复用会话归属与可见性校验', async () => {
  const own = await gatewayReq('POST', '/api/agentPreset.select', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ sessionId: 's-owned', agentPreset: 'standard' }));
  assert.equal(own.status, 200);

  const other = await gatewayReq('POST', '/api/agentPreset.select', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ sessionId: 's-other', agentPreset: 'standard' }));
  assert.equal(other.status, 403);
  assert.match(rawHeader(other.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(other.body).code, 'FORBIDDEN');
});

test('共享 Host 设置面仅管理员可读写', async () => {
  for (const operation of ['openDocument', 'update', 'replace', 'mutate']) {
    for (const separator of ['.', '/']) {
      const response = await gatewayReq('POST', `/api/settings${separator}${operation}`, {
        cookie: customerCookie,
        'content-type': 'application/json',
      }, JSON.stringify({
        type: 'client-request', rpcId: `settings-${operation}`, method: `settings.${operation}`, payload: {},
      }));
      assert.equal(response.status, 403, operation);
      assert.match(rawHeader(response.rawHeaders, 'content-type'), /^application\/json/);
      assert.equal(JSON.parse(response.body).code, 'FORBIDDEN');
      assert.doesNotMatch(response.body, /<!doctype/i);
    }
  }
  for (const endpoint of ['/api/dsh-web-ui-settings/describe', '/api/dsh-web-ui-settings/mutate']) {
    const response = await gatewayReq('POST', endpoint, {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, '{}');
    assert.equal(response.status, 403, endpoint);
    assert.equal(JSON.parse(response.body).code, 'FORBIDDEN');
  }
  for (const endpoint of ['/describe-image/native-images', '/sidebar/api/settings.update']) {
    const response = await gatewayReq('POST', endpoint, {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, '{}');
    assert.equal(response.status, 403, endpoint);
    assert.match(rawHeader(response.rawHeaders, 'content-type'), /^application\/json/);
    assert.equal(JSON.parse(response.body).code, 'FORBIDDEN');
  }

  const customer = await gatewayReq('POST', '/api/settings.describe', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(customer.status, 403);
  assert.equal(JSON.parse(customer.body).code, 'FORBIDDEN');

  const admin = await gatewayReq('POST', '/api/settings.describe', {
    cookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(admin.status, 200);
  assert.equal(JSON.parse(admin.body).result.value.writable, true);
});

test('API 拒绝与登录失效始终返回 JSON，不再把登录页或 403 HTML 交给客户端解析', async () => {
  const adminOnly = await gatewayReq('GET', '/api/dsh-ssh', { cookie: customerCookie });
  assert.equal(adminOnly.status, 403);
  assert.match(rawHeader(adminOnly.rawHeaders, 'content-type'), /^application\/json/);
  assert.doesNotMatch(adminOnly.body, /<!doctype/i);

  const expired = await gatewayReq('POST', '/api/session.list', {
    cookie: '',
    'content-type': 'application/json',
  }, '{}');
  assert.equal(expired.status, 401);
  assert.match(rawHeader(expired.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(expired.body).code, 'UNAUTHENTICATED');

  const tooLarge = await gatewayReq('POST', '/api/session.prompt', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ sessionId: 's-owned', content: 'x'.repeat(1024 * 1024 + 1) }));
  assert.equal(tooLarge.status, 413);
  assert.match(rawHeader(tooLarge.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(tooLarge.body).code, 'PAYLOAD_TOO_LARGE');

  const unavailable = await gatewayReq('POST', '/api/test-upstream-error', {
    cookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(unavailable.status, 502);
  assert.match(rawHeader(unavailable.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(unavailable.body).code, 'UPSTREAM_UNAVAILABLE');
});

test('租户过滤、at-file 与授权快照失败统一返回 JSON', async () => {
  const malformedWorkspace = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'x-test-mode': 'bad-json',
  }, '{}');
  assert.equal(malformedWorkspace.status, 502);
  assert.match(rawHeader(malformedWorkspace.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(malformedWorkspace.body).code, 'UPSTREAM_UNAVAILABLE');

  const malformedAtFile = await gatewayReq('POST', '/api/atFile/getSettings', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'x-test-mode': 'bad-json',
  }, '{}');
  assert.equal(malformedAtFile.status, 502);
  assert.match(rawHeader(malformedAtFile.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(malformedAtFile.body).code, 'UPSTREAM_UNAVAILABLE');

  db.claimSessionOwner('s-missing-from-snapshot', customerId);
  failSessionList = true;
  try {
    const unavailableSnapshot = await gatewayReq('POST', '/api/session.history', {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, JSON.stringify({ sessionId: 's-missing-from-snapshot' }));
    assert.equal(unavailableSnapshot.status, 502);
    assert.match(rawHeader(unavailableSnapshot.rawHeaders, 'content-type'), /^application\/json/);
    assert.equal(JSON.parse(unavailableSnapshot.body).code, 'UPSTREAM_UNAVAILABLE');
  } finally {
    failSessionList = false;
  }
});

test('子用户既看不到 Session @ 候选，也不能手工注入跨会话引用', async () => {
  const candidates = await gatewayReq('POST', '/api/sessionReferenceResolver/candidates', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(candidates.status, 403);

  const crafted = await gatewayReq('POST', '/api/session.prompt', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    sessionId: 's-owned',
    content: [{ type: 'text', text: '@[管理员会话](dsh-session:InMtb3RoZXIi)' }],
    mode: 'queue',
  }));
  assert.equal(crafted.status, 403);
  assert.equal(JSON.parse(crafted.body).code, 'FORBIDDEN');

  const queueEdit = await gatewayReq('POST', '/api/session.updateQueue', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    sessionId: 's-owned', itemId: 'queued-1',
    action: { kind: 'edit', content: [{ type: 'text', text: 'dsh-session:InMtb3RoZXIi' }] },
  }));
  assert.equal(queueEdit.status, 403);

  const subagent = await gatewayReq('POST', '/api/subagent.prompt', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    parentSessionId: 's-owned', childSessionId: 'child-1', mode: 'continuable',
    content: [{ type: 'text', text: 'dsh-session:InMtb3RoZXIi' }],
  }));
  assert.equal(subagent.status, 403);

  const fileMention = await gatewayReq('POST', '/api/session.prompt', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    sessionId: 's-owned', content: [{ type: 'text', text: '@报表.xlsx' }], mode: 'queue',
  }));
  assert.equal(fileMention.status, 200);
});

test('子用户可切换自己的会话模型，但不能操作其他账号会话', async () => {
  const own = await gatewayReq('POST', '/api/session.selectModel', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ sessionId: 's-owned', provider: 'codex', model: 'gpt-5.6-luna' }));
  assert.equal(own.status, 200);

  const other = await gatewayReq('POST', '/api/session.selectModel', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ sessionId: 's-other', provider: 'codex', model: 'gpt-5.6-luna' }));
  assert.equal(other.status, 403);
});

test('session.search：子用户搜索结果不包含其他账号会话', async () => {
  const response = await gatewayReq('POST', '/api/session.search', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    type: 'client-request', rpcId: 'search-1', method: 'session.search', payload: { query: 'result' },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(
    JSON.parse(response.body).result.value.items,
    [{ sessionId: 's-owned', snippet: 'customer result' }],
  );
  assert.doesNotMatch(response.body, /administrator secret/);
});

test('dsh-at-file：客户端取消期间工作区刷新失败不会终止网关', async () => {
  failWorkspaceList = true;
  await new Promise<void>((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: gatewayPort,
      method: 'POST',
      path: '/api/atFile/search',
      headers: {
        cookie: customerCookie,
        'content-type': 'application/json',
      },
    });
    req.once('error', () => resolve());
    req.end(JSON.stringify({ agentId: 's-owned' }));
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 5);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  failWorkspaceList = false;

  const healthy = await gatewayReq('POST', '/api/atFile/search', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ agentId: 's-owned' }));
  assert.equal(healthy.status, 200);
  assert.equal(gateway.listening, true);
});

test('已有授权快照时 workspace.list 暂时失败不再阻断历史加载', async () => {
  const baseline = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(baseline.status, 200);

  failWorkspaceList = true;
  try {
    const history = await gatewayReq('POST', '/api/session.history', {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, JSON.stringify({ sessionId: 's-owned' }));
    assert.equal(history.status, 200);
  } finally {
    failWorkspaceList = false;
  }
});

test('历史响应按浏览器能力重新 gzip，避免大型会话在远程连接上超时', async () => {
  const baseline = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(baseline.status, 200);

  const history = await gatewayReq('POST', '/api/session.history', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'accept-encoding': 'gzip',
  }, JSON.stringify({ sessionId: 's-owned' }));
  assert.equal(history.status, 200);
  assert.equal(rawHeader(history.rawHeaders, 'content-encoding'), 'gzip');
  assert.match(rawHeader(history.rawHeaders, 'vary'), /(?:^|,)\s*Cookie\s*(?:,|$)/i);
  assert.match(rawHeader(history.rawHeaders, 'vary'), /(?:^|,)\s*Accept-Encoding\s*(?:,|$)/i);
  assert.match(rawHeader(history.rawHeaders, 'cache-control'), /(?:^|,)\s*no-store(?:,|$)/);
  assert.ok(history.rawBody.length < Buffer.byteLength(history.body));
  assert.equal(JSON.parse(history.body).history.length, 16 * 1024);
});

test('session.history 专用缓冲允许 20MiB，超过 32MiB 仍返回 JSON 502', async () => {
  const baseline = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(baseline.status, 200);

  const large = await gatewayReqSize('POST', '/api/session.history', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'accept-encoding': 'identity',
    'x-test-mode': 'history-large',
  }, JSON.stringify({ sessionId: 's-owned' }));
  assert.equal(large.status, 200);
  assert.ok(large.bodyBytes > 16 * 1024 * 1024);
  assert.ok(large.bodyBytes < 32 * 1024 * 1024);
  assertNoClTe(large.rawHeaders);

  const oversize = await gatewayReq('POST', '/api/session.history', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'accept-encoding': 'identity',
    'x-test-mode': 'history-oversize',
  }, JSON.stringify({ sessionId: 's-owned' }));
  assert.equal(oversize.status, 502);
  assert.match(rawHeader(oversize.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(oversize.body).code, 'UPSTREAM_UNAVAILABLE');
});

test('子用户历史上游 HTML、坏 JSON 与改写异常统一返回 JSON 502', async () => {
  const baseline = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(baseline.status, 200);

  for (const testMode of ['history-html', 'history-bad-json', 'history-bad-gzip']) {
    const response = await gatewayReq('POST', '/api/session.history', {
      cookie: customerCookie,
      'content-type': 'application/json',
      'x-test-mode': testMode,
    }, JSON.stringify({ sessionId: 's-owned' }));
    assert.equal(response.status, 502, testMode);
    assert.match(rawHeader(response.rawHeaders, 'content-type'), /^application\/json/, testMode);
    assert.equal(JSON.parse(response.body).code, 'UPSTREAM_UNAVAILABLE', testMode);
    assert.doesNotMatch(response.body, /<!doctype/i, testMode);
  }
});

test('管理员历史异常响应保持既有兼容回退', async () => {
  const malformed = await gatewayReq('POST', '/api/session.history', {
    'content-type': 'application/json',
    'x-test-mode': 'history-bad-json',
  }, JSON.stringify({ sessionId: 's-owned' }));
  assert.equal(malformed.status, 200);
  assert.equal(malformed.body, '<!doctype html>');

  const html = await gatewayReq('POST', '/api/session.history', {
    'content-type': 'application/json',
    'x-test-mode': 'history-html',
  }, JSON.stringify({ sessionId: 's-owned' }));
  assert.equal(html.status, 200);
  assert.match(html.body, /randomUUID/);
  assert.match(html.body, /upstream login/);
});

test('普通文件预览和下载不再依赖 Git 下载权限', async () => {
  const current = db.getPermissions(customerId)!;
  db.setPermissions(current.user_id, {
    allowedFolders: current.allowed_folders,
    hourlyTokenLimit: current.hourly_token_limit,
    dailyMinutesLimit: current.daily_minutes_limit,
    monthlyBudgetMicros: current.monthly_budget_micros,
    allowUpload: current.allow_upload,
    allowGitDownload: false,
    banned: current.banned,
    sandboxMode: current.sandbox_mode,
    disabledSessions: current.disabled_sessions,
  });
  try {
    const raw = await gatewayReq('GET', '/aionui-panel/raw?root=%2Fworkspaces%2Fa&path=file.txt', {
      cookie: customerCookie,
    });
    assert.equal(raw.status, 200);

    const read = await gatewayReq('POST', '/aionui-panel/read', {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, JSON.stringify({ root: '/workspaces/a', path: 'file.txt' }));
    assert.equal(read.status, 200);

    const git = await gatewayReq('POST', '/aionui-panel/git-status', {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, JSON.stringify({ root: '/workspaces/a' }));
    assert.equal(git.status, 403);
  } finally {
    db.setPermissions(current.user_id, {
      allowedFolders: current.allowed_folders,
      hourlyTokenLimit: current.hourly_token_limit,
      dailyMinutesLimit: current.daily_minutes_limit,
      monthlyBudgetMicros: current.monthly_budget_micros,
      allowUpload: current.allow_upload,
      allowGitDownload: current.allow_git_download,
      banned: current.banned,
      sandboxMode: current.sandbox_mode,
      disabledSessions: current.disabled_sessions,
    });
  }
});

test('流式透传路径（session.list，管理员）：保留 chunked，不带 content-length', async () => {
  const r = await gatewayReq('GET', '/api/session.list');
  assert.equal(r.status, 200);
  assertNoClTe(r.rawHeaders);
  const names = rawNames(r.rawHeaders);
  assert.ok(names.includes('transfer-encoding'), '透传路径应保留上游的 chunked 分帧');
  assert.ok(!names.includes('content-length'), '透传路径不得出现 content-length');
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.ok, true);
});

test('管理员模型目录保持完整，子用户只过滤 Codex 的旧模型', async () => {
  const admin = await gatewayReq('POST', '/api/llm.models', { 'content-type': 'application/json' });
  assert.equal(admin.status, 200);
  assert.deepEqual(JSON.parse(admin.body), MODELS_RESPONSE);

  for (const endpoint of ['/api/llm.models', '/api/session.models']) {
    const customer = await gatewayReq('POST', endpoint, {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, endpoint === '/api/session.models' ? JSON.stringify({ sessionId: 's-owned' }) : undefined);
    assert.equal(customer.status, 200);
    assertNoClTe(customer.rawHeaders);
    const value = JSON.parse(customer.body).result.value;
    assert.deepEqual(value.groups.map((group: { id: string; models: Array<{ id: string }> }) => ({
      id: group.id,
      models: group.models.map(model => model.id),
    })), [
      {
        id: 'codex',
        models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      },
      {
        id: 'deepseek-official',
        models: ['deepseek-v4'],
      },
    ]);
  }
});

test('子用户模型目录解析失败时拒绝响应，不泄露未过滤目录', async () => {
  const r = await gatewayReq('POST', '/api/llm.models', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'x-test-mode': 'bad-json',
  });
  assert.equal(r.status, 502);
  assert.equal(r.body, '502 Upstream response unprocessable');
});

test('JSON 解析失败回退路径：不得同时出现 CL+TE，body 原样透传', async () => {
  const r = await gatewayReq('POST', '/api/workspace.list', {
    'content-type': 'application/json',
    'x-test-mode': 'bad-json',
  });
  assert.equal(r.status, 200);
  assertNoClTe(r.rawHeaders);
  const names = rawNames(r.rawHeaders);
  assert.ok(names.includes('transfer-encoding'), '回退路径应保留上游的 chunked 分帧');
  assert.ok(!names.includes('content-length'), '回退路径不得出现 content-length');
  assert.equal(r.body, 'not-json{');
});

test('F-15：网关会话 Cookie 不得转发给上游（信任边界最小化）', async () => {
  const r = await gatewayReq('GET', '/api/workspace.list');
  assert.equal(r.status, 200);
  assert.equal(lastUpstreamMethod, 'POST', '列表兼容 GET 必须转换为 Host 接受的 POST RPC');
  assert.equal(lastUpstreamHeaders['content-type'], 'application/json');
  assert.ok(Number(lastUpstreamHeaders['content-length']) > 0);
  // 上游收到的请求头里不得出现 cookie（含 dsh_gateway_token JWT）——
  // 否则上游/插件被入侵时可收割全部活动会话并回放
  assert.equal(
    lastUpstreamHeaders['cookie'],
    undefined,
    `上游收到网关 Cookie：${JSON.stringify(lastUpstreamHeaders['cookie'])}`,
  );
});

test('F-15 例外：自身插件路由 /api/dsh-passwords/* 必须保留 Cookie（插件 guard 鉴权依赖）', async () => {
  const r = await gatewayReq('GET', '/api/dsh-passwords/state');
  assert.equal(r.status, 200);
  assert.equal(
    lastUpstreamHeaders['cookie'],
    cookie,
    '插件路由的上游请求必须携带网关 Cookie，否则设置页用户管理全部 401',
  );
});

test('Cookie Chaos 加固（P3）：Unicode 空白前缀的会话 cookie 不再被归一化匹配 → 未认证', async () => {
  const locationOf = (rh: string[]): string => {
    const i = rh.findIndex((v, idx) => idx % 2 === 0 && v.toLowerCase() === 'location');
    return i >= 0 ? rh[i + 1] ?? '' : '';
  };
  // 只有 U+00A0 前缀的伪同名 cookie（旧 trim() 会按 Unicode 空白语义归一化成
  // dsh_gateway_token 读入并放行认证）；严格解析应视为不同 cookie → 302 登录页
  const r = await gatewayReq('GET', '/html', {
    cookie: `\u00a0dsh_gateway_token=${tokenValue}`, // U+00A0 在 latin1 下为单字节 0xA0
  });
  assert.equal(r.status, 302, 'Unicode 前缀 cookie 不应通过认证，应重定向到登录页');
  assert.match(locationOf(r.rawHeaders), /\/gateway\/login/);

  // 对照：正常 cookie 认证通过（U+00A0 精确匹配不被干扰）
  const ok = await gatewayReq('GET', '/html', { cookie: `dsh_gateway_token=${tokenValue}` });
  assert.equal(ok.status, 200, '正常会话 cookie 应认证通过');
});
