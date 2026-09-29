/** Native Harness compatibility and optional service restart helpers. */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

interface DshPackageMetadata {
  name?: unknown;
  version?: unknown;
}

function dshPackageRoot(candidate: string): string | null {
  const resolved = path.resolve(candidate);
  const packageFile = path.join(resolved, 'package.json');
  if (!existsSync(packageFile)) return null;
  try {
    const metadata = JSON.parse(readFileSync(packageFile, 'utf8')) as DshPackageMetadata;
    return metadata.name === '@deepseek-ai/dsh' ? resolved : null;
  } catch {
    return null;
  }
}

function findFrom(start: string): string | null {
  let directory = path.resolve(start);
  for (;;) {
    const direct = dshPackageRoot(directory);
    if (direct !== null) return direct;
    const dependency = dshPackageRoot(path.join(directory, 'node_modules', '@deepseek-ai', 'dsh'));
    if (dependency !== null) return dependency;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function findOwningDshRoot(start: string): string | null {
  let directory = path.resolve(start);
  for (;;) {
    const direct = dshPackageRoot(directory);
    if (direct !== null) return direct;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function runtimeEntrypoints(): string[] {
  const entrypoints = typeof process.argv[1] === 'string' ? [process.argv[1]] : [];
  if (process.platform === 'linux') {
    try {
      entrypoints.push(...readFileSync('/proc/self/cmdline', 'utf8').split('\0').slice(1));
    } catch {
      // Linux environments may mount procfs without exposing this process's command line.
    }
  }
  return [...new Set(entrypoints.filter((entrypoint) => entrypoint !== ''))];
}

function findConfiguredRoot(configured: string): string | null {
  const resolved = path.resolve(configured);
  return dshPackageRoot(resolved)
    ?? dshPackageRoot(path.join(resolved, 'node_modules', '@deepseek-ai', 'dsh'));
}

/** Resolve an explicit profile, running CLI, local, or global `@deepseek-ai/dsh` installation. */
export function findDshRoot(explicit: string, entrypoints = runtimeEntrypoints()): string | null {
  if (explicit !== '') {
    const fromExplicit = findConfiguredRoot(explicit);
    if (fromExplicit !== null) return fromExplicit;
  }
  for (const entrypoint of entrypoints) {
    const resolvedEntrypoint = path.resolve(entrypoint);
    if (!existsSync(resolvedEntrypoint)) continue;
    const fromEntrypoint = findOwningDshRoot(path.dirname(resolvedEntrypoint));
    if (fromEntrypoint !== null) return fromEntrypoint;
  }
  try {
    const npm = resolveNpmCommand(['root', '-g']);
    const result = npm === null ? null : spawnSync(npm.command, npm.args, { encoding: 'utf8', shell: false, windowsHide: true });
    const globalRoot = result !== null && result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const candidate = dshPackageRoot(path.join(globalRoot, '@deepseek-ai', 'dsh'));
    if (candidate !== null) return candidate;
  } catch {
    // A local installation may still be available when npm is absent.
  }
  const local = findFrom(process.cwd());
  if (local !== null) return local;
  for (const candidate of [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ]) {
    const installed = dshPackageRoot(candidate);
    if (installed !== null) return installed;
  }
  return null;
}

function nativeHarnessAvailable(dshRoot: string): boolean {
  const packageFile = path.join(dshRoot, 'package.json');
  if (!existsSync(packageFile)) return false;
  try {
    const metadata = JSON.parse(readFileSync(packageFile, 'utf8')) as DshPackageMetadata;
    return typeof metadata.version === 'string' && /^(?:0\.1\.(?:2|3|5|6|7)|0\.2\.0)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(metadata.version);
  } catch {
    return false;
  }
}

export interface NpmCommand {
  command: string;
  args: string[];
}

/** npm CLI 的 JS 入口；找不到返回 null。 */
function npmCliEntry(env: NodeJS.ProcessEnv): string | null {
  // npm start / npm test 启动时 npm_execpath 指向正在使用的 npm CLI 入口，
  // 优先采信它以跟随调用方实际使用的 npm。只接受 npm 自身的 JS 入口——
  // pnpm/yarn 的 execpath 拿来执行 npm 参数会跑错包管理器。
  const execpath = env.npm_execpath?.trim() ?? '';
  if (execpath !== '' && /^npm[\w.-]*\.(?:cjs|mjs|js)$/i.test(path.basename(execpath)) && existsSync(execpath)) {
    return path.resolve(execpath);
  }
  const nodeDir = path.dirname(process.execPath);
  for (const candidate of [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    try {
      if (existsSync(candidate)) return path.resolve(candidate);
    } catch {
      /* 受限环境读不到候选路径时继续尝试下一个 */
    }
  }
  return null;
}

/**
 * Windows 回退方式：`cmd /d /s /c "<npm.cmd> …"`（与 scripts/install.mjs 同口径，
 * 不用 shell:true，避开 DEP0190 弃用警告与参数拼接）。
 * 参数含双引号、百分号（环境变量展开）或换行会破坏命令串 → 返回 null，调用方必须 fail-closed，
 * 绝不能把未转义文本拼进 shell 命令串。
 */
export function windowsNpmShimArgs(args: string[]): string[] | null {
  if (args.some((arg) => /["%\r\n]/.test(arg))) return null;
  const line = ['npm.cmd', ...args].map((arg) => `"${arg}"`).join(' ');
  return ['/d', '/s', '/c', `"${line}"`];
}

/**
 * 解析执行 npm 子命令的方式（Issue #33）：
 * 1. `node <npm-cli.js>`——首选，Windows/Linux/macOS 通用，shell:false 可执行；
 * 2. Windows 找不到 npm-cli.js——cmd.exe 显式启动 npm.cmd shim；
 * 3. 其他平台——直接 `npm`（.cmd shim 问题只存在于 Windows）。
 * 参数不安全（见 windowsNpmShimArgs）时返回 null。
 */
export function resolveNpmCommand(args: string[], env: NodeJS.ProcessEnv = process.env): NpmCommand | null {
  const cli = npmCliEntry(env);
  if (cli !== null) return { command: process.execPath, args: [cli, ...args] };
  if (process.platform !== 'win32') return { command: 'npm', args: [...args] };
  const shimArgs = windowsNpmShimArgs(args);
  if (shimArgs === null) return null;
  return { command: env.ComSpec?.trim() || 'cmd.exe', args: shimArgs };
}

/** The native Harness exposes Settings and model selection without bundle rewriting. */
export function patchStatus(
  dshRoot: string,
): { settingsHostMode: boolean; whitelist: boolean; workspaceSearch: boolean; connectionCookieBridge: 'native' | 'missing' } {
  const ready = nativeHarnessAvailable(dshRoot);
  return { settingsHostMode: ready, whitelist: ready, workspaceSearch: ready, connectionCookieBridge: ready ? 'native' : 'missing' };
}

/** Validate native Harness support; no installed package is modified. */
export function applyRemotePatch(dshRoot: string): 'applied' | 'unchanged' | 'missing' {
  return nativeHarnessAvailable(dshRoot) ? 'unchanged' : 'missing';
}

/** Native Harness has no dsh-passwords bundle rewrite to roll back. */
export function rollbackPatch(dshRoot: string): 'rolled-back' | 'no-backup' | 'missing' {
  return nativeHarnessAvailable(dshRoot) ? 'no-backup' : 'missing';
}

/** Restart a configured systemd unit and report whether systemd accepted it. */
export function restartDshWebChecked(
  service: string,
  delayMs = 2500,
): Promise<{ ok: boolean; message: string; manual?: boolean }> {
  return new Promise((resolve) => {
    if (service === '') {
      resolve({ ok: false, message: '未配置 dsh-web 服务名' });
      return;
    }
    if (!/^[A-Za-z0-9_.@-]+$/u.test(service)) {
      resolve({ ok: false, message: '重启服务名非法' });
      return;
    }
    if (process.platform === 'win32') {
      resolve({ ok: false, manual: true, message: 'Windows 不支持 systemd，请重启 DeepSeek Harness' });
      return;
    }
    const timer = setTimeout(() => {
      try {
        const result = spawnSync('systemctl', ['restart', service], { stdio: 'ignore' });
        if (result.status !== 0 || result.error !== undefined) {
          resolve({
            ok: false,
            message: result.error instanceof Error
              ? result.error.message
              : `systemctl exit ${String(result.status)}`,
          });
          return;
        }
        resolve({ ok: true, message: '' });
      } catch (error) {
        resolve({ ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    }, delayMs);
    timer.unref();
  });
}

/** Restart a configured systemd unit after a deployment-level operation. */
export function restartDshWeb(service: string, delayMs = 2500): void {
  if (service === '') return;
  if (!/^[A-Za-z0-9_.@-]+$/u.test(service)) {
    console.error(`[dsh-passwords] 重启服务名非法（拒绝执行）：${service}`);
    return;
  }
  void restartDshWebChecked(service, delayMs).then((result) => {
    if (!result.ok && !result.manual) console.error(`[dsh-passwords] 重启 ${service} 失败（补丁将在下次 dsh 重启后生效）: ${result.message}`);
    if (result.manual) console.error(`[dsh-passwords] ${result.message}`);
  });
}
