/** New-session control-row action that opens the signed-in user's local workspace companion. */

import { Fragment, createElement as h, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { IconProjectAddOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { buildLocalWorkspaceLaunchUri, isWindowsBrowser } from './local-workspace-launch-uri';

const LAUNCH_ENDPOINT = '/api/dsh-passwords/local-workspace/launch';
const WINDOWS_ASSISTANT_URL = '/api/dsh-passwords/local-workspace/windows';
const WINDOWS_GUIDE_STORAGE_KEY = 'dshpw.windows-local-workspace-guide.v2';

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
  const [isWindowsClient, setIsWindowsClient] = useState(false);
  const [guideSeen, setGuideSeen] = useState(true);
  const [guideOpen, setGuideOpen] = useState(false);
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

  useEffect(() => {
    const windows = isWindowsBrowser(window.navigator);
    setIsWindowsClient(windows);
    if (!windows) return;
    try {
      setGuideSeen(window.localStorage.getItem(WINDOWS_GUIDE_STORAGE_KEY) === 'seen');
    } catch {
      setGuideSeen(false);
    }
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

  const rememberGuide = () => {
    try {
      window.localStorage.setItem(WINDOWS_GUIDE_STORAGE_KEY, 'seen');
    } catch {
      // A blocked storage API still allows the guide to close for this page.
    }
    setGuideSeen(true);
  };

  const dismissGuide = () => {
    rememberGuide();
    setGuideOpen(false);
  };

  const continueFromGuide = () => {
    rememberGuide();
    setGuideOpen(false);
    launch();
  };

  const onSummaryClick = (event: ReactMouseEvent<HTMLElement>) => {
    const details = event.currentTarget.closest('details');
    if (launching) {
      event.preventDefault();
      return;
    }
    if (details instanceof HTMLDetailsElement && !details.open) {
      if (isWindowsClient && !guideSeen) {
        event.preventDefault();
        setGuideOpen(true);
        return;
      }
      launch();
    }
  };

  return h(
    Fragment,
    null,
    h(
      'details',
      { className: 'dshpw-local-launcher-seat' },
    h(
      'summary',
      {
        className: 'dshpw-local-launcher-trigger',
        role: 'button',
        'aria-busy': launching,
        'aria-disabled': launching,
        onClick: onSummaryClick,
      },
      h(IconProjectAddOutline16, { size: 16 }),
      h('span', null, launching ? t('localLaunching') : t('localLaunchButton')),
    ),
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
        isWindowsClient
          ? h('button', {
              className: 'dshpw-local-guide-link',
              type: 'button',
              onClick: () => setGuideOpen(true),
            }, t('localGuideReopen'))
          : null,
        h('span', null, t('localLaunchFallbackHint')),
      ),
    ),
      error === '' ? null : h('div', { className: 'dshpw-error', role: 'alert' }, error),
    ),
    ),
    guideOpen
      ? h(
          'div',
          {
            className: 'dshpw-local-guide-backdrop',
            onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
              if (event.target === event.currentTarget) dismissGuide();
            },
          },
          h(
            'div',
            {
              className: 'dshpw-local-guide-dialog',
              role: 'dialog',
              'aria-modal': true,
              'aria-labelledby': 'dshpw-local-guide-title',
            },
            h('div', { className: 'dshpw-local-guide-head' },
              h('h2', { id: 'dshpw-local-guide-title' }, t('localGuideTitle')),
              h('button', {
                className: 'dshpw-local-guide-close',
                type: 'button',
                'aria-label': t('localGuideDismiss'),
                onClick: dismissGuide,
              }, '×'),
            ),
            h('p', null, t('localGuideIntro')),
            h('ol', { className: 'dshpw-local-guide-steps' },
              h('li', null, t('localGuideStep1')),
              h('li', null, t('localGuideStep2')),
              h('li', null, t('localGuideStep3')),
              h('li', null, t('localGuideStep4')),
            ),
            h('div', { className: 'dshpw-local-guide-note' }, t('localGuideNote')),
            h('div', { className: 'dshpw-local-guide-actions' },
              h('a', {
                className: 'dshpw-btn dshpw-download-btn',
                href: WINDOWS_ASSISTANT_URL,
                download: '山东梯智物联AI本机助手.exe',
              }, t('localGuideDownload')),
              h('button', {
                className: 'dshpw-local-guide-dismiss',
                type: 'button',
                onClick: dismissGuide,
              }, t('localGuideDismiss')),
              h('button', {
                className: 'dshpw-btn',
                type: 'button',
                onClick: continueFromGuide,
              }, t('localGuideContinue')),
            ),
          ),
        )
      : null,
  );
}
