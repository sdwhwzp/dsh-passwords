/** Tenant-safe parsing and filtering for the alpha Remote stream multiplexer. */

/** Remote stream endpoints mounted by the default alpha web application. */
export const TENANT_REMOTE_STREAM_ENDPOINTS: ReadonlySet<string> = new Set([
  '$events',
  'workspace/follow',
  'session/follow',
  'session/control',
] as const);

/** One strictly decoded browser-to-Host mux frame. */
export type TenantRemoteClientFrame =
  | { type: 'open'; streamId: string; endpoint: string; payload: unknown }
  | { type: 'cancel'; streamId: string };

/** One strictly decoded Host-to-browser mux frame. */
export type TenantRemoteServerFrame =
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'error'; streamId: string; error: { code: string; message: string; details: Record<string, unknown> } }
  | { type: 'end'; streamId: string };

/** Authorization predicates evaluated for each forwarded Remote event item. */
export interface TenantRemoteEventAccess {
  readonly managedHome: string;
  readonly sessionAllowed: (sessionId: string) => boolean;
}

/** Result of filtering one structurally valid Remote event item. */
export type TenantRemoteEventDecision =
  | { readonly kind: 'forward'; readonly value: Record<string, unknown> }
  | { readonly kind: 'drop' };

/** Per-logical-stream state required to validate and filter `$events`. */
export class TenantRemoteEventFilter {
  private ready = false;
  private readonly deliveredEventIds = new Set<string>();

  /**
   * Validate one `$events` item and remove frames without tenant ownership proof.
   * @param value - untrusted logical-stream item from the Host.
   * @param access - current account authorization predicates.
   * @returns a rewritten safe frame or a deliberate drop decision.
   */
  accept(value: unknown, access: TenantRemoteEventAccess): TenantRemoteEventDecision {
    const frame = record(value);
    if (frame === undefined || typeof frame.type !== 'string') invalidRemoteEvent();

    if (frame.type === 'ready') {
      if (
        this.ready ||
        !exactKeys(frame, ['type', 'clientId', 'host']) ||
        !nonEmptyString(frame.clientId)
      ) invalidRemoteEvent();
      const host = record(frame.host);
      if (host === undefined || !exactKeys(host, ['home']) || typeof host.home !== 'string') {
        invalidRemoteEvent();
      }
      this.ready = true;
      return {
        kind: 'forward',
        value: { ...frame, host: { home: access.managedHome } },
      };
    }

    if (!this.ready) invalidRemoteEvent();

    if (frame.type === 'emit') return this.acceptEmit(frame, access);
    if (frame.type === 'waterfall') return this.acceptWaterfall(frame, access);
    if (frame.type === 'cancel') return this.acceptCancellation(frame);
    return invalidRemoteEvent();
  }

  private acceptEmit(
    frame: Record<string, unknown>,
    access: TenantRemoteEventAccess,
  ): TenantRemoteEventDecision {
    if (
      !exactKeys(frame, ['type', 'event', 'args']) ||
      !nonEmptyString(frame.event) ||
      !Array.isArray(frame.args)
    ) invalidRemoteEvent();
    const event = frame.event;
    const args = frame.args;

    if (event === 'agent-preset/selected') {
      if (args.length !== 2 || !nonEmptyString(args[0]) || typeof args[1] !== 'string') {
        invalidRemoteEvent();
      }
      return access.sessionAllowed(args[0]) ? { kind: 'forward', value: frame } : { kind: 'drop' };
    }

    if (event === 'api-session/added') {
      if (args.length !== 1) invalidRemoteEvent();
      const summary = record(args[0]);
      if (summary === undefined || !nonEmptyString(summary.sessionId)) invalidRemoteEvent();
      return access.sessionAllowed(summary.sessionId)
        ? { kind: 'forward', value: frame }
        : { kind: 'drop' };
    }

    if (event === 'api-session/removed') {
      if (args.length !== 1 || !nonEmptyString(args[0])) invalidRemoteEvent();
      return access.sessionAllowed(args[0]) ? { kind: 'forward', value: frame } : { kind: 'drop' };
    }

    if (event === 'api-session/status') {
      if (args.length !== 2 || !nonEmptyString(args[0]) || typeof args[1] !== 'boolean') {
        invalidRemoteEvent();
      }
      return access.sessionAllowed(args[0]) ? { kind: 'forward', value: frame } : { kind: 'drop' };
    }

    if (event === 'api-session/activity') {
      if (
        args.length !== 2 ||
        !nonEmptyString(args[0]) ||
        typeof args[1] !== 'number' ||
        !Number.isFinite(args[1])
      ) invalidRemoteEvent();
      return access.sessionAllowed(args[0]) ? { kind: 'forward', value: frame } : { kind: 'drop' };
    }

    if (event === 'api-session/error') {
      if (args.length !== 2 || !nonEmptyString(args[0]) || typeof args[1] !== 'string') {
        invalidRemoteEvent();
      }
      return access.sessionAllowed(args[0]) ? { kind: 'forward', value: frame } : { kind: 'drop' };
    }

    // These events contain no Host state; they only invalidate tenant-scoped reads.
    if ((event === 'commands/change' || event === 'llm/adapters-updated') && args.length === 0) {
      return { kind: 'forward', value: frame };
    }

    // Cordis topology, credential references, settings namespaces, and future
    // unclassified notifications are Host-global and have no tenant proof.
    return { kind: 'drop' };
  }

