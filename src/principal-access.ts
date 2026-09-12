/** Host authorization for principal-scoped Session and Workspace reads. */

import type { Context } from '@deepseek-ai/cordis';
import type {
  PrincipalAccessResult,
  PrincipalAccessSubjects,
} from '@deepseek-ai/dsh-principal-access';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Database, UserPermissionsRow } from './db.js';
import type { AuthenticatedPrincipal } from './principal.js';
import { customerModelAllowed } from './model-policy.js';

interface WorkspaceRecord {
  readonly id: string;
  readonly path: string;
}

interface SessionRecord {
  readonly header: {
    readonly id: string;
    readonly cwd?: string;
    readonly parentSession?: string;
    readonly origin?: string;
  };
}

interface HostServices {
  get(name: string): unknown;
  provide(name: string, service: unknown): () => void;
}

const DENY_ALL_WORKSPACES = '__deny__';

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function defaultPermissions(userId: number): UserPermissionsRow {
  return {
    user_id: userId,
    allowed_folders: [DENY_ALL_WORKSPACES],
    hourly_token_limit: null,
    daily_minutes_limit: null,
    monthly_budget_micros: 0,
    allow_upload: true,
    allow_git_download: false,
    allow_workspace_create: false,
    allow_ssh: false,
    // 缺行时由 DENY_ALL_WORKSPACES 拦截；空数组会隐式变成“一个 preset 都不许用”
    allowed_agent_presets: null,
    banned: false,
    sandbox_mode: null,
    disabled_sessions: [],
    updated_at: '',
  };
}

/** Resolve Harness read access from dsh-passwords account, ownership, and folder records. */
export class DshPasswordsPrincipalAccessProvider {
  constructor(
    private readonly ctx: Context,
    private readonly db: Database,
  ) {}

  /** Return only the requested Session and Workspace ids that this account may read. */
  async resolve(
    principal: AuthenticatedPrincipal,
    subjects: PrincipalAccessSubjects,
    signal?: AbortSignal,
  ): Promise<PrincipalAccessResult> {
    signal?.throwIfAborted();
    const requestedSessions = [...new Set(subjects.sessionIds ?? [])];
    const requestedWorkspaces = [...new Set(subjects.workspaceIds ?? [])];
    const denied: PrincipalAccessResult = {
      readableSessionIds: new Set(),
      readableWorkspaceIds: new Set(),
    };
    const user = this.authenticatedUser(principal);
    if (user === null) return denied;
    if (user.role === 'admin') {
      return {
        readableSessionIds: new Set(requestedSessions),
        readableWorkspaceIds: new Set(requestedWorkspaces),
      };
    }

    const permissions = this.db.getPermissions(user.id) ?? defaultPermissions(user.id);
    if (permissions.banned) return denied;
    const services = this.ctx.root as unknown as HostServices;
    const registry = services.get('workspaceRegistry') as { list(): readonly WorkspaceRecord[] } | undefined;
    const query = services.get('sessionQuery') as {
      listSessions(signal?: AbortSignal): Promise<readonly SessionRecord[]>;
    } | undefined;
    if (registry === undefined || (requestedSessions.length > 0 && query === undefined)) return denied;

    const workspacePaths = new Map(registry.list().map((workspace) => [String(workspace.id), workspace.path]));
    const pathDecisions = new Map<string, Promise<boolean>>();
    const pathAllowed = (candidate: string): Promise<boolean> => {
      const cached = pathDecisions.get(candidate);
      if (cached !== undefined) return cached;
      const pending = this.pathAllowed(user.id, candidate, permissions.allowed_folders);
      pathDecisions.set(candidate, pending);
      return pending;
    };

    const readableWorkspaceIds = new Set<WorkspaceId>();
    for (const workspaceId of requestedWorkspaces) {
      const workspacePath = workspacePaths.get(workspaceId);
      if (workspacePath !== undefined && await pathAllowed(workspacePath)) readableWorkspaceIds.add(workspaceId);
    }

    const readableSessionIds = new Set<SessionId>();
    if (requestedSessions.length > 0 && query !== undefined) {
      const records = await query.listSessions(signal);
      signal?.throwIfAborted();
      const headers = new Map(records.map((record) => [String(record.header.id), record.header]));
      const disabled = new Set(permissions.disabled_sessions);
      for (const sessionId of requestedSessions) {
        // Only Host-recorded subagents inherit an unclaimed parent's account.
        // Explicit ownership and disabled sessions stop traversal immediately.
        const seen = new Set<string>();
        let current: string | undefined = sessionId;
        while (current !== undefined && !seen.has(current)) {
          signal?.throwIfAborted();
          seen.add(current);
          const header = headers.get(current);
          if (disabled.has(current) || header?.cwd === undefined || !await pathAllowed(header.cwd)) break;
          const owner = this.db.getSessionOwner(current);
          if (owner !== null) {
            if (owner === user.id) readableSessionIds.add(sessionId);
            break;
          }
          current = header.origin === 'subagent' ? header.parentSession : undefined;
        }
      }
    }
    signal?.throwIfAborted();
    return { readableSessionIds, readableWorkspaceIds };
  }

