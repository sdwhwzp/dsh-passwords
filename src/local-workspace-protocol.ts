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

export interface LocalWorkspaceResumeHello extends LocalWorkspaceHelloFields {
  type: 'resume';
  token: string;
}

export type LocalWorkspaceHello = LocalWorkspacePairHello | LocalWorkspaceResumeHello;

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

export interface LocalWorkspaceProtocolError {
  type: 'error';
  code: string;
  error: string;
}

export type HostToCompanionMessage = LocalWorkspaceRequest | LocalWorkspaceCancel | LocalWorkspaceReady | LocalWorkspaceProtocolError;
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
  if (value.type !== 'pair' && value.type !== 'resume') throw new Error('first message must be pair or resume');
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
  if (value.type === 'pair') {
    return { type: 'pair', code: boundedString(value.code, 'code', 32, 200), ...shared };
  }
  return { type: 'resume', token: boundedString(value.token, 'token', 32, 300), ...shared };
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
