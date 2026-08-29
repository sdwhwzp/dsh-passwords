/** Host-side workspace provisioning for dsh-passwords subusers. */

import type { Context } from '@deepseek-ai/cordis';
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { PlatformConfig } from './config.js';
import { Database, type UserListRow, type UserPermissionsRow } from './db.js';
import type { AuthenticatedPrincipal } from './principal.js';

/** The sandbox level that permits writes inside a session workspace only. */
export const MANAGED_WORKSPACE_SANDBOX = 'workspace-write';

/** Durable workspace registrations removed while deleting one subuser. */
export interface ManagedWorkspaceRegistration {
  path: string;
  title: string;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    managedUserWorkspace: ManagedUserWorkspaceProvider;
  }
}

/** Resolves the private host directory owned by one authenticated account. */
export class ManagedUserWorkspaceProvider {
  constructor(
    private readonly db: Database,
    private readonly config: PlatformConfig,
  ) {}

  /** Return the account's canonical private root, or undefined for a stale or forged principal. */
  async resolve(principal: AuthenticatedPrincipal): Promise<string | undefined> {
    if (principal.source !== 'dsh-passwords' || !/^[1-9][0-9]*$/u.test(principal.id)) return undefined;
    const user = this.db.getUserListRowById(Number(principal.id));
    if (user === null || user.username !== principal.username || user.role !== principal.role) return undefined;
    if (user.role === 'admin') {
      const parent = await ensureDirectory(this.config.managedWorkspaceRoot);
      return ensureDirectory(path.join(parent, `admin-u${String(user.id)}`));
    }
    const managed = this.db.getManagedWorkspace(user.id);
    if (managed === null) return undefined;
    if (!managedDirectoryName(user.id, path.basename(path.resolve(managed.path)))) return undefined;
    const info = await lstat(managed.path).catch(() => undefined);
    if (info === undefined) return undefined;
    if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    return realpath(managed.path);
  }

  /** Return current account identities so dependent services can restore durable per-account resources. */
  async listPrincipals(): Promise<AuthenticatedPrincipal[]> {
    return this.db.listUsers().map((user) => ({
      source: 'dsh-passwords',
      id: String(user.id),
      username: user.username,
      role: user.role,
    }));
  }
}

/** Publish account-private workspace resolution without exposing the user database. */
export function registerManagedUserWorkspace(
  ctx: Context,
  db: Database,
  config: PlatformConfig,
): ManagedUserWorkspaceProvider {
  const provider = new ManagedUserWorkspaceProvider(db, config);
  ctx.effect(
    () => ctx.root.provide('managedUserWorkspace', provider),
    'dsh-passwords: managed user workspace provider',
  );
  return provider;
}

