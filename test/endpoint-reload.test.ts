// 端点登记表热更新（改 .env 无需重启网关）回归测试：
//   1) 写入部署 .env 的登记表规则后，运行中的网关在轮询周期内自动生效；
//   2) 两把钥匙语义不变：未登记 / 未勾选 SSH 都是 403；
//   3) 规则被清空后立即收紧，并断开已授权 WebSocket（撤销语义）；
//   4) 非法规则保留上一次有效快照（不静默放宽，也不打断已有授权）。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';

import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer } from '../src/gateway.js';
import type { PlatformConfig } from '../src/config.js';

let tempDir = '';
let envFile = '';
let db: Database;
let upstream: http.Server;
let gateway: http.Server;
let port = 0;
let adminCookie = '';
let subCookie = '';
let subId = 0;
const RELOAD_MS = 25;
const SETTLE_MS = RELOAD_MS * 6;

function writeEnv(registry?: string, pluginCompat?: string): void {
  const lines = ['SETUP_KEY=test-setup-key'];
  if (registry !== undefined) lines.push(`MCP_GATEWAY_SSH_ENDPOINTS=${registry}`);
  if (pluginCompat !== undefined) lines.push(`MCP_GATEWAY_PLUGIN_COMPAT=${pluginCompat}`);
  lines.push('');
  writeFileSync(envFile, lines.join('\n'));
}

function setSubPermissions(allowSsh: boolean): void {
  db.setPermissions(subId, {
    allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    banned: false, sandboxMode: null, disabledSessions: [], allowSsh,
  });
}

function request(pathname: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'GET',
      headers: { cookie, 'content-type': 'application/json', 'content-length': '2' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

/** 原始 WS 握手：被拒绝时按普通 HTTP 响应返回状态码，被放行时返回 101。 */
function wsHandshake(pathname: string, cookie: string): Promise<{ status: number; socket: http.IncomingMessage['socket'] | null }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname,
      headers: {
        // originHostMatches 要求 Origin.host 与请求 Host 精确相等（含端口），
        // 因此两者统一写成不带端口的 127.0.0.1（与既有 WS 测试一致）。
        host: '127.0.0.1',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': Buffer.from(`reload-${Math.random()}`).toString('base64'),
        'sec-websocket-version': '13',
        cookie,
        origin: 'http://127.0.0.1',
      },
    });
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, socket: null }); });
    req.on('error', reject);
    req.end();
  });
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-reload-'));
  envFile = path.join(tempDir, '.env');
  writeEnv();
  process.env.DSH_PASSWORDS_ENV_FILE = envFile;
  db = new Database(path.join(tempDir, 'test.db'), createFieldCrypto('test-key', 'test-key'));
  db.init();
  const admin = db.createUser('reload-admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');
  const sub = db.createUser('reload-sub', '$2a$10$dummyhashdummyhashdummyhashdu');
  subId = sub.id;
  setSubPermissions(true);
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  upstream.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve); });
  const upstreamPort = (upstream.address() as { port: number }).port;
  const config: PlatformConfig = {
    setupKey: 'test-setup-key', dbPath: path.join(tempDir, 'test.db'), dbEncKey: 'test-key',
    gateway: {
      host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstreamPort}`,
      tls: null, redirectPort: null, publicHost: '', domain: 'localhost', autoTls: false,
      acmeEmail: '', acmeStaging: false,
    },
    jwtSecret: 'test-secret', internalSecret: 'test-internal',
    patch: { dshRoot: '', restartService: '' },
    endpointRules: [],
    pluginCompat: false,
  };
  adminCookie = `dsh_gateway_token=${jwt.sign({ sub: String(admin.id), username: admin.username, cv: 0 }, config.jwtSecret, { expiresIn: '12h' })}`;
  subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(sub.id), username: sub.username, cv: 0 }, config.jwtSecret, { expiresIn: '12h' })}`;
  gateway = createGatewayServer(config, new AuthService(config, db), db, undefined, {
    envFile,
    endpointReloadIntervalMs: RELOAD_MS,
  });
  await new Promise<void>((resolve) => { gateway.listen(0, '127.0.0.1', resolve); });
  port = (gateway.address() as { port: number }).port;
});

