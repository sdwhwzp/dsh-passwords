/** Cordis v4 access to the Remote namespace mounted by this browser plugin. */

import type { Context } from '@deepseek-ai/cordis';
import type { DshPasswordsRemoteClient } from './remote';

export type DshPasswordsClient = DshPasswordsRemoteClient['dshPasswords'];

/**
 * Resolve the mounted namespace through its exact nested service injection.
 *
 * @param ctx - Plugin context whose parent scope injected the root Remote service.
 * @returns The traced dsh-passwords Remote client.
 */
export async function resolveDshPasswordsClient(ctx: Context): Promise<DshPasswordsClient> {
  let client!: DshPasswordsClient;
  await ctx.inject(['remote', 'remote.dshPasswords'], (scope) => {
    client = (scope.remote as unknown as DshPasswordsRemoteClient).dshPasswords;
  }).await();
  return client;
}
