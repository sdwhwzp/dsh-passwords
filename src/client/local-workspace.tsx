/** Settings panel for approving and revoking user-side local workspace companions. */

import { createElement as h, useEffect, useState } from 'react';

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

export interface LocalWorkspaceConnection {
  port: number;
  secure: boolean;
  publicUrl: string;
}

interface PairingResult extends LocalWorkspaceConnection {
  code: string;
  expiresAt: string;
}

interface Props {
  t: (key: string, params?: Record<string, string | number>) => string;
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

/** Accept readable forms such as 123456, 123 456, or 12-34-56. */
export function normalizeDeviceCode(raw: string): string | null {
  if (!/^[0-9\s-]*$/u.test(raw)) return null;
  const code = raw.replace(/[\s-]/gu, '');
  return /^[0-9]{6}$/.test(code) ? code : null;
}

/** Resolve the address shown to the companion without trusting browser Host for its port. */
export function localWorkspaceServerAddress(
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

export function LocalWorkspacePanel(props: Props) {
  const { t, busy, setBusy, setError, setNotice } = props;
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [connection, setConnection] = useState<LocalWorkspaceConnection | null>(null);
  const [deviceCode, setDeviceCode] = useState('');
  const [legacyCommand, setLegacyCommand] = useState('');
  const [legacyExpiresAt, setLegacyExpiresAt] = useState('');

  const refresh = () => {
    void api<{ workspaces: WorkspaceView[] }>('/api/dsh-passwords/local-workspace/list')
      .then((result) => setWorkspaces(result.workspaces))
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
    void api<LocalWorkspaceConnection & { ok: true }>('/api/dsh-passwords/local-workspace/info')
      .then((result) => setConnection(result))
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
  };

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const approve = () => {
    const code = normalizeDeviceCode(deviceCode);
    if (code === null) {
      setError(t('localCodeInvalid'));
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    void api('/api/dsh-passwords/local-workspace/approve', { code })
      .then(() => {
        setDeviceCode('');
        setNotice(t('localApproved'));
        refresh();
      })
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  /** Compatibility path for older CLI builds that still consume a long one-time secret. */
  const createLegacyPairing = () => {
    setBusy(true);
    setError('');
    setNotice('');
    void api<{ pairing: PairingResult }>('/api/dsh-passwords/local-workspace/pair', {})
      .then(({ pairing }) => {
        const hostname = typeof window === 'undefined' ? 'localhost' : window.location.hostname;
        const server = localWorkspaceServerAddress(pairing, hostname);
        setLegacyCommand(
          `dsh-local-workspace --server ${shellQuote(server)} --pair ${shellQuote(pairing.code)} --folder ${shellQuote(t('localFolderPlaceholder'))}`,
        );
        setLegacyExpiresAt(new Date(pairing.expiresAt).toLocaleTimeString());
        setNotice(t('localPairReady'));
      })
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

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

  const copyText = (value: string, successKey: string) => {
    if (navigator.clipboard === undefined) {
      setError(t('localCopyFailed'));
      return;
    }
    void navigator.clipboard.writeText(value)
      .then(() => setNotice(t(successKey)))
      .catch(() => setError(t('localCopyFailed')));
  };

  const hostname = typeof window === 'undefined' ? 'localhost' : window.location.hostname;
  const serverAddress = connection === null ? '' : localWorkspaceServerAddress(connection, hostname);

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
    h(
      'div',
      { className: 'dshpw-local-server' },
      h('div', { className: 'dshpw-switch-copy' },
        h('strong', null, t('localServerTitle')),
        h('code', null, serverAddress || t('localServerLoading')),
      ),
      h('button', {
        className: 'dshpw-btn',
        type: 'button',
        disabled: busy || serverAddress === '',
        onClick: () => copyText(serverAddress, 'localServerCopied'),
      }, t('localServerCopy')),
    ),
    h('div', { className: 'dshpw-hint' }, t('localServerHint')),
    h(
      'div',
      { className: 'dshpw-local-approval' },
      h('div', { className: 'dshpw-switch-copy' },
        h('strong', null, t('localApproveTitle')),
        h('small', null, t('localApproveHint')),
      ),
      h('input', {
        className: 'dshpw-input dshpw-local-code',
        type: 'text',
        inputMode: 'numeric',
        pattern: '[0-9 -]*',
        maxLength: 12,
        autoComplete: 'one-time-code',
        name: 'dshpw-local-device-code',
        value: deviceCode,
        placeholder: t('localCodePlaceholder'),
        'aria-label': t('localApproveTitle'),
        onChange: (event: { target: { value: string } }) => setDeviceCode(event.target.value),
        onKeyDown: (event: { key: string; preventDefault(): void }) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            approve();
          }
        },
      }),
      h('button', {
        className: 'dshpw-btn',
        type: 'button',
        disabled: busy,
        onClick: approve,
      }, t('localApprove')),
    ),
    h(
      'div',
      { className: 'dshpw-local-command' },
      h('small', { className: 'dshpw-hint' }, t('localInstallHint')),
      h('code', null, t('localInstallCommand')),
    ),
    h('div', { className: 'dshpw-hint' }, t('localShellWarning')),
    h(
      'details',
      { className: 'dshpw-local-legacy' },
      h('summary', null, t('localLegacyTitle')),
      h('div', { className: 'dshpw-hint' }, t('localLegacyHint')),
      h('button', {
        className: 'dshpw-btn',
        type: 'button',
        disabled: busy,
        onClick: createLegacyPairing,
      }, t('localPair')),
      legacyCommand !== ''
        ? h(
            'div',
            { className: 'dshpw-local-command' },
            h('code', null, legacyCommand),
            h('button', {
              className: 'dshpw-btn',
              type: 'button',
              disabled: busy,
              onClick: () => copyText(legacyCommand, 'localCopied'),
            }, t('localCopy')),
            h('small', { className: 'dshpw-hint' }, t('localExpires', { time: legacyExpiresAt })),
          )
        : null,
    ),
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

function shellQuote(value: string): string {
  return `"${value.replace(/["\\$`]/g, '\\$&')}"`;
}
