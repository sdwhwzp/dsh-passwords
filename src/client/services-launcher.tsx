/** Sidebar shortcut available to both account roles. */
import { createElement as h } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
export function ServicesLauncher({ t, wide }: PropsLocale<'dshpw'> & { wide: boolean }) {
  return h('a', { href: '/gateway/services', target: '_blank', rel: 'noopener noreferrer', className: `dshpw-sidebar-workspace-action${wide ? '' : ' compact'}`, title: t('servicesTitle'), 'aria-label': t('servicesTitle') },
    h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true }, h('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2 }), h('path', { d: 'M8 21h8M12 17v4M9 8l6 3-6 3z' })),
    wide ? h('span', null, t('servicesTitle')) : null);
}
