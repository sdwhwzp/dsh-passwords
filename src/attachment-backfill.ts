/** Offline migration only. No request handler or session-history discovery invokes this module. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from './db.js';
import type { AuthenticatedPrincipal } from './principal.js';

export interface ReviewedAttachmentMapping {
  source: 'dsh-passwords';
  accountId: string;
  sessionId: string;
  attachmentId: string;
  /** Canonical local-store object, relative to the explicitly supplied attachments/v1 root. */
  objectPath: string;
  provenance: { kind: 'operator-reviewed-upload'; reference: string };
}

/**
 * Validate an explicit, operator-reviewed mapping against local content and current owners.
 * Existence/hash alone is never ownership evidence: provenance is a separate operator attestation.
 * All entries are preflighted, then each is transactionally rechecked and applied idempotently.
 */
export async function backfillAttachmentGrants(
  db: Database,
  mappings: readonly ReviewedAttachmentMapping[],
  options: { root: string; apply: boolean },
): Promise<{ validated: number; applied: number }> {
  if (!Array.isArray(mappings) || mappings.length === 0) throw new Error('reviewed mapping array required');
  const root = await realpath(options.root);
  const validated: Array<{ principal: AuthenticatedPrincipal; mapping: ReviewedAttachmentMapping; provenance: string }> = [];
  for (const mapping of mappings) {
    if (mapping?.source !== 'dsh-passwords' || typeof mapping.accountId !== 'string'
      || !/^[1-9][0-9]*$/u.test(mapping.accountId) || !Number.isSafeInteger(Number(mapping.accountId))
      || typeof mapping.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(mapping.attachmentId)
      || mapping.provenance?.kind !== 'operator-reviewed-upload'
      || typeof mapping.provenance.reference !== 'string' || mapping.provenance.reference.trim().length === 0
      || mapping.provenance.reference.length > 2000 || typeof mapping.objectPath !== 'string') {
      throw new Error('trusted reviewed mapping required; history references are not evidence');
    }
    const digest = mapping.attachmentId.slice(7);
    const canonicalPaths = ['objects', 'file-objects'].map((kind) => `${kind}/${digest.slice(0, 2)}/${digest}`);
    if (!canonicalPaths.includes(mapping.objectPath)) throw new Error('canonical local-store object required');
    const objectPath = path.join(root, mapping.objectPath);
    if (await realpath(objectPath) !== objectPath) throw new Error('backfill object must not use symlinks');
    const file = await open(objectPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new Error('backfill object must be a regular file');
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== digest) throw new Error('backfill object integrity mismatch');
    } finally { await file.close(); }
    const user = db.getUserListRowById(Number(mapping.accountId));
    if (user === null) throw new Error('backfill account no longer exists');
    const principal: AuthenticatedPrincipal = { source: mapping.source, id: mapping.accountId, username: user.username, role: user.role };
    const provenance = JSON.stringify(mapping.provenance);
    db.recordAttachmentGrants(principal, mapping.sessionId, [mapping.attachmentId], provenance, undefined, true);
    validated.push({ principal, mapping, provenance });
  }
  if (options.apply) {
    for (const { principal, mapping, provenance } of validated) {
      db.recordAttachmentGrants(principal, mapping.sessionId, [mapping.attachmentId], provenance);
    }
  }
  return { validated: validated.length, applied: options.apply ? validated.length : 0 };
}
