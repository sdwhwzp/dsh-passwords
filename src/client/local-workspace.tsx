/** Settings panel for downloading the Windows companion and revoking local workspaces. */

import { createElement as h, useEffect, useState } from 'react';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';

interface WorkspaceView {
  id: string;
  deviceName: string;
  workspaceName: string;
  platform: string;
  shellEnabled: boolean;
  online: boolean;
  createdAt: string;
  lastSeenAt: string;
}

interface Props {
  t: TranslateNS<'dshpw'>;
  busy: boolean;
  setBusy(value: boolean): void;
  setError(value: string): void;
  setNotice(value: string): void;
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${String(response.status)}`);
  return value;
}

export function LocalWorkspacePanel(props: Props) {
  const { t, busy, setBusy, setError, setNotice } = props;
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);

  const refresh = () => {
    void api<{ workspaces: WorkspaceView[] }>('/api/dsh-passwords/local-workspace/list')
      .then((result) => setWorkspaces(result.workspaces))
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
  };

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const revoke = (workspace: WorkspaceView) => {
    if (!window.confirm(t('localRevokeConfirm', { name: workspace.workspaceName }))) return;
    setBusy(true);
    setError('');
    void api('/api/dsh-passwords/local-workspace/revoke', { id: workspace.id })
      .then(() => {
        setNotice(t('localRevoked'));
        refresh();
      })
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  return h(
    'div',
    { className: 'dshpw-section' },
    h('div', { className: 'dshpw-section-head' },
      h('span', { className: 'dshpw-label' }, t('localTitle')),
    ),
    h('div', { className: 'dshpw-hint' }, t('localHint')),
    h(
      'div',
      { className: 'dshpw-local-download' },
      h('div', { className: 'dshpw-switch-copy' },
        h('strong', null, t('localWindowsTitle')),
        h('small', null, t('localWindowsHint')),
      ),
      h('a', {
        className: 'dshpw-btn dshpw-download-btn',
        href: '/api/dsh-passwords/local-workspace/windows',
        download: '山东梯智物联AI本机助手.exe',
      }, t('localWindowsDownload')),
    ),
    h('div', { className: 'dshpw-hint' }, t('localWindowsUnsigned')),
    h('div', { className: 'dshpw-hint' }, t('localShellWarning')),
    workspaces.length === 0
      ? h('div', { className: 'dshpw-hint' }, t('localEmpty'))
      : h(
          'div',
          { className: 'dshpw-workspaces' },
          ...workspaces.map((workspace) => h(
            'div',
            { className: 'dshpw-local-workspace', key: workspace.id },
            h('div', { className: 'dshpw-switch-copy' },
              h('strong', null, workspace.workspaceName),
              h('small', null, `${workspace.deviceName} · ${workspace.platform} · ${workspace.shellEnabled ? t('localShellOn') : t('localShellOff')}`),
            ),
            h('span', { className: workspace.online ? 'dshpw-ok' : 'dshpw-hint' }, workspace.online ? t('localOnline') : t('localOffline')),
            h('button', { className: 'dshpw-btn danger', disabled: busy, onClick: () => revoke(workspace) }, t('localRevoke')),
          )),
        ),
  );
}
