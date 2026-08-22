import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { AuthService } from '../src/auth.js';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { ManagedWorkspaceProvisioner } from '../src/managed-workspace.js';

class FakeWorkspaceRegistry {
  readonly workspaces: Array<{
    id: string;
    path: string;
    title: string;
    setTitle(title: string): Promise<void>;
  }> = [];

  async create(workspacePath: string, title = path.basename(workspacePath)) {
    const canonical = await realpath(workspacePath);
    const existing = this.workspaces.find((workspace) => workspace.path === canonical);
    if (existing !== undefined) return existing;
    const workspace = {
      id: `workspace-${String(this.workspaces.length + 1)}`,
      path: canonical,
      title,
      async setTitle(next: string) {
        workspace.title = next;
      },
    };
    this.workspaces.unshift(workspace);
    return workspace;
  }

  async resolveByPath(workspacePath: string) {
    const canonical = await realpath(workspacePath);
    return this.workspaces.find((workspace) => workspace.path === canonical);
  }

  list() {
    return [...this.workspaces];
  }

  async delete(id: string) {
    const index = this.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) return false;
    this.workspaces.splice(index, 1);
    return true;
  }
}

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-passwords-managed-'));
  const dbPath = path.join(directory, 'data', 'platform.db');
  const config: PlatformConfig = {
    setupKey: 'setup',
    dbPath,
    dbEncKey: 'enc',
    gateway: {
      host: '127.0.0.1', port: 8080, upstream: 'http://127.0.0.1:3080', tls: null,
      redirectPort: null, publicHost: '', domain: '', autoTls: false, acmeEmail: '', acmeStaging: false,
    },
    jwtSecret: 'jwt',
    internalSecret: 'internal',
    localWorkspace: { host: '127.0.0.1', port: 8081, publicUrl: '' },
    managedWorkspaceRoot: path.join(directory, 'users'),
    patch: { dshRoot: '', restartService: '' },
  };
  const db = new Database(dbPath, createFieldCrypto(config.dbEncKey, config.setupKey));
  db.init();
  db.setupInitialAdmin('admin', await bcrypt.hash('AdminPassword1!', 4));
  const cleanup = async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, config, db, cleanup };
}

test('new subuser receives a private registered workspace with workspace-write permissions', async () => {
  const env = await harness();
  try {
    const created = env.db.createUser('alice', await bcrypt.hash('UserPassword1!', 4), 'user');
    const user = env.db.getUserListRowById(created.id)!;
    const registry = new FakeWorkspaceRegistry();
    const provisioner = new ManagedWorkspaceProvisioner(env.db, env.config);

    const workspacePath = await provisioner.provisionNewUser(registry as unknown as WorkspaceRegistry, user);

    assert.equal(workspacePath, path.join(await realpath(env.config.managedWorkspaceRoot), `u${String(user.id)}`));
    assert.equal((await stat(workspacePath)).isDirectory(), true);
    if (process.platform !== 'win32') assert.equal((await stat(workspacePath)).mode & 0o777, 0o700);
    assert.equal(registry.workspaces.length, 1);
    assert.equal(registry.workspaces[0].path, workspacePath);
    assert.equal(env.db.getManagedWorkspace(user.id)?.path, workspacePath);
    const permissions = env.db.getPermissions(user.id)!;
    assert.deepEqual(permissions.allowed_folders, [workspacePath]);
    assert.equal(permissions.sandbox_mode, 'workspace-write');
  } finally {
    await env.cleanup();
  }
});