/** Creates, registers, restores, and revokes host directories owned by subusers. */
export class ManagedWorkspaceProvisioner {
  private rootPromise: Promise<string> | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly config: PlatformConfig,
  ) {}

  /** Create the durable directory and permission assignment for a new subuser. */
  provisionNewUser(registry: WorkspaceRegistry, user: UserListRow): Promise<string> {
    return this.enqueue(() => this.provisionNewUserNow(registry, user));
  }

  private async provisionNewUserNow(registry: WorkspaceRegistry, user: UserListRow): Promise<string> {
    if (user.role !== 'user') throw new Error('主用户不能分配子用户托管工作区');
    if (this.db.getManagedWorkspace(user.id) !== null) {
      throw new Error(`用户 ${String(user.id)} 已有托管工作区`);
    }

    const workspacePath = await this.prepareDirectory(user.id, null);
    const beforeRegistration = await registry.resolveByPath(workspacePath);
    let registration: Workspace | undefined;
    try {
      registration = beforeRegistration ?? await registry.create(workspacePath, workspaceTitle(user));
      if (registration.title !== workspaceTitle(user)) await registration.setTitle(workspaceTitle(user));
      this.db.setManagedWorkspace(user.id, workspacePath);
      this.db.setPermissions(user.id, {
        allowedFolders: [workspacePath],
        hourlyTokenLimit: null,
        dailyMinutesLimit: null,
        monthlyBudgetMicros: 0,
        allowUpload: true,
        allowGitDownload: false,
        banned: false,
        sandboxMode: MANAGED_WORKSPACE_SANDBOX,
        disabledSessions: [],
      });
      return workspacePath;
    } catch (error) {
      this.db.deleteManagedWorkspace(user.id);
      if (beforeRegistration === undefined && registration !== undefined) {
        await registry.delete(registration.id).catch(() => undefined);
      }
      throw error;
    }
  }

  /** Restore registrations and backfill pre-existing subusers without replacing their quotas. */
  restore(registry: WorkspaceRegistry): Promise<void> {
    return this.enqueue(() => this.restoreNow(registry));
  }

  private async restoreNow(registry: WorkspaceRegistry): Promise<void> {
    const failures: unknown[] = [];
    for (const user of this.db.listUsers()) {
      if (user.role !== 'user') continue;
      try {
        const existing = this.db.getManagedWorkspace(user.id);
        if (existing === null) {
          await this.provisionExistingUser(registry, user);
        } else {
          const workspacePath = await this.prepareDirectory(user.id, existing.path);
          const registration = await registry.create(workspacePath, workspaceTitle(user));
          if (registration.title !== workspaceTitle(user)) await registration.setTitle(workspaceTitle(user));
          if (!samePath(existing.path, workspacePath)) this.db.setManagedWorkspace(user.id, workspacePath);
          this.db.setPermissions(user.id, mergedPermissions(workspacePath, this.db.getPermissions(user.id)));
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${String(failures.length)} 个子用户的托管工作区恢复失败`);
    }
  }

  /** Restore one still-existing user's registration after a failed account deletion. */
  restoreUser(
    registry: WorkspaceRegistry,
    user: UserListRow,
    registrations: readonly ManagedWorkspaceRegistration[] = [],
  ): Promise<void> {
    return this.enqueue(() => this.restoreUserNow(registry, user, registrations));
  }

  private async restoreUserNow(
    registry: WorkspaceRegistry,
    user: UserListRow,
    registrations: readonly ManagedWorkspaceRegistration[],
  ): Promise<void> {
    const existing = this.db.getManagedWorkspace(user.id);
    if (existing === null) throw new Error(`用户 ${String(user.id)} 没有托管工作区记录`);
    const workspacePath = await this.prepareDirectory(user.id, existing.path);
    const targets = registrations.length === 0
      ? [{ path: workspacePath, title: workspaceTitle(user) }]
      : registrations;
    for (const target of targets) {
      const canonical = await realpath(target.path);
      if (!samePath(workspacePath, canonical) && !isWithin(workspacePath, canonical)) {
        throw new Error(`工作区注册越出用户 ${String(user.id)} 的托管目录`);
      }
      const registration = await registry.create(canonical, target.title);
      if (registration.title !== target.title) await registration.setTitle(target.title);
    }
    if (!samePath(existing.path, workspacePath)) this.db.setManagedWorkspace(user.id, workspacePath);
  }

  /** Unregister every workspace under a deleted user's host root while retaining all files. */
  unregisterUser(registry: WorkspaceRegistry, userId: number): Promise<ManagedWorkspaceRegistration[]> {
    return this.enqueue(() => this.unregisterUserNow(registry, userId));
  }

  private async unregisterUserNow(
    registry: WorkspaceRegistry,
    userId: number,
  ): Promise<ManagedWorkspaceRegistration[]> {
    const managed = this.db.getManagedWorkspace(userId);
    if (managed === null) return [];
    const registrations = registry.list().filter((workspace) =>
      samePath(workspace.path, managed.path) || isWithin(managed.path, workspace.path));
    const removed: ManagedWorkspaceRegistration[] = [];
    try {
      for (const registration of registrations) {
        if (await registry.delete(registration.id)) {
          removed.push({ path: registration.path, title: registration.title });
        }
      }
      return removed;
    } catch (error) {
      const restoreFailures: unknown[] = [];
      for (const registration of removed) {
        try {
          const restored = await registry.create(registration.path, registration.title);
          if (restored.title !== registration.title) await restored.setTitle(registration.title);
        } catch (restoreError) {
          restoreFailures.push(restoreError);
        }
      }
      if (restoreFailures.length > 0) {
        throw new AggregateError([error, ...restoreFailures], '撤销子用户工作区失败，且部分注册恢复失败');
      }
      throw error;
    }
  }

  private async provisionExistingUser(registry: WorkspaceRegistry, user: UserListRow): Promise<void> {
    const workspacePath = await this.prepareDirectory(user.id, null);
    const beforeRegistration = await registry.resolveByPath(workspacePath);
    let registration: Workspace | undefined;
    try {
      registration = beforeRegistration ?? await registry.create(workspacePath, workspaceTitle(user));
      if (registration.title !== workspaceTitle(user)) await registration.setTitle(workspaceTitle(user));
      this.db.setManagedWorkspace(user.id, workspacePath);
      const permissions = this.db.getPermissions(user.id);
      this.db.setPermissions(user.id, mergedPermissions(workspacePath, permissions));
    } catch (error) {
      this.db.deleteManagedWorkspace(user.id);
      if (beforeRegistration === undefined && registration !== undefined) {
        await registry.delete(registration.id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async prepareDirectory(userId: number, recordedPath: string | null): Promise<string> {
    const baseName = `u${String(userId)}`;
    let parent: string;
    let directoryName: string;
    if (recordedPath === null) {
      parent = await this.managedRoot();
      directoryName = await reserveDirectory(parent, baseName);
    } else {
      const resolved = path.resolve(recordedPath);
      directoryName = path.basename(resolved);
      if (!managedDirectoryName(userId, directoryName)) {
        throw new Error(`用户 ${String(userId)} 的托管工作区路径与稳定目录名不匹配`);
      }
      parent = await ensureDirectory(path.dirname(resolved));
      const recordedDirectory = path.join(parent, directoryName);
      await mkdir(recordedDirectory, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
        if (!isAlreadyExists(error)) throw error;
      });
    }
    const workspacePath = path.join(parent, directoryName);
    const info = await lstat(workspacePath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`托管工作区不是普通目录：${workspacePath}`);
    }
    if (process.platform !== 'win32') await chmod(workspacePath, 0o700);
    const canonical = await realpath(workspacePath);
    if (path.basename(canonical) !== directoryName || !isWithin(parent, canonical)) {
      throw new Error(`托管工作区解析到了预期父目录之外：${workspacePath}`);
    }
    return canonical;
  }

  private managedRoot(): Promise<string> {
    this.rootPromise ??= this.loadManagedRoot();
    return this.rootPromise;
  }

  private async loadManagedRoot(): Promise<string> {
    const configured = path.resolve(this.config.managedWorkspaceRoot);
    if (configured === path.parse(configured).root) throw new Error('托管工作区根目录不能是文件系统根目录');
    const dbDirectory = path.resolve(path.dirname(this.config.dbPath));
    if (samePath(dbDirectory, configured) || isWithin(dbDirectory, configured)) {
      throw new Error('托管工作区根目录不能位于数据库数据目录内');
    }
    return ensureDirectory(configured);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function mergedPermissions(
  workspacePath: string,
  current: UserPermissionsRow | null,
): Parameters<Database['setPermissions']>[1] {
  if (current === null) {
    return {
      allowedFolders: [workspacePath],
      hourlyTokenLimit: null,
      dailyMinutesLimit: null,
      monthlyBudgetMicros: 0,
      allowUpload: true,
      allowGitDownload: false,
      banned: false,
      sandboxMode: MANAGED_WORKSPACE_SANDBOX,
      disabledSessions: [],
    };
  }
  const allowedFolders = current.allowed_folders.length === 0
    ? [workspacePath]
    : current.allowed_folders.some((entry) => samePath(entry, workspacePath))
      ? current.allowed_folders
      : current.allowed_folders.length === 1 && current.allowed_folders[0] === '__deny__'
        ? [workspacePath]
        : [...current.allowed_folders, workspacePath];
  return {
    allowedFolders,
    hourlyTokenLimit: current.hourly_token_limit,
    dailyMinutesLimit: current.daily_minutes_limit,
    monthlyBudgetMicros: current.monthly_budget_micros,
    allowUpload: current.allow_upload,
    allowGitDownload: current.allow_git_download,
    banned: current.banned,
    sandboxMode: current.sandbox_mode ?? MANAGED_WORKSPACE_SANDBOX,
    disabledSessions: current.disabled_sessions,
  };
}

async function ensureDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`托管工作区根路径不是普通目录：${directory}`);
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  return realpath(directory);
}

function workspaceTitle(user: UserListRow): string {
  return `${user.username} · 专属工作区`;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

async function reserveDirectory(parent: string, baseName: string): Promise<string> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const directoryName = attempt === 0 ? baseName : `${baseName}-${randomBytes(6).toString('hex')}`;
    try {
      await mkdir(path.join(parent, directoryName), { recursive: false, mode: 0o700 });
      return directoryName;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  throw new Error(`无法为 ${baseName} 分配唯一的托管工作区目录`);
}

function managedDirectoryName(userId: number, directoryName: string): boolean {
  return new RegExp(`^u${String(userId)}(?:-[0-9a-f]{12})?$`).test(directoryName);
}
