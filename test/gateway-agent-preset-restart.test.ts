import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import jwt from 'jsonwebtoken';

import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer } from '../src/gateway.js';
import type { PlatformConfig } from '../src/config.js';

// 会话的 preset 决定它此后每一条 prompt 是否放行，但 Harness 的 session/list
// 不带 agentPreset，网关只能在 session.create 响应里看到它一次。所以这份映射
// 必须落库：否则网关一重启，受限账号的历史会话就永久发不出消息。

let tempDir: string;
let dbPath: string;
let db: Database;
let upstream: http.Server;
let gateway: http.Server;
let port = 0;
let cookie = '';
let config: PlatformConfig;
let upstreamCalls: string[] = [];

function request(pathname: string, body = '{}'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Start a gateway over the current database, the way a restart would. */
async function startGateway(): Promise<void> {
  gateway = createGatewayServer(config, new AuthService(config, db), db);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  port = (gateway.address() as { port: number }).port;
  // 建立 cwd 快照：受限账号的会话作用域 RPC 需要它才能判定目录白名单
  const snapshot = await request('/api/workspace.list');
  assert.equal(snapshot.status, 200, snapshot.body);
}

before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-preset-restart-'));
  dbPath = path.join(tempDir, 'test.db');
  db = new Database(dbPath, createFieldCrypto('test-key', 'test-key'));
  db.init();
  db.createUser('admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');
  const user = db.createUser('preset-user', '$2a$10$dummyhashdummyhashdummyhashdu');
  db.setPermissions(user.id, {
    allowedFolders: ['/work/allowed'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: ['preset/allowed'], disabledSessions: [], banned: false, sandboxMode: null,
  });

  upstream = http.createServer((req, res) => {
    upstreamCalls.push(req.url ?? '');
    const reply = (value: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url?.startsWith('/api/workspace.list')) {
      reply({ result: { ok: true, value: { items: [{
        workspaceId: 'workspace', path: '/work/allowed', title: 'Allowed',
        sessionIds: ['restart-session'],
        createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
      }], archivedSessionIds: [] } } });
    } else if (req.url?.startsWith('/api/session.list')) {
      // Harness 的 SessionSummary 没有 agentPreset —— 正是重启后取不回 preset 的原因
      reply({ result: { ok: true, value: { items: [{ sessionId: 'restart-session', cwd: '/work/allowed' }] } } });
    } else if (req.url?.startsWith('/api/session.create')) {
      reply({ result: { ok: true, value: { sessionId: 'restart-session', cwd: '/work/allowed', agentPreset: 'preset/allowed' } } });
    } else {
      reply({ ok: true });
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  config = {
    setupKey: 'test-setup-key', dbPath, dbEncKey: 'test-key',
    gateway: {
      host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstreamPort}`,
      tls: null, redirectPort: null, publicHost: '', domain: 'localhost', autoTls: false,
      acmeEmail: '', acmeStaging: false,
    },
    jwtSecret: 'test-secret', internalSecret: 'test-internal',
    patch: { dshRoot: '', restartService: '' }, webSocket: { sshEndpoints: [] },
  };
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, config.jwtSecret, { expiresIn: '12h' })}`;
  await startGateway();
});

after(() => {
  gateway?.close();
  upstream?.close();
  db?.close();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows cleanup is best effort */ }
});

test('授权 preset 建出的会话在网关重启后仍然可以发消息', async () => {
  const create = await request('/api/session.create', JSON.stringify({
    cwd: '/work/allowed', agentPreset: 'preset/allowed',
  }));
  assert.equal(create.status, 200, create.body);
  const before = await request('/api/session.prompt', JSON.stringify({ sessionId: 'restart-session', text: 'hi' }));
  assert.equal(before.status, 200, before.body);

  assert.equal(
    db.listSessionOwners().find((row) => row.session_id === 'restart-session')?.agent_preset,
    'preset/allowed',
    '会话 preset 必须随归属一起落库',
  );

  // 重启：新的 Database 与新的网关实例，内存里的 preset 映射全部丢失
  await new Promise<void>((resolve) => gateway.close(() => { resolve(); }));
  db.close();
  db = new Database(dbPath, createFieldCrypto('test-key', 'test-key'));
  db.init();
  upstreamCalls = [];
  await startGateway();

  const after = await request('/api/session.prompt', JSON.stringify({ sessionId: 'restart-session', text: 'hi' }));
  assert.equal(after.status, 200, after.body);
  assert.equal(upstreamCalls.some((url) => url.startsWith('/api/session.prompt')), true);
});
