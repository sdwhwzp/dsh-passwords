import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

const projectRoot = path.resolve(import.meta.dirname, '..');

test('无 token/--pair 时显示 6 位码，网页批准后只保存高熵设备令牌，并可 resume', async (context) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-local-device-code-'));
  const root = path.join(temp, 'workspace');
  const config = path.join(temp, 'device.json');
  mkdirSync(root);
  const resolvedRoot = realpathSync(root);

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(server, 'listening');
  const children: ChildProcess[] = [];
  context.after(async () => {
    for (const child of children) await stopCli(child);
    await closeServer(server);
    rmSync(temp, { recursive: true, force: true });
  });
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('WebSocket server did not expose a TCP port');
  const url = `ws://127.0.0.1:${String(address.port)}`;
  const token = 'T'.repeat(43);

  const firstHello = nextHello(server);
  const first = startCli(['--server', url, '--folder', root, '--config', config]);
  children.push(first.child);
  const { socket: firstSocket, hello: deviceHello } = await firstHello;
  assert.equal(deviceHello.type, 'device');
  assert.equal(deviceHello.code, undefined, 'device hello 不得夹带旧配对 secret');
  assert.equal(deviceHello.token, undefined, 'device hello 不得夹带设备 token');
  assert.equal(deviceHello.root, resolvedRoot);

  firstSocket.send(JSON.stringify({
    type: 'device-code',
    code: '123 456',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  }));
  await waitUntil(
    () => first.output().includes('正在等待网页确认'),
    5_000,
    '设备确认提示未完整显示',
  );
  assert.match(first.output(), /设置 → 插件 → 本机工作区/);
  assert.match(first.output(), /正在等待网页确认/);
  assert.equal(existsSync(config), false, '6 位用户码绝不能作为设备凭据落盘');

  firstSocket.send(JSON.stringify({
    type: 'ready',
    workspaceId: deviceHello.workspaceId,
    workspacePath: '/host/placeholder',
    token,
  }));
  await waitUntil(() => first.output().includes('已连接'), 5_000, '设备批准后未连接');
  const saved = JSON.parse(readFileSync(config, 'utf8')) as { token?: string; server?: string; root?: string };
  assert.equal(saved.token, token);
  assert.equal(saved.server, `${url}/`);
  assert.equal(saved.root, resolvedRoot);
  assert.doesNotMatch(readFileSync(config, 'utf8'), /123 456|123456/);

  firstSocket.terminate();
  await stopCli(first.child);

  const resumedHello = nextHello(server);
  const resumed = startCli(['--config', config]);
  children.push(resumed.child);
  const { socket: resumedSocket, hello: resumeHello } = await resumedHello;
  assert.equal(resumeHello.type, 'resume');
  assert.equal(resumeHello.token, token);
  resumedSocket.send(JSON.stringify({
    type: 'ready',
    workspaceId: resumeHello.workspaceId,
    workspacePath: '/host/placeholder',
  }));
  await waitUntil(() => resumed.output().includes('已连接'), 5_000, 'token resume 未连接');
  resumedSocket.terminate();
});

test('Windows --setup 备用向导只询问服务器、目录和 Shell，并进入设备确认流程', async (context) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-local-device-wizard-'));
  const root = path.join(temp, 'workspace');
  mkdirSync(root);

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('WebSocket server did not expose a TCP port');

  const pendingHello = nextHello(server);
  const cli = startCli(['--setup'], {
    HOME: temp,
    USERPROFILE: temp,
    DSH_LOCAL_WORKSPACE_FORCE_WIZARD: '1',
  });
  context.after(async () => {
    await stopCli(cli.child);
    await closeServer(server);
    rmSync(temp, { recursive: true, force: true });
  });
  let step = 0;
  const answerWizard = () => {
    const output = cli.output();
    if (step === 0 && output.includes('输入服务器 ws://')) {
      step = 1;
      cli.child.stdin?.write(`ws://127.0.0.1:${String(address.port)}\n`);
    } else if (step === 1 && output.includes('输入或拖入要授权的本机文件夹')) {
      step = 2;
      cli.child.stdin?.write(`${root}\n`);
    } else if (step === 2 && output.includes('允许 AI 在本机执行')) {
      step = 3;
      cli.child.stdin?.write('n\n');
    }
  };
  cli.child.stdout?.on('data', answerWizard);
  answerWizard();

  const { socket, hello } = await pendingHello;
  assert.equal(step, 3);
  assert.equal(hello.type, 'device');
  socket.send(JSON.stringify({
    type: 'device-code',
    code: '654 321',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  }));
  await waitUntil(() => cli.output().includes('654 321'), 5_000, '向导没有显示设备码');
  socket.send(JSON.stringify({
    type: 'ready',
    workspaceId: hello.workspaceId,
    workspacePath: '/host/placeholder',
    token: 'W'.repeat(43),
  }));
  await waitUntil(() => cli.output().includes('已连接'), 5_000, '向导批准后未连接');
  assert.doesNotMatch(cli.output(), /粘贴网页生成的完整配对命令（或配对码）/);
  socket.terminate();
});

