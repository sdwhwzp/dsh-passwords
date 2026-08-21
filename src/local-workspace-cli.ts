#!/usr/bin/env node
/** User-side companion that exposes one explicitly selected local folder. */

import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import WebSocket from 'ws';
import {
  LOCAL_WORKSPACE_MAX_MESSAGE_BYTES,
  LOCAL_WORKSPACE_PROTOCOL_VERSION,
  parseWireObject,
  type HostToCompanionMessage,
  type LocalWorkspaceOperation,
  type LocalWorkspaceRequest,
  type LocalWorkspaceResponse,
} from './local-workspace-protocol.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILES = 20_000;
const MAX_SEARCH_RESULTS = 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;

interface CompanionConfig {
  server: string;
  token?: string;
  workspaceId: string;
  deviceName: string;
  workspaceName: string;
  root: string;
  shellEnabled: boolean;
}

interface CliOptions {
  configPath: string;
  pairCode?: string;
  server?: string;
  folder?: string;
  deviceName?: string;
  workspaceName?: string;
  allowShell: boolean;
  help: boolean;
}

interface RunningOperation {
  controller: AbortController;
}

class CompanionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CompanionError';
  }
}

void main().catch(async (error: unknown) => {
  console.error(`[山东梯智物联AI 本机助手] ${error instanceof Error ? error.message : String(error)}`);
  await pauseBeforeWindowsExit();
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  let options = parseArgs(rawArgs);
  if (options.help) {
    printHelp();
    return;
  }
  if (rawArgs.length === 0 && !(await configExists(options.configPath))) {
    options = await runFirstPairingWizard(options);
  }
  const initial = await resolveConfig(options);
  await runForever(initial, options.configPath, options.pairCode);
}

async function runForever(config: CompanionConfig, configPath: string, pairCode?: string): Promise<never> {
  let delayMs = 1_000;
  let firstPairCode = pairCode;
  for (;;) {
    try {
      await runConnection(config, configPath, firstPairCode);
      firstPairCode = undefined;
      delayMs = 1_000;
    } catch (error) {
      console.error(`[dsh-local-workspace] ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof CompanionError && error.code === 'AUTH_FAILED') throw error;
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 30_000);
    console.log('[dsh-local-workspace] 正在重新连接…');
  }
}

function runConnection(config: CompanionConfig, configPath: string, pairCode?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(config.server, { maxPayload: LOCAL_WORKSPACE_MAX_MESSAGE_BYTES });
    const running = new Map<string, RunningOperation>();
    let authenticated = false;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      for (const operation of running.values()) operation.controller.abort();
      running.clear();
      if (error === undefined) resolve();
      else reject(error);
    };

    socket.once('open', () => {
      const shared = {
        protocol: LOCAL_WORKSPACE_PROTOCOL_VERSION,
        deviceName: config.deviceName,
        workspaceName: config.workspaceName,
        workspaceId: config.workspaceId,
        root: config.root,
        platform: process.platform,
        shellEnabled: config.shellEnabled,
      } as const;
      if (pairCode !== undefined) {
        socket.send(JSON.stringify({ type: 'pair', code: pairCode, ...shared }));
      } else if (config.token !== undefined) {
        socket.send(JSON.stringify({ type: 'resume', token: config.token, ...shared }));
      } else {
        finish(new CompanionError('缺少配对码或已保存的设备令牌', 'AUTH_FAILED'));
        socket.close();
      }
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text frames only');
        return;
      }
      void handleMessage(data.toString('utf8')).catch((error: unknown) => {
        console.error('[dsh-local-workspace] 消息处理失败:', error);
        socket.close(1011, 'message handling failed');
      });
    });

    socket.on('error', (error) => finish(error));
    socket.on('close', (code, reason) => {
      const text = reason.toString('utf8');
      if (!authenticated && code === 1008) {
        finish(new CompanionError(text || '配对或设备令牌无效', 'AUTH_FAILED'));
      } else {
        finish(text === '' ? undefined : new Error(`连接关闭：${text}`));
      }
    });

    async function handleMessage(raw: string): Promise<void> {
      const value = parseWireObject(raw);
      if (value.type === 'ready') {
        const token = typeof value.token === 'string' ? value.token : undefined;
        authenticated = true;
        if (token !== undefined) {
          config.token = token;
          await saveConfig(configPath, config);
          pairCode = undefined;
        }
        console.log(`[dsh-local-workspace] 已连接：${config.workspaceName}`);
        console.log(`[dsh-local-workspace] 授权目录：${config.root}`);
        console.log(`[dsh-local-workspace] Shell：${config.shellEnabled ? '已启用（可访问当前系统用户权限范围）' : '已关闭'}`);
        return;
      }
      if (value.type === 'error') {
        const message = typeof value.error === 'string' ? value.error : '服务器拒绝连接';
        const code = typeof value.code === 'string' ? value.code : 'PROTOCOL_ERROR';
        throw new CompanionError(message, code === 'AUTH_FAILED' ? 'AUTH_FAILED' : 'PROTOCOL_ERROR');
      }
      if (!authenticated) throw new Error('received operation before authentication');
      if (value.type === 'cancel') {
        const id = requireString(value.id, 'id', 1, 120);
        running.get(id)?.controller.abort();
        return;
      }
      if (value.type !== 'request') throw new Error('unsupported host message');
      const request = parseRequest(value);
      if (running.has(request.id)) throw new Error(`duplicate operation id ${request.id}`);
      const controller = new AbortController();
      running.set(request.id, { controller });
      try {
        const result = await executeOperation(config, request.operation, request.args, controller.signal);
        send({ type: 'response', id: request.id, ok: true, value: result });
      } catch (error) {
        const aborted = controller.signal.aborted;
        send({
          type: 'response',
          id: request.id,
          ok: false,
          code: aborted ? 'ABORTED' : error instanceof CompanionError ? error.code : 'OPERATION_FAILED',
          error: aborted ? 'operation aborted' : error instanceof Error ? error.message : String(error),
        });
      } finally {
        running.delete(request.id);
      }
    }

    function send(message: LocalWorkspaceResponse): void {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }
  });
}

async function executeOperation(
  config: CompanionConfig,
  operation: LocalWorkspaceOperation,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  switch (operation) {
    case 'read':
      return await readTextWindow(config.root, args, signal);
    case 'write':
      return await writeTextFile(config.root, args, signal);
    case 'edit':
      return await editTextFile(config.root, args, signal);
    case 'glob':
      return await globFiles(config.root, args, signal);
    case 'grep':
      return await grepFiles(config.root, args, signal);
    case 'bash':
      if (!config.shellEnabled) throw new CompanionError('本机助手未启用 Shell；重新配对时添加 --allow-shell', 'SHELL_DISABLED');
      return await runShell(config.root, args, signal);
  }
}

async function readTextWindow(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const relative = requireRelativePath(args.path, 'path');
  const offset = optionalPositiveInteger(args.offset, 'offset') ?? 1;
  const limit = optionalPositiveInteger(args.limit, 'limit') ?? 500;
  if (limit > 2_000) throw new CompanionError('limit 不能超过 2000', 'INVALID_ARGUMENT');
  const target = await existingPathWithin(root, relative);
  const info = await stat(target);
  if (!info.isFile()) throw new CompanionError('目标不是普通文件', 'NOT_FILE');
  if (info.size > MAX_TEXT_BYTES) throw new CompanionError('文本文件超过 2 MiB 上限', 'FILE_TOO_LARGE');
  throwIfAborted(signal);
  const content = await readFile(target, 'utf8');
  throwIfAborted(signal);
  const lines = content.split(/\r?\n/);
  const start = Math.min(offset - 1, lines.length);
  return {
    path: displayPath(relative),
    offset,
    lines: lines.slice(start, start + limit).map((text, index) => ({ number: start + index + 1, text })),
    totalLines: lines.length,
  };
}

async function writeTextFile(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const relative = requireRelativePath(args.path, 'path');
  const content = requireString(args.content, 'content', 0, MAX_TEXT_BYTES);
  const target = await writablePathWithin(root, relative);
  let before: string | null = null;
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new CompanionError('目标不是普通文件', 'NOT_FILE');
    if (info.size > MAX_TEXT_BYTES) throw new CompanionError('原文件超过 2 MiB 上限', 'FILE_TOO_LARGE');
    before = await readFile(target, 'utf8');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  throwIfAborted(signal);
  await atomicWrite(target, content);
  throwIfAborted(signal);
  return { path: displayPath(relative), operation: before === null ? 'create' : 'update', before, after: content };
}

async function editTextFile(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const relative = requireRelativePath(args.path, 'path');
  const oldString = requireString(args.oldString, 'oldString', 1, MAX_TEXT_BYTES);
  const newString = requireString(args.newString, 'newString', 0, MAX_TEXT_BYTES);
  const replaceAll = args.replaceAll === true;
  const target = await existingPathWithin(root, relative);
  const info = await stat(target);
  if (!info.isFile()) throw new CompanionError('目标不是普通文件', 'NOT_FILE');
  if (info.size > MAX_TEXT_BYTES) throw new CompanionError('文本文件超过 2 MiB 上限', 'FILE_TOO_LARGE');
  const before = await readFile(target, 'utf8');
  throwIfAborted(signal);
  const count = countOccurrences(before, oldString);
  if (count === 0) throw new CompanionError('old_string 未在文件中出现', 'NO_MATCH');
  if (!replaceAll && count !== 1) throw new CompanionError(`old_string 出现 ${String(count)} 次，请提供更具体内容或设置 replace_all`, 'MULTIPLE_MATCHES');
  const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
  if (Buffer.byteLength(after, 'utf8') > MAX_TEXT_BYTES) throw new CompanionError('编辑后文件超过 2 MiB 上限', 'FILE_TOO_LARGE');
  await atomicWrite(target, after);
  throwIfAborted(signal);
  return { path: displayPath(relative), before, after, replacements: replaceAll ? count : 1 };
}

async function globFiles(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const pattern = requireString(args.pattern, 'pattern', 1, 500).replace(/\\/g, '/');
  const relativeRoot = optionalRelativePath(args.path, 'path') ?? '.';
  const searchRoot = await existingPathWithin(root, relativeRoot);
  if (!(await stat(searchRoot)).isDirectory()) throw new CompanionError('glob path 不是目录', 'NOT_DIRECTORY');
  const matcher = globRegex(pattern);
  const files = await walkFiles(root, searchRoot, signal);
  const paths = files
    .map((file) => path.relative(searchRoot, file).split(path.sep).join('/'))
    .filter((file) => matcher.test(file))
    .slice(0, MAX_SEARCH_RESULTS);
  return { root: displayPath(relativeRoot), paths };
}

async function grepFiles(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const source = requireString(args.pattern, 'pattern', 1, 2_000);
  const relativeRoot = optionalRelativePath(args.path, 'path') ?? '.';
  const include = typeof args.include === 'string' && args.include !== '' ? globRegex(args.include) : null;
  let expression: RegExp;
  try {
    expression = new RegExp(source, 'u');
  } catch (error) {
    throw new CompanionError(`无效正则表达式：${error instanceof Error ? error.message : String(error)}`, 'INVALID_REGEX');
  }
  const target = await existingPathWithin(root, relativeRoot);
  const info = await stat(target);
  const files = info.isFile() ? [target] : await walkFiles(root, target, signal);
  const matches: Array<{ path: string; lineNumber: number; line: string }> = [];
  for (const file of files) {
    throwIfAborted(signal);
    const relative = path.relative(target, file).split(path.sep).join('/') || path.basename(file);
    if (include !== null && !include.test(relative)) continue;
    const fileInfo = await stat(file);
    if (fileInfo.size > MAX_TEXT_BYTES) continue;
    const content = await readFile(file);
    if (content.includes(0)) continue;
    const lines = content.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      expression.lastIndex = 0;
      if (expression.test(line)) matches.push({ path: relative, lineNumber: index + 1, line: line.slice(0, 2_000) });
      if (matches.length >= MAX_SEARCH_RESULTS) return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

async function runShell(root: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const command = requireString(args.command, 'command', 1, 200_000);
  const relativeWorkdir = optionalRelativePath(args.workdir, 'workdir') ?? '.';
  const workdir = await existingPathWithin(root, relativeWorkdir);
  if (!(await stat(workdir)).isDirectory()) throw new CompanionError('workdir 不是目录', 'NOT_DIRECTORY');
  const timeoutMs = Math.min(optionalPositiveInteger(args.timeoutMs, 'timeoutMs') ?? DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  return await spawnCommand(command, workdir, timeoutMs, signal);
}

async function spawnCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  const windows = process.platform === 'win32';
  const executable = windows ? 'powershell.exe' : '/bin/bash';
  const argv = windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    : ['--noprofile', '--norc', '-lc', command];
  const child = spawn(executable, argv, {
    cwd,
    detached: !windows,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: scrubEnvironment(process.env),
    windowsHide: true,
  });
  const stdout = collectStream(child.stdout, MAX_COMMAND_OUTPUT_BYTES);
  const stderr = collectStream(child.stderr, MAX_COMMAND_OUTPUT_BYTES);
  let timedOut = false;
  let aborted = false;
  let terminating: Promise<void> | null = null;
  const terminate = (): Promise<void> => {
    terminating ??= terminateProcessTree(child);
    return terminating;
  };
  const onAbort = () => {
    aborted = true;
    void terminate();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, timeoutMs);
  try {
    const exit = await waitForExit(child);
    if (terminating !== null) await terminating;
    const [out, err] = await Promise.all([stdout, stderr]);
    return {
      stdout: out.text,
      stderr: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      aborted,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
    await waitForExit(child).then(() => undefined, () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
  const exited = await Promise.race([waitForExit(child).then(() => true), sleep(1_000).then(() => false)]);
  if (exited) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
  await waitForExit(child).then(() => undefined, () => undefined);
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function collectStream(stream: NodeJS.ReadableStream | null, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (stream === null) return { text: '', truncated: false };
  const chunks: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    const remaining = Math.max(0, maxBytes - retained);
    if (remaining > 0) {
      const take = chunk.subarray(0, remaining);
      chunks.push(take);
      retained += take.length;
    }
    if (chunk.length > remaining) truncated = true;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function walkFiles(root: string, start: string, signal: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const pending = [start];
  let seen = 0;
  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop();
    if (current === undefined) break;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      if (++seen > MAX_SEARCH_FILES) throw new CompanionError('搜索扫描文件数量超过 20000 上限', 'SEARCH_TOO_LARGE');
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const resolved = await existingPathWithin(root, path.relative(root, candidate));
          if ((await stat(resolved)).isFile()) files.push(resolved);
        } catch {
          continue;
        }
      } else if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile()) {
        files.push(candidate);
      }
    }
  }
  return files;
}

async function existingPathWithin(root: string, relative: string): Promise<string> {
  const candidate = lexicalPathWithin(root, relative);
  const resolved = await realpath(candidate);
  ensureContained(root, resolved);
  return resolved;
}

async function writablePathWithin(root: string, relative: string): Promise<string> {
  const candidate = lexicalPathWithin(root, relative);
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(candidate);
      ensureContained(root, resolved);
      return resolved;
    }
    ensureContained(root, await realpath(candidate));
    return candidate;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  let ancestor = path.dirname(candidate);
  for (;;) {
    try {
      const resolved = await realpath(ancestor);
      ensureContained(root, resolved);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return candidate;
}

function lexicalPathWithin(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new CompanionError('只接受相对于授权目录的路径', 'PATH_OUTSIDE_ROOT');
  const candidate = path.resolve(root, relative);
  ensureContained(root, candidate);
  return candidate;
}

function ensureContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) return;
  throw new CompanionError('路径超出授权目录', 'PATH_OUTSIDE_ROOT');
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    let mode = 0o600;
    try {
      mode = (await stat(target)).mode & 0o777;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await writeFile(temp, content, { encoding: 'utf8', mode, flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    try {
      await unlink(temp);
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) console.warn(`[dsh-local-workspace] 临时文件清理失败：${String(cleanupError)}`);
    }
    throw error;
  }
}

function globRegex(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? '';
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index++;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += /[\\^$+?.()|{}\[\]]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(pattern.includes('/') ? `^${source}$` : `(?:^|/)${source}$`, 'u');
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let at = 0;
  while ((at = content.indexOf(needle, at)) !== -1) {
    count++;
    at += needle.length;
  }
  return count;
}

function scrubEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|COOKIE)/i.test(key)) continue;
    if (key === 'NODE_OPTIONS' || key === 'SSH_AUTH_SOCK') continue;
    clean[key] = value;
  }
  clean.DSH_LOCAL_WORKSPACE = '1';
  return clean;
}

function parseRequest(value: Record<string, unknown>): LocalWorkspaceRequest {
  const operation = value.operation;
  if (operation !== 'read' && operation !== 'write' && operation !== 'edit' && operation !== 'glob' && operation !== 'grep' && operation !== 'bash') {
    throw new Error('unsupported operation');
  }
  if (value.args === null || typeof value.args !== 'object' || Array.isArray(value.args)) throw new Error('request args must be an object');
  return {
    type: 'request',
    id: requireString(value.id, 'id', 1, 120),
    operation,
    args: value.args as Record<string, unknown>,
  };
}

function requireRelativePath(value: unknown, name: string): string {
  const pathValue = requireString(value, name, 1, 4096).replace(/\\/g, '/');
  if (pathValue.includes('\0')) throw new CompanionError(`${name} 包含空字符`, 'INVALID_ARGUMENT');
  return pathValue;
}

function optionalRelativePath(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requireRelativePath(value, name);
}

function requireString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || Buffer.byteLength(value, 'utf8') > max) {
    throw new CompanionError(`${name} 长度无效`, 'INVALID_ARGUMENT');
  }
  return value;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new CompanionError(`${name} 必须是正整数`, 'INVALID_ARGUMENT');
  return value as number;
}

function displayPath(relative: string): string {
  const normalized = relative.split(path.sep).join('/');
  return normalized === '' ? '.' : normalized;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CompanionError('operation aborted', 'ABORTED');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH';
}

async function configExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function runFirstPairingWizard(defaults: CliOptions): Promise<CliOptions> {
  const forceWizard = process.env.DSH_LOCAL_WORKSPACE_FORCE_WIZARD === '1';
  if (!forceWizard && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('首次配对需要提供 --server、--pair 和 --folder，或双击 Windows 助手进入向导');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    console.log('==================================================');
    console.log('       山东梯智物联AI · DSH 本机助手');
    console.log('==================================================');
    console.log('首次配置一次，之后双击本程序即可自动连接。');
    console.log('请先在 DSH 设置 → 插件 → 本机工作区中生成配对命令。');
    console.log('');
    const pairingInput = await terminal.question('1. 粘贴网页生成的完整配对命令（或配对码）：\n> ');
    const pairing = parsePairingInput(pairingInput);
    const server = pairing.server ?? stripOuterQuotes(await terminal.question('2. 输入服务器 ws:// 或 wss:// 地址：\n> '));
    const pairCode = pairing.pairCode ?? stripOuterQuotes(pairingInput.trim());
    const folder = stripOuterQuotes(await terminal.question('3. 输入或拖入要授权的本机文件夹：\n> '));
    const shellAnswer = (await terminal.question('4. 允许 AI 在本机执行 PowerShell 命令？风险较高 [y/N]：\n> ')).trim();
    console.log('正在验证目录并连接服务器…');
    return {
      ...defaults,
      server,
      pairCode,
      folder,
      allowShell: /^(?:y|yes|是)$/i.test(shellAnswer),
    };
  } finally {
    terminal.close();
  }
}

function parsePairingInput(input: string): { server?: string; pairCode?: string } {
  const value = input.trim();
  return {
    server: flagValue(value, '--server'),
    pairCode: flagValue(value, '--pair'),
  };
}

function flagValue(command: string, flag: string): string | undefined {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}\\s+(?:"([^"]*)"|'([^']*)'|(\\S+))`, 'u').exec(command);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : stripOuterQuotes(value);
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function pauseBeforeWindowsExit(): Promise<void> {
  if (process.platform !== 'win32' || !process.stdin.isTTY || !process.stdout.isTTY) return;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question('按回车键关闭窗口…');
  } finally {
    terminal.close();
  }
}

async function resolveConfig(cli: CliOptions): Promise<CompanionConfig> {
  let saved: CompanionConfig | null = null;
  try {
    saved = JSON.parse(await readFile(cli.configPath, 'utf8')) as CompanionConfig;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const folderInput = cli.folder ?? saved?.root;
  if (folderInput === undefined) throw new Error('首次配对必须提供 --folder <目录>');
  const root = await realpath(path.resolve(folderInput));
  if (!(await stat(root)).isDirectory()) throw new Error(`不是目录：${root}`);
  const server = cli.server ?? saved?.server;
  if (server === undefined) throw new Error('首次配对必须提供 --server <ws://或wss://地址>');
  const parsed = new URL(server);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('--server 必须使用 ws:// 或 wss://');
  const workspaceId = saved?.workspaceId ?? randomUUID();
  const deviceName = cli.deviceName ?? saved?.deviceName ?? os.hostname();
  const workspaceName = cli.workspaceName ?? saved?.workspaceName ?? path.basename(root);
  const shellEnabled = cli.allowShell || saved?.shellEnabled === true;
  if (shellEnabled) {
    console.warn('[dsh-local-workspace] 警告：Shell 命令以当前系统用户身份执行，可能访问授权目录之外的文件。');
  }
  return { server: parsed.toString(), token: saved?.token, workspaceId, deviceName, workspaceName, root, shellEnabled };
}

async function saveConfig(file: string, config: CompanionConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temp, file);
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows does not implement POSIX mode bits; the user profile directory remains the owner boundary.
  }
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {
    configPath: path.join(os.homedir(), '.dsh-local-workspace', 'config.json'),
    allowShell: false,
    help: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--allow-shell') result.allowShell = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--server') result.server = nextArg(args, ++index, '--server');
    else if (arg === '--pair') result.pairCode = nextArg(args, ++index, '--pair');
    else if (arg === '--folder') result.folder = nextArg(args, ++index, '--folder');
    else if (arg === '--device-name') result.deviceName = nextArg(args, ++index, '--device-name');
    else if (arg === '--name') result.workspaceName = nextArg(args, ++index, '--name');
    else if (arg === '--config') result.configPath = path.resolve(nextArg(args, ++index, '--config'));
    else throw new Error(`未知参数：${arg ?? ''}`);
  }
  if (result.pairCode !== undefined && result.pairCode.length < 32) throw new Error('配对码无效');
  return result;
}

function nextArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} 缺少值`);
  return value;
}

function printHelp(): void {
  console.log(`山东梯智物联AI · DSH 本机助手

Windows 用户可直接双击 EXE，首次启动会进入中文配对向导。

首次配对：
  dsh-local-workspace --server ws://服务器:3082 --pair <配对码> --folder <目录> [--name 名称]

恢复连接：
  dsh-local-workspace

选项：
  --allow-shell       明确允许 AI 在本机执行 Shell；默认关闭
  --device-name NAME  设备显示名
  --config PATH       使用另一份配置文件（可同时共享多个目录）
`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
