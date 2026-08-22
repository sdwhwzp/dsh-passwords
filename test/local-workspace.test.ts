import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { localWorkspacePrincipalAllowed } from '../src/local-workspace-hub.js';

interface CompanionHarness {
  child: ChildProcess;
  root: string;
  socket: WebSocket;
  server: WebSocketServer;
  temp: string;
  output(): string;
}

test('共享会话中的本机工作区工具只接受配对所有者 principal', () => {
  assert.equal(localWorkspacePrincipalAllowed(undefined, 7), false);
  assert.equal(localWorkspacePrincipalAllowed({
    source: 'other-gateway',
    id: '7',
    username: 'owner',
    role: 'user',
  }, 7), false);
  assert.equal(localWorkspacePrincipalAllowed({
    source: 'dsh-passwords',
    id: '8',
    username: 'other',
    role: 'user',
  }, 7), false);
  assert.equal(localWorkspacePrincipalAllowed({
    source: 'dsh-passwords',
    id: '7',
    username: 'owner',
    role: 'user',
  }, 7), true);
});

test('本机助手只在授权目录执行文件操作，默认拒绝 Shell', async (context) => {
  const harness = await startCompanion(false);
  context.after(() => stopCompanion(harness));

  const written = await request(harness.socket, 'write', {
    path: 'src/nested/example.txt',
    content: 'alpha\nbeta\n',
  });
  assert.equal(written.ok, true, harness.output());
  assert.equal(readFileSync(path.join(harness.root, 'src/nested/example.txt'), 'utf8'), 'alpha\nbeta\n');

  const read = await request(harness.socket, 'read', { path: 'src/nested/example.txt', offset: 2, limit: 1 });
  assert.equal(read.ok, true, harness.output());
  assert.deepEqual((read.value as { lines: unknown[] }).lines, [{ number: 2, text: 'beta' }]);

  const edited = await request(harness.socket, 'edit', {
    path: 'src/nested/example.txt',
    oldString: 'beta',
    newString: 'gamma',
  });
  assert.equal(edited.ok, true, harness.output());

  const globbed = await request(harness.socket, 'glob', { pattern: '**/*.txt' });
  assert.equal(globbed.ok, true, harness.output());
  assert.deepEqual((globbed.value as { paths: string[] }).paths, ['src/nested/example.txt']);

  const grepped = await request(harness.socket, 'grep', { pattern: 'gamma', include: '*.txt' });
  assert.equal(grepped.ok, true, harness.output());
  assert.deepEqual((grepped.value as { matches: Array<{ path: string; lineNumber: number }> }).matches, [
    { path: 'src/nested/example.txt', lineNumber: 2, line: 'gamma' },
  ]);

  const existing = path.join(harness.root, 'existing.txt');
  writeFileSync(existing, 'before');
  chmodSync(existing, 0o640);
  const replaced = await request(harness.socket, 'write', { path: 'existing.txt', content: 'after' });
  assert.equal(replaced.ok, true, harness.output());
  assert.equal(statSync(existing).mode & 0o777, 0o640);

  const escaped = await request(harness.socket, 'write', { path: '../outside.txt', content: 'blocked' });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.code, 'PATH_OUTSIDE_ROOT');

  const outside = mkdtempSync(path.join(tmpdir(), 'dsh-local-outside-'));
  context.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  symlinkSync(outside, path.join(harness.root, 'outside-link'));
  const symlinkEscape = await request(harness.socket, 'read', { path: 'outside-link/secret.txt' });
  assert.equal(symlinkEscape.ok, false);
  assert.equal(symlinkEscape.code, 'PATH_OUTSIDE_ROOT');

  const shell = await request(harness.socket, 'bash', { command: 'pwd' });
  assert.equal(shell.ok, false);
  assert.equal(shell.code, 'SHELL_DISABLED');
});

test('本机助手显式启用后在授权目录启动 Shell', async (context) => {
  const harness = await startCompanion(true);
  context.after(() => stopCompanion(harness));
  const response = await request(harness.socket, 'bash', {
    command: 'printf "%s\\n%s" "$PWD" "${DSH_LOCAL_WORKSPACE:-}"',
    timeoutMs: 5_000,
  });
  assert.equal(response.ok, true, harness.output());
  const value = response.value as { stdout: string; exitCode: number | null; timedOut: boolean };
  assert.equal(value.stdout, `${harness.root}\n1`);
  assert.equal(value.exitCode, 0);
  assert.equal(value.timedOut, false);
});

