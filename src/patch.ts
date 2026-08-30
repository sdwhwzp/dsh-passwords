/** Native Harness compatibility and optional service restart helpers. */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

interface DshPackageMetadata {
  version?: unknown;
}

/** Resolve an explicit, local, or global `@deepseek-ai/dsh` installation. */
export function findDshRoot(explicit: string): string | null {
  if (explicit !== '') return existsSync(explicit) ? path.resolve(explicit) : null;
  try {
    const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
    const candidate = path.join(globalRoot, '@deepseek-ai', 'dsh');
    if (existsSync(candidate)) return candidate;
  } catch {
    // A local installation may still be available when npm is absent.
  }
  let directory = process.cwd();
  for (;;) {
    const candidate = path.join(directory, 'node_modules', '@deepseek-ai', 'dsh');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const candidate of [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function nativeHarnessAvailable(dshRoot: string): boolean {
  const packageFile = path.join(dshRoot, 'package.json');
  if (!existsSync(packageFile)) return false;
  try {
    const metadata = JSON.parse(readFileSync(packageFile, 'utf8')) as DshPackageMetadata;
    return typeof metadata.version === 'string' && /^0\.1\.2-alpha\./u.test(metadata.version);
  } catch {
    return false;
  }
}

/** Native alpha.1 exposes Settings and model selection without bundle rewriting. */
export function patchStatus(
  dshRoot: string,
): { settingsHostMode: boolean; whitelist: boolean; workspaceSearch: boolean } {
  const ready = nativeHarnessAvailable(dshRoot);
  return { settingsHostMode: ready, whitelist: ready, workspaceSearch: ready };
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
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    if (service === '') {
      resolve({ ok: false, message: '未配置 dsh-web 服务名' });
      return;
    }
    if (!/^[A-Za-z0-9_.@-]+$/u.test(service)) {
      resolve({ ok: false, message: '重启服务名非法' });
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
    if (!result.ok) console.error(`[dsh-passwords] 重启 ${service} 失败: ${result.message}`);
  });
}
