/** Account logout UI and gateway-safe desktop-launcher suppression. */

import { createElement as h } from 'react';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';

/** Submit a real top-level POST and let the gateway's 302 render login. */
export function submitLogoutNavigation(): void {
  const action = new URL('/gateway/logout', window.location.href);
  if (action.protocol !== 'http:' && action.protocol !== 'https:') {
    throw new Error('account logout requires an HTTP(S) gateway page');
  }
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action.href;
  form.target = '_top';
  form.hidden = true;
  document.body.appendChild(form);
  form.submit();
}

/**
 * Hide the desktop launcher's machine-wide shutdown control behind the login
 * gateway. Account logout lives in General settings instead.
 */
export function installDesktopLauncherSuppression(): () => void {
  const existing = document.querySelector<HTMLStyleElement>('style[data-dshpw-launcher-suppressed="1"]');
  if (existing !== null) return () => {};
  const style = document.createElement('style');
  style.dataset.dshpwLauncherSuppressed = '1';
  style.textContent = '[data-dsh-shutdown-float="true"]{display:none!important}';
  document.head.appendChild(style);
  return () => style.remove();
}

type AccountLogoutRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'dshpw'>;

/** Render account logout as the final General settings row. */
export function AccountLogoutRow({ t }: AccountLogoutRowProps) {
  const logout = () => {
    if (!window.confirm(t('logoutConfirm'))) return;
    submitLogoutNavigation();
  };
  return h(
    'div',
    { className: 'dshpw-general-row' },
    h(
      'div',
      { className: 'dshpw-general-row-copy' },
      h('div', { className: 'dshpw-general-row-title' }, t('logout')),
      h('div', { className: 'dshpw-general-row-desc' }, t('logoutHint')),
    ),
    h('button', {
      className: 'dshpw-general-logout',
      type: 'button',
      onClick: logout,
    }, t('logout')),
  );
}
