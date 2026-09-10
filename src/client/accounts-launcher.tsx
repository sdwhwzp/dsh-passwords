/** Administrator-only shortcut to the standalone account directory. */
import { createElement as h, useEffect, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { StateData } from './card';

interface Props extends PropsLocale<'dshpw'> {
  wide: boolean;
  loadState(): Promise<StateData>;
}

export function AccountsLauncher({ t, wide, loadState }: Props) {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let disposed = false;
    void loadState().then((state) => { if (!disposed) setAdmin(state.me.role === 'admin'); }).catch(() => { if (!disposed) setAdmin(false); });
    return () => { disposed = true; };
  }, []);
  if (!admin) return null;
  return h('a', { href: '/gateway/accounts', target: '_blank', rel: 'noopener noreferrer', className: `dshpw-sidebar-workspace-action${wide ? '' : ' compact'}`, title: t('accountsTitle'), 'aria-label': t('accountsTitle') },
    h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
      h('circle', { cx: 9, cy: 8, r: 3 }), h('path', { d: 'M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2' })),
    wide ? h('span', null, t('accountsTitle')) : null);
}
