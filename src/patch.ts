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

function findConfiguredRoot(configured: string): string | null {
  const resolved = path.resolve(configured);
  return dshPackageRoot(resolved)
    ?? dshPackageRoot(path.join(resolved, 'node_modules', '@deepseek-ai', 'dsh'));
}

/** Resolve an explicit profile, running CLI, local, or global `@deepseek-ai/dsh` installation. */
export function findDshRoot(explicit: string): string | null {
  if (explicit !== '') {
    const fromExplicit = findConfiguredRoot(explicit);
    if (fromExplicit !== null) return fromExplicit;
  }
  const entrypoint = process.argv[1];
  if (typeof entrypoint === 'string' && entrypoint !== '') {
    const fromEntrypoint = findFrom(path.dirname(entrypoint));
    if (fromEntrypoint !== null) return fromEntrypoint;
  }
  try {
    const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
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
