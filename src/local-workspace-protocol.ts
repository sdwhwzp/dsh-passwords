/** Wire protocol shared by the dsh host plugin and the user's local companion. */

export const LOCAL_WORKSPACE_PROTOCOL_VERSION = 1;
export const LOCAL_WORKSPACE_MAX_MESSAGE_BYTES = 3 * 1024 * 1024;

export type LocalWorkspaceOperation = 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'bash';

export interface LocalWorkspaceHelloFields {
  protocol: typeof LOCAL_WORKSPACE_PROTOCOL_VERSION;
  deviceName: string;
  workspaceName: string;
  workspaceId: string;
  root: string;
  platform: string;
  shellEnabled: boolean;
}

export interface LocalWorkspacePairHello extends LocalWorkspaceHelloFields {
  type: 'pair';
  code: string;
}

/** One-click custom-scheme launch using a browser-issued, short-lived ticket. */
export interface LocalWorkspaceLaunchHello extends LocalWorkspaceHelloFields {
  type: 'launch';
  ticket: string;
}

/** New device-confirmation flow: no browser-issued bearer secret is sent by the companion. */
export interface LocalWorkspaceDeviceHello extends LocalWorkspaceHelloFields {
  type: 'device';
}

export interface LocalWorkspaceResumeHello extends LocalWorkspaceHelloFields {
  type: 'resume';
  token: string;
}

export type LocalWorkspaceHello =
  | LocalWorkspaceDeviceHello
  | LocalWorkspaceLaunchHello
  | LocalWorkspacePairHello
  | LocalWorkspaceResumeHello;

export interface LocalWorkspaceRequest {
  type: 'request';
  id: string;
  operation: LocalWorkspaceOperation;
  args: Record<string, unknown>;
}

export interface LocalWorkspaceCancel {
  type: 'cancel';
  id: string;
}

export interface LocalWorkspaceResponse {
  type: 'response';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: string;
}

export interface LocalWorkspaceReady {
  type: 'ready';
  workspaceId: string;
  workspacePath: string;
  token?: string;
}

/** Short human-readable code displayed by a device while its WebSocket awaits browser approval. */
export interface LocalWorkspaceDeviceCode {
  type: 'device-code';
  /** Six ASCII digits formatted as `123 456`; it is not a device credential. */
  code: string;
  expiresAt: string;
}

export interface LocalWorkspaceProtocolError {
  type: 'error';
  code: string;
  error: string;
}

export type HostToCompanionMessage =
  | LocalWorkspaceRequest
  | LocalWorkspaceCancel
  | LocalWorkspaceReady
  | LocalWorkspaceDeviceCode
  | LocalWorkspaceProtocolError;
export type CompanionToHostMessage = LocalWorkspaceHello | LocalWorkspaceResponse;

/** Parse one text WebSocket frame into a JSON object. */
export function parseWireObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('wire message must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Validate the first companion frame before authentication or pairing. */
export function parseHello(raw: string): LocalWorkspaceHello {
  const value = parseWireObject(raw);
  if (value.type !== 'device' && value.type !== 'launch' && value.type !== 'pair' && value.type !== 'resume') {
    throw new Error('first message must be device, launch, pair, or resume');
  }
  if (value.protocol !== LOCAL_WORKSPACE_PROTOCOL_VERSION) throw new Error('unsupported local workspace protocol');
  const deviceName = boundedString(value.deviceName, 'deviceName', 1, 80);
  const workspaceName = boundedString(value.workspaceName, 'workspaceName', 1, 120);
  const workspaceId = boundedString(value.workspaceId, 'workspaceId', 8, 120);
  const root = boundedString(value.root, 'root', 1, 4096);
  const platform = boundedString(value.platform, 'platform', 1, 40);
  if (typeof value.shellEnabled !== 'boolean') throw new Error('shellEnabled must be boolean');
  const shared: LocalWorkspaceHelloFields = {
    protocol: LOCAL_WORKSPACE_PROTOCOL_VERSION,
    deviceName,
    workspaceName,
    workspaceId,
    root,
    platform,
    shellEnabled: value.shellEnabled,
  };
  if (value.type === 'device') {
    // Reject accidentally retained legacy secrets instead of silently accepting them
    // into the new device-confirmation flow.
    if (value.code !== undefined || value.token !== undefined) {
      throw new Error('device hello must not include code or token');
    }
    return { type: 'device', ...shared };
  }
  if (value.type === 'launch') {
    const keys = Object.keys(value).sort().join(',');
    if (keys !== 'deviceName,platform,protocol,root,shellEnabled,ticket,type,workspaceId,workspaceName') {
      throw new Error('launch hello contains unexpected fields');
    }
    return { type: 'launch', ticket: launchTicket(value.ticket), ...shared };
  }
  if (value.type === 'pair') {
    return { type: 'pair', code: boundedString(value.code, 'code', 32, 200), ...shared };
  }
  return { type: 'resume', token: boundedString(value.token, 'token', 32, 300), ...shared };
}

/** Accept the compact form used by the API and the grouped form displayed by a device. */
export function normalizeDeviceUserCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (/^[0-9]{6}$/.test(value)) return value;
  if (/^[0-9]{3} [0-9]{3}$/.test(value)) return value.slice(0, 3) + value.slice(4);
  return null;
}

export function displayDeviceUserCode(value: string): string {
  if (!/^[0-9]{6}$/.test(value)) throw new Error('device user code must contain six ASCII digits');
  return `${value.slice(0, 3)} ${value.slice(3)}`;
}

/**
 * Construct the server-issued launch URI. The server parameter is deliberately
 * omitted: when publicUrl is empty only the browser knows its trustworthy
 * current hostname, so the authenticated UI appends `server` immediately
 * before invoking the custom scheme.
 */
export function buildLocalWorkspaceLaunchUri(ticket: string): string {
  const validTicket = launchTicket(ticket);
  const query = new URLSearchParams({ ticket: validTicket });
  return `dsh-local-workspace://connect?${query.toString()}`;
}

/** Validate one authenticated companion response. */
export function parseResponse(raw: string): LocalWorkspaceResponse {
  const value = parseWireObject(raw);
  if (value.type !== 'response') throw new Error('authenticated companion message must be a response');
  const response: LocalWorkspaceResponse = {
    type: 'response',
    id: boundedString(value.id, 'id', 1, 120),
    ok: value.ok === true,
  };
  if (value.value !== undefined) response.value = value.value;
  if (typeof value.error === 'string') response.error = value.error.slice(0, 2000);
  if (typeof value.code === 'string') response.code = value.code.slice(0, 120);
  return response;
}

function boundedString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new Error(`${name} must be a string with length ${String(min)}-${String(max)}`);
  }
  return value;
}

function launchTicket(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('launch ticket must be a 256-bit base64url value');
  }
  return value;
}