test('Windows 网页 URI 自动启用 Shell、兼容规范化尾斜杠并使用独立 profile', async (context) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-local-launch-uri-'));
  const selectedRoot = path.join(temp, 'selected workspace');
  const oldRoot = path.join(temp, 'old workspace');
  const fakeBin = path.join(temp, 'bin');
  const regLog = path.join(temp, 'registry.log');
  const powershellLog = path.join(temp, 'powershell.log');
  const defaultConfig = path.join(temp, '.dsh-local-workspace', 'config.json');
  mkdirSync(selectedRoot);
  mkdirSync(oldRoot);
  mkdirSync(fakeBin);
  mkdirSync(path.dirname(defaultConfig));
  createWindowsCommandShims(fakeBin);

  const oldConfig = JSON.stringify({
    server: 'ws://127.0.0.1:9/',
    token: 'O'.repeat(43),
    workspaceId: 'old-workspace-identity',
    deviceName: 'old-device',
    workspaceName: 'old-workspace',
    root: realpathSync(oldRoot),
    shellEnabled: true,
  }, null, 2) + '\n';
  writeFileSync(defaultConfig, oldConfig);

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('WebSocket server did not expose a TCP port');
  const serverUrl = `ws://127.0.0.1:${String(address.port)}`;
  const ticket = 'L'.repeat(43);
  const uri = new URL('dsh-local-workspace://connect/');
  uri.searchParams.set('server', serverUrl);
  uri.searchParams.set('ticket', ticket);
  const env = {
    HOME: temp,
    USERPROFILE: temp,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    DSH_LOCAL_WORKSPACE_TEST_WINDOWS: '1',
    DSH_TEST_SELECTED_FOLDER: selectedRoot,
    DSH_TEST_REG_LOG: regLog,
    DSH_TEST_POWERSHELL_LOG: powershellLog,
  };
  const children: ChildProcess[] = [];
  context.after(async () => {
    for (const child of children) await stopCli(child);
    await closeServer(server);
    rmSync(temp, { recursive: true, force: true });
  });

  const pendingLaunch = nextHello(server);
  const launched = startCli(['--allow-shell', uri.toString()], env);
  children.push(launched.child);
  const { socket, hello } = await pendingLaunch;
  assert.equal(hello.type, 'launch');
  assert.equal(hello.protocol, 2);
  assert.equal(hello.ticket, ticket);
  assert.equal(hello.code, undefined);
  assert.equal(hello.token, undefined);
  assert.equal(hello.root, realpathSync(selectedRoot));
  assert.equal(hello.shellEnabled, true, 'Windows 协议处理器应自动添加 --allow-shell');
  assert.notEqual(hello.workspaceId, 'old-workspace-identity');
  assert.equal(readFileSync(defaultConfig, 'utf8'), oldConfig, '旧工作区配置不得被 launch 覆盖');
  assert.doesNotMatch(launched.output(), new RegExp(ticket, 'u'));
  assert.doesNotMatch(launched.output(), /dsh-local-workspace:\/\/connect/u);

  const longLivedToken = 'N'.repeat(43);
  socket.send(JSON.stringify({
    type: 'ready',
    workspaceId: hello.workspaceId,
    workspacePath: '/host/placeholder',
    token: longLivedToken,
  }));
  await waitUntil(() => launched.output().includes('已连接'), 5_000, 'launch ticket 成功后未连接');

  const profileDirectory = path.join(temp, '.dsh-local-workspace', 'profiles');
  const profileNames = readdirSync(profileDirectory);
  assert.equal(profileNames.length, 1);
  assert.match(profileNames[0] ?? '', /^[0-9a-f-]{36}\.json$/u);
  const profilePath = path.join(profileDirectory, profileNames[0] ?? '');
  const profileSource = readFileSync(profilePath, 'utf8');
  const profile = JSON.parse(profileSource) as { token?: string; workspaceId?: string; root?: string; shellEnabled?: boolean };
  assert.equal(profile.token, longLivedToken);
  assert.equal(profile.workspaceId, hello.workspaceId);
  assert.equal(profile.root, realpathSync(selectedRoot));
  assert.equal(profile.shellEnabled, true);
  assert.doesNotMatch(profileSource, new RegExp(ticket, 'u'));
  assert.doesNotMatch(profileSource, /dsh-local-workspace:\/\/connect/u);
  assert.equal(readFileSync(defaultConfig, 'utf8'), oldConfig);

  const registrySource = readFileSync(regLog, 'utf8');
  assert.match(registrySource, /HKCU\\Software\\Classes\\dsh-local-workspace/u);
  assert.match(registrySource, /URL Protocol/u);
  assert.match(registrySource, /shell\\open\\command/u);
  assert.match(registrySource, /--allow-shell/u);
  assert.match(registrySource, /%1/u);
  assert.doesNotMatch(registrySource, new RegExp(ticket, 'u'));
  const powershellSource = readFileSync(powershellLog, 'utf8');
  assert.match(powershellSource, /FolderBrowserDialog/u);
  assert.doesNotMatch(powershellSource, new RegExp(ticket, 'u'));

  socket.terminate();
  await stopCli(launched.child);
  rmSync(defaultConfig);

  const pendingResume = nextHello(server);
  const resumed = startCli([], env);
  children.push(resumed.child);
  const { socket: resumedSocket, hello: resumeHello } = await pendingResume;
  assert.equal(resumeHello.type, 'resume');
  assert.equal(resumeHello.token, longLivedToken);
  assert.equal(resumeHello.workspaceId, hello.workspaceId);
  resumedSocket.send(JSON.stringify({
    type: 'ready',
    workspaceId: resumeHello.workspaceId,
    workspacePath: '/host/placeholder',
  }));
  await waitUntil(() => resumed.output().includes('已连接'), 5_000, '独立 profile 未能在双击后 resume');
  resumedSocket.terminate();
});

