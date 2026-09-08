/** Tenant filtering for the Host's server-to-browser event downlinks. */

/** Per-account authorization predicates evaluated for one event frame. */
export interface TenantEventAccess {
  workspacePathAllowed(path: string): boolean;
  workspaceIdAllowed(workspaceId: string): boolean;
  sessionVisible(sessionId: string): boolean;
  sessionOwned(sessionId: string): boolean;
  newSessionVisible(sessionId: string, cwd: string): boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return undefined;
  return value as string[];
}

/**
 * Filter one parsed WebSocket server-request envelope for a restricted account.
 * Unknown or malformed frames are dropped because the upstream streams are global.
 */
export function filterTenantEventEnvelope(
  value: unknown,
  access: TenantEventAccess,
): Record<string, unknown> | undefined {
  const envelope = record(value);
  const payload = record(envelope?.payload);
  if (
    envelope?.type !== 'server-request' ||
    typeof envelope.rpcId !== 'string' ||
    typeof envelope.method !== 'string' ||
    typeof payload?.type !== 'string' ||
    envelope.method !== payload.type
  ) {
    return undefined;
  }

  const filteredPayload = filterPayload(payload, access);
  return filteredPayload === undefined ? undefined : { ...envelope, payload: filteredPayload };
}

function filterPayload(
  payload: Record<string, unknown>,
  access: TenantEventAccess,
): Record<string, unknown> | undefined {
  const type = payload.type as string;
  if (type === 'stream/error') return payload;

  if (type === 'host/workspace-changed') {
    const workspace = record(payload.workspace);
    const sessionIds = stringArray(workspace?.sessionIds);
    if (
      workspace === undefined ||
      typeof workspace.workspaceId !== 'string' ||
      typeof workspace.path !== 'string' ||
      sessionIds === undefined ||
      !access.workspacePathAllowed(workspace.path)
    ) {
      return undefined;
    }
    return {
      ...payload,
      workspace: {
        ...workspace,
        sessionIds: sessionIds.filter((sessionId) => access.sessionVisible(sessionId)),
      },
    };
  }

  if (type === 'host/workspace-removed') {
    return typeof payload.workspaceId === 'string' && access.workspaceIdAllowed(payload.workspaceId)
      ? payload
      : undefined;
  }

  if (type === 'host/workspace-order-changed') {
    const workspaceIds = stringArray(payload.workspaceIds);
    return workspaceIds === undefined
      ? undefined
      : { ...payload, workspaceIds: workspaceIds.filter((id) => access.workspaceIdAllowed(id)) };
  }

  if (type === 'host/archived-sessions-changed') {
    const sessionIds = stringArray(payload.archivedSessionIds);
    return sessionIds === undefined
      ? undefined
      : { ...payload, archivedSessionIds: sessionIds.filter((id) => access.sessionOwned(id)) };
  }

  if (type === 'host/session-added') {
    return typeof payload.sessionId === 'string' &&
      typeof payload.cwd === 'string' &&
      access.newSessionVisible(payload.sessionId, payload.cwd)
      ? payload
      : undefined;
  }

  if (
    type === 'host/session-removed' ||
    type === 'host/session-status' ||
    type === 'host/agent-error'
  ) {
    return typeof payload.sessionId === 'string' && access.sessionVisible(payload.sessionId)
      ? payload
      : undefined;
  }

  if (
    type === 'session/event' ||
    type === 'session/subscribed' ||
    type === 'session/queue' ||
    type === 'session/jobs' ||
    type === 'session/projection' ||
    type === 'approval/requested' ||
    type === 'approval/resolved' ||
    type === 'question/requested' ||
    type === 'question/resolved'
  ) {
    return typeof payload.sessionId === 'string' && access.sessionVisible(payload.sessionId)
      ? payload
      : undefined;
  }

  // host/remote-event and future frame kinds have no tenant ownership proof.
  return undefined;
}