  private acceptWaterfall(
    frame: Record<string, unknown>,
    access: TenantRemoteEventAccess,
  ): TenantRemoteEventDecision {
    if (
      !exactKeys(frame, ['type', 'event', 'eventId', 'agentId', 'request']) ||
      (frame.event !== 'approval/request' && frame.event !== 'user-questions/request') ||
      !nonEmptyString(frame.eventId) ||
      !nonEmptyString(frame.agentId) ||
      record(frame.request) === undefined
    ) invalidRemoteEvent();
    if (!access.sessionAllowed(frame.agentId)) return { kind: 'drop' };
    if (this.deliveredEventIds.has(frame.eventId)) invalidRemoteEvent();
    this.deliveredEventIds.add(frame.eventId);
    return { kind: 'forward', value: frame };
  }

  private acceptCancellation(frame: Record<string, unknown>): TenantRemoteEventDecision {
    if (!exactKeys(frame, ['type', 'eventId']) || !nonEmptyString(frame.eventId)) {
      invalidRemoteEvent();
    }
    if (!this.deliveredEventIds.delete(frame.eventId)) return { kind: 'drop' };
    return { kind: 'forward', value: frame };
  }
}

/**
 * Parse one complete browser mux text message with exact-key validation.
 * @param text - untrusted WebSocket text payload.
 * @returns the validated client frame.
 */
export function parseTenantRemoteClientFrame(text: string): TenantRemoteClientFrame {
  const frame = parsedRecord(text);
  if (frame.type === 'cancel' && exactKeys(frame, ['type', 'streamId']) && nonEmptyString(frame.streamId)) {
    return { type: 'cancel', streamId: frame.streamId };
  }
  if (
    frame.type === 'open' &&
    exactKeys(frame, ['type', 'streamId', 'endpoint', 'payload']) &&
    nonEmptyString(frame.streamId) &&
    nonEmptyString(frame.endpoint)
  ) {
    return {
      type: 'open',
      streamId: frame.streamId,
      endpoint: frame.endpoint,
      payload: frame.payload,
    };
  }
  throw new Error('invalid Remote stream client frame');
}

/**
 * Parse one complete Host mux text message with exact-key validation.
 * @param text - untrusted WebSocket text payload.
 * @returns the validated server frame.
 */
export function parseTenantRemoteServerFrame(text: string): TenantRemoteServerFrame {
  const frame = parsedRecord(text);
  if (
    frame.type === 'item' &&
    (exactKeys(frame, ['type', 'streamId']) || exactKeys(frame, ['type', 'streamId', 'value'])) &&
    nonEmptyString(frame.streamId)
  ) {
    return Object.hasOwn(frame, 'value')
      ? { type: 'item', streamId: frame.streamId, value: frame.value }
      : { type: 'item', streamId: frame.streamId };
  }
  if (frame.type === 'end' && exactKeys(frame, ['type', 'streamId']) && nonEmptyString(frame.streamId)) {
    return { type: 'end', streamId: frame.streamId };
  }
  if (
    frame.type === 'error' &&
    exactKeys(frame, ['type', 'streamId', 'error']) &&
    nonEmptyString(frame.streamId)
  ) {
    const error = record(frame.error);
    if (
      error !== undefined &&
      exactKeys(error, ['code', 'message', 'details']) &&
      typeof error.code === 'string' &&
      typeof error.message === 'string'
    ) {
      const details = record(error.details);
      if (details !== undefined) {
        return {
          type: 'error',
          streamId: frame.streamId,
          error: { code: error.code, message: error.message, details },
        };
      }
    }
  }
  throw new Error('invalid Remote stream server frame');
}

function parsedRecord(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error('Remote stream frame is not JSON', { cause });
  }
  const frame = record(value);
  if (frame === undefined) throw new Error('Remote stream frame must be an object');
  return frame;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function invalidRemoteEvent(): never {
  throw new Error('invalid forwarded Remote event frame');
}
