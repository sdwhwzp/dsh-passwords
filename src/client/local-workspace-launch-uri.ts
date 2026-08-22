/** Validation and assembly for the local-workspace companion protocol URI. */

const MAX_LAUNCH_URI_LENGTH = 4096;
const LAUNCH_TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

interface LocalWorkspaceConnection {
  port: number;
  secure: boolean;
  publicUrl: string;
}

/** Detect a desktop Windows browser for the first-use companion guide. */
export function isWindowsBrowser(value: {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}): boolean {
  const platform = value.userAgentData?.platform ?? value.platform ?? '';
  if (/^Win(?:32|64)?$/iu.test(platform) || /^Windows$/iu.test(platform)) return true;
  return /Windows NT/iu.test(value.userAgent ?? '');
}

function localWorkspaceServerAddress(
  connection: LocalWorkspaceConnection,
  browserHostname: string,
): string {
  const configured = connection.publicUrl.trim();
  if (configured !== '') return configured;
  const hostname = browserHostname.includes(':') && !browserHostname.startsWith('[')
    ? `[${browserHostname}]`
    : browserHostname;
  return `${connection.secure ? 'wss' : 'ws'}://${hostname}:${String(connection.port)}`;
}

/**
 * Return the canonical companion URI only when it addresses the one supported
 * custom-protocol action. Server response text never reaches navigation
 * without this allowlist.
 */
export function validatedLocalWorkspaceLaunchUri(value: unknown): string | null {
  return validateLocalWorkspaceLaunchUri(value, false);
}

function validateLocalWorkspaceLaunchUri(value: unknown, requireServer: boolean): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LAUNCH_URI_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'dsh-local-workspace:'
    || url.hostname !== 'connect'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || (url.pathname !== '' && url.pathname !== '/')
    || url.hash !== ''
  ) return null;
  const keys = [...url.searchParams.keys()];
  const tickets = url.searchParams.getAll('ticket');
  const servers = url.searchParams.getAll('server');
  if (
    keys.some((key) => key !== 'ticket' && key !== 'server')
    || tickets.length !== 1
    || !LAUNCH_TICKET_RE.test(tickets[0] ?? '')
    || (requireServer ? servers.length !== 1 || servers[0] === '' : servers.length > 1)
  ) return null;
  return url.href;
}

/** Build the final protocol URI from the ticket and trusted connection fields. */
export function buildLocalWorkspaceLaunchUri(
  baseUri: unknown,
  connectionValue: unknown,
  browserHostname: string,
): string | null {
  const canonicalBase = validatedLocalWorkspaceLaunchUri(baseUri);
  if (canonicalBase === null || !isLocalWorkspaceConnection(connectionValue)) return null;

  const server = localWorkspaceServerAddress(connectionValue, browserHostname);
  let serverUrl: URL;
  try {
    serverUrl = new URL(server);
  } catch {
    return null;
  }
  if (
    (serverUrl.protocol !== 'ws:' && serverUrl.protocol !== 'wss:')
    || serverUrl.hostname === ''
    || serverUrl.username !== ''
    || serverUrl.password !== ''
    || serverUrl.hash !== ''
  ) return null;

  const launchUrl = new URL(canonicalBase);
  launchUrl.searchParams.set('server', server);
  return validateLocalWorkspaceLaunchUri(launchUrl.href, true);
}

function isLocalWorkspaceConnection(value: unknown): value is LocalWorkspaceConnection {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<LocalWorkspaceConnection>;
  return typeof candidate.port === 'number'
    && Number.isInteger(candidate.port)
    && candidate.port >= 1
    && candidate.port <= 65535
    && typeof candidate.secure === 'boolean'
    && typeof candidate.publicUrl === 'string';
}
