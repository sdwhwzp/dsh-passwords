import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import jwt from 'jsonwebtoken';

import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer } from '../src/gateway.js';
import type { PlatformConfig } from '../src/config.js';

let tempDir: string;
let db: Database;
let upstream: http.Server;
let gateway: http.Server;
let port = 0;
let cookie = '';
let restrictedCookie = '';
let otherCookie = '';
let upstreamCalls: string[] = [];
let selectBlocked = false;
let successfulCreates = 0;

function request(
  pathname: string,
  body = '{}',
  tokenCookie = cookie,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: {
        cookie: tokenCookie,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const decoded = String(res.headers['content-encoding'] ?? '').includes('gzip')
          ? zlib.gunzipSync(raw)
          : raw;
        resolve({ status: res.statusCode ?? 0, body: decoded.toString('utf8'), headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-preset-'));
  db = new Database(path.join(tempDir, 'test.db'), createFieldCrypto('test-key', 'test-key'));
  db.init();
  db.createUser('admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');
  const user = db.createUser('preset-user', '$2a$10$dummyhashdummyhashdummyhashdu');
  const restricted = db.createUser('restricted-user', '$2a$10$dummyhashdummyhashdummyhashdu');
  const other = db.createUser('other-user', '$2a$10$dummyhashdummyhashdummyhashdu');
  db.setPermissions(user.id, {
    allowedFolders: ['/work/allowed'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: ['preset/allowed'], disabledSessions: [], banned: false, sandboxMode: null,
  });
  db.setPermissions(restricted.id, {
    allowedFolders: ['/work/allowed'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: [], disabledSessions: [], banned: false, sandboxMode: null,
  });
  db.setPermissions(other.id, {
    allowedFolders: ['/work/allowed'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: ['preset/other-only'], disabledSessions: [], banned: false, sandboxMode: null,
  });
  db.claimSessionOwner('existing-session', user.id);
  db.claimSessionOwner('gzip-session', user.id);
  upstream = http.createServer((req, res) => {
    upstreamCalls.push(req.url ?? '');
    const reply = (value: unknown) => {
      const raw = Buffer.from(JSON.stringify(value), 'utf8');
      if (req.headers['x-test-encoding'] === 'gzip-chunked') {
        const compressed = zlib.gzipSync(raw);
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        const split = Math.max(1, Math.floor(compressed.length / 2));
        res.write(compressed.subarray(0, split));
        res.end(compressed.subarray(split));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(raw);
    };
    if (req.url?.startsWith('/api/workspace.list')) {
      reply({ result: { ok: true, value: { items: [{ workspaceId: 'workspace', path: '/work/allowed', title: 'Allowed', sessionIds: ['existing-session', 'gzip-session'], createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z' }], archivedSessionIds: [] } } });
    } else if (req.url?.startsWith('/api/session.list')) {
      reply({ result: { ok: true, value: { items: [{ sessionId: 'existing-session', cwd: '/work/allowed', agentPreset: 'preset/allowed' }, { sessionId: 'gzip-session', cwd: '/work/allowed' }] } } });
    } else if (req.url?.startsWith('/api/session.create')) {
      successfulCreates += 1;
      const sessionId = successfulCreates === 1 ? 'restricted-session' : 'new-session';
      reply({ result: { ok: true, value: { sessionId, cwd: '/work/allowed' } } });
    } else if (req.url?.startsWith('/api/agentPreset.select')) {
        if (selectBlocked) {
        reply({ result: { ok: false, error: { message: 'boom' } } });
      } else {
        reply({ result: { ok: true, value: { agentPreset: 'preset/allowed' } } });
      }
    } else if (req.url?.startsWith('/api/agentPreset.list')) {
      reply({ result: { ok: true, value: { items: [
        { id: 'preset/allowed' },
        { id: 'preset/blocked' },
      ] } } });
    } else {
      reply({ ok: true });
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const config: PlatformConfig = {
    setupKey: 'test-setup-key', dbPath: path.join(tempDir, 'test.db'), dbEncKey: 'test-key',
    gateway: {
      host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstreamPort}`,
      tls: null, redirectPort: null, publicHost: '', domain: 'localhost', autoTls: false,
      acmeEmail: '', acmeStaging: false,
    },
    jwtSecret: 'test-secret', internalSecret: 'test-internal',
    patch: { dshRoot: '', restartService: '' }, webSocket: { adminAllowlist: [], userAllowlist: [] },
  };
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, config.jwtSecret, { expiresIn: '12h' })}`;
  restrictedCookie = `dsh_gateway_token=${jwt.sign({ sub: String(restricted.id), username: restricted.username, cv: 0 }, config.jwtSecret, { expiresIn: '12h' })}`;
  otherCookie = `dsh_gateway_token=${jwt.sign({ sub: String(other.id), username: other.username, cv: 0 }, config.jwtSecret, { expiresIn: '12h' })}`;
  gateway = createGatewayServer(config, new AuthService(config, db), db);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  port = (gateway.address() as { port: number }).port;
  const snapshot = await request('/api/workspace.list');
  assert.equal(snapshot.status, 200);
  await request('/api/workspace.list', '{}', restrictedCookie);
  await request('/api/workspace.list', '{}', otherCookie);
});

after(() => {
  gateway?.close();
  upstream?.close();
  db?.close();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows cleanup is best effort */ }
});

test('Issue #22: restricted subuser cannot create a session with an unapproved agent preset', async () => {
  upstreamCalls = [];
  const response = await request('/api/session.create', JSON.stringify({ cwd: '/work/allowed', agentPreset: 'preset/blocked' }));
  assert.equal(response.status, 403);
  assert.equal(upstreamCalls.some((url) => url.startsWith('/api/session.create')), false);
});

test('Issue #22: 默认空白名单用户无 preset 创建会话时不被网关伪协议字段拦截', async () => {
  upstreamCalls = [];
  const noPreset = await request('/api/session.create', JSON.stringify({ cwd: '/work/allowed' }), restrictedCookie);
  assert.equal(noPreset.status, 200, noPreset.body);
  assert.equal(upstreamCalls.some((url) => url.startsWith('/api/session.create')), true);
  const anyPreset = await request('/api/session.create', JSON.stringify({ cwd: '/work/allowed', agentPreset: 'preset/whatever' }), restrictedCookie);
  assert.equal(anyPreset.status, 403);
});

test('Issue #22: 授权 preset 允许创建会话，并登记缓存供 prompt 使用', async () => {
  upstreamCalls = [];
  // 缓存未登记前 prompt fail-closed
  const beforePrompt = await request('/api/session.prompt', JSON.stringify({ sessionId: 'existing-session', text: 'hi' }));
  assert.equal(beforePrompt.status, 403);
  // select 成功后 prompt 放行
  const select = await request('/api/agentPreset.select', JSON.stringify({ sessionId: 'existing-session', agentPreset: 'preset/allowed' }));
  assert.equal(select.status, 200, select.body);
  const afterPrompt = await request('/api/session.prompt', JSON.stringify({ sessionId: 'existing-session', text: 'hi' }));
  assert.equal(afterPrompt.status, 200, afterPrompt.body);
});

test('Agent preset gzip chunked responses are decoded before filtering and selection state updates', async () => {
  const list = await request(
    '/api/agentPreset.list',
    '{}',
    cookie,
    { 'x-test-encoding': 'gzip-chunked', 'accept-encoding': 'gzip' },
  );
  assert.equal(list.status, 200, list.body);
  assert.deepEqual(
    JSON.parse(list.body).result.value.items,
    [{ id: 'preset/allowed' }],
  );
  assert.equal(list.headers['content-encoding'], undefined, 'rewritten list response must be identity encoded');

  const before = await request('/api/session.prompt', JSON.stringify({ sessionId: 'gzip-session', text: 'hi' }));
  assert.equal(before.status, 403);
  const select = await request(
    '/api/agentPreset.select',
    JSON.stringify({ sessionId: 'gzip-session', agentPreset: 'preset/allowed' }),
    cookie,
    { 'x-test-encoding': 'gzip-chunked', 'accept-encoding': 'gzip' },
  );
  assert.equal(select.status, 200, select.body);
  assert.equal(select.headers['content-encoding'], 'gzip');
  const after = await request('/api/session.prompt', JSON.stringify({ sessionId: 'gzip-session', text: 'hi' }));
  assert.equal(after.status, 200, after.body);
});

test('Issue #22: Agent preset 会话缓存按用户隔离', async () => {
  upstreamCalls = [];
  const ownerList = await request('/api/session.list', '{}', cookie);
  assert.equal(ownerList.status, 200, ownerList.body);
  const response = await request(
    '/api/session.prompt',
    JSON.stringify({ sessionId: 'existing-session', text: 'hi' }),
    otherCookie,
  );
  assert.equal(response.status, 403, '其他用户不能借用当前用户的 session preset 缓存');
});

test('Issue #22: select 失败后不更新缓存，prompt 仍按旧缓存判断', async () => {
  // 先确认旧缓存允许
  const okPrompt = await request('/api/session.prompt', JSON.stringify({ sessionId: 'existing-session', text: 'hi' }));
  assert.equal(okPrompt.status, 200, okPrompt.body);
  // 上游失败：select 本身经网关放行后由上游返回 500，网关不得登记该 preset
  selectBlocked = true;
  try {
    const failedSelect = await request('/api/agentPreset.select', JSON.stringify({ sessionId: 'existing-session', agentPreset: 'preset/allowed' }));
    assert.equal(failedSelect.status, 200, failedSelect.body);
    const afterPrompt = await request('/api/session.prompt', JSON.stringify({ sessionId: 'existing-session', text: 'hi' }));
    assert.equal(afterPrompt.status, 200, 'select 失败不得污染既有缓存');
  } finally {
    selectBlocked = false;
  }
});

test('Issue #22: approved preset permits a bounded session prompt below the inspected RPC limit', async () => {
  const create = await request('/api/session.create', JSON.stringify({ cwd: '/work/allowed', agentPreset: 'preset/allowed' }));
  assert.equal(create.status, 200, create.body);
  const prompt = JSON.stringify({ sessionId: 'new-session', text: 'x'.repeat(768 * 1024) });
  const response = await request('/api/session.prompt', prompt);
  assert.equal(response.status, 200, response.body);
  assert.equal(upstreamCalls.some((url) => url.startsWith('/api/session.prompt')), true);
});


test('Issue #22: preset 被管理员撤销后已有会话 prompt 拒绝', async () => {
  // 撤销 preset（保留会话授权），重建快照后 prompt 因 preset 白名单拒绝
  db.setPermissions(db.getUserByUsername('preset-user')!.id, {
    allowedFolders: ['/work/allowed'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: [], banned: false, sandboxMode: null, disabledSessions: [],
  });
  const snapshot = await request('/api/workspace.list');
  assert.equal(snapshot.status, 200);
  const response = await request('/api/session.prompt', JSON.stringify({ sessionId: 'existing-session', text: 'hi' }));
  assert.equal(response.status, 403);
});
