import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { DshPasswordsPrincipalAccessProvider } from '../src/principal-access.js';

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
    const ctx = { root: { get: (name: string) => services.get(name) } } as unknown as Context;
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
