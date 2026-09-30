import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { DshPasswordsPrincipalAccessProvider } from '../src/principal-access.js';

function hostContext(services: Map<string, unknown>): Context {
  return { root: { get: (name: string) => services.get(name) } } as unknown as Context;
}

test('cold session access reads only current target metadata and observes deletion and directory changes', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-cold-access-'));
  const ownRoot = path.join(temporary, 'own');
  const outsideRoot = path.join(temporary, 'outside');
  const linkedRoot = path.join(temporary, 'linked');
  await mkdir(ownRoot);
  await mkdir(outsideRoot);
  await symlink(ownRoot, linkedRoot);
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  try {
    db.init();
    const alice = db.createUser('alice', 'hash', 'user');
    db.setPermissions(alice.id, {
      allowedFolders: [ownRoot], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: true, allowGitDownload: false, banned: false,
    });
    db.claimSessionOwner('cold', alice.id);
    const records = new Map([
      ['cold', { header: { id: 'cold', cwd: ownRoot } }],
    ]);
    const statIds: string[] = [];
    let catalogReads = 0;
    const services = new Map<string, unknown>([
      ['workspaceRegistry', { list: () => [] }],
      ['sessionPersistence', { stat: async (id: string) => {
        statIds.push(id);
        return records.get(id);
      } }],
      ['sessionQuery', { listSessions: async () => {
        catalogReads += 1;
        return [...records.values()];
      } }],
    ]);
    const provider = new DshPasswordsPrincipalAccessProvider(hostContext(services), db);
    const principal = { source: 'dsh-passwords', id: String(alice.id), username: alice.username, role: 'user' } as const;
    const resolve = () => provider.resolve(principal, { sessionIds: ['cold'] });
    for (let read = 0; read < 3; read += 1) {
      assert.deepEqual([...(await resolve()).readableSessionIds], ['cold']);
    }
    assert.deepEqual(statIds, ['cold', 'cold', 'cold']);
    assert.equal(catalogReads, 0);

    records.delete('cold');
    assert.equal((await resolve()).readableSessionIds.size, 0);
    records.set('cold', { header: { id: 'cold', cwd: outsideRoot } });
    assert.equal((await resolve()).readableSessionIds.size, 0);
    records.set('cold', { header: { id: 'cold', cwd: linkedRoot } });
    assert.deepEqual([...(await resolve()).readableSessionIds], ['cold']);
    await rm(linkedRoot);
    await symlink(outsideRoot, linkedRoot);
    assert.equal((await resolve()).readableSessionIds.size, 0);
    records.set('cold', { header: { id: 'cold', cwd: ownRoot } });
    db.markSessionGrantsSeeded(alice.id);
    assert.deepEqual([...(await resolve()).readableSessionIds], ['cold']);
    db.deleteUserSessionGrants(alice.id, ['cold']);
    assert.equal((await resolve()).readableSessionIds.size, 0);
    assert.equal(catalogReads, 0);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('cold session access does not authorize failed, cancelled, or unavailable metadata reads', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-cold-access-failure-'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  try {
    db.init();
    const alice = db.createUser('alice', 'hash', 'user');
    db.setPermissions(alice.id, {
      allowedFolders: [temporary], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: true, allowGitDownload: false, banned: false,
    });
    db.claimSessionOwner('cold', alice.id);
    const services = new Map<string, unknown>([
      ['workspaceRegistry', { list: () => [] }],
      ['sessionPersistence', { stat: async () => { throw new Error('corrupt stored header'); } }],
      ['sessionQuery', { listSessions: async () => {
        throw new Error('unrelated corpus read');
      } }],
    ]);
    const provider = new DshPasswordsPrincipalAccessProvider(hostContext(services), db);
    const principal = { source: 'dsh-passwords', id: String(alice.id), username: alice.username, role: 'user' } as const;
    await assert.rejects(provider.resolve(principal, { sessionIds: ['cold'] }), /corrupt stored header/);

    const controller = new AbortController();
    services.set('sessionPersistence', { stat: async (id: string, options?: { signal?: AbortSignal }) => {
      assert.equal(id, 'cold');
      assert.equal(options?.signal, controller.signal);
      controller.abort(new Error('metadata read cancelled'));
      return { header: { id, cwd: temporary } };
    } });
    await assert.rejects(provider.resolve(principal, { sessionIds: ['cold'] }, controller.signal), /metadata read cancelled/);
    services.delete('sessionPersistence');
    assert.equal((await provider.resolve(principal, { sessionIds: ['cold'] })).readableSessionIds.size, 0);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('batch session access lists cold headers once per call and keeps live headers authoritative', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-batch-access-'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  try {
    db.init();
    const alice = db.createUser('alice', 'hash', 'user');
    db.setPermissions(alice.id, {
      allowedFolders: [temporary], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: true, allowGitDownload: false, banned: false,
    });
    const coldIds = Array.from({ length: 32 }, (_, index) => `cold-${index}`);
    for (const id of ['live', ...coldIds]) db.claimSessionOwner(id, alice.id);
    db.markSessionGrantsSeeded(alice.id);
    const records = new Map(coldIds.map((id) => [id, { header: { id, cwd: temporary } }]));
    records.set('live', { header: { id: 'live', cwd: path.join(temporary, 'missing-directory') } });
    let catalogReads = 0;
    let metadataReads = 0;
    const controller = new AbortController();
    const services = new Map<string, unknown>([
      ['workspaceRegistry', { list: () => [] }],
      ['sessions', { get: (id: string) => id === 'live' ? { header: { id, cwd: temporary } } : undefined }],
      ['sessionQuery', { listSessions: async (signal?: AbortSignal) => {
        assert.equal(signal, controller.signal);
        catalogReads += 1;
        return [...records.values()];
      } }],
      ['sessionPersistence', { stat: async (id: string) => {
        metadataReads += 1;
        return records.get(id);
      } }],
    ]);
    const provider = new DshPasswordsPrincipalAccessProvider(hostContext(services), db);
    const principal = { source: 'dsh-passwords', id: String(alice.id), username: alice.username, role: 'user' } as const;
    const requested = ['live', ...coldIds, 'missing'];
    const first = await provider.resolve(principal, { sessionIds: requested }, controller.signal);
    assert.deepEqual([...first.readableSessionIds], ['live', ...coldIds]);
    assert.equal(catalogReads, 1);
    assert.equal(metadataReads, 0);

    records.delete(coldIds[0]);
    db.deleteUserSessionGrants(alice.id, [coldIds[1]]);
    const second = await provider.resolve(principal, { sessionIds: requested }, controller.signal);
    assert.deepEqual([...second.readableSessionIds], ['live', ...coldIds.slice(2)]);
    assert.equal(catalogReads, 2);
    assert.equal(metadataReads, 0);

    services.set('sessionQuery', { listSessions: async () => { throw new Error('catalog read failed'); } });
    await assert.rejects(provider.resolve(principal, { sessionIds: requested }), /catalog read failed/);
    services.set('sessionQuery', { listSessions: async (signal?: AbortSignal) => {
      assert.equal(signal, controller.signal);
      controller.abort(new Error('catalog read cancelled'));
      return [...records.values()];
    } });
    await assert.rejects(provider.resolve(principal, { sessionIds: requested }, controller.signal), /catalog read cancelled/);
    services.delete('sessionQuery');
    assert.deepEqual([...(await provider.resolve(principal, { sessionIds: requested })).readableSessionIds], ['live']);
    assert.equal(metadataReads, 0);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('live session updates authorize without scanning the corpus and still observe revocation', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-live-access-'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  try {
    db.init();
    const alice = db.createUser('alice', 'hash', 'user');
    const bob = db.createUser('bob', 'hash', 'user');
    const permissions = {
      allowedFolders: [temporary], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: true, allowGitDownload: false, banned: false,
    };
    db.setPermissions(alice.id, permissions);
    db.claimSessionOwner('live', alice.id);
    db.claimSessionOwner('foreign', bob.id);
    db.claimSessionOwner('cold', alice.id);
    const records = new Map([
      ['live', { header: { id: 'live', cwd: temporary } }],
      ['child', { header: { id: 'child', cwd: temporary, origin: 'subagent', parentSession: 'live' } }],
      ['foreign', { header: { id: 'foreign', cwd: temporary } }],
    ]);
    let metadataReads = 0;
    let catalogReads = 0;
    const services = new Map<string, unknown>([
      ['workspaceRegistry', { list: () => [] }],
      ['sessions', { get: (id: string) => records.get(id) }],
      ['sessionQuery', { listSessions: async () => {
        catalogReads += 1;
        return [...records.values(), { header: { id: 'cold', cwd: temporary } }];
      } }],
      ['sessionPersistence', { stat: async (id: string) => {
        metadataReads += 1;
        return id === 'cold' ? { header: { id, cwd: temporary } } : records.get(id);
      } }],
    ]);
    const ctx = hostContext(services);
    const provider = new DshPasswordsPrincipalAccessProvider(ctx, db);
    const principal = { source: 'dsh-passwords', id: String(alice.id), username: alice.username, role: 'user' } as const;
    const live = await provider.resolve(principal, { sessionIds: ['live', 'child', 'foreign'] });
    assert.deepEqual([...live.readableSessionIds], ['live', 'child']);
    assert.equal(metadataReads, 0);
    assert.equal(catalogReads, 0);

    const mixed = await provider.resolve(principal, { sessionIds: ['live', 'cold', 'missing'] });
    assert.deepEqual([...mixed.readableSessionIds], ['live', 'cold']);
    assert.equal(metadataReads, 0);
    assert.equal(catalogReads, 1);
    db.setPermissions(alice.id, { ...permissions, disabledSessions: ['live'] });
    assert.equal((await provider.resolve(principal, { sessionIds: ['live', 'child'] })).readableSessionIds.size, 0);
    assert.equal(metadataReads, 0);
    assert.equal(catalogReads, 1);
    db.setPermissions(alice.id, { ...permissions, banned: true });
    assert.equal((await provider.resolve(principal, { sessionIds: ['live'] })).readableSessionIds.size, 0);
    db.setPermissions(alice.id, { ...permissions, allowedFolders: ['__deny__'] });
    assert.equal((await provider.resolve(principal, { sessionIds: ['live'] })).readableSessionIds.size, 0);
    db.setPermissions(alice.id, { ...permissions, disabledSessions: [] });
    services.delete('sessionPersistence');
    services.delete('sessionQuery');
    assert.deepEqual([...(await provider.resolve(principal, { sessionIds: ['live', 'cold'] })).readableSessionIds], ['live']);
    const aborted = AbortSignal.abort(new Error('access cancelled'));
    await assert.rejects(provider.resolve(principal, { sessionIds: ['live'] }, aborted), /access cancelled/);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('SSH access resolves legacy ownership for the active account and observes permission changes', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-principal-ssh-'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  try {
    db.init();
    const admin = db.createUser('admin', 'hash', 'admin');
    const alice = db.createUser('alice', 'hash', 'user');
    const bob = db.createUser('bob', 'hash', 'user');
    const otherAdmin = db.createUser('other-admin', 'hash', 'admin');
    const permissions = {
      allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: true, allowGitDownload: false, banned: false,
    };
    db.setPermissions(alice.id, permissions);
    assert.equal(db.getPermissions(alice.id)?.allow_ssh, false);
    db.setPermissions(alice.id, { ...permissions, allowSsh: true });
    db.claimSshHost('alice-host', alice.id);
    db.claimSshHost('bob-host', bob.id);
    const ctx = { root: { get: () => undefined } } as unknown as Context;
    const provider = new DshPasswordsPrincipalAccessProvider(ctx, db);
    const principal = { source: 'dsh-passwords', id: String(alice.id), username: alice.username, role: 'user' } as const;
    assert.deepEqual(provider.sshAccess(principal), {
      legacyAliases: ['alice-host'], includeUnownedLegacy: false, claimedLegacyAliases: [],
    });
    assert.throws(() => provider.sshAccess({ ...principal, id: String(bob.id), username: bob.username }), /SSH access is disabled/);
    db.setPermissions(bob.id, { ...permissions, allowSsh: true });
    assert.deepEqual(provider.sshAccess({ ...principal, id: String(bob.id), username: bob.username }), {
      legacyAliases: ['bob-host'], includeUnownedLegacy: false, claimedLegacyAliases: [],
    });
    assert.deepEqual(provider.sshAccess({ ...principal, id: String(admin.id), username: admin.username, role: 'admin' }), {
      legacyAliases: [], includeUnownedLegacy: true, claimedLegacyAliases: ['alice-host', 'bob-host'],
    });
    assert.deepEqual(provider.sshAccess({ ...principal, id: String(otherAdmin.id), username: otherAdmin.username, role: 'admin' }), {
      legacyAliases: [], includeUnownedLegacy: false, claimedLegacyAliases: [],
    });
    for (const forged of [
      { ...principal, username: 'other' }, { ...principal, source: 'browser' },
      { ...principal, id: '99999' }, { ...principal, role: 'admin' as const },
    ]) assert.throws(() => provider.sshAccess(forged), /active account required/);
    db.setPermissions(alice.id, { ...permissions, allowSsh: false });
    assert.throws(() => provider.sshAccess(principal), /SSH access is disabled/);
    db.setPermissions(alice.id, permissions);
    assert.throws(() => provider.sshAccess(principal), /SSH access is disabled/);
    db.setPermissions(alice.id, { ...permissions, allowSsh: true, banned: true });
    assert.throws(() => provider.sshAccess(principal), /active account required/);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('principal access returns only the account-owned resources inside allowed folders', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-principal-access-'));
  const ownRoot = path.join(temporary, 'own');
  const otherRoot = path.join(temporary, 'other');
  await mkdir(ownRoot);
  await mkdir(otherRoot);
  await symlink(otherRoot, path.join(ownRoot, 'escape'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  try {
    db.init();
    const admin = db.createUser('admin', 'hash', 'admin');
    const customer = db.createUser('customer', 'hash', 'user');
    const other = db.createUser('other', 'hash', 'user');
    db.setPermissions(customer.id, {
      allowedFolders: [ownRoot], hourlyTokenLimit: null, dailyMinutesLimit: null,
      monthlyBudgetMicros: 0, allowUpload: true, allowGitDownload: false, banned: false,
      sandboxMode: 'workspace-write', disabledSessions: ['disabled'],
    });
    db.claimSessionOwner('owned', customer.id);
    db.claimSessionOwner('disabled', customer.id);
    db.claimSessionOwner('outside', customer.id);
    db.claimSessionOwner('other-owned', other.id);
    db.claimSessionOwner('new-blank', customer.id);
    db.claimSessionOwner('foreign-child', other.id);

    const services = new Map<string, unknown>([
      ['workspaceRegistry', {
        list: () => [
          { id: 'workspace-own', path: ownRoot },
          { id: 'workspace-other', path: otherRoot },
          { id: 'workspace-escape', path: path.join(ownRoot, 'escape') },
        ],
      }],
      ['sessionQuery', {
        listSessions: async () => [
          { header: { id: 'owned', cwd: ownRoot } },
          { header: { id: 'disabled', cwd: ownRoot } },
          { header: { id: 'outside', cwd: otherRoot } },
          { header: { id: 'other-owned', cwd: ownRoot } },
          { header: { id: 'new-blank', cwd: ownRoot } },
          ...[
            ['child', 'owned', ownRoot, 'subagent'],
            ['grandchild', 'child', ownRoot, 'subagent'],
            ['foreign-child', 'owned', ownRoot, 'subagent'],
            ['foreign-parent', 'other-owned', ownRoot, 'subagent'],
            ['disabled-parent', 'disabled', ownRoot, 'subagent'],
            ['outside-child', 'owned', otherRoot, 'subagent'],
            ['escape-child', 'owned', path.join(ownRoot, 'escape'), 'subagent'],
            ['fork', 'owned', ownRoot, 'fork'],
            ['missing-parent', 'missing', ownRoot, 'subagent'],
            ['unclaimed-root', '', ownRoot, 'root'],
            ['unclaimed-child', 'unclaimed-root', ownRoot, 'subagent'],
            ['cycle-a', 'cycle-b', ownRoot, 'subagent'],
            ['cycle-b', 'cycle-a', ownRoot, 'subagent'],
          ].map(([id, parentSession, cwd, origin]) => ({ header: { id, parentSession, cwd, origin } })),
        ],
      }],
    ]);
    const ctx = hostContext(services);
    const provider = new DshPasswordsPrincipalAccessProvider(ctx, db);
    const principal = {
      source: 'dsh-passwords', id: String(customer.id), username: customer.username, role: 'user',
    } as const;

    assert.doesNotThrow(() => provider.assertAuthenticated(principal));
    assert.equal(provider.modelAllowed(principal, 'codex', 'gpt-5.5'), false);
    assert.equal(provider.modelAllowed(principal, 'codex', 'gpt-5.6'), true);
    assert.equal(provider.modelAllowed(principal, 'codex', 'gpt-6-astra'), true);
    assert.equal(provider.modelAllowed(principal, 'deepseek', 'deepseek-chat'), true);
    assert.throws(() => provider.assertAuthenticated({ ...principal, username: 'forged' }), /active account required/);
    assert.throws(() => provider.assertAuthenticated({ ...principal, id: '999999' }), /active account required/);
    const access = await provider.resolve(principal, {
      sessionIds: ['owned', 'disabled', 'outside', 'other-owned', 'new-blank', 'missing'],
      workspaceIds: ['workspace-own', 'workspace-other', 'workspace-escape', 'missing'],
    });
    assert.deepEqual([...access.readableSessionIds], ['owned', 'new-blank']);
    assert.deepEqual([...access.readableWorkspaceIds], ['workspace-own']);
    const descendants = await provider.resolve(principal, {
      sessionIds: ['child', 'grandchild', 'foreign-child', 'foreign-parent', 'disabled-parent',
        'outside-child', 'escape-child', 'fork', 'missing-parent', 'unclaimed-root', 'unclaimed-child', 'cycle-a', 'cycle-b'],
    });
    assert.deepEqual([...descendants.readableSessionIds], ['child', 'grandchild']);

    const forged = await provider.resolve({ ...principal, username: 'forged' }, {
      sessionIds: ['owned'], workspaceIds: ['workspace-own'],
    });
    assert.equal(forged.readableSessionIds.size, 0);
    assert.equal(forged.readableWorkspaceIds.size, 0);

    const adminAccess = await provider.resolve({
      source: 'dsh-passwords', id: String(admin.id), username: admin.username, role: 'admin',
    }, { sessionIds: ['owned', 'missing'], workspaceIds: ['workspace-own', 'missing'] });
    assert.deepEqual([...adminAccess.readableSessionIds], ['owned', 'missing']);
    assert.deepEqual([...adminAccess.readableWorkspaceIds], ['workspace-own', 'missing']);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('principal access fails closed for banned accounts and missing Host services', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-principal-access-deny-'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  try {
    db.init();
    db.createUser('admin', 'hash', 'admin');
    const customer = db.createUser('customer', 'hash', 'user');
    db.setPermissions(customer.id, {
      allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
      monthlyBudgetMicros: 0, allowUpload: true, allowGitDownload: false, banned: true,
      sandboxMode: null, disabledSessions: [],
    });
    const ctx = { root: { get: () => undefined } } as unknown as Context;
    const provider = new DshPasswordsPrincipalAccessProvider(ctx, db);
    assert.throws(() => provider.assertAuthenticated({
      source: 'dsh-passwords', id: String(customer.id), username: customer.username, role: 'user',
    }), /active account required/);
    const access = await provider.resolve({
      source: 'dsh-passwords', id: String(customer.id), username: customer.username, role: 'user',
    }, { sessionIds: ['session'], workspaceIds: ['workspace'] });
    assert.equal(access.readableSessionIds.size, 0);
    assert.equal(access.readableWorkspaceIds.size, 0);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
