/** In-app service inventory, retaining the selected conversation and sidebar. */
import { createElement as h, useEffect } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { ServicesPage } from './services-page';
import { SERVICES_CSS } from './services-styles';

export function ServicesPanel({ t, onBack }: PropsLocale<'dshpw'> & { onBack(): void }) {
  useEffect(() => {
    const style = document.createElement('style'); style.textContent = SERVICES_CSS;
    document.head.appendChild(style); return () => style.remove();
  }, []);
  return h('div', { className: 'services-host', style: { height: '100%', minHeight: 0, minWidth: 0, overflow: 'auto' } }, h(ServicesPage, { t, onBack }));
}