after(() => {
  gateway?.close();
  upstream?.close();
  db?.close();
  delete process.env.DSH_PASSWORDS_ENV_FILE;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows 清理尽力而为 */ }
});

test('热更新：未登记时 fail-closed，写入 .env 后无需重启即生效（两把钥匙都验证）', async () => {
  assert.equal(await request('/api/plugin/terminal', subCookie), 403, '未登记：子用户 fail-closed');
  assert.equal(await request('/api/plugin/terminal', adminCookie), 200, '未登记：主用户不受登记表限制');

  writeEnv('/api/plugin/terminal');
  await wait(SETTLE_MS);
  assert.equal(await request('/api/plugin/terminal', subCookie), 200, '热更新生效：已登记 + 已勾选 SSH');

  // 钥匙二：取消勾选后立即 403（无需等待热更新，权限本身就实时生效）
  setSubPermissions(false);
  assert.equal(await request('/api/plugin/terminal', subCookie), 403, '未勾选 SSH：拒绝');
  setSubPermissions(true);
  assert.equal(await request('/api/plugin/terminal', subCookie), 200, '重新勾选：放行');
});

test('热更新：owner: 前缀与传输前缀在运行中变更同样生效', async () => {
  writeEnv('owner:/api/plugin/terminal');
  await wait(SETTLE_MS);
  assert.equal(await request('/api/plugin/terminal', subCookie), 403, 'owner: 规则对子用户 403');

  writeEnv('ws:/api/plugin/terminal');
  await wait(SETTLE_MS);
  assert.equal(await request('/api/plugin/terminal', subCookie), 403, 'ws: 规则不作用于 HTTP 通道');

  writeEnv('http:/api/plugin/terminal');
  await wait(SETTLE_MS);
  assert.equal(await request('/api/plugin/terminal', subCookie), 200, 'http: 规则作用于 HTTP 通道');
});

test('热更新：规则被清空后立即收紧，且已授权 WebSocket 被断开（撤销语义）', async () => {
  writeEnv('ws:/api/plugin/terminal');
  await wait(SETTLE_MS);
  const allowed = await wsHandshake('/api/plugin/terminal', subCookie);
  assert.equal(allowed.status, 101, '已登记 WS 端点允许升级');

  let closed = false;
  allowed.socket?.once('close', () => { closed = true; });
  writeEnv(undefined);
  await wait(SETTLE_MS);
  assert.equal(closed, true, '规则清空后已授权 WS 必须被断开');
  assert.equal(await request('/api/plugin/terminal', subCookie), 403, 'HTTP 侧同样收紧');
});

test('热更新：非法规则保留上一次有效快照（不静默放宽、不打断已有授权）', async () => {
  writeEnv('/api/plugin/terminal');
  await wait(SETTLE_MS);
  assert.equal(await request('/api/plugin/terminal', subCookie), 200, '有效规则生效');

  writeEnv('ws:');
  await wait(SETTLE_MS);
  assert.equal(await request('/api/plugin/terminal', subCookie), 200, '非法写法不生效，保持上一次有效规则');

  writeEnv('/gateway/login');
  await wait(SETTLE_MS);
  assert.equal(await request('/api/plugin/terminal', subCookie), 200, '网关自身路径同样不生效（保留旧快照）');
});

test('热更新：插件兼容层开关随 .env 变更即时生效', async () => {
  const overview = (): Promise<{ pluginCompat: boolean; endpoints: string[] }> => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/gateway/api/overview', method: 'GET',
      headers: { cookie: adminCookie },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end();
  });

  writeEnv('/api/plugin/terminal', undefined);
  await wait(SETTLE_MS);
  assert.equal((await overview()).pluginCompat, false, '默认关闭');

  writeEnv('/api/plugin/terminal', 'on');
  await wait(SETTLE_MS);
  assert.equal((await overview()).pluginCompat, true, '热更新打开兼容层');
  assert.deepEqual((await overview()).endpoints, ['/api/plugin/terminal'], '登记表同步可见');

  writeEnv('/api/plugin/terminal', 'off');
  await wait(SETTLE_MS);
  assert.equal((await overview()).pluginCompat, false, '热更新关闭兼容层');
});
