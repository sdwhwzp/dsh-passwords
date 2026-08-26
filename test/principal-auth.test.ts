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

function config(dbPath: string): PlatformConfig {
  return {
    setupKey: 'setup', dbPath, dbEncKey: 'enc', jwtSecret: 'jwt-secret', internalSecret: 'internal-secret',
    gateway: { host: '127.0.0.1', port: 8080, upstream: 'http://127.0.0.1:3080', tls: null, redirectPort: null, publicHost: '', domain: '', autoTls: false, acmeEmail: '', acmeStaging: false },
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

test('ordinary users authenticate only with their local SQLite password', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-passwords-local-auth-'));
  const dbPath = join(directory, 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('enc', 'setup'));
  db.init();
  db.setupInitialAdmin('admin', await bcrypt.hash('AdminPassword1!', 4));
  const alice = db.createUser('alice', await bcrypt.hash('LocalPassword1!', 4), 'user');
  try {
    const auth = new AuthService(config(dbPath), db);
    const login = await auth.login({ username: 'alice', password: 'LocalPassword1!' }, { ip: '127.0.0.1' });
    assert.ok(login.token.length > 10);
    const verified = auth.verifyToken(login.token);
    assert.equal(verified.userId, alice.id);
    assert.equal(verified.username, 'alice');
    assert.equal(verified.cv, alice.credential_version);
    assert.equal(typeof verified.exp, 'number');
    await assert.rejects(
      auth.login({ username: 'alice', password: 'WrongPassword1!' }, { ip: '127.0.0.2' }),
      (error: unknown) => error instanceof AuthError && error.code === 'INVALID_CREDENTIALS' && error.status === 401,
    );
    await assert.rejects(
      auth.login({ username: 'bob', password: 'UnknownUser1!' }, { ip: '127.0.0.3' }),
      (error: unknown) => error instanceof AuthError && error.code === 'INVALID_CREDENTIALS' && error.status === 401,
    );
    assert.equal(db.getUserByUsername('bob'), null, 'unknown credentials must never auto-create a local user');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