test('startup backfills existing subusers and preserves their explicit quotas and sandbox restriction', async () => {
  const env = await harness();
  try {
    const created = env.db.createUser('legacy', await bcrypt.hash('UserPassword1!', 4), 'user');
    const extra = path.join(env.directory, 'existing-project');
    env.db.setPermissions(created.id, {
      allowedFolders: [extra], hourlyTokenLimit: 123, dailyMinutesLimit: 45, monthlyBudgetMicros: 6_000_000,
      allowUpload: false, allowGitDownload: true, banned: false, sandboxMode: 'read-only', disabledSessions: ['s1'],
    });
    const registry = new FakeWorkspaceRegistry();
    const provisioner = new ManagedWorkspaceProvisioner(env.db, env.config);

    await provisioner.restore(registry as unknown as WorkspaceRegistry);

    const managed = env.db.getManagedWorkspace(created.id)!;
    const permissions = env.db.getPermissions(created.id)!;
    assert.deepEqual(permissions.allowed_folders, [extra, managed.path]);
    assert.equal(permissions.hourly_token_limit, 123);
    assert.equal(permissions.daily_minutes_limit, 45);
    assert.equal(permissions.monthly_budget_micros, 6_000_000);
    assert.equal(permissions.sandbox_mode, 'read-only');
    assert.deepEqual(permissions.disabled_sessions, ['s1']);

    const restartedRegistry = new FakeWorkspaceRegistry();
    await provisioner.restore(restartedRegistry as unknown as WorkspaceRegistry);
    assert.equal(restartedRegistry.workspaces[0].path, managed.path);
  } finally {
    await env.cleanup();
  }
});

test('removing a subuser unregisters access but retains the host directory', async () => {
  const env = await harness();
  try {
    const created = env.db.createUser('alice', await bcrypt.hash('UserPassword1!', 4), 'user');
    const user = env.db.getUserListRowById(created.id)!;
    const registry = new FakeWorkspaceRegistry();
    const provisioner = new ManagedWorkspaceProvisioner(env.db, env.config);
    const workspacePath = await provisioner.provisionNewUser(registry as unknown as WorkspaceRegistry, user);

    await provisioner.unregisterUser(registry as unknown as WorkspaceRegistry, user.id);
    env.db.deleteUser(user.id);

    assert.equal(registry.workspaces.length, 0);
    assert.equal((await stat(workspacePath)).isDirectory(), true);
    assert.equal(env.db.getManagedWorkspace(user.id), null);
  } finally {
    await env.cleanup();
  }
});

test('managed workspace ownership includes descendants and excludes sibling users', async () => {
  const env = await harness();
  try {
    const first = env.db.createUser('alice', await bcrypt.hash('UserPassword1!', 4), 'user');
    const second = env.db.createUser('bob', await bcrypt.hash('UserPassword1!', 4), 'user');
    const registry = new FakeWorkspaceRegistry();
    const provisioner = new ManagedWorkspaceProvisioner(env.db, env.config);
    const firstPath = await provisioner.provisionNewUser(
      registry as unknown as WorkspaceRegistry,
      env.db.getUserListRowById(first.id)!,
    );
    await provisioner.provisionNewUser(
      registry as unknown as WorkspaceRegistry,
      env.db.getUserListRowById(second.id)!,
    );

    assert.equal(env.db.managedWorkspaceOwnerForPath(path.join(firstPath, 'src', 'index.ts')), first.id);
    assert.equal(env.db.managedWorkspaceOwnerForPath(env.config.managedWorkspaceRoot), null);
    assert.notEqual(env.db.managedWorkspaceOwnerForPath(path.join(firstPath, 'file.txt')), second.id);
  } finally {
    await env.cleanup();
  }
});

test('failed workspace provisioning rolls back the newly created account', async () => {
  const env = await harness();
  try {
    const auth = new AuthService(env.config, env.db);
    await assert.rejects(
      auth.addSubUser(
        { userId: 1, username: 'admin', role: 'admin' },
        'failed-user',
        'UserPassword1!',
        async () => { throw new Error('workspace registry unavailable'); },
      ),
      /workspace registry unavailable/,
    );
    assert.equal(env.db.getUserByUsername('failed-user'), null);
  } finally {
    await env.cleanup();
  }
});
