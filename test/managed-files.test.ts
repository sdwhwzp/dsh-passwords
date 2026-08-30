import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';

import { AuthService } from '../src/auth.js';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer, type GatewayServerOptions } from '../src/gateway.js';

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json<T>(): T;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function withManagedFiles(
  run: (context: {
    root: string;
    outside: string;
    db: Database;
    userId: number;
    request(method: string, requestPath: string, body?: Buffer): Promise<TestResponse>;
    requestChunked(method: string, requestPath: string, chunks: readonly Buffer[]): Promise<TestResponse>;
  }) => Promise<void>,
  options: GatewayServerOptions = {},
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-managed-files-'));
  const dbPath = path.join(tempDir, 'data', 'platform.db');
  const rootPath = path.join(tempDir, 'managed', 'u1');
  const outsidePath = path.join(tempDir, 'outside');
  mkdirSync(path.join(rootPath, 'nested'), { recursive: true });
  mkdirSync(outsidePath, { recursive: true });
  const root = realpathSync(rootPath);
  const outside = realpathSync(outsidePath);
  writeFileSync(path.join(root, 'hello.txt'), 'hello');
  writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  if (process.platform !== 'win32') {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    symlinkSync(outside, path.join(root, 'escape-dir'), 'dir');
  }

  const config: PlatformConfig = {
    setupKey: 'test-setup-key',
    dbPath,
    database: { driver: 'sqlite', path: dbPath },
    dbEncKey: 'test-key',
    gateway: {
      host: '127.0.0.1',
      port: 0,
      upstream: 'http://127.0.0.1:9',
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
  const db = new Database(dbPath, createFieldCrypto('test-key', 'test-key'));
  db.init();
  const user = db.createUser('subuser', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setManagedWorkspace(user.id, root);
  db.setPermissions(user.id, {
    allowedFolders: [root],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    monthlyBudgetMicros: 0,
    allowUpload: true,
    allowGitDownload: false,
    banned: false,
    sandboxMode: 'workspace-write',
    disabledSessions: [],
  });
  const server = createGatewayServer(config, new AuthService(config, db), db, options);
  const port = await listen(server);
  const token = jwt.sign(
    { sub: String(user.id), username: user.username, cv: 0 },
    config.jwtSecret,
    { expiresIn: '12h' },
  );

  const request = (method: string, requestPath: string, body?: Buffer): Promise<TestResponse> =>
    new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: {
          cookie: `dsh_gateway_token=${token}`,
          ...(body === undefined ? {} : {
            'content-type': 'application/octet-stream',
            'content-length': String(body.length),
          }),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: responseBody,
            json: <T>() => JSON.parse(responseBody.toString('utf8')) as T,
          });
        });
      });
      req.on('error', reject);
      req.end(body);
    });

  const requestChunked = (
    method: string,
    requestPath: string,
    chunksToWrite: readonly Buffer[],
  ): Promise<TestResponse> => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: {
        cookie: `dsh_gateway_token=${token}`,
        'content-type': 'application/octet-stream',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: responseBody,
          json: <T>() => JSON.parse(responseBody.toString('utf8')) as T,
        });
      });
    });
    req.on('error', reject);
    for (const chunk of chunksToWrite) req.write(chunk);
    req.end();
  });

  try {
    await run({ root, outside, db, userId: user.id, request, requestChunked });
  } finally {
    await close(server);
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('subuser lists and downloads only regular files inside the private host folder', async () => {
  await withManagedFiles(async ({ root, request }) => {
    const status = await request('GET', '/gateway/api/managed-files/status');
    assert.equal(status.status, 200, status.body.toString('utf8'));
    assert.deepEqual(status.json<{ ok: boolean; available: boolean }>(), { ok: true, available: true });

    const listing = await request('GET', '/gateway/api/managed-files?path=');
    assert.equal(listing.status, 200, listing.body.toString('utf8'));
    const value = listing.json<{
      path: string;
      parent: string | null;
      entries: Array<{ name: string; path: string; kind: string }>;
    }>();
    assert.equal(value.path, '');
    assert.equal(value.parent, null);
    assert.deepEqual(value.entries.map((entry) => [entry.name, entry.path, entry.kind]), [
      ['nested', 'nested', 'directory'],
      ['hello.txt', 'hello.txt', 'file'],
    ]);
    assert.equal(listing.body.includes(Buffer.from(root)), false);

    const download = await request('GET', '/gateway/api/managed-files/download?path=hello.txt');
    assert.equal(download.status, 200);
    assert.equal(download.body.toString('utf8'), 'hello');
    assert.match(String(download.headers['content-disposition']), /hello\.txt/);

    assert.equal((await request('GET', '/gateway/api/managed-files?path=..%2Foutside')).status, 403);
    assert.equal((await request('GET', '/gateway/api/managed-files/download?path=..%2Foutside%2Fsecret.txt')).status, 403);
    if (process.platform !== 'win32') {
      assert.equal((await request('GET', '/gateway/api/managed-files/download?path=escape.txt')).status, 403);
      assert.equal((await request('GET', '/gateway/api/managed-files?path=escape-dir')).status, 403);
    }
  });
});

test('subuser uploads atomically into the selected private directory and cannot overwrite or escape', async () => {
  await withManagedFiles(async ({ root, db, userId, request }) => {
    const uploaded = Buffer.from('uploaded bytes');
    const response = await request(
      'PUT',
      '/gateway/api/managed-files/upload?path=nested&name=upload.txt',
      uploaded,
    );
    assert.equal(response.status, 201, response.body.toString('utf8'));
    assert.deepEqual(response.json<{ file: { name: string; path: string; bytes: number } }>().file, {
      name: 'upload.txt',
      path: 'nested/upload.txt',
      bytes: uploaded.length,
    });
    assert.equal(readFileSync(path.join(root, 'nested', 'upload.txt'), 'utf8'), 'uploaded bytes');

    const folderUpload = await request(
      'PUT',
      '/gateway/api/managed-files/upload?path=&relativePath=folder-a%2Fsub%2Finside.txt',
      Buffer.from('folder bytes'),
    );
    assert.equal(folderUpload.status, 201, folderUpload.body.toString('utf8'));
    assert.deepEqual(folderUpload.json<{ file: { name: string; path: string; bytes: number } }>().file, {
      name: 'inside.txt',
      path: 'folder-a/sub/inside.txt',
      bytes: 12,
    });
    assert.equal(readFileSync(path.join(root, 'folder-a', 'sub', 'inside.txt'), 'utf8'), 'folder bytes');

    const duplicate = await request(
      'PUT',
      '/gateway/api/managed-files/upload?path=nested&name=upload.txt',
      Buffer.from('replacement'),
    );
    assert.equal(duplicate.status, 409);
    assert.equal(readFileSync(path.join(root, 'nested', 'upload.txt'), 'utf8'), 'uploaded bytes');
    assert.equal((await request(
      'PUT',
      '/gateway/api/managed-files/upload?path=..%2Foutside&name=bad.txt',
      Buffer.from('bad'),
    )).status, 403);
    if (process.platform !== 'win32') {
      assert.equal((await request(
        'PUT',
        '/gateway/api/managed-files/upload?path=&relativePath=escape-dir%2Fbad.txt',
        Buffer.from('bad'),
      )).status, 403);
    }
    assert.equal((await request(
      'PUT',
      '/gateway/api/managed-files/upload?path=&name=..%2Fbad.txt',
      Buffer.from('bad'),
    )).status, 400);

    const current = db.getPermissions(userId)!;
    db.setPermissions(userId, {
      allowedFolders: current.allowed_folders,
      hourlyTokenLimit: current.hourly_token_limit,
      dailyMinutesLimit: current.daily_minutes_limit,
      monthlyBudgetMicros: current.monthly_budget_micros,
      allowUpload: false,
      allowGitDownload: current.allow_git_download,
      banned: current.banned,
      sandboxMode: current.sandbox_mode,
      disabledSessions: current.disabled_sessions,
    });
    assert.equal((await request(
      'PUT',
      '/gateway/api/managed-files/upload?path=&name=blocked.txt',
      Buffer.from('blocked'),
    )).status, 403);
  });
});

test('chunked managed uploads drain after the hard limit and leave no partial file', async () => {
  await withManagedFiles(async ({ root, requestChunked }) => {
    const [oversize, neighbor] = await Promise.all([
      requestChunked(
        'PUT',
        '/gateway/api/managed-files/upload?path=&name=too-large.bin',
        [Buffer.from('123456'), Buffer.from('789abc')],
      ),
      requestChunked(
        'PUT',
        '/gateway/api/managed-files/upload?path=&name=neighbor.bin',
        [Buffer.from('1234'), Buffer.from('5678')],
      ),
    ]);
    assert.equal(oversize.status, 413, oversize.body.toString('utf8'));
    assert.equal(oversize.json<{ code: string }>().code, 'FILE_TOO_LARGE');
    assert.equal(neighbor.status, 201, neighbor.body.toString('utf8'));
    assert.equal(readFileSync(path.join(root, 'neighbor.bin'), 'utf8'), '12345678');
    assert.equal(existsSync(path.join(root, 'too-large.bin')), false);
    assert.equal(readdirSync(root).some((name) => name.startsWith('.dsh-upload-')), false);
  }, { managedFileUploadMaxBytes: 8 });
});

test('subuser deletes files and non-empty folders without deleting the private root or escaped paths', async () => {
  await withManagedFiles(async ({ root, outside, db, userId, request }) => {
    writeFileSync(path.join(root, 'remove.txt'), 'remove me');
    mkdirSync(path.join(root, 'remove-folder', 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'remove-folder', 'nested', 'remove.txt'), 'remove me too');

    const fileResponse = await request('DELETE', '/gateway/api/managed-files?path=remove.txt');
    assert.equal(fileResponse.status, 200, fileResponse.body.toString('utf8'));
    assert.deepEqual(fileResponse.json<{ deleted: { path: string; kind: string } }>().deleted, {
      path: 'remove.txt',
      kind: 'file',
    });
    assert.equal(existsSync(path.join(root, 'remove.txt')), false);

    const folderResponse = await request('DELETE', '/gateway/api/managed-files?path=remove-folder');
    assert.equal(folderResponse.status, 200, folderResponse.body.toString('utf8'));
    assert.deepEqual(folderResponse.json<{ deleted: { path: string; kind: string } }>().deleted, {
      path: 'remove-folder',
      kind: 'directory',
    });
    assert.equal(existsSync(path.join(root, 'remove-folder')), false);

    assert.equal((await request('DELETE', '/gateway/api/managed-files?path=')).status, 403);
    assert.equal(existsSync(root), true);
    assert.equal((await request('DELETE', '/gateway/api/managed-files?path=..%2Foutside%2Fsecret.txt')).status, 403);
    assert.equal(readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
    if (process.platform !== 'win32') {
      assert.equal((await request('DELETE', '/gateway/api/managed-files?path=escape-dir')).status, 403);
      assert.equal(existsSync(outside), true);
    }

    writeFileSync(path.join(root, 'permission-blocked.txt'), 'keep');
    const current = db.getPermissions(userId)!;
    db.setPermissions(userId, {
      allowedFolders: current.allowed_folders,
      hourlyTokenLimit: current.hourly_token_limit,
      dailyMinutesLimit: current.daily_minutes_limit,
      monthlyBudgetMicros: current.monthly_budget_micros,
      allowUpload: false,
      allowGitDownload: current.allow_git_download,
      banned: current.banned,
      sandboxMode: current.sandbox_mode,
      disabledSessions: current.disabled_sessions,
    });
    assert.equal((await request('DELETE', '/gateway/api/managed-files?path=permission-blocked.txt')).status, 403);
    assert.equal(readFileSync(path.join(root, 'permission-blocked.txt'), 'utf8'), 'keep');
  });
});