test('Windows 打包版恢复旧的仅文件配置时自动启用 Shell', async (context) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-local-packaged-resume-'));
  const root = path.join(temp, 'workspace');
  const fakeBin = path.join(temp, 'bin');
  const config = path.join(temp, '.dsh-local-workspace', 'config.json');
  const regLog = path.join(temp, 'registry.log');
  mkdirSync(root);
  mkdirSync(fakeBin);
  mkdirSync(path.dirname(config));
  createWindowsCommandShims(fakeBin);

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('WebSocket server did not expose a TCP port');
  writeFileSync(config, JSON.stringify({
    server: `ws://127.0.0.1:${String(address.port)}`,
    token: 'P'.repeat(43),
    workspaceId: 'saved-files-only',
    deviceName: 'customer-pc',
    workspaceName: 'saved-workspace',
    root: realpathSync(root),
    shellEnabled: false,
  }, null, 2) + '\n');

  const pendingHello = nextHello(server);
  const cli = startCli([], {
    HOME: temp,
    USERPROFILE: temp,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    DSH_LOCAL_WORKSPACE_TEST_WINDOWS: '1',
    DSH_LOCAL_WORKSPACE_TEST_PACKAGED: '1',
    DSH_TEST_REG_LOG: regLog,
  });
  context.after(async () => {
    await stopCli(cli.child);
    await closeServer(server);
    rmSync(temp, { recursive: true, force: true });
  });

  const { socket, hello } = await pendingHello;
  assert.equal(hello.type, 'resume');
  assert.equal(hello.workspaceId, 'saved-files-only');
  assert.equal(hello.shellEnabled, true);
  socket.send(JSON.stringify({
    type: 'ready',
    workspaceId: hello.workspaceId,
    workspacePath: '/host/placeholder',
  }));
  await waitUntil(() => cli.output().includes('Shell：已启用'), 5_000, '旧配置恢复后未自动启用 Shell');
  socket.terminate();
});

