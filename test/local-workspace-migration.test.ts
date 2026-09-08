import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { legacyLocalWorkspaceRegistration, LocalWorkspaceHub } from '../src/local-workspace-hub.js';

interface Registration {
  id: string;
  path: string;
  title: string;
}

class MigrationRegistry {
  readonly registrations: Registration[] = [];
  readonly operations: string[] = [];
  maxConcurrentCreates = 0;
  private concurrentCreates = 0;
  private failDeleteOnce = new Set<string>();
  private falseDeleteOnce = new Set<string>();
  private createGate: { started(): void; wait: Promise<void> } | null = null;

  async seed(workspacePath: string, title = 'legacy'): Promise<void> {
    this.registrations.push({
      id: `seed-${String(this.registrations.length + 1)}`,
      path: await realpath(workspacePath),
      title,
    });
  }

  failNextDelete(workspacePath: string): void {
    this.failDeleteOnce.add(path.resolve(workspacePath));
  }

  returnFalseNextDelete(workspacePath: string): void {
    this.falseDeleteOnce.add(path.resolve(workspacePath));
  }

  holdNextCreate(): { started: Promise<void>; release(): void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.createGate = { started: markStarted, wait };
    return { started, release };
  }

  async create(workspacePath: string, title = path.basename(workspacePath)): Promise<Registration> {
    this.concurrentCreates += 1;
    this.maxConcurrentCreates = Math.max(this.maxConcurrentCreates, this.concurrentCreates);
    try {
      const gate = this.createGate;
      this.createGate = null;
      if (gate !== null) {
        gate.started();
        await gate.wait;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const canonical = await realpath(workspacePath);
      const existing = this.registrations.find((entry) => entry.path === canonical);
      if (existing !== undefined) return existing;
      const created = {
        id: `created-${String(this.registrations.length + 1)}`,
        path: canonical,
        title,
      };
      this.registrations.unshift(created);
      this.operations.push(`create:${canonical}`);
      return created;
    } finally {
      this.concurrentCreates -= 1;
    }
  }

  list(): Registration[] {
    return [...this.registrations];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.registrations.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const registration = this.registrations[index]!;
    this.operations.push(`delete:${registration.path}`);
    if (this.failDeleteOnce.delete(registration.path)) throw new Error('transient registry delete failure');
    this.registrations.splice(index, 1);
    if (this.falseDeleteOnce.delete(registration.path)) return false;
    return true;
  }
}

test('startup migrates active local workspaces before removing only exact release registrations', async (t) => {
  const harness = await migrationHarness();
  t.after(harness.cleanup);
  const registry = new MigrationRegistry();
  await registry.seed(harness.legacyOne);
  await registry.seed(harness.legacyTwo);
  await registry.seed(harness.lookalike);

  await Promise.all([
    harness.hub.restoreWorkspaces(registry as unknown as WorkspaceRegistry),
    harness.hub.restoreWorkspaces(registry as unknown as WorkspaceRegistry),
  ]);

  const stablePath = await realpath(harness.stablePath);
  assert.equal(harness.db.getLocalWorkspace(harness.workspaceId)?.placeholder_path, stablePath);
  assert.deepEqual(registry.registrations.map((entry) => entry.path).sort(), [
    await realpath(harness.lookalike),
    stablePath,
  ].sort());
  assert.equal(registry.maxConcurrentCreates, 1, 'concurrent restore calls must serialize registry mutations');
  const createIndex = registry.operations.indexOf(`create:${stablePath}`);
  const firstDeleteIndex = registry.operations.findIndex((entry) => entry.startsWith('delete:'));
  assert.ok(createIndex >= 0 && firstDeleteIndex > createIndex, 'stable registration must commit before legacy deletion');
  assert.equal(await readFile(path.join(harness.legacyOne, 'retained-session.log'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(harness.legacyTwo, 'retained-file.txt'), 'utf8'), 'keep');
});

test('a partial Host cleanup retries from the stable database path without deleting files', async (t) => {
  const harness = await migrationHarness();
  t.after(harness.cleanup);
  const registry = new MigrationRegistry();
  await registry.seed(harness.legacyOne);
  await registry.seed(harness.legacyTwo);
  registry.failNextDelete(await realpath(harness.legacyOne));

  await assert.rejects(
    harness.hub.restoreWorkspaces(registry as unknown as WorkspaceRegistry),
    /1 个本机工作区恢复失败/,
  );
  const stablePath = await realpath(harness.stablePath);
  assert.equal(harness.db.getLocalWorkspace(harness.workspaceId)?.placeholder_path, stablePath);
  assert.ok(registry.registrations.some((entry) => entry.path === stablePath));

  await harness.hub.restoreWorkspaces(registry as unknown as WorkspaceRegistry);
  assert.deepEqual(registry.registrations.map((entry) => entry.path), [stablePath]);
  assert.equal(await readFile(path.join(harness.legacyOne, 'retained-session.log'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(harness.legacyTwo, 'retained-file.txt'), 'utf8'), 'keep');
});

test('restore and revoke serialize so neither stable nor legacy registrations survive revocation', async (t) => {
  const harness = await migrationHarness();
  t.after(harness.cleanup);
  const registry = new MigrationRegistry();
  await registry.seed(harness.legacyOne);
  await registry.seed(harness.legacyTwo);
  await registry.seed(harness.lookalike);
  harness.setRegistry(registry);
  const gate = registry.holdNextCreate();

  const restoring = harness.hub.restoreWorkspaces(registry as unknown as WorkspaceRegistry);
  await gate.started;
  let revokeSettled = false;
  const revoking = harness.hub.revoke(harness.userId, harness.workspaceId).then((result) => {
    revokeSettled = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(revokeSettled, false, 'revoke must wait for the in-flight restore mutation');

  gate.release();
  await restoring;
  assert.equal(await revoking, true);
  assert.notEqual(harness.db.getLocalWorkspace(harness.workspaceId)?.revoked_at, null);
  assert.deepEqual(registry.registrations.map((entry) => entry.path), [await realpath(harness.lookalike)]);
  assert.equal(await readFile(path.join(harness.legacyOne, 'retained-session.log'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(harness.legacyTwo, 'retained-file.txt'), 'utf8'), 'keep');
});

test('revoke completes a partial restore cleanup and remains retryable when registry deletion throws', async (t) => {
  const harness = await migrationHarness();
  t.after(harness.cleanup);
  const registry = new MigrationRegistry();
  await registry.seed(harness.legacyOne);
  await registry.seed(harness.legacyTwo);
  harness.setRegistry(registry);
  registry.failNextDelete(await realpath(harness.legacyTwo));

  await assert.rejects(
    harness.hub.restoreWorkspaces(registry as unknown as WorkspaceRegistry),
    /1 个本机工作区恢复失败/,
  );
  const stablePath = await realpath(harness.stablePath);
  assert.deepEqual(registry.registrations.map((entry) => entry.path).sort(), [
    await realpath(harness.legacyTwo),
    stablePath,
  ].sort());

  registry.failNextDelete(stablePath);
  await assert.rejects(harness.hub.revoke(harness.userId, harness.workspaceId), /transient registry delete failure/);
  assert.equal(harness.db.getLocalWorkspace(harness.workspaceId)?.revoked_at, null);

  registry.returnFalseNextDelete(await realpath(harness.legacyTwo));
  assert.equal(await harness.hub.revoke(harness.userId, harness.workspaceId), true);
  assert.notEqual(harness.db.getLocalWorkspace(harness.workspaceId)?.revoked_at, null);
  assert.deepEqual(registry.registrations, []);
  assert.equal(await readFile(path.join(harness.legacyOne, 'retained-session.log'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(harness.legacyTwo, 'retained-file.txt'), 'utf8'), 'keep');
});

test('revoke removes the durable registration when the configured stable root changed before restore', async (t) => {
  const harness = await migrationHarness('previous-stable');
  t.after(harness.cleanup);
  const registry = new MigrationRegistry();
  await registry.seed(harness.previousStable);
  await registry.seed(harness.lookalike);
  harness.setRegistry(registry);

  assert.equal(await harness.hub.revoke(harness.userId, harness.workspaceId), true);
  assert.notEqual(harness.db.getLocalWorkspace(harness.workspaceId)?.revoked_at, null);
  assert.deepEqual(registry.registrations.map((entry) => entry.path), [await realpath(harness.lookalike)]);
  assert.equal(await readFile(path.join(harness.previousStable, 'retained-previous.txt'), 'utf8'), 'keep');
});

test('legacy registration matching requires package root, owner and workspace digest', () => {
  const workspaceId = 'local-workspace-identity';
  const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  const stable = path.join('/srv/dsh-local-workspaces', 'u2', digest);
  assert.equal(legacyLocalWorkspaceRegistration(
    path.join('/srv/releases/r1/node_modules/dsh-passwords/data/local-workspaces', 'u2', digest),
    stable,
    2,
    workspaceId,
  ), true);
  assert.equal(legacyLocalWorkspaceRegistration(stable, stable, 2, workspaceId), false);
  assert.equal(legacyLocalWorkspaceRegistration(
    path.join('/srv/releases/r1/node_modules/another-plugin/data/local-workspaces', 'u2', digest),
    stable,
    2,
    workspaceId,
  ), false);
  assert.equal(legacyLocalWorkspaceRegistration(
    path.join('/srv/releases/r1/node_modules/dsh-passwords/data/local-workspaces', 'u3', digest),
    stable,
    2,
    workspaceId,
  ), false);
});

async function migrationHarness(initialPath: 'legacy' | 'previous-stable' = 'legacy'): Promise<{
  db: Database;
  hub: LocalWorkspaceHub;
  userId: number;
  workspaceId: string;
  stablePath: string;
  legacyOne: string;
  legacyTwo: string;
  previousStable: string;
  lookalike: string;
  setRegistry(registry: MigrationRegistry): void;
  cleanup(): Promise<void>;
}> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-local-migration-'));
  const dbPath = path.join(temporary, 'platform.db');
  const stableRoot = path.join(temporary, 'stable-local-workspaces');
  const workspaceId = 'kcmac-workspace-id';
  const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  const legacyOne = path.join(
    temporary,
    'releases',
    'one',
    'node_modules',
    'dsh-passwords',
    'data',
    'local-workspaces',
    'u2',
    digest,
  );
  const legacyTwo = path.join(
    temporary,
    'releases',
    'two',
    'node_modules',
    'dsh-passwords',
    'data',
    'local-workspaces',
    'u2',
    digest,
  );
  const previousStable = path.join(temporary, 'previous-stable-root', 'u2', digest);
  const lookalike = path.join(
    temporary,
    'releases',
    'other',
    'node_modules',
    'another-plugin',
    'data',
    'local-workspaces',
    'u2',
    digest,
  );
  await Promise.all([legacyOne, legacyTwo, previousStable, lookalike]
    .map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(path.join(legacyOne, 'retained-session.log'), 'keep');
  await writeFile(path.join(legacyTwo, 'retained-file.txt'), 'keep');
  await writeFile(path.join(previousStable, 'retained-previous.txt'), 'keep');

  const db = new Database(dbPath, createFieldCrypto('migration-encryption-key', 'migration-setup-key'));
  db.init();
  db.createUser('admin', 'hash', 'admin');
  const user = db.createUser('owner', 'hash', 'user');
  assert.equal(user.id, 2);
  db.createLocalWorkspace({
    id: workspaceId,
    userId: user.id,
    token: 'A'.repeat(43),
    deviceName: 'kmMac',
    workspaceName: '2026-8-11 9：00桓台县少海花园住宅老旧电',
    remoteRoot: '/Users/km/project',
    placeholderPath: initialPath === 'legacy' ? legacyTwo : previousStable,
    platform: 'darwin',
    shellEnabled: true,
  });
  const config: PlatformConfig = {
    setupKey: 'migration-setup-key',
    dbPath,
    dbEncKey: 'migration-encryption-key',
    gateway: {
      host: '127.0.0.1', port: 0, upstream: 'http://127.0.0.1:3080', tls: null,
      redirectPort: null, publicHost: '', domain: '', autoTls: false, acmeEmail: '', acmeStaging: false,
    },
    jwtSecret: 'jwt',
    internalSecret: 'internal',
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: stableRoot },
    managedWorkspaceRoot: path.join(temporary, 'managed'),
    patch: { dshRoot: '', restartService: '' },
  };
  let activeRegistry: WorkspaceRegistry | undefined;
  const ctx = {
    get(name: string) {
      return name === 'workspaceRegistry' ? activeRegistry : undefined;
    },
  } as unknown as Context;
  return {
    db,
    hub: new LocalWorkspaceHub(ctx, db, config),
    userId: user.id,
    workspaceId,
    stablePath: path.join(stableRoot, `u${String(user.id)}`, digest),
    legacyOne,
    legacyTwo,
    previousStable,
    lookalike,
    setRegistry(registry) {
      activeRegistry = registry as unknown as WorkspaceRegistry;
    },
    async cleanup() {
      db.close();
      await rm(temporary, { recursive: true, force: true });
    },
  };
}
