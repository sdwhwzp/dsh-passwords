/** Cordis v4 access to the Remote namespace mounted by this browser plugin. */

import type { Context } from '@deepseek-ai/cordis';
import type { StateData } from './card';
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

/**
 * Invoke the authenticated state method and unwrap the Gateway result envelope.
 *
 * @param client - Mounted dsh-passwords Remote namespace.
 * @returns The current principal and visible account list.
 */
export async function loadDshPasswordsState(client: DshPasswordsClient): Promise<StateData> {
  const result = await client.state();
  if (result.ok) return result.value;
  const error = new Error(result.error.message) as Error & { code?: string; details?: unknown };
  error.code = result.error.code;
  if (result.error.details !== undefined) error.details = result.error.details;
  throw error;
}
