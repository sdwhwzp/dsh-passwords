/** In-app private-folder page with the existing authenticated file operations. */
import { createElement as h, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { ManagedFilesPanel } from './managed-files';

/** Render directory controls without an outer dialog or browser navigation. */
export function ManagedFilesPage({ t, onBack }: PropsLocale<'dshpw'> & { onBack(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  return h('main', { className: 'dshpw-managed-files-page' },
    h('div', { className: 'dshpw-managed-files-inner' },
      h('div', { className: 'dshpw-managed-files-page-head' },
        h('nav', null, h('button', { type: 'button', className: 'dshpw-btn ghost sm', disabled: busy, onClick: onBack }, `← ${t('accountsBack')}`)),
        h('div', { className: 'dshpw-managed-files-page-title' },
          h('h1', null, t('managedFilesManage')),
          h('span', { className: 'dshpw-chip' }, t('managedFilesTitle')),
        ),
      ),
      error === '' ? null : h('div', { className: 'dshpw-error', role: 'alert' }, error),
      notice === '' ? null : h('div', { className: 'dshpw-ok', role: 'status' }, notice),
      h(ManagedFilesPanel, { t, busy, setBusy, setError, setNotice }),
    ),
  );
}
