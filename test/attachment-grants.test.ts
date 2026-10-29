import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import mysql from 'mysql2/promise';
// Built modules also exercise the actual MySQL worker entrypoint, not a SQL mock.
import { Database } from '../dist/db.js';
import { createFieldCrypto } from '../dist/encrypt.js';
import { DshPasswordsPrincipalAccessProvider } from '../dist/principal-access.js';
import { backfillAttachmentGrants } from '../dist/attachment-backfill.js';
import { readHostAttachmentWindow } from '../dist/local-workspace-hub.js';

for (const backend of ['sqlite', 'mysql'] as const) {
  test(`${backend}: durable attachment account boundary`, {
    skip: backend === 'mysql' && !process.env.DSH_TEST_MYSQL_PORT ? 'set DSH_TEST_MYSQL_PORT for an isolated loopback MySQL test instance' : false,
  }, async (suite) => {
    const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dshpw-attachment-')));
    const schema = `dshpw_attachment_test_${randomUUID().replaceAll('-', '')}`;
    const port = Number(process.env.DSH_TEST_MYSQL_PORT);
    const admin = backend === 'mysql' ? await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' }) : undefined;
    let db: Database;
    suite.after(async () => {
      db?.close();
      if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${schema}`); await admin.end(); }
      await rm(temporary, { recursive: true, force: true });
    });
    if (admin) await admin.query(`CREATE DATABASE ${schema}`);
    const target = backend === 'mysql'
      ? { driver: 'mysql' as const, host: '127.0.0.1', port, user: 'root', password: '', database: schema, tls: 'off' as const, queryTimeoutMs: 15000 }
      : path.join(temporary, 'platform.db');
    db = new Database(target, createFieldCrypto('fixture-encryption', 'fixture-setup'));
    db.init();
    const alice = db.createUser('alice', 'hash', 'user');
    const bob = db.createUser('bob', 'hash', 'user');
    const root = db.createUser('admin', 'hash', 'admin');
    const permissions = { allowedFolders: [temporary], hourlyTokenLimit: null, dailyMinutesLimit: null, allowUpload: true, allowGitDownload: false, banned: false };
    for (const user of [alice, bob, root]) db.setPermissions(user.id, permissions);
    for (const [session, owner] of [['AliceSession', alice.id], ['BobSession', bob.id], ['AdminSession', root.id]] as const) db.claimSessionOwner(session, owner);
    const principal = (user: typeof alice) => ({ source: 'dsh-passwords', id: String(user.id), username: user.username, role: user.role });
    const a = principal(alice), b = principal(bob), r = principal(root);
    const services = new Map<string, unknown>([
      ['workspaceRegistry', { list: () => [] }],
      ['sessionPersistence', { stat: async (id: string) => ({ header: { id, cwd: temporary }, history: [{ attachmentId: 'injected-history' }] }) }],
    ]);
    const provider = () => new DshPasswordsPrincipalAccessProvider({ root: { get: (name: string) => services.get(name) } } as never, db);
    const readable = async (p: typeof a, ids: string[]) => [...(await provider().resolve(p, { attachmentIds: ids })).readableAttachmentIds!];
    const record = (p: typeof a, sessionId: string, attachmentIds: string[], signal?: AbortSignal) =>
      provider().recordAttachments(p, { sessionId, attachmentIds }, signal);
      await suite.test('two accounts, admin, duplicates and independently uploaded equal content', async () => {
        assert.deepEqual(await readable(a, ['shared', 'injected-history']), []);
        await record(a, 'AliceSession', ['shared', 'alpha', 'shared']);
        await record(a, 'AliceSession', ['shared']);
        assert.deepEqual(await readable(a, ['shared', 'alpha', 'unknown']), ['shared', 'alpha']);
        assert.deepEqual(await readable(b, ['shared', 'alpha']), []);
        assert.deepEqual(await readable(r, ['shared', 'alpha']), []);
        await record(b, 'BobSession', ['shared']);
        assert.deepEqual(await readable(b, ['shared', 'alpha']), ['shared']);
        assert.deepEqual(await readable(a, ['injected-history']), []);
      });
      await suite.test('foreign, missing, collation-alias and admin session ownership never confer a grant', async () => {
        for (const [p, session] of [[b, 'AliceSession'], [r, 'AliceSession'], [a, 'missing'], [a, 'alicesession'], [a, 'AliceSession ']] as const) {
          await assert.rejects(record(p, session, ['forbidden']), { code: 'PRINCIPAL_ACCESS_DENIED' });
          assert.deepEqual(await readable(p, ['forbidden']), []);
        }
        assert.equal(db.getSessionOwner('missing'), null);
      });
      await suite.test('stale or malformed identities cannot read or grant', async () => {
        for (const invalid of [
          { ...a, source: 'other' }, { ...a, id: `0${a.id}` }, { ...a, id: '9007199254740992' },
          { ...a, username: 'old-name' }, { ...a, role: 'admin' as const }, { ...b, username: a.username },
        ]) {
          assert.deepEqual(await readable(invalid, ['shared', 'alpha']), []);
          await assert.rejects(record(invalid, 'AliceSession', ['identity-forged']), { code: 'PRINCIPAL_ACCESS_DENIED' });
        }
      });
      await suite.test('opaque IDs preserve case, trailing spaces, Unicode and NUL without normalization', async () => {
        const ids = ['Opaque', 'Opaque ', 'é', 'e\u0301', 'nul\u0000value'];
        await record(a, 'AliceSession', ids);
        assert.deepEqual(await readable(a, [...ids, 'opaque', 'OPAQUE', 'é ']), ids);
        assert.deepEqual(await readable(b, ids), []);
        for (const bad of ['', '\ud800', 'x'.repeat(4097)]) {
          await assert.rejects(record(a, 'AliceSession', ['batch-must-rollback', bad]), { code: 'PRINCIPAL_ACCESS_DENIED' });
          assert.deepEqual(await readable(a, ['batch-must-rollback', bad]), []);
        }
      });
      await suite.test('ban, disabled session and explicit grant revocation are rechecked in the write transaction', async () => {
        const original = db.recordAttachmentGrants.bind(db);
        for (const change of [
          () => db.setPermissions(alice.id, { ...permissions, banned: true }),
          () => db.setPermissions(alice.id, { ...permissions, disabledSessions: ['AliceSession'] }),
          () => { db.markSessionGrantsSeeded(alice.id); db.deleteUserSessionGrants(alice.id, ['AliceSession']); },
        ]) {
          db.recordAttachmentGrants = (...args) => { change(); return original(...args); };
          await assert.rejects(record(a, 'AliceSession', ['revoked']), { code: 'PRINCIPAL_ACCESS_DENIED' });
          db.recordAttachmentGrants = original;
          db.setPermissions(alice.id, { ...permissions, disabledSessions: [], sessionGrantsSeeded: false });
          db.addUserSessionGrant(alice.id, 'AliceSession');
        }
        assert.deepEqual(await readable(a, ['revoked']), []);
        db.setPermissions(alice.id, { ...permissions, banned: true });
        assert.deepEqual(await readable(a, ['shared']), []);
        db.setPermissions(alice.id, permissions);
      });
      await suite.test('permission change while awaiting session metadata denies admission', async () => {
        const previous = services.get('sessionPersistence');
        services.set('sessionPersistence', { stat: async (id: string) => {
          db.setPermissions(alice.id, { ...permissions, allowedFolders: ['__deny__'] });
          return { header: { id, cwd: temporary } };
        } });
        await assert.rejects(record(a, 'AliceSession', ['raced-policy']), { code: 'PRINCIPAL_ACCESS_DENIED' });
        services.set('sessionPersistence', previous);
        db.setPermissions(alice.id, permissions);
        assert.deepEqual(await readable(a, ['raced-policy']), []);
      });
      await suite.test('abort before admission and after inserts rolls back the complete batch', async () => {
        const abort = new AbortController();
        abort.abort(new Error('cancelled'));
        await assert.rejects(record(a, 'AliceSession', ['cancelled'], abort.signal), /cancelled/);
        let checks = 0;
        assert.throws(() => db.recordAttachmentGrants(a, 'AliceSession', ['atomic-one', 'atomic-two'], 'host-validated-upload', {
          throwIfAborted() { if (++checks === 3) throw new Error('cancel after inserts'); },
        } as AbortSignal), /cancel after inserts/);
        assert.deepEqual(await readable(a, ['cancelled', 'atomic-one', 'atomic-two']), []);
      });
      await suite.test('trusted offline backfill verifies provenance, bytes and owner; dry-run never grants', async () => {
        const bytes = Buffer.from('legacy legitimate upload');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const attachmentId = `sha256:${digest}`;
        const objectPath = `file-objects/${digest.slice(0, 2)}/${digest}`;
        await mkdir(path.dirname(path.join(temporary, objectPath)), { recursive: true });
        await writeFile(path.join(temporary, objectPath), bytes);
        const mapping = { source: 'dsh-passwords' as const, accountId: a.id, sessionId: 'AliceSession', attachmentId, objectPath, provenance: { kind: 'operator-reviewed-upload' as const, reference: 'reviewed-upload-ledger:fixture-42' } };
        assert.deepEqual(await backfillAttachmentGrants(db, [mapping], { root: temporary, apply: false }), { validated: 1, applied: 0 });
        assert.deepEqual(await readable(a, [attachmentId]), []);
        await assert.rejects(backfillAttachmentGrants(db, [{ ...mapping, accountId: b.id }], { root: temporary, apply: true }));
        await assert.rejects(backfillAttachmentGrants(db, [{ ...mapping, provenance: { kind: 'history' as never, reference: 'message' } }], { root: temporary, apply: true }));
        await assert.rejects(backfillAttachmentGrants(db, [{ ...mapping, objectPath: '../escape' }], { root: temporary, apply: true }));
        await writeFile(path.join(temporary, objectPath), 'tampered');
        await assert.rejects(backfillAttachmentGrants(db, [mapping], { root: temporary, apply: true }), /integrity/);
        await writeFile(path.join(temporary, objectPath), bytes);
        assert.deepEqual(await backfillAttachmentGrants(db, [mapping], { root: temporary, apply: true }), { validated: 1, applied: 1 });
        await backfillAttachmentGrants(db, [mapping], { root: temporary, apply: true });
        assert.deepEqual(await readable(a, [attachmentId]), [attachmentId]);
        assert.deepEqual(await readable(b, [attachmentId]), []);
      });
      await suite.test('paired Host attachment reads require the exact account grant, including symlink aliases', async () => {
        const digest = createHash('sha256').update('private attachment').digest('hex');
        const id = `sha256:${digest}`;
        const file = path.join(temporary, 'files', digest.slice(0, 2), digest, 'secret.txt');
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'private attachment');
        await record(a, 'AliceSession', [id]);
        const authorize = (p: typeof a) => async (candidate: string) => {
          assert.equal(candidate, id);
          assert.deepEqual(await readable(p, [candidate]), [candidate], 'account grant required');
        };
        assert.equal((await readHostAttachmentWindow(file, {}, temporary, authorize(a)))?.lines[0].text, 'private attachment');
        await assert.rejects(readHostAttachmentWindow(file, {}, temporary, authorize(b)), /account grant required/);
        const alias = path.join(temporary, 'alias.txt');
        await symlink(file, alias);
        await assert.rejects(readHostAttachmentWindow(alias, {}, temporary, authorize(b)), /account grant required/);
        await assert.rejects(readHostAttachmentWindow(file, {}, temporary, undefined as never), /授权/);
      });
      await suite.test('grants survive restart/schema initialization and account deletion removes them', async () => {
        db.close();
        db = new Database(target, createFieldCrypto('fixture-encryption', 'fixture-setup'));
        db.init();
        assert.deepEqual(await readable(a, ['shared', 'alpha']), ['shared', 'alpha']);
        db.deleteUser(alice.id);
        assert.deepEqual(await readable(a, ['shared', 'alpha']), []);
        assert.deepEqual([...db.readableAttachmentIds(alice.id, ['shared', 'alpha'])], []);
        assert.deepEqual(await readable(b, ['shared']), ['shared']);
      });
  });
}
