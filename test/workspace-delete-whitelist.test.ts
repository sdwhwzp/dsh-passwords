// Directory creation capability does not grant access to arbitrary server folders.
import { test } from 'node:test';
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
import { normalizePath } from '../src/permissions.js';
import type { PlatformConfig } from '../src/config.js';

const DUMMY_HASH = '$2a$10$dummyhashdummyhashdummyhashdu';
const HOME = normalizePath(os.homedir());
const SYNTH_ROOT = normalizePath(`${HOME}/dshpw-wsdel-synth`);

interface Reply {
  status: number;
  body: string;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

function jsonBody(method: string, port: number, pathname: string, body: unknown, cookie: string): Promise<Reply> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path: pathname,
        headers: { cookie, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function readArgs(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { payload?: { args?: Record<string, unknown> } };
        resolve(parsed.payload?.args ?? {});
      } catch {
        resolve({});
      }
    });
  });
}

test('自建能力不扩大授权根，也不能删除非私有工作区登记', async () => {
  const appDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-wsdel-app-'));
  mkdirSync(path.join(appDir, 'data'));
  const dbPath = path.join(appDir, 'data', 'test.db');
  const db = new Database(dbPath, createFieldCrypto('test-key', 'test-key'));
  db.init();
  let upstream: http.Server | null = null;
  let gateway: http.Server | null = null;
  try {
    const restricted = (folders: string[], allowCreate: boolean) => ({
      allowedFolders: folders, hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: allowCreate,
      allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    });

    // 场景 A：__deny__ 起点（无预分配根），靠目录选择器自建工作区。
    const denyCreator = db.createUser('wsdel-deny-creator', DUMMY_HASH, 'user');
    db.setPermissions(denyCreator.id, restricted(['__deny__'], true));
    // 场景 B：管理员分配了父目录 /assigned 与另一个目录 /other。
    const assignedOwner = db.createUser('wsdel-assigned-owner', DUMMY_HASH, 'user');
    db.setPermissions(assignedOwner.id, restricted([`${SYNTH_ROOT}/assigned`, `${SYNTH_ROOT}/other`], true));
    // 场景 C：管理员把白名单精确设成一个尚不存在的目录；用户随后创建并登记它。
    const exactPath = `${HOME}/dshpw-wsdel-exact`;
    const exactOwner = db.createUser('wsdel-exact-owner', DUMMY_HASH, 'user');
    db.setPermissions(exactOwner.id, restricted([exactPath], true));

    let workspaceSeq = 0;
    upstream = await new Promise<http.Server>((resolve) => {
      const server = http.createServer((req, res) => {
        void (async () => {
          const url = req.url ?? '';
          const reply = (value: unknown) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'server-response', result: { ok: true, value } }));
          };
          if (req.method === 'POST' && url.startsWith('/api/directoryPicker/createDirectory')) {
            const args = await readArgs(req);
            const parent = typeof args.path === 'string' ? args.path.replace(/\\/g, '/') : '';
            const name = typeof args.name === 'string' ? args.name : '';
            reply(`${parent}/${name}`);
            return;
          }
          if (req.method === 'POST' && url.startsWith('/api/workspace/create')) {
            const args = await readArgs(req);
            const request = args.request as Record<string, unknown> | undefined;
            const target = typeof request?.path === 'string' ? request.path : '';
            workspaceSeq += 1;
            reply({ created: true, workspace: { workspaceId: `wsdel-${workspaceSeq}`, path: target, title: 't', sessionIds: [] } });
            return;
          }
          if (req.method === 'POST' && url.startsWith('/api/workspace/delete')) {
            reply({ deleted: true });
            return;
          }
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{}');
        })();
      });
      listen(server).then(() => resolve(server));
    });
    const upstreamPort = (upstream.address() as { port: number }).port;

    const config: PlatformConfig = {
      setupKey: 'test-setup-key', dbPath, dbEncKey: 'test-key',
      gateway: {
        host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstreamPort}`,
        tls: null, redirectPort: null, publicHost: '', domain: 'localhost', autoTls: false,
        acmeEmail: '', acmeStaging: false,
      },
      jwtSecret: 'test-secret', internalSecret: 'test-internal',
      patch: { dshRoot: '', restartService: '' },
      endpointRules: [],
    };
    gateway = createGatewayServer(config, new AuthService(config, db), db);
    const gatewayPort = await listen(gateway);

    const cookieFor = (user: { id: number; username: string }): string =>
      `dsh_gateway_token=${jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, config.jwtSecret, { expiresIn: '12h' })}`;
    const denyCookie = cookieFor(denyCreator);
    const assignedCookie = cookieFor(assignedOwner);
    const exactCookie = cookieFor(exactOwner);

    const createDirectory = (cookie: string, parent: string, name: string, rpcId: string) =>
      jsonBody('POST', gatewayPort, '/api/directoryPicker/createDirectory', {
        type: 'client-request', rpcId, method: 'directoryPicker/createDirectory',
        payload: { args: { path: parent, name } },
      }, cookie);
    const createWorkspace = (cookie: string, target: string, rpcId: string) =>
      jsonBody('POST', gatewayPort, '/api/workspace/create', {
        type: 'client-request', rpcId, method: 'workspace/create',
        payload: { args: { request: { path: target } } },
      }, cookie);
    const deleteWorkspace = (cookie: string, workspaceId: string, rpcId: string) =>
      jsonBody('POST', gatewayPort, '/api/workspace/delete', {
        type: 'client-request', rpcId, method: 'workspace/delete',
        payload: { args: { request: { workspaceId } } },
      }, cookie);
    const createSessionByPath = (cookie: string, target: string, rpcId: string) =>
      jsonBody('POST', gatewayPort, '/api/session.create', {
        type: 'client-request', rpcId, method: 'session/create',
        payload: { args: { request: { path: target } } },
      }, cookie);
    const createSessionById = (cookie: string, workspaceId: string, rpcId: string) =>
      jsonBody('POST', gatewayPort, '/api/session.create', {
        type: 'client-request', rpcId, method: 'session/create',
        payload: { args: { request: { workspaceId } } },
      }, cookie);

    const denyPath = `${HOME}/wsdel-deny-created`;
    assert.equal((await createDirectory(denyCookie, HOME, 'wsdel-deny-created', 'a-mkdir')).status, 403);
    assert.equal((await createWorkspace(denyCookie, denyPath, 'a-create')).status, 403);
    assert.equal((await createSessionByPath(denyCookie, denyPath, 'a-session')).status, 403);
    assert.deepEqual(db.getPermissions(denyCreator.id)?.allowed_folders, ['__deny__']);
    assert.deepEqual(db.listUserWorkspacePaths(denyCreator.id), []);

    // An assigned root authorizes reads; the server picker still needs a managed root.
    assert.equal((await createDirectory(assignedCookie, `${SYNTH_ROOT}/assigned`, 'child', 'b-mkdir')).status, 403);
    assert.deepEqual(db.getPermissions(assignedOwner.id)?.allowed_folders,
      [`${SYNTH_ROOT}/assigned`, `${SYNTH_ROOT}/other`]);
    assert.equal((await createDirectory(exactCookie, HOME, 'dshpw-wsdel-exact', 'c-mkdir')).status, 403);
    const removed = await deleteWorkspace(exactCookie, 'foreign-workspace', 'c-delete');
    assert.equal(removed.status, 502, 'unavailable Host registry cannot authorize deletion');
    assert.deepEqual(db.getPermissions(exactOwner.id)?.allowed_folders, [exactPath]);
    assert.deepEqual(db.listUserWorkspacePaths(exactOwner.id), []);
    assert.equal(workspaceSeq, 0, 'unauthorized registration never reaches the Host');
  } finally {
    gateway?.close();
    upstream?.close();
    try { db.close(); } catch { /* 已关闭 */ }
    try { rmSync(appDir, { recursive: true, force: true }); } catch { /* Windows 句柄尽力而为 */ }
  }
});
