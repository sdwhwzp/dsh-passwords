/** Explicit offline approval of account-level access to reviewed legacy attachments. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Database, UserPermissionsRow } from './db.js';
import type { AuthenticatedPrincipal } from './principal.js';

/** Immutable approval document for a frozen legacy-attachment review inventory. */
export interface LegacyAttachmentAccessManifest {
  schema: 'dsh-passwords/legacy-attachment-access@1';
  scope: 'account';
  approvedBy: string;
  approvedAt: string;
  inventorySha256: string;
  entries: readonly LegacyAttachmentAccessEntry[];
}

/** One explicitly approved account/object pair. Session ownership anchors the account review. */
export interface LegacyAttachmentAccessEntry {
  source: 'dsh-passwords';
  accountId: string;
  username: string;
  role: 'admin' | 'user';
  sessionId: string;
  attachmentId: string;
  objectPath: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/u;

function requiredText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || value.trim() !== value || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new Error('invalid review manifest field');
  }
  return value;
}

/**
 * Validate and apply one frozen, human-approved legacy access manifest.
 *
 * The resulting grant is account-level in the existing schema. The named
 * session is used only to prove that the account currently owns a valid review
 * context; it does not confine later reads to that session.
 */
export async function approveLegacyAttachmentAccess(
  db: Database,
  source: Uint8Array,
  options: { root: string; approvedSha256?: string; apply: boolean },
): Promise<{ manifestSha256: string; validated: number; applied: number }> {
  // Hash and parse the same immutable byte snapshot. A caller cannot approve one
  // document's hash while supplying a different parsed object.
  const bytes = Buffer.from(source);
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex');
  if ((options.apply && options.approvedSha256 === undefined)
    || (options.approvedSha256 !== undefined
      && (!SHA256.test(options.approvedSha256) || options.approvedSha256 !== manifestSha256))) {
    throw new Error('exact reviewed manifest sha256 required');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('manifest must be lossless UTF-8');
  const manifest = JSON.parse(text) as LegacyAttachmentAccessManifest;
  if (manifest?.schema !== 'dsh-passwords/legacy-attachment-access@1'
    || manifest.scope !== 'account' || typeof manifest.inventorySha256 !== 'string'
    || !SHA256.test(manifest.inventorySha256)
    || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error('invalid legacy attachment approval manifest');
  }
  requiredText(manifest.approvedBy, 200);
  const approvedAt = requiredText(manifest.approvedAt, 64);
  if (Number.isNaN(Date.parse(approvedAt))) throw new Error('invalid legacy attachment approval time');

  const root = await realpath(options.root);
  const approved = new Map<string, {
    principal: AuthenticatedPrincipal;
    sessionId: string;
    attachmentId: string;
    permissions: UserPermissionsRow | null;
  }>();
  for (const entry of manifest.entries) {
    if (entry?.source !== 'dsh-passwords' || typeof entry.accountId !== 'string'
      || !/^[1-9][0-9]*$/u.test(entry.accountId) || !Number.isSafeInteger(Number(entry.accountId))
      || typeof entry.username !== 'string' || entry.username.length === 0
      || (entry.role !== 'admin' && entry.role !== 'user')
      || typeof entry.sessionId !== 'string' || entry.sessionId.length === 0 || entry.sessionId.length > 200
      || typeof entry.attachmentId !== 'string' || typeof entry.objectPath !== 'string') {
      throw new Error('invalid legacy attachment approval entry');
    }
    const match = ATTACHMENT_ID.exec(entry.attachmentId);
    if (match === null) throw new Error('legacy approval requires a canonical sha256 attachment id');
    const digest = match[1];
    const canonicalPaths = ['objects', 'file-objects'].map((kind) => `${kind}/${digest.slice(0, 2)}/${digest}`);
    if (!canonicalPaths.includes(entry.objectPath)) throw new Error('canonical local-store object required');

    const pairKey = `${entry.accountId}\u0000${entry.attachmentId}`;
    if (approved.has(pairKey)) throw new Error('duplicate approved account and attachment pair');

    const objectPath = path.join(root, entry.objectPath);
    if (await realpath(objectPath) !== objectPath) throw new Error('approved object must not use symlinks');
    const file = await open(objectPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new Error('approved object must be a regular file');
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== digest) throw new Error('approved object integrity mismatch');
    } finally {
      await file.close();
    }

    const user = db.getUserListRowById(Number(entry.accountId));
    if (user === null || user.username !== entry.username || user.role !== entry.role) {
      throw new Error('approved account identity changed or no longer exists');
    }
    approved.set(pairKey, {
      principal: {
        source: 'dsh-passwords',
        id: entry.accountId,
        username: user.username,
        role: user.role,
      },
      sessionId: entry.sessionId,
      attachmentId: entry.attachmentId,
      permissions: db.getPermissions(user.id),
    });
  }

  const provenance = `operator-approved-legacy-access:${manifestSha256}`;
  for (const entry of approved.values()) {
    db.recordAttachmentGrants(
      entry.principal,
      entry.sessionId,
      [entry.attachmentId],
      provenance,
      undefined,
      true,
      entry.permissions,
    );
  }
  if (!options.apply) return { manifestSha256, validated: approved.size, applied: 0 };
  for (const entry of approved.values()) {
    db.recordAttachmentGrants(
      entry.principal,
      entry.sessionId,
      [entry.attachmentId],
      provenance,
      undefined,
      false,
      entry.permissions,
    );
  }
  return { manifestSha256, validated: approved.size, applied: approved.size };
}
