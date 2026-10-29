#!/usr/bin/env node
// Explicit offline operator action. Never discover ownership by scanning history.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { backfillAttachmentGrants } from '../dist/attachment-backfill.js';
import { Database } from '../dist/db.js';
import { createFieldCrypto } from '../dist/encrypt.js';

const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3 || (args[2] !== undefined && args[2] !== '--apply')
  || !process.env.DSH_PASSWORDS_ENV_FILE || !args.slice(0, 2).every(path.isAbsolute)) {
  console.error('Usage: DSH_PASSWORDS_ENV_FILE=/absolute/protected.env node scripts/backfill-attachment-grants.mjs /absolute/reviewed.json /absolute/attachments/v1 [--apply]');
  process.exit(1);
}
let db;
try {
  const info = await stat(args[0]);
  if (!info.isFile() || (info.mode & 0o022) !== 0
    || (process.getuid && info.uid !== process.getuid() && info.uid !== 0)) {
    throw new Error('mapping must be an operator-owned file without group/world write access');
  }
  const mappings = JSON.parse(await readFile(args[0], 'utf8'));
  const { databaseTarget, loadConfig } = await import('../dist/config.js');
  const config = loadConfig();
  db = new Database(databaseTarget(config), createFieldCrypto(config.dbEncKey, config.setupKey));
  db.init();
  const result = await backfillAttachmentGrants(db, mappings, { root: args[1], apply: args[2] === '--apply' });
  console.log(JSON.stringify({ mode: args[2] === '--apply' ? 'apply' : 'dry-run', ...result }));
} catch {
  // Do not echo database errors, paths, credentials or mapping content.
  console.error('Attachment backfill refused or failed. Verify reviewed provenance, current account/session ownership and local object integrity.');
  process.exitCode = 1;
} finally { db?.close(); }