test('Windows 本机助手通过受控 Office RPC 读写 Word 且限制在授权目录', async (context) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'dsh-local-office-'));
  const fakePowerShell = path.join(fixture, 'fake-powershell');
  const requestLog = path.join(fixture, 'requests.jsonl');
  writeFileSync(fakePowerShell, `#!/usr/bin/env node
const fs = require('node:fs');
let source = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { source += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(source);
  fs.appendFileSync(process.env.DSH_TEST_OFFICE_REQUEST_LOG, JSON.stringify(request) + '\\n');
  if (request.action === 'status') {
    process.stdout.write(JSON.stringify({ ok: true, value: { platform: 'win32', office: true, wps: true, preferred: 'office' } }));
    return;
  }
  if (request.action === 'read_word') {
    process.stdout.write(JSON.stringify({ ok: true, value: {
      provider: 'office', progId: 'Word.Application', text: '测试内容', truncated: false,
      paragraphCount: 1, tableCount: 0, paragraphs: [{ index: 1, text: '测试内容' }], tables: [],
    } }));
    return;
  }
  if (request.create) fs.writeFileSync(request.workPath, 'fake-docx');
  for (const operation of request.operations) {
    if (operation.type === 'export_pdf') fs.writeFileSync(operation.outputPath, 'fake-pdf');
  }
  process.stdout.write(JSON.stringify({ ok: true, value: {
    provider: 'office', progId: 'Word.Application', created: request.create, operationsApplied: request.operations.length,
  } }));
});
`);
  chmodSync(fakePowerShell, 0o755);
  const harness = await startCompanion(false, false, {
    DSH_LOCAL_WORKSPACE_TEST_WINDOWS: '1',
    DSH_LOCAL_WORKSPACE_TEST_POWERSHELL: fakePowerShell,
    DSH_TEST_OFFICE_REQUEST_LOG: requestLog,
  });
  context.after(async () => {
    await stopCompanion(harness);
    rmSync(fixture, { recursive: true, force: true });
  });

  const status = await request(harness.socket, 'office', { action: 'status' });
  assert.equal(status.ok, true, harness.output());
  assert.deepEqual(status.value, { platform: 'win32', office: true, wps: true, preferred: 'office' });

  const created = await request(harness.socket, 'office', {
    action: 'edit_word',
    path: '报告.docx',
    create: true,
    operations: [
      { type: 'append_paragraph', text: '含有 \" 和 $() 的安全文本', style: 'Title' },
      { type: 'set_header', text: '山东梯智物联有限公司' },
      { type: 'export_pdf', outputPath: '导出/报告.pdf' },
    ],
  });
  assert.equal(created.ok, true, harness.output());
  assert.equal(readFileSync(path.join(harness.root, '报告.docx'), 'utf8'), 'fake-docx');
  assert.equal(readFileSync(path.join(harness.root, '导出/报告.pdf'), 'utf8'), 'fake-pdf');
  assert.deepEqual((created.value as { pdfPaths: string[] }).pdfPaths, ['导出/报告.pdf']);

  const read = await request(harness.socket, 'office', { action: 'read_word', path: '报告.docx' });
  assert.equal(read.ok, true, harness.output());
  assert.equal((read.value as { text: string }).text, '测试内容');

  const escaped = await request(harness.socket, 'office', {
    action: 'edit_word',
    path: '../越界.docx',
    create: true,
    operations: [{ type: 'append_paragraph', text: 'blocked' }],
  });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.code, 'PATH_OUTSIDE_ROOT');

  const logged = readFileSync(requestLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const editRequest = logged.find((value) => value.action === 'edit_word') as { operations: Array<Record<string, unknown>> } | undefined;
  assert.equal(editRequest?.operations[0]?.text, '含有 \" 和 $() 的安全文本');
  assert.equal(path.isAbsolute(String(editRequest?.operations[2]?.outputPath)), true);
});

test('Windows 双击模式可解析网页配对命令并保存配置', async (context) => {
  const harness = await startCompanion(false, true);
  context.after(() => stopCompanion(harness));
  assert.match(harness.output(), /山东梯智物联AI/);
  const config = JSON.parse(readFileSync(path.join(harness.temp, '.dsh-local-workspace/config.json'), 'utf8')) as {
    server: string;
    root: string;
    token: string;
  };
  assert.equal(config.root, harness.root);
  assert.equal(config.token, 't'.repeat(43));
  assert.match(config.server, /^ws:\/\/127\.0\.0\.1:/);
});

