/** Sidebar entry and page dialog for the signed-in subuser's managed folder. */

import { Fragment, createElement as h, useEffect, useState } from 'react';
import {
  IconFolderOpenOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { ManagedFilesPanel } from './managed-files';

interface Props extends PropsLocale<'dshpw'> {
  wide: boolean;
}

/** Show the private-folder action only for a subuser and open its management page. */
export function ManagedFilesLauncher({ t, wide }: Props) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let disposed = false;
    void fetch('/api/dsh-passwords/state', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const value = await response.json().catch(() => ({})) as { me?: { role?: unknown } };
        return value.me?.role === 'user';
      })
      .then((next) => { if (!disposed) setAvailable(next); })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, []);

  if (!available) return null;

  const close = () => {
    if (!busy) setOpen(false);
  };
  return h(
    Fragment,
    null,
    h('button', {
      type: 'button',
      className: `dshpw-sidebar-workspace-action${wide ? '' : ' compact'}`,
      'aria-label': t('managedFilesManage'),
      title: t('managedFilesManage'),
      onClick: () => {
        setError('');
        setNotice('');
        setOpen(true);
      },
    },
    h(IconFolderOpenOutline16, { size: wide ? 16 : 18 }),
    wide ? h('span', null, t('managedFilesManage')) : null,
    ),
    h(
      Modal,
      {
        open,
        onClose: close,
        title: t('managedFilesManage'),
        closeLabel: t('managedFilesClose'),
        className: 'dshpw-managed-files-dialog',
        contentClassName: 'dshpw-managed-files-dialog-content',
      },
      error === '' ? null : h('div', { className: 'dshpw-error', role: 'alert' }, error),
      notice === '' ? null : h('div', { className: 'dshpw-ok', role: 'status' }, notice),
      h(ManagedFilesPanel, { t, busy, setBusy, setError, setNotice }),
    ),
  );
}
