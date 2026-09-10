/** Standalone account page; all data and mutations use the authenticated gateway. */
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { DshPasswordsCard, type StateData } from './card';
import { api } from './api';
import { zh, en } from './locales';
import { CARD_CSS } from './styles';
import { ACCOUNTS_CSS } from './accounts-styles';

const dictionary = document.documentElement.lang === 'en' ? en : zh;
const t = (key: string, params?: Record<string, unknown>) => {
  let text: string = (dictionary as Record<string, string>)[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
  return text;
};
const style = document.createElement('style');
style.textContent = CARD_CSS + ACCOUNTS_CSS;
document.head.appendChild(style);
document.title = t('accountsTitle');
createRoot(document.getElementById('accounts-root')!).render(
  h('main', { className: 'dshpw-accounts-page' },
    h('nav', { className: 'dshpw-accounts-nav' }, h('a', { href: '/' }, `← ${t('accountsBack')}`),
      h('span', null, h('a', { href: '?lang=zh', lang: 'zh-CN' }, '中文'), ' / ', h('a', { href: '?lang=en', lang: 'en' }, 'English'))),
    h(DshPasswordsCard, { t, mode: 'accounts', loadState: () => api<StateData>('/api/dsh-passwords/state') })),
);
