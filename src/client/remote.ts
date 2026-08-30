/** Manual Typert Remote contribution for this externally built plugin. */

import type { StateData } from './card';

function parseJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('value must be finite JSON');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) parseJson(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('value must be plain JSON');
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('JSON object keys must be strings');
      parseJson((value as Record<string, unknown>)[key], seen);
    }
  }
  seen.delete(value);
  return value;
}

const resultCodec = {
  mode: 'strict' as const,
  typeSymbol: 'dsh-passwords#State',
  schema: { parse: (value: unknown) => parseJson(value) as StateData },
};

export const DSH_PASSWORDS_REMOTE = {
  package: 'dsh-passwords',
  descriptors: [{
    id: 'dsh-passwords#dshPasswords/state',
    service: 'dshPasswords',
    namespace: 'dshPasswords',
    method: 'state',
    invocation: { kind: 'direct' as const },
    parameters: [],
    result: resultCodec,
  }],
};

export interface DshPasswordsRemoteClient {
  $mount(contribution: typeof DSH_PASSWORDS_REMOTE): Promise<() => void>;
  dshPasswords: {
    state(): Promise<StateData>;
  };
}
