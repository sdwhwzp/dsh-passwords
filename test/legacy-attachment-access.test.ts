import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { Database } from '../dist/db.js';
import { createFieldCrypto } from '../dist/encrypt.js';
import { approveLegacyAttachmentAccess } from '../dist/legacy-attachment-access.js';
import { DshPasswordsPrincipalAccessProvider } from '../dist/principal-access.js';

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

for (const backend of ['sqlite', 'mysql'] as const) {
  test(`${backend}: explicit legacy attachment access approval`, {
    skip: backend === 'mysql' && !process.env.DSH_TEST_MYSQL_PORT
      ? 'set DSH_TEST_MYSQL_PORT for an isolated loopback MySQL instance' : false,
  }, async (suite) => {
    const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dshpw-legacy-approval-')));
    const schema = `dshpw_legacy_test_${randomUUID().replaceAll('-', '')}`;
    const admin = backend === 'mysql' ? await mysql.createConnection({
      host: '127.0.0.1', port: Number(process.env.DSH_TEST_MYSQL_PORT), user: 'root', password: '',
    }) : undefined;
    let db: Database;
    suite.after(async () => {
      db?.close();
      if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${schema}`); await admin.end(); }
      await rm(temporary, { recursive: true, force: true });
    });
    if (admin) await admin.query(`CREATE DATABASE ${schema}`);
    const target = backend === 'mysql'
      ? { driver: 'mysql' as const, host: '127.0.0.1', port: Number(process.env.DSH_TEST_MYSQL_PORT),
        user: 'root', password: '', database: schema, tls: 'off' as const, queryTimeoutMs: 15000 }
      : path.join(temporary, 'platform.db');
    db = new Database(target, createFieldCrypto('fixture-encryption', 'fixture-setup'));
    db.init();
    const alice = db.createUser('alice', 'hash', 'user');
    const bob = db.createUser('bob', 'hash', 'user');
    const root = db.createUser('admin', 'hash', 'admin');
    const permissions = { allowedFolders: [temporary], hourlyTokenLimit: null,
      dailyMinutesLimit: null, allowUpload: true, allowGitDownload: false, banned: false };
    for (const user of [alice, bob, root]) db.setPermissions(user.id, permissions);
    for (const [session, owner] of [
      ['AliceSession', alice.id], ['AliceOtherSession', alice.id],
      ['BobSession', bob.id], ['AdminSession', root.id],
    ] as const) db.claimSessionOwner(session, owner);
    const principal = (user: typeof alice) => ({
      source: 'dsh-passwords', id: String(user.id), username: user.username, role: user.role,
    });
    // A forged reference exists even in the requester's genuinely owned session.
    // Merely owning that session must never grant its referenced object.
    const provider = new DshPasswordsPrincipalAccessProvider({ root: { get: (name: string) => (
      name === 'workspaceRegistry' ? { list: () => [] }
        : name === 'sessionPersistence' ? { stat: async (id: string) => ({
          header: { id, cwd: temporary }, history: [{ attachmentId: 'injected-reference' }],
        }) } : undefined
    ) } } as never, db);
    const readable = async (user: typeof alice, id: string, sessionId?: string) =>
      (await provider.resolve(principal(user), {
        attachmentIds: [id] as never, ...(sessionId ? { sessionIds: [sessionId] as never } : {}),
      })).readableAttachmentIds!.has(id as never);
    let sequence = 0;
    const fixture = async (user = alice, sessionId = 'AliceSession') => {
      const bytes = Buffer.from(`legacy approved fixture ${++sequence}`);
      const digest = sha256(bytes);
      const objectPath = `file-objects/${digest.slice(0, 2)}/${digest}`;
      await mkdir(path.dirname(path.join(temporary, objectPath)), { recursive: true });
      await writeFile(path.join(temporary, objectPath), bytes);
      const manifest = {
        schema: 'dsh-passwords/legacy-attachment-access@1',
        scope: 'account',
        approvedBy: 'fixture operator',
        approvedAt: '2026-10-29T12:00:00.000Z',
        inventorySha256: 'a'.repeat(64),
        entries: [{
          source: 'dsh-passwords', accountId: String(user.id), username: user.username, role: user.role,
          sessionId, attachmentId: `sha256:${digest}`, objectPath,
        }],
      };
      return { manifest, id: `sha256:${digest}`, objectPath, bytes };
    };
    const encoded = (manifest: unknown) => Buffer.from(JSON.stringify(manifest));
    const apply = (manifest: unknown) => {
      const source = encoded(manifest);
      return approveLegacyAttachmentAccess(db, source, {
        root: temporary, apply: true, approvedSha256: sha256(source),
      });
    };

    await suite.test('dry run and an owned session reference confer no access', async () => {
      const item = await fixture();
      const source = encoded(item.manifest);
      assert.deepEqual(await approveLegacyAttachmentAccess(db, source, { root: temporary, apply: false }), {
        manifestSha256: sha256(source), validated: 1, applied: 0,
      });
      assert.equal(await readable(alice, item.id, 'AliceSession'), false);
      assert.equal(await readable(alice, 'injected-reference', 'AliceSession'), false);
    });
    await suite.test('application requires the exact externally supplied approved document hash', async () => {
      const item = await fixture();
      const source = encoded(item.manifest);
      await assert.rejects(approveLegacyAttachmentAccess(db, source, { root: temporary, apply: true }), /sha256/);
      await assert.rejects(approveLegacyAttachmentAccess(db, source, {
        root: temporary, apply: true, approvedSha256: '0'.repeat(64),
      }), /sha256/);
      const changed = encoded({ ...item.manifest, approvedBy: 'changed' });
      await assert.rejects(approveLegacyAttachmentAccess(db, changed, {
        root: temporary, apply: true, approvedSha256: sha256(source),
      }), /sha256/);
      assert.equal(await readable(alice, item.id), false);
    });
    await suite.test('exact account grant restores reads across its sessions, never other accounts or admin', async () => {
      const item = await fixture();
      await apply(item.manifest);
      assert.equal(await readable(alice, item.id, 'AliceSession'), true);
      assert.equal(await readable(alice, item.id, 'AliceOtherSession'), true);
      assert.equal(await readable(bob, item.id, 'BobSession'), false);
      assert.equal(await readable(root, item.id, 'AdminSession'), false);
      assert.equal(await readable(alice, 'injected-reference', 'AliceSession'), false);
      await apply(item.manifest); // Idempotent.
      const adminManifest = { ...item.manifest, entries: [{
        ...item.manifest.entries[0], accountId: String(root.id), username: root.username,
        role: root.role, sessionId: 'AdminSession',
      }] };
      await apply(adminManifest);
      assert.equal(await readable(root, item.id, 'AdminSession'), true);
      assert.equal(await readable(bob, item.id), false);
    });
    await suite.test('foreign and missing owners, stale identities and misleading session scope deny', async () => {
      const item = await fixture();
      for (const patch of [
        { sessionId: 'BobSession' }, { sessionId: 'missing' }, { sessionId: 'alicesession' },
        { username: 'renamed' }, { role: 'admin' }, { accountId: `0${alice.id}` },
      ]) {
        await assert.rejects(apply({ ...item.manifest, entries: [{ ...item.manifest.entries[0], ...patch }] }));
      }
      await assert.rejects(apply({ ...item.manifest, scope: 'session' }));
      assert.equal(db.getSessionOwner('missing'), null);
      assert.equal(await readable(alice, item.id), false);
    });
    await suite.test('all entries preflight before writes; duplicate pairs and invalid objects deny', async () => {
      const item = await fixture();
      await assert.rejects(apply({ ...item.manifest, entries: [
        item.manifest.entries[0], { ...item.manifest.entries[0], sessionId: 'BobSession' },
      ] }), /duplicate/);
      const second = await fixture();
      await assert.rejects(apply({ ...item.manifest, entries: [
        item.manifest.entries[0], { ...second.manifest.entries[0], sessionId: 'BobSession' },
      ] }));
      assert.equal(await readable(alice, item.id), false);
      await assert.rejects(apply({ ...item.manifest, entries: [{
        ...item.manifest.entries[0], objectPath: '../outside',
      }] }), /canonical/);
      await writeFile(path.join(temporary, item.objectPath), 'tampered');
      await assert.rejects(apply(item.manifest), /integrity/);
      await rm(path.join(temporary, item.objectPath));
      const outside = path.join(temporary, 'outside');
      await writeFile(outside, item.bytes);
      await symlink(outside, path.join(temporary, item.objectPath));
      await assert.rejects(apply(item.manifest), /symlinks/);
      assert.equal(await readable(alice, item.id), false);
    });
    await suite.test('ban, disabled session and revoked session grant prevent application', async () => {
      const item = await fixture();
      for (const change of [
        () => db.setPermissions(alice.id, { ...permissions, banned: true }),
        () => db.setPermissions(alice.id, { ...permissions, disabledSessions: ['AliceSession'] }),
        () => { db.markSessionGrantsSeeded(alice.id); db.deleteUserSessionGrants(alice.id, ['AliceSession']); },
      ]) {
        change();
        await assert.rejects(apply(item.manifest));
        db.setPermissions(alice.id, { ...permissions, disabledSessions: [], sessionGrantsSeeded: false });
        db.addUserSessionGrant(alice.id, 'AliceSession');
      }
      assert.equal(await readable(alice, item.id), false);
    });
    await suite.test('policy change between preflight and application denies the write', async () => {
      const item = await fixture();
      const original = db.recordAttachmentGrants.bind(db);
      db.recordAttachmentGrants = (...args) => {
        if (args[5] === false) db.setPermissions(alice.id, { ...permissions, allowUpload: false });
        return original(...args);
      };
      try { await assert.rejects(apply(item.manifest)); }
      finally {
        db.recordAttachmentGrants = original;
        db.setPermissions(alice.id, permissions);
      }
      assert.equal(await readable(alice, item.id), false);
    });
    await suite.test('document bytes are captured before asynchronous file checks', async () => {
      const item = await fixture();
      const source = encoded(item.manifest);
      const expected = sha256(source);
      const pending = approveLegacyAttachmentAccess(db, source, {
        root: temporary, apply: true, approvedSha256: expected,
      });
      source.fill(0);
      assert.equal((await pending).manifestSha256, expected);
      assert.equal(await readable(alice, item.id), true);
    });
  });
}

test('CLI refuses --apply without a separate approved hash before loading database config', () => {
  const result = spawnSync(process.execPath, [
    'scripts/approve-legacy-attachment-access.mjs', '/unused/approved.json', '/unused/attachments', '--apply',
  ], { encoding: 'utf8', env: { PATH: process.env.PATH, DSH_PASSWORDS_ENV_FILE: '/unused/protected.env' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:.*--approved-sha256/);
});
