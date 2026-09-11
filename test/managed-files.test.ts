import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
    requestJson(method: string, requestPath: string, body: unknown): Promise<TestResponse>;
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

  const requestJson = (method: string, requestPath: string, body: unknown): Promise<TestResponse> =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const req = http.request({
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: {
          cookie: `dsh_gateway_token=${token}`,
          'content-type': 'application/json',
          'content-length': String(payload.length),
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
      req.end(payload);
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
    await run({ root, outside, db, userId: user.id, request, requestJson, requestChunked });
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

test('subuser creates, moves and copies inside the private host folder', async () => {
  await withManagedFiles(async ({ root, requestJson }) => {
    const created = await requestJson('POST', '/gateway/api/managed-files/directory', { path: '', name: 'docs' });
    assert.equal(created.status, 201);
    assert.equal(created.json<{ directory: { path: string } }>().directory.path, 'docs');
    assert.ok(existsSync(path.join(root, 'docs')));

    const duplicate = await requestJson('POST', '/gateway/api/managed-files/directory', { path: '', name: 'docs' });
    assert.equal(duplicate.status, 409);

    for (const name of ['..', '../escape', 'nested/deeper', '/absolute', '']) {
      const rejected = await requestJson('POST', '/gateway/api/managed-files/directory', { path: '', name });
      assert.equal(rejected.status, 400, `文件夹名 ${name} 必须被拒绝`);
    }

    const moved = await requestJson('POST', '/gateway/api/managed-files/move', { from: 'hello.txt', toDirectory: 'docs' });
    assert.equal(moved.status, 200);
    assert.ok(!existsSync(path.join(root, 'hello.txt')));
    assert.equal(readFileSync(path.join(root, 'docs', 'hello.txt'), 'utf8'), 'hello');

    const copied = await requestJson('POST', '/gateway/api/managed-files/copy', {
      from: 'docs',
      toDirectory: '',
      name: 'docs-copy',
    });
    assert.equal(copied.status, 200);
    assert.equal(readFileSync(path.join(root, 'docs-copy', 'hello.txt'), 'utf8'), 'hello');
    assert.equal(readFileSync(path.join(root, 'docs', 'hello.txt'), 'utf8'), 'hello');

    const intoItself = await requestJson('POST', '/gateway/api/managed-files/move', { from: 'docs', toDirectory: 'docs' });
    assert.equal(intoItself.status, 400);

    const overwrite = await requestJson('POST', '/gateway/api/managed-files/copy', {
      from: 'docs',
      toDirectory: '',
      name: 'docs-copy',
    });
    assert.equal(overwrite.status, 409);
  });
});

test('managed move and copy stay inside the private host folder', async () => {
  await withManagedFiles(async ({ root, outside, requestJson }) => {
    const escapeDestination = await requestJson('POST', '/gateway/api/managed-files/move', {
      from: 'hello.txt',
      toDirectory: '../outside',
    });
    assert.equal(escapeDestination.status, 403);
    assert.ok(!existsSync(path.join(outside, 'hello.txt')));

    const missingSource = await requestJson('POST', '/gateway/api/managed-files/copy', {
      from: 'absent.txt',
      toDirectory: '',
      name: 'copy.txt',
    });
    assert.equal(missingSource.status, 404);

    const rootSource = await requestJson('POST', '/gateway/api/managed-files/move', { from: '', toDirectory: 'nested' });
    assert.equal(rootSource.status, 403);

    if (process.platform !== 'win32') {
      const symlinkSource = await requestJson('POST', '/gateway/api/managed-files/copy', {
        from: 'escape.txt',
        toDirectory: '',
        name: 'leak.txt',
      });
      assert.equal(symlinkSource.status, 403);
      assert.ok(!existsSync(path.join(root, 'leak.txt')));
    }
  });
});

test('managed git refuses unauthorized accounts, unusable URLs and directories without a repository', async () => {
  await withManagedFiles(async ({ db, userId, requestJson }) => {
    const permissions = {
      allowedFolders: [] as string[],
      hourlyTokenLimit: null,
      dailyMinutesLimit: null,
      monthlyBudgetMicros: 0,
      allowUpload: true,
      allowGitDownload: false,
      banned: false,
      sandboxMode: 'workspace-write',
      disabledSessions: [] as string[],
    };
    const denied = await requestJson('POST', '/gateway/api/managed-files/git/clone', {
      path: '',
      url: 'https://example.test/team/repo.git',
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json<{ code: string }>().code, 'NO_GIT');

    db.setPermissions(userId, { ...permissions, allowGitDownload: true });

    for (const url of [
      'ext::sh -c whoami',
      'file:///etc/passwd',
      'ssh://git@example.test/repo.git',
      'git://example.test/repo.git',
      'https://example.test/repo.git\nhttps://evil.test',
      'not-a-url',
      '',
    ]) {
      const rejected = await requestJson('POST', '/gateway/api/managed-files/git/clone', { path: '', url });
      assert.equal(rejected.status, 400, `仓库地址 ${JSON.stringify(url)} 必须被拒绝`);
      assert.equal(rejected.json<{ code: string }>().code, 'INVALID_GIT_URL');
    }

    const badDirectory = await requestJson('POST', '/gateway/api/managed-files/git/clone', {
      path: '',
      url: 'https://example.test/team/repo.git',
      directory: '../escape',
    });
    assert.equal(badDirectory.status, 400);

    const notRepository = await requestJson('POST', '/gateway/api/managed-files/git/pull', { path: '' });
    assert.equal(notRepository.status, 400);
    assert.equal(notRepository.json<{ code: string }>().code, 'NOT_REPOSITORY');
  });
});

test('managed listing reports the repository branch of the current directory', async () => {
  await withManagedFiles(async ({ root, request }) => {
    mkdirSync(path.join(root, 'nested', '.git'), { recursive: true });
    writeFileSync(path.join(root, 'nested', '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const plain = await request('GET', '/gateway/api/managed-files?path=');
    assert.deepEqual(plain.json<{ git: unknown }>().git, { repository: false, branch: null });

    const repository = await request('GET', '/gateway/api/managed-files?path=nested');
    assert.deepEqual(repository.json<{ git: unknown }>().git, { repository: true, branch: 'main' });
  });
});

for (const privateRepository of [false, true]) test(`managed git clone and pull with ${privateRepository ? 'temporary credentials' : 'anonymous access'}`, async (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('本机没有 git');
    return;
  }
  const originDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-git-origin-'));
  let fixtureServer: http.Server | undefined;
  t.after(async () => {
    try { if (fixtureServer?.listening) await close(fixtureServer); }
    finally { rmSync(originDir, { recursive: true, force: true }); }
  });
  const credentials = { username: 'fixture-user', password: 'fixture-secret:@ token' };
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  let redirectedRequests = 0;
  const workTree = path.join(originDir, 'work');
  mkdirSync(workTree, { recursive: true });
  const git = (args: readonly string[], cwd: string) => execFileSync('git', [
    '-c', 'user.email=fixture@example.test',
    '-c', 'user.name=fixture',
    '-c', 'init.defaultBranch=main',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, stdio: 'ignore' });
  git(['init'], workTree);
  writeFileSync(path.join(workTree, 'README.md'), 'origin\n');
  git(['add', 'README.md'], workTree);
  git(['commit', '-m', 'init'], workTree);
  git(['clone', '--bare', workTree, 'origin.git'], originDir);
  git(['repack', '-a', '-d'], path.join(originDir, 'origin.git'));
  git(['update-server-info'], path.join(originDir, 'origin.git'));

  // 哑 HTTP 服务：静态返回裸仓库文件，git 在智能协议探测失败后回退到 dumb http
  const originServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/redirect.git')) {
      res.writeHead(302, { location: `http://localhost:${originPort}/leak.git/info/refs` }).end();
      return;
    }
    if (req.url?.startsWith('/leak.git')) { redirectedRequests++; res.writeHead(500).end(); return; }
    if (privateRepository && req.headers.authorization !== authorization) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm=fixture' }).end('authentication required');
      return;
    }
    const requested = path.join(originDir, path.normalize(decodeURIComponent((req.url ?? '/').split('?')[0])));
    if (!requested.startsWith(originDir) || !existsSync(requested) || !statSync(requested).isFile()) {
      res.writeHead(404).end('missing');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    createReadStream(requested).pipe(res);
  });
  fixtureServer = originServer;
  const originPort = await listen(originServer);

  await withManagedFiles(async ({ root, db, userId, requestJson }) => {
      db.setPermissions(userId, {
        allowedFolders: [],
        hourlyTokenLimit: null,
        dailyMinutesLimit: null,
        monthlyBudgetMicros: 0,
        allowUpload: true,
        allowGitDownload: true,
        banned: false,
        sandboxMode: 'workspace-write',
        disabledSessions: [],
      });
      const url = `http://127.0.0.1:${String(originPort)}/origin.git`;
      if (privateRepository) {
        const denied = await requestJson('POST', '/gateway/api/managed-files/git/clone', { url, directory: 'denied' });
        assert.equal(denied.status, 502);
        assert.equal(existsSync(path.join(root, 'denied')), false);
        const malformed = await requestJson('POST', '/gateway/api/managed-files/git/clone', { url, username: 'user' });
        assert.equal(malformed.status, 400);
      }
      const cloned = await requestJson('POST', '/gateway/api/managed-files/git/clone', {
        ...(privateRepository ? credentials : {}),
        path: 'nested',
        url: `http://127.0.0.1:${String(originPort)}/origin.git`,
      });
      assert.equal(cloned.status, 201, cloned.body.toString('utf8'));
      assert.equal(cloned.json<{ directory: { path: string } }>().directory.path, 'nested/origin');
      assert.equal(readFileSync(path.join(root, 'nested', 'origin', 'README.md'), 'utf8'), 'origin\n');

      const listed = await requestJson('GET', '/gateway/api/managed-files?path=nested/origin', {});
      assert.equal(listed.json<{ git: { repository: boolean } }>().git.repository, true);

      const clonePath = path.join(root, 'nested', 'origin');
      assert.equal(execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: clonePath, encoding: 'utf8' }).trim(), url);
      const configBefore = readFileSync(path.join(clonePath, '.git', 'config'), 'utf8');
      assert.doesNotMatch(configBefore, /fixture-secret|extraHeader|Authorization/);
      git(['remote', 'rename', 'origin', 'team'], clonePath);
      writeFileSync(path.join(workTree, 'README.md'), 'updated\n');
      git(['commit', '-am', 'update'], workTree);
      git(['push', path.join(originDir, 'origin.git'), 'main'], workTree);
      git(['update-server-info'], path.join(originDir, 'origin.git'));
      if (privateRepository) {
        assert.equal((await requestJson('POST', '/gateway/api/managed-files/git/pull', { path: 'nested/origin' })).status, 502);
        assert.equal((await requestJson('POST', '/gateway/api/managed-files/git/pull', { path: 'nested/origin', ...credentials, password: 'wrong' })).status, 502);
      }
      const pulled = await requestJson('POST', '/gateway/api/managed-files/git/pull', { path: 'nested/origin', ...(privateRepository ? credentials : {}) });
      assert.equal(pulled.status, 200, pulled.body.toString('utf8'));
      assert.equal(readFileSync(path.join(clonePath, 'README.md'), 'utf8'), 'updated\n');
      if (privateRepository) {
        const embedded = new URL(url); embedded.username = credentials.username; embedded.password = credentials.password;
        const legacy = await requestJson('POST', '/gateway/api/managed-files/git/clone', { url: embedded.toString(), directory: 'legacy' });
        assert.equal(legacy.status, 201, legacy.body.toString());
        assert.equal(execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: path.join(root, 'legacy'), encoding: 'utf8' }).trim(), url);
        const redirect = await requestJson('POST', '/gateway/api/managed-files/git/clone', { url: url.replace('/origin.git', '/redirect.git'), ...credentials });
        assert.equal(redirect.status, 502); assert.equal(redirectedRequests, 0);
        assert.equal((await requestJson('POST', '/gateway/api/managed-files/git/pull', { path: 'nested/origin' })).status, 502);
        const serialized = JSON.stringify(db.listAuditLogs(100)) + cloned.body.toString() + pulled.body.toString();
        for (const secret of [credentials.password, encodeURIComponent(credentials.password), authorization.slice(6)]) assert.equal(serialized.includes(secret), false);
      }
  });
});
