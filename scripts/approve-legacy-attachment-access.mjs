#!/usr/bin/env node
// Explicit offline approval only. Never discovers legacy access by scanning history.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { approveLegacyAttachmentAccess } from '../dist/legacy-attachment-access.js';
import { Database } from '../dist/db.js';
import { createFieldCrypto } from '../dist/encrypt.js';

const args = process.argv.slice(2);
const apply = args.length === 5 && args[2] === '--apply'
  && args[3] === '--approved-sha256' && /^[a-f0-9]{64}$/u.test(args[4]);
if ((args.length !== 2 && !apply)
  || !process.env.DSH_PASSWORDS_ENV_FILE || !args.slice(0, 2).every(path.isAbsolute)) {
  console.error('Usage: DSH_PASSWORDS_ENV_FILE=/absolute/protected.env node scripts/approve-legacy-attachment-access.mjs /absolute/approved.json /absolute/attachments/v1 [--apply --approved-sha256 <human-approved-sha256>]');
  process.exit(1);
}
let db;
try {
  const file = await open(args[0], constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o022) !== 0
      || (process.getuid && info.uid !== process.getuid() && info.uid !== 0)) {
      throw new Error('approval must be an operator-owned file without group/world write access');
    }
    source = await file.readFile();
  } finally {
    await file.close();
  }
  const { databaseTarget, loadConfig } = await import('../dist/config.js');
  const config = loadConfig();
  db = new Database(databaseTarget(config), createFieldCrypto(config.dbEncKey, config.setupKey));
  db.init();
  const result = await approveLegacyAttachmentAccess(db, source, {
    root: args[1],
    ...(apply ? { approvedSha256: args[4] } : {}),
    apply,
  });
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    scope: 'account',
    ...result,
  }));
} catch {
  // Do not echo database errors, paths, credentials or approval contents.
  console.error('Legacy attachment approval refused or failed. Verify the frozen review manifest, current account/session ownership and local object integrity.');
  process.exitCode = 1;
} finally {
  db?.close();
}
