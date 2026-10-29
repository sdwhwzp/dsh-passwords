import { createHash } from 'node:crypto';

/** Stable Host denial code without requiring a runtime import of the optional peer. */
export function attachmentGrantDenied(): Error {
  return Object.assign(new Error('authenticated attachment ownership required'), {
    code: 'PRINCIPAL_ACCESS_DENIED',
    reason: 'subject-denied',
  });
}

/** Hash only lossless UTF-8 identifiers; retain and compare the original opaque ID. */
export function attachmentGrantKey(id: string): string {
  if (typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id, 'utf8') > 4096
    || Buffer.from(id, 'utf8').toString('utf8') !== id) throw attachmentGrantDenied();
  return createHash('sha256').update(id, 'utf8').digest('hex');
}
