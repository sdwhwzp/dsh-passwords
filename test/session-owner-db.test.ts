import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';

test('session ownership is immutable and survives account deletion', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-session-owner-'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  try {
    db.init();
    db.createUser('admin', 'hash', 'admin');
    const first = db.createUser('first', 'hash', 'user');
    const second = db.createUser('second', 'hash', 'user');

    assert.equal(db.claimSessionOwner('session-1', first.id), first.id);
    assert.equal(db.claimSessionOwner('session-1', second.id), first.id);
    assert.equal(db.getSessionOwner('session-1'), first.id);
    assert.deepEqual(
      db.listSessionOwners().map(({ session_id, user_id }) => ({ session_id, user_id })),
      [{ session_id: 'session-1', user_id: first.id }],
    );

    db.deleteUser(first.id);
    assert.equal(db.getSessionOwner('session-1'), first.id);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
