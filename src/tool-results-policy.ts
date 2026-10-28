/** Account scope and parsed JSON fields for live Trajectory result inspection. */
import { clientConnectionArgs } from './permissions.js';

/**
 * Read the exact Session requested by one live result inspector.
 * @param payload - untrusted Remote stream arguments.
 * @returns the Session requiring account authorization, or null for invalid arguments.
 */
export function toolResultSessionId(payload: unknown): string | null {
  const args = clientConnectionArgs({ type: 'client-request', method: 'toolResults/watch', payload });
  if (args === null || Object.keys(args).length !== 1) return null;
  const request = args.request;
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return null;
  const value = request as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.sessionId !== 'string' ||
      value.sessionId.length === 0 || value.sessionId.length > 200 ||
      typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0) return null;
  return value.sessionId;
}

/**
 * Validate one parsed JSON item from the authorized result stream.
 * @param value - JSON decoded from a Host Remote frame.
 * @returns the availability item, or null when its fields are invalid.
 */
export function toolResultItem(value: unknown): unknown | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.available === false && Object.keys(item).length === 1) return item;
  if (item.available === true && Object.keys(item).length === 2 && Object.hasOwn(item, 'value')) return item;
  return null;
}
