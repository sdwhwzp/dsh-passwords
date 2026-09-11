/** Standalone service directory served by the authenticated gateway. */
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { ServicesPage } from './services-page';
import { zh, en } from './locales';
import { SERVICES_CSS } from './services-styles';
const dictionary = document.documentElement.lang === 'en' ? en : zh;
const t = (key: string, params?: Record<string, unknown>) => {
  let text: string = (dictionary as Record<string, string>)[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
  return text;
};
const style = document.createElement('style');
style.textContent = SERVICES_CSS;
document.head.appendChild(style);
document.title = t('servicesTitle');
createRoot(document.getElementById('services-root')!).render(h(ServicesPage, { t }));
