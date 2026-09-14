import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer } from '../src/gateway.js';
import type { PlatformConfig } from '../src/config.js';

// HSTS 绑主机名并且忽略端口：同一主机名上任何一个明文端口的服务都会被浏览器
// 一起锁成 https。线上 gr.gr-iot.cn 就是这样——网关在 3081 上发了 HSTS，
// 把同主机名 30000 端口上的纯 HTTP GitLab 一并锁死。所以 max-age 必须可配。

let tempDir: string;
let db: Database;
let upstream: http.Server;
let baseConfig: PlatformConfig;

/** Fetch the gateway's `Strict-Transport-Security` header for one config. */
async function hstsHeaderFor(hstsMaxAge: number | null, tls: boolean): Promise<string | undefined> {
  const config: PlatformConfig = {
    ...baseConfig,
    gateway: {
      ...baseConfig.gateway,
      hstsMaxAge,
      ...(tls ? { tls: { cert: path.join(tempDir, 'cert.pem'), key: path.join(tempDir, 'key.pem') } } : { tls: null }),
    },
  };
  const server = createGatewayServer(config, new AuthService(config, db), db);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const agent = tls ? new https.Agent({ rejectUnauthorized: false }) : undefined;
      const request = (tls ? https : http).request(
        { host: '127.0.0.1', port, path: '/gateway/login', method: 'GET', ...(agent ? { agent } : {}) },
        (res) => {
          res.resume();
          const value = res.headers['strict-transport-security'];
          resolve(typeof value === 'string' ? value : undefined);
        },
      );
      request.on('error', reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  }
}

before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-hsts-'));
  // 自签证书：网关只在监听时读它，内容不参与断言
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost',
    '-keyout', path.join(tempDir, 'key.pem'),
    '-out', path.join(tempDir, 'cert.pem'),
  ], { stdio: 'ignore' });
  writeFileSync(path.join(tempDir, 'marker'), 'x');

  db = new Database(path.join(tempDir, 'test.db'), createFieldCrypto('test-key', 'test-key'));
  db.init();
  db.createUser('admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');
  upstream = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  baseConfig = {
    setupKey: 'test-setup-key', dbPath: path.join(tempDir, 'test.db'), dbEncKey: 'test-key',
    gateway: {
      host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${String(upstreamPort)}`,
      tls: null, redirectPort: null, publicHost: '', domain: 'localhost', autoTls: false,
      acmeEmail: '', acmeStaging: false, hstsMaxAge: 31536000,
    },
    jwtSecret: 'test-secret', internalSecret: 'test-internal',
    patch: { dshRoot: '', restartService: '' }, webSocket: { sshEndpoints: [] },
  };
});

after(() => {
  upstream?.close();
  db?.close();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows cleanup is best effort */ }
});

test('HTTPS 下按配置的秒数发 HSTS', async () => {
  assert.equal(await hstsHeaderFor(31536000, true), 'max-age=31536000');
  assert.equal(await hstsHeaderFor(600, true), 'max-age=600');
});

test('max-age=0 会发出去——这是让浏览器忘掉已种策略的唯一办法', async () => {
  // 不发头只会让旧策略留到一年后过期；必须显式发 0 才能主动解开。
  assert.equal(await hstsHeaderFor(0, true), 'max-age=0');
});

test('配置为 off 时完全不发这个头', async () => {
  assert.equal(await hstsHeaderFor(null, true), undefined);
});

test('明文模式下任何配置都不发 HSTS', async () => {
  assert.equal(await hstsHeaderFor(31536000, false), undefined);
  assert.equal(await hstsHeaderFor(0, false), undefined);
});
