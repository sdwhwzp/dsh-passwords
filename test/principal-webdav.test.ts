import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import bcrypt from 'bcryptjs';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { AuthError, AuthService } from '../src/auth.js';
import { signedPrincipalHeaders, verifyPrincipalHeaders } from '../src/principal.js';
import type { PlatformConfig } from '../src/config.js';
import type { PrincipalIdentity, WebDavCredentialStore } from '../src/webdav-credentials.js';

function config(dbPath: string): PlatformConfig {
  return {
    setupKey: 'setup', dbPath, dbEncKey: 'enc', jwtSecret: 'jwt-secret', internalSecret: 'internal-secret',
    gateway: { host: '127.0.0.1', port: 8080, upstream: 'http://127.0.0.1:3080', tls: null, redirectPort: null, publicHost: '', domain: '', autoTls: false, acmeEmail: '', acmeStaging: false },
    webdav: { url: 'https://192.168.10.47:4006', insecureSkipVerify: false },
    mysql: { host: '127.0.0.1', port: 3306, database: 'x', user: 'x', passwordCredential: 'p', masterKeyCredential: 'k', keyVersion: 'v1' },
    patch: { dshRoot: '', restartService: '' },
  };
}

test('short-lived principal headers verify and tampering/expiry fail closed', () => {
  const now = Date.parse('2026-08-21T00:00:00Z');
  const signed = signedPrincipalHeaders({ userId: 7, username: 'alice', role: 'user' }, 'secret', now);
  const headers = new Headers(signed);
  assert.deepEqual(verifyPrincipalHeaders(headers, 'secret', now), { source: 'dsh-passwords', id: '7', username: 'alice', role: 'user' });
  headers.set('x-dsh-principal-signature', 'tampered');
  assert.throws(() => verifyPrincipalHeaders(headers, 'secret', now));
  assert.throws(() => verifyPrincipalHeaders(new Headers(signed), 'secret', now + 31_000), /expired/);
});

test('successful WebDAV login auto-creates a zero-budget user and stores credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-passwords-webdav-'));
  const dbPath = join(directory, 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('enc', 'setup'));
  db.init();
  const adminHash = await bcrypt.hash('AdminPassword1!', 4);
  db.setupInitialAdmin('admin', adminHash);
  const saved: Array<{ id: number; username: string; password: string }> = [];
  const store: WebDavCredentialStore = {
    async save(id, username, password) { saved.push({ id, username, password }); },
    async get(_principal: PrincipalIdentity) { return undefined; },
    async close() {},
  };
  try {
    const auth = new AuthService(config(dbPath), db, store, async () => {});
    const login = await auth.login({ username: 'alice', password: 'synology-secret' }, { ip: '127.0.0.1' });
    assert.ok(login.token.length > 10);
    const user = db.getUserByUsername('alice');
    assert.ok(user);
    assert.equal(user.role, 'user');
    assert.equal(db.getPermissions(user.id)?.monthly_budget_micros, 0);
    assert.deepEqual(saved, [{ id: user.id, username: 'alice', password: 'synology-secret' }]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('MySQL outage blocks WebDAV users but leaves the local recovery administrator usable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-passwords-recovery-'));
  const dbPath = join(directory, 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('enc', 'setup'));
  db.init();
  db.setupInitialAdmin('admin', await bcrypt.hash('AdminPassword1!', 4));
  const store: WebDavCredentialStore = {
    async save() { throw new Error('mysql unavailable'); },
    async get() { throw new Error('mysql unavailable'); },
    async close() {},
  };
  try {
    const auth = new AuthService(config(dbPath), db, store, async () => {});
    const admin = await auth.login({ username: 'admin', password: 'AdminPassword1!' }, { ip: '127.0.0.1' });
    assert.ok(admin.token.length > 10);
    await assert.rejects(
      auth.login({ username: 'alice', password: 'synology-secret' }, { ip: '127.0.0.2' }),
      (error: unknown) => error instanceof AuthError && error.code === 'WEBDAV_UNAVAILABLE' && error.status === 503,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
