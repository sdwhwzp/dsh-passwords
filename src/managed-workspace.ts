/** Host-side workspace provisioning for dsh-passwords subusers. */

import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { PlatformConfig } from './config.js';
import { Database, type UserListRow, type UserPermissionsRow } from './db.js';

/** The sandbox level that permits writes inside a session workspace only. */
export const MANAGED_WORKSPACE_SANDBOX = 'workspace-write';

/** Creates, registers, restores, and revokes host directories owned by subusers. */
export class ManagedWorkspaceProvisioner {
  private rootPromise: Promise<string> | null = null;

  constructor(
    private readonly db: Database,
    private readonly config: PlatformConfig,
  ) {}

  /** Create the durable directory and permission assignment for a new subuser. */
  async provisionNewUser(registry: WorkspaceRegistry, user: UserListRow): Promise<string> {
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
  async restore(registry: WorkspaceRegistry): Promise<void> {
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
  async restoreUser(registry: WorkspaceRegistry, user: UserListRow): Promise<void> {
    const existing = this.db.getManagedWorkspace(user.id);
    if (existing === null) throw new Error(`用户 ${String(user.id)} 没有托管工作区记录`);
    const workspacePath = await this.prepareDirectory(user.id, existing.path);
    const registration = await registry.create(workspacePath, workspaceTitle(user));
    if (registration.title !== workspaceTitle(user)) await registration.setTitle(workspaceTitle(user));
    if (!samePath(existing.path, workspacePath)) this.db.setManagedWorkspace(user.id, workspacePath);
  }

  /** Unregister a deleted user's host workspace while retaining every file and session log. */
  async unregisterUser(registry: WorkspaceRegistry, userId: number): Promise<boolean> {
    const managed = this.db.getManagedWorkspace(userId);
    if (managed === null) return false;
    const registration = registry.list().find((workspace) => samePath(workspace.path, managed.path));
    return registration === undefined ? false : registry.delete(registration.id);
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
    const expectedName = `u${String(userId)}`;
    let parent: string;
    if (recordedPath === null) {
      parent = await this.managedRoot();
    } else {
      const resolved = path.resolve(recordedPath);
      if (path.basename(resolved) !== expectedName) {
        throw new Error(`用户 ${String(userId)} 的托管工作区路径与稳定目录名不匹配`);
      }
      parent = await ensureDirectory(path.dirname(resolved));
    }
    const workspacePath = path.join(parent, expectedName);
    await mkdir(workspacePath, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
      if (!isAlreadyExists(error)) throw error;
    });
    const info = await lstat(workspacePath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`托管工作区不是普通目录：${workspacePath}`);
    }
    if (process.platform !== 'win32') await chmod(workspacePath, 0o700);
    const canonical = await realpath(workspacePath);
    if (path.basename(canonical) !== expectedName || !isWithin(parent, canonical)) {
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
    ? []
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