test('Windows 首次双击只注册网页协议，不强迫填写服务器和目录', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-local-register-only-'));
  try {
    const fakeBin = path.join(temp, 'bin');
    const regLog = path.join(temp, 'registry.log');
    mkdirSync(fakeBin);
    createWindowsCommandShims(fakeBin);
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/local-workspace-cli.ts'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: temp,
          USERPROFILE: temp,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          DSH_LOCAL_WORKSPACE_TEST_WINDOWS: '1',
          DSH_TEST_REG_LOG: regLog,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /网页一键选择已安装/u);
    assert.match(result.stdout, /请返回已登录的 dsh 网页/u);
    assert.doesNotMatch(result.stdout, /输入服务器 ws:\/\//u);
    const registrySource = readFileSync(regLog, 'utf8');
    assert.match(registrySource, /shell\\open\\command/u);
    assert.match(registrySource, /--allow-shell/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('启动 URI 严格拒绝错误 route、字段、ticket 和 server，且不回显秘密', () => {
  const ticket = 'S'.repeat(43);
  const server = encodeURIComponent('wss://example.test:3082');
  const invalid = [
    `dsh-local-workspace://launch?server=${server}&ticket=${ticket}`,
    `dsh-local-workspace://connect/path?server=${server}&ticket=${ticket}`,
    `dsh-local-workspace://connect?server=${server}&ticket=${ticket}&extra=1`,
    `dsh-local-workspace://connect?server=${server}&ticket=${ticket}&ticket=${ticket}`,
    `dsh-local-workspace://connect?server=${server}&ticket=short`,
    `dsh-local-workspace://connect?server=${encodeURIComponent('https://example.test')}&ticket=${ticket}`,
    `dsh-local-workspace://connect?server=${encodeURIComponent('wss://user:password@example.test')}&ticket=${ticket}`,
    `dsh-local-workspace://connect?ticket=${ticket}`,
    `dsh-local-workspace://connect?server=${server}&ticket=${ticket}#fragment`,
  ];
  for (const uri of invalid) {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/local-workspace-cli.ts', uri],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, `URI 应被拒绝：${uri.replace(ticket, '<redacted>')}`);
    assert.match(output, /网页一键连接链接无效或已损坏/u);
    assert.doesNotMatch(output, new RegExp(ticket, 'u'));
    assert.doesNotMatch(output, /user:password/u);
  }
  const mixed = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/local-workspace-cli.ts', `dsh-local-workspace://connect?server=${server}&ticket=${ticket}`, '--help'],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  assert.equal(mixed.status, 1);
  assert.doesNotMatch(mixed.stdout + mixed.stderr, new RegExp(ticket, 'u'));
});

test('--help 以网页一键唤起为推荐，并保留 6 位码、--setup 和旧 --pair 说明', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/local-workspace-cli.ts', '--help'],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /6 位确认码/);
  assert.match(result.stdout, /网页一键唤起/);
  assert.match(result.stdout, /自动启用 PowerShell/);
  assert.match(result.stdout, /--setup/);
  assert.match(result.stdout, /--server ws:\/\/服务器:3082 --folder/);
  assert.match(result.stdout, /旧版长配对码（兼容）/);
  assert.match(result.stdout, /--pair CODE/);
});

function createWindowsCommandShims(directory: string): void {
  const reg = path.join(directory, 'reg.exe');
  const powershell = path.join(directory, 'powershell.exe');
  writeFileSync(reg, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DSH_TEST_REG_LOG"\n');
  writeFileSync(
    powershell,
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$DSH_TEST_POWERSHELL_LOG"\nprintf "%s" "$DSH_TEST_SELECTED_FOLDER"\n',
  );
  chmodSync(reg, 0o755);
  chmodSync(powershell, 0o755);
}

function startCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): {
  child: ChildProcess;
  output(): string;
} {
  let stdout = '';
  let stderr = '';
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/local-workspace-cli.ts', ...args],
    {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  return { child, output: () => stdout + stderr };
}

async function stopCli(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  try {
    await withTimeout(exited, 2_000, 'companion did not stop after SIGTERM');
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await withTimeout(exited, 2_000, 'companion did not stop after SIGKILL');
  }
}

async function nextHello(server: WebSocketServer): Promise<{
  socket: WebSocket;
  hello: Record<string, unknown>;
}> {
  return await withTimeout(new Promise((resolve, reject) => {
    server.once('connection', (socket) => {
      socket.once('message', (raw) => {
        try {
          resolve({ socket, hello: JSON.parse(raw.toString('utf8')) as Record<string, unknown> });
        } catch (error) {
          reject(error);
        }
      });
      socket.once('error', reject);
    });
  }), 5_000, 'companion did not connect and send hello');
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  if (server.address() === null) return;
  await withTimeout(
    new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
    2_000,
    'WebSocket test server did not close',
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
