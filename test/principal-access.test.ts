import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { DshPasswordsPrincipalAccessProvider } from '../src/principal-access.js';

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
        ],
      }],
    ]);
    const ctx = { root: { get: (name: string) => services.get(name) } } as unknown as Context;
    const provider = new DshPasswordsPrincipalAccessProvider(ctx, db);
    const principal = {
      source: 'dsh-passwords', id: String(customer.id), username: customer.username, role: 'user',
    } as const;

    const access = await provider.resolve(principal, {
      sessionIds: ['owned', 'disabled', 'outside', 'other-owned', 'new-blank', 'missing'],
      workspaceIds: ['workspace-own', 'workspace-other', 'workspace-escape', 'missing'],
    });
    assert.deepEqual([...access.readableSessionIds], ['owned', 'new-blank']);
    assert.deepEqual([...access.readableWorkspaceIds], ['workspace-own']);

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
    const access = await new DshPasswordsPrincipalAccessProvider(ctx, db).resolve({
      source: 'dsh-passwords', id: String(customer.id), username: customer.username, role: 'user',
    }, { sessionIds: ['session'], workspaceIds: ['workspace'] });
    assert.equal(access.readableSessionIds.size, 0);
    assert.equal(access.readableWorkspaceIds.size, 0);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
