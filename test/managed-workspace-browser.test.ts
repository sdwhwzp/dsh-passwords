import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import jwt from 'jsonwebtoken';

import { createGatewayServer } from '../src/gateway.js';
import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import type { PlatformConfig } from '../src/config.js';

interface GatewayResponse {
  status: number;
  body: unknown;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function rpcResponse(rpcId: string, value: unknown): string {
  return JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: true, value },
  });
}

async function runScenario(
  run: (scenario: {
    root: string;
    child: string;
    outside: string;
    shared: string;
    escapedLink: string | null;
    upstreamCalls: Array<{ method: string; payload: Record<string, unknown> }>;
    request(method: string, payload: Record<string, unknown>): Promise<GatewayResponse>;
  }) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-managed-browser-'));
  const rootPath = path.join(tempDir, 'managed', 'u2');
  const outsidePath = path.join(tempDir, 'outside');
  const sharedPath = path.join(tempDir, 'shared');
  mkdirSync(path.join(rootPath, 'projects'), { recursive: true });
  mkdirSync(outsidePath, { recursive: true });
  mkdirSync(sharedPath, { recursive: true });
  const root = realpathSync(rootPath);
  const child = path.join(root, 'projects');
  const outside = realpathSync(outsidePath);
  const shared = realpathSync(sharedPath);
  const escapedLink = process.platform === 'win32' ? null : path.join(root, 'escaped-link');
  if (escapedLink !== null) symlinkSync(outside, escapedLink, 'dir');

  const dbPath = path.join(tempDir, 'data', 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('test-key', 'test-key'));
  db.init();
  const user = db.createUser('subuser', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setManagedWorkspace(user.id, root);
  db.setPermissions(user.id, {
    allowedFolders: [root, shared],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    monthlyBudgetMicros: 0,
    allowUpload: true,
    allowGitDownload: false,
    banned: false,
    sandboxMode: 'workspace-write',
    disabledSessions: [],
  });

  const upstreamCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let createdWorkspacePath: string | null = null;
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        rpcId: string;
        method: string;
        payload: Record<string, unknown>;
      };
      upstreamCalls.push({ method: envelope.method, payload: envelope.payload });

      if (envelope.method === 'host.listDirectory') {
        const listed = String(envelope.payload.path);
        const entries = readdirSync(listed, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => ({ name: entry.name, path: path.join(listed, entry.name), hidden: false }));
        const crumbs = listed === root
          ? [
              { name: path.parse(root).root, path: path.parse(root).root, hidden: false },
              { name: path.basename(root), path: root, hidden: false },
            ]
          : [
              { name: path.parse(root).root, path: path.parse(root).root, hidden: false },
              { name: path.basename(root), path: root, hidden: false },
              { name: path.basename(listed), path: listed, hidden: false },
            ];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(rpcResponse(envelope.rpcId, {
          path: listed,
          home: os.homedir(),
          crumbs,
          entries,
          truncated: false,
        }));
        return;
      }

      if (envelope.method === 'host.createDirectory') {
        const created = path.join(String(envelope.payload.path), String(envelope.payload.name));
        mkdirSync(created);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(rpcResponse(envelope.rpcId, { path: created }));
        return;
      }

      if (envelope.method === 'workspace.create') {
        const workspacePath = String(envelope.payload.path);
        createdWorkspacePath = workspacePath;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(rpcResponse(envelope.rpcId, {
          workspace: {
            workspaceId: 'workspace-created',
            path: workspacePath,
            title: path.basename(workspacePath),
            sessionIds: [],
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
          created: true,
        }));
        return;
      }

      if (envelope.method === 'workspace.list') {
        const workspaces = [
          ...(createdWorkspacePath === null ? [] : [{
            workspaceId: 'workspace-created',
            path: createdWorkspacePath,
            title: path.basename(createdWorkspacePath),
            sessionIds: [],
          }]),
          {
            workspaceId: 'workspace-outside',
            path: outside,
            title: path.basename(outside),
            sessionIds: [],
          },
          {
            workspaceId: 'workspace-shared',
            path: shared,
            title: path.basename(shared),
            sessionIds: [],
          },
        ];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(rpcResponse(envelope.rpcId, { workspaces, archivedSessionIds: [] }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(rpcResponse(envelope.rpcId, { deleted: true }));
    });
  });
  const upstreamPort = await listen(upstream);

  const config: PlatformConfig = {
    setupKey: 'test-setup-key',
    dbPath,
    dbEncKey: 'test-key',
    gateway: {
      host: '127.0.0.1',
      port: 0,
      upstream: `http://127.0.0.1:${String(upstreamPort)}`,
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
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: path.join(path.dirname(root), 'local') },
    managedWorkspaceRoot: path.dirname(root),
    patch: { dshRoot: '', restartService: '' },
  };
  const gateway = createGatewayServer(config, new AuthService(config, db), db);
  const gatewayPort = await listen(gateway);
  const token = jwt.sign(
    { sub: String(user.id), username: user.username, cv: 0 },
    config.jwtSecret,
    { expiresIn: '12h' },
  );

  const request = (method: string, payload: Record<string, unknown>): Promise<GatewayResponse> =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({
        type: 'client-request',
        rpcId: `${method}-${String(Math.random())}`,
        method,
        payload,
      });
      const req = http.request(
        {
          host: '127.0.0.1',
          port: gatewayPort,
          method: 'POST',
          path: `/api/${method}`,
          headers: {
            cookie: `dsh_gateway_token=${token}`,
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body)),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try { parsed = JSON.parse(text); } catch { /* HTML denial stays text. */ }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  try {
    await run({ root, child, outside, shared, escapedLink, upstreamCalls, request });
  } finally {
    await close(gateway);
    await close(upstream);
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('directory picker opens at the private root and hides host ancestors and escaping symlinks', async () => {
  await runScenario(async ({ root, escapedLink, upstreamCalls, request }) => {
    const response = await request('host.listDirectory', {});

    assert.equal(response.status, 200, String(response.body));
    assert.equal(upstreamCalls[0]?.payload.path, root);
    const listing = (response.body as {
      result: { value: { home: string; path: string; crumbs: Array<{ name: string; path: string }>; entries: Array<{ path: string }> } };
    }).result.value;
    assert.equal(listing.home, root);
    assert.equal(listing.path, root);
    assert.deepEqual(listing.crumbs, [{ name: 'subuser · 专属工作区', path: root, hidden: false }]);
    assert.ok(listing.entries.some((entry) => entry.path === path.join(root, 'projects')));
    if (escapedLink !== null) assert.ok(!listing.entries.some((entry) => entry.path === escapedLink));
  });
});

test('subuser can create, adopt, and remove a private workspace registration but cannot leave the private root', async () => {
  await runScenario(async ({ root, outside, escapedLink, upstreamCalls, request }) => {
    const created = await request('host.createDirectory', { path: root, name: 'fresh' });
    assert.equal(created.status, 200, String(created.body));
    const fresh = path.join(root, 'fresh');
    assert.equal(existsSync(fresh), true);

    const adopted = await request('workspace.create', { path: fresh });
    assert.equal(adopted.status, 200);
    assert.equal(upstreamCalls.at(-1)?.payload.path, fresh);

    const callsBeforeDenials = upstreamCalls.length;
    assert.equal((await request('host.listDirectory', { path: outside })).status, 403);
    assert.equal((await request('host.createDirectory', { path: outside, name: 'blocked' })).status, 403);
    assert.equal((await request('workspace.create', { path: outside })).status, 403);
    assert.equal((await request('session.create', { cwd: outside })).status, 403);
    assert.equal((await request('host.createDirectory', { path: root, name: '../blocked' })).status, 403);
    if (escapedLink !== null) {
      assert.equal((await request('host.listDirectory', { path: escapedLink })).status, 403);
      assert.equal((await request('host.createDirectory', { path: escapedLink, name: 'blocked' })).status, 403);
      assert.equal((await request('workspace.create', { path: escapedLink })).status, 403);
      assert.equal((await request('session.create', { cwd: escapedLink })).status, 403);
    }
    assert.equal(upstreamCalls.length, callsBeforeDenials);

    const deleted = await request('workspace.delete', { workspaceId: 'workspace-created' });
    assert.equal(deleted.status, 200, String(deleted.body));
    assert.equal(upstreamCalls.filter((call) => call.method === 'workspace.delete').length, 1);

    const deleteCallsBeforeOutside = upstreamCalls.filter((call) => call.method === 'workspace.delete').length;
    assert.equal((await request('workspace.delete', { workspaceId: 'workspace-outside' })).status, 403);
    assert.equal((await request('workspace.delete', { workspaceId: 'workspace-shared' })).status, 403);
    assert.equal(
      upstreamCalls.filter((call) => call.method === 'workspace.delete').length,
      deleteCallsBeforeOutside,
    );
  });
});