test('本机工作区令牌、所有权与撤销持久化', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-local-db-'));
  const dbPath = path.join(temp, 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('db-key', 'setup-key'));
  try {
    db.init();
    const owner = db.createUser('owner', 'hash', 'admin');
    const other = db.createUser('other', 'hash', 'user');
    const token = 'local-workspace-token-value-1234567890';
    const placeholder = path.join(temp, 'local-workspaces', 'owner', 'workspace');
    const workspace = db.createLocalWorkspace({
      id: 'workspace-id-1234',
      userId: owner.id,
      token,
      deviceName: 'owner-laptop',
      workspaceName: 'private-project',
      remoteRoot: '/Users/owner/private-project',
      placeholderPath: placeholder,
      platform: 'darwin',
      shellEnabled: false,
    });

    assert.equal(workspace.user_id, owner.id);
    assert.equal(db.authenticateLocalWorkspace(token)?.id, workspace.id);
    assert.equal(db.authenticateLocalWorkspace(token + '-wrong'), null);
    assert.equal(db.localWorkspaceOwnerForPath(path.join(placeholder, 'src')), owner.id);
    assert.equal(db.localWorkspacePathAllowed(owner.id, placeholder), true);
    assert.equal(db.localWorkspacePathAllowed(other.id, placeholder), false);
    assert.equal(db.localWorkspaceOwnerForPath(path.join(temp, 'ordinary-host-folder')), null);
    assert.equal(db.revokeLocalWorkspace(other.id, workspace.id), false);
    assert.equal(db.revokeLocalWorkspace(owner.id, workspace.id), true);
    assert.equal(db.authenticateLocalWorkspace(token), null);
    assert.equal(db.listLocalWorkspacesForUser(owner.id).length, 0);

    const raw = readFileSync(dbPath);
    assert.equal(raw.includes(Buffer.from(token)), false);
    assert.equal(raw.includes(Buffer.from('private-project')), false);
    assert.equal(raw.includes(Buffer.from('/Users/owner/private-project')), false);
  } finally {
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

async function startCompanion(
  allowShell: boolean,
  interactive = false,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CompanionHarness> {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-local-companion-'));
  const rootInput = path.join(temp, 'workspace');
  const config = interactive ? path.join(temp, '.dsh-local-workspace', 'config.json') : path.join(temp, 'config.json');
  mkdirSync(rootInput);
  const root = realpathSync(rootInput);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('WebSocket server did not expose a TCP port');
  const pairCode = 'p'.repeat(43);
  let stdout = '';
  let stderr = '';
  let wizardStep = 0;
  let markConnected: (() => void) | undefined;
  const connected = new Promise<void>((resolve) => { markConnected = resolve; });
  const child = spawn(
    process.execPath,
    interactive ? [
      '--import',
      'tsx',
      'src/local-workspace-cli.ts',
    ] : [
      '--import',
      'tsx',
      'src/local-workspace-cli.ts',
      '--server',
      `ws://127.0.0.1:${String(address.port)}`,
      '--pair',
      pairCode,
      '--folder',
      root,
      '--config',
      config,
      ...(allowShell ? ['--allow-shell'] : []),
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(interactive ? {
          HOME: temp,
          USERPROFILE: temp,
          DSH_LOCAL_WORKSPACE_FORCE_WIZARD: '1',
        } : {}),
        ...extraEnv,
      },
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (stdout.includes('已连接')) markConnected?.();
    if (!interactive) return;
    if (wizardStep === 0 && stdout.includes('完整配对命令')) {
      wizardStep = 1;
      child.stdin?.write(
        `dsh-local-workspace --server "ws://127.0.0.1:${String(address.port)}" --pair "${pairCode}" --folder "replace"\n`,
      );
    } else if (wizardStep === 1 && stdout.includes('输入或拖入要授权的本机文件夹')) {
      wizardStep = 2;
      child.stdin?.write(`${root}\n`);
    } else if (wizardStep === 2 && stdout.includes('允许 AI 在本机执行')) {
      wizardStep = 3;
      child.stdin?.write('n\n');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  try {
    const socket = await withTimeout(new Promise<WebSocket>((resolve, reject) => {
      child.once('exit', (code, signal) => reject(new Error(`companion exited before pairing (${String(code)}/${String(signal)}): ${stderr}`)));
      server.once('connection', (connection) => {
        connection.once('message', (raw) => {
          try {
            const hello = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
            assert.equal(hello.type, 'pair');
            assert.equal(hello.code, pairCode);
            assert.equal(hello.root, root);
            assert.equal(hello.shellEnabled, allowShell);
            connection.send(JSON.stringify({
              type: 'ready',
              workspaceId: hello.workspaceId,
              workspacePath: '/host/placeholder',
              token: 't'.repeat(43),
            }));
            if (interactive) void connected.then(() => resolve(connection), reject);
            else resolve(connection);
          } catch (error) {
            reject(error);
          }
        });
      });
    }), 10_000, 'companion pairing timed out');
    return { child, root, socket, server, temp, output: () => stdout + stderr };
  } catch (error) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

async function stopCompanion(harness: CompanionHarness): Promise<void> {
  harness.socket.terminate();
  harness.child.kill('SIGTERM');
  if (harness.child.exitCode === null && harness.child.signalCode === null) {
    await withTimeout(once(harness.child, 'exit').then(() => undefined), 5_000, 'companion did not stop').catch(() => {
      harness.child.kill('SIGKILL');
    });
  }
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  rmSync(harness.temp, { recursive: true, force: true });
}

let requestSequence = 0;

function request(
  socket: WebSocket,
  operation: 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'bash' | 'office',
  args: Record<string, unknown>,
): Promise<{ ok: boolean; value?: unknown; code?: string; error?: string }> {
  const id = `request-${String(++requestSequence)}`;
  return withTimeout(new Promise((resolve, reject) => {
    const onMessage = (raw: Buffer) => {
      try {
        const response = JSON.parse(raw.toString('utf8')) as {
          type?: string;
          id?: string;
          ok: boolean;
          value?: unknown;
          code?: string;
          error?: string;
        };
        if (response.type !== 'response' || response.id !== id) return;
        socket.off('message', onMessage);
        resolve(response);
      } catch (error) {
        socket.off('message', onMessage);
        reject(error);
      }
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'request', id, operation, args }));
  }), 10_000, `${operation} request timed out`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
