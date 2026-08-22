/** Composer dock entry that opens the signed-in user's local workspace companion. */

import { createElement as h, useEffect, useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import {
  localWorkspaceServerAddress,
  type LocalWorkspaceConnection,
} from './local-workspace';

const LAUNCH_ENDPOINT = '/api/dsh-passwords/local-workspace/launch';
const WINDOWS_ASSISTANT_URL = '/api/dsh-passwords/local-workspace/windows';
const MAX_LAUNCH_URI_LENGTH = 4096;
const LAUNCH_TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

interface LaunchResponse {
  error?: unknown;
  launch?: {
    uri?: unknown;
    connection?: unknown;
  };
}

interface LocalWorkspaceView {
  id: string;
  deviceName: string;
  workspaceName: string;
  workspacePath: string;
  online: boolean;
}

interface LauncherProps extends PropsLocale<'dshpw'> {
  openWorkspacePath(path: string): Promise<void>;
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

function triggerLocalWorkspaceLaunch(uri: string): void {
  // A same-page protocol link asks the browser to invoke the registered helper.
  // It never creates an about:blank tab and does not clear the current dsh page.
  const anchor = document.createElement('a');
  anchor.href = uri;
  anchor.hidden = true;
  anchor.setAttribute('aria-hidden', 'true');
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

/** Global one-click local folder picker available even without a conversation. */
export function LocalWorkspaceLauncher({ t, openWorkspacePath }: LauncherProps) {
  const [launching, setLaunching] = useState(false);
  const [openingId, setOpeningId] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState('');
  const [workspaces, setWorkspaces] = useState<LocalWorkspaceView[]>([]);
  const inFlight = useRef(false);

  const refreshWorkspaces = () => {
    void fetch('/api/dsh-passwords/local-workspace/list', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    }).then(async (response) => {
      const result = await response.json().catch(() => ({})) as { workspaces?: unknown };
      if (!response.ok || !Array.isArray(result.workspaces)) return;
      const next = result.workspaces.filter((value): value is LocalWorkspaceView => {
        if (value === null || typeof value !== 'object') return false;
        const row = value as Partial<LocalWorkspaceView>;
        return typeof row.id === 'string'
          && typeof row.deviceName === 'string'
          && typeof row.workspaceName === 'string'
          && typeof row.workspacePath === 'string'
          && typeof row.online === 'boolean';
      });
      setWorkspaces(next);
    }).catch(() => undefined);
  };

  useEffect(() => {
    refreshWorkspaces();
    const timer = window.setInterval(refreshWorkspaces, 2_000);
    return () => window.clearInterval(timer);
  }, []);

  const launch = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLaunching(true);
    setAttempted(false);
    setError('');
    void fetch(LAUNCH_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: '{}',
    })
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as LaunchResponse;
        if (!response.ok) {
          throw new Error(typeof result.error === 'string' ? result.error : `HTTP ${String(response.status)}`);
        }
        const uri = buildLocalWorkspaceLaunchUri(
          result.launch?.uri,
          result.launch?.connection,
          window.location.hostname,
        );
        if (uri === null) throw new Error(t('localLaunchInvalid'));
        setAttempted(true);
        triggerLocalWorkspaceLaunch(uri);
        window.setTimeout(refreshWorkspaces, 750);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        inFlight.current = false;
        setLaunching(false);
      });
  };

  const openConversation = (workspace: LocalWorkspaceView) => {
    if (openingId !== '') return;
    setOpeningId(workspace.id);
    setError('');
    void openWorkspacePath(workspace.workspacePath)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : t('localOpenConversationFailed'));
      })
      .finally(() => setOpeningId(''));
  };

  const onlineWorkspaces = workspaces.filter((workspace) => workspace.online);

  return h(
    'details',
    { className: 'dshpw-local-launcher-popover' },
    h('summary', { className: 'dshpw-btn' }, t('localLaunchButton')),
    h(
      'div',
      { className: 'dshpw-local-launcher', 'aria-busy': launching },
    h(
      'div',
      { className: 'dshpw-local-launcher-main' },
      h(
        'div',
        { className: 'dshpw-local-launcher-copy' },
        h('strong', null, t('localLaunchTitle')),
        h('small', null, t('localLaunchHint')),
      ),
      h('button', {
        className: 'dshpw-btn',
        type: 'button',
        disabled: launching,
        onClick: launch,
      }, launching ? t('localLaunching') : t('localLaunchButton')),
    ),
    attempted
      ? h('div', { className: 'dshpw-local-launcher-status', role: 'status' }, t('localLaunchRequested'))
      : null,
    onlineWorkspaces.length === 0
      ? h('div', { className: 'dshpw-hint' }, t('localConnectedHint'))
      : h(
          'div',
          { className: 'dshpw-local-launcher-workspaces' },
          ...onlineWorkspaces.map((workspace) => h(
            'div',
            { className: 'dshpw-local-launcher-workspace', key: workspace.id },
            h('span', null,
              h('strong', null, workspace.workspaceName),
              h('small', null, workspace.deviceName),
            ),
            h('button', {
              className: 'dshpw-btn',
              type: 'button',
              disabled: openingId !== '',
              onClick: () => openConversation(workspace),
            }, openingId === workspace.id ? t('localOpeningConversation') : t('localOpenConversation')),
          )),
        ),
    h(
      'details',
      { className: 'dshpw-local-launcher-fallback', open: attempted },
      h('summary', null, t('localLaunchFallbackTitle')),
      h(
        'div',
        { className: 'dshpw-local-launcher-help' },
        h('a', {
          href: WINDOWS_ASSISTANT_URL,
          download: '山东梯智物联AI本机助手.exe',
        }, t('localLaunchDownload')),
        h('span', null, t('localLaunchFallbackHint')),
      ),
    ),
      error === '' ? null : h('div', { className: 'dshpw-error', role: 'alert' }, error),
    ),
  );
}