  /**
   * Reject stale or disabled identities before accessing account data without a Session id.
   * @param principal Identity already verified by the Host transport or message log.
   */
  assertAuthenticated(principal: AuthenticatedPrincipal): void {
    const user = this.authenticatedUser(principal);
    if (user === null || this.db.getPermissions(user.id)?.banned) {
      throw new Error('authenticated active account required');
    }
  }

  /**
   * Apply the same model policy to plugin-owned model selectors and settings.
   * @param principal Host-authenticated account requesting the model.
   * @param provider Provider route id.
   * @param model Model id within the provider.
   * @returns whether this active account may select the route.
   */
  modelAllowed(principal: AuthenticatedPrincipal, provider: string, model: string): boolean {
    this.assertAuthenticated(principal);
    return principal.role === 'admin' || customerModelAllowed(provider, model);
  }

  /**
   * Authorize one account's SSH operation and identify its legacy connections for migration.
   * @param principal Identity verified by the Host transport or persisted user message.
   * @returns Owned aliases and the administrator's exclusion list for unclaimed legacy connections.
   */
  sshAccess(principal: AuthenticatedPrincipal): {
    legacyAliases: string[];
    includeUnownedLegacy: boolean;
    claimedLegacyAliases: string[];
  } {
    this.assertAuthenticated(principal);
    const userId = Number(principal.id);
    const permissions = this.db.getPermissions(userId) ?? defaultPermissions(userId);
    if (principal.role !== 'admin' && !permissions.allow_ssh) throw new Error('SSH access is disabled for this account');
    const firstAdminId = principal.role === 'admin'
      ? this.db.listUsers().filter((user) => user.role === 'admin').sort((left, right) => left.id - right.id)[0]?.id
      : undefined;
    const includeUnownedLegacy = userId === firstAdminId;
    return {
      legacyAliases: this.db.listSshHostAliases(userId),
      includeUnownedLegacy,
      claimedLegacyAliases: includeUnownedLegacy ? this.db.listClaimedSshHostAliases() : [],
    };
  }

  private authenticatedUser(principal: AuthenticatedPrincipal) {
    if (principal.source !== 'dsh-passwords' || !/^[1-9][0-9]*$/u.test(principal.id)) return null;
    const userId = Number(principal.id);
    if (!Number.isSafeInteger(userId)) return null;
    const user = this.db.getUserListRowById(userId);
    return user !== null && user.username === principal.username && user.role === principal.role ? user : null;
  }

  private async pathAllowed(userId: number, candidate: string, allowedFolders: readonly string[]): Promise<boolean> {
    const canonical = await realpath(candidate).catch(() => undefined);
    if (canonical === undefined) return false;
    const localOwner = this.db.localWorkspaceOwnerForPath(canonical);
    if (localOwner !== null) return localOwner === userId;
    const managedOwner = this.db.managedWorkspaceOwnerForPath(canonical);
    if (managedOwner !== null) return managedOwner === userId;
    if (allowedFolders.includes(DENY_ALL_WORKSPACES)) return false;
    if (allowedFolders.length === 0) return true;
    for (const allowedFolder of allowedFolders) {
      const allowed = await realpath(allowedFolder).catch(() => undefined);
      if (allowed !== undefined && isWithin(allowed, canonical)) return true;
    }
    return false;
  }
}

/** Publish the deployment provider at root for already-mounted Harness API services. */
export function registerPrincipalAccess(
  ctx: Context,
  db: Database,
): DshPasswordsPrincipalAccessProvider {
  const provider = new DshPasswordsPrincipalAccessProvider(ctx, db);
  ctx.effect(
    () => (ctx.root as unknown as HostServices).provide('principalAccess', provider),
    'dsh-passwords: principal access provider',
  );
  return provider;
}
