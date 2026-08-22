/**
 * Account logout shared by the settings card and the desktop launcher's
 * floating power entry.  The latter normally shuts down dsh and deliberately
 * replaces the tab with a blank page; behind the login gateway that action is
 * account logout instead, so the service must stay alive.
 */

const LAUNCHER_EXIT_LABELS = new Set(['退出 DeepSeek Harness', 'Exit DeepSeek Harness']);

type LogoutLanguage = 'zh' | 'en';

export function isDesktopLauncherExitLabel(label: string | null | undefined): boolean {
  return typeof label === 'string' && LAUNCHER_EXIT_LABELS.has(label.trim());
}

function languageOf(label: string | null | undefined): LogoutLanguage {
  return typeof label === 'string' && label.includes('退出') ? 'zh' : 'en';
}

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

function markLauncherButton(button: HTMLButtonElement): void {
  const currentLabel = button.getAttribute('aria-label');
  const alreadyMarked = button.dataset.dshpwAccountLogout === '1';
  const inStableLauncherHost = button.closest('[data-dsh-shutdown-float="true"]') !== null;
  if (!alreadyMarked && !inStableLauncherHost && !isDesktopLauncherExitLabel(currentLabel)) return;

  const language = alreadyMarked
    ? (button.dataset.dshpwLogoutLanguage === 'zh' ? 'zh' : 'en')
    : languageOf(currentLabel);
  const label = language === 'zh' ? '退出当前账号' : 'Sign out current account';
  button.dataset.dshpwAccountLogout = '1';
  button.dataset.dshpwLogoutLanguage = language;
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
  if (button.title !== label) button.title = label;
}

function markLauncherButtons(root: ParentNode): void {
  if (root instanceof HTMLButtonElement) markLauncherButton(root);
  root.querySelectorAll<HTMLButtonElement>('button[aria-label]').forEach(markLauncherButton);
}

/**
 * Convert @linxin666/dsh-desktop-launcher's floating shutdown control into an
 * account logout control.  A document capture listener runs before React's
 * delegated onClick, so the third-party shutdown handler never executes.
 */
export function installDesktopLauncherLogoutBridge(): () => void {
  markLauncherButtons(document);

  const onClickCapture = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button');
    if (!button) return;
    markLauncherButton(button);
    if (button.dataset.dshpwAccountLogout !== '1') return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const language: LogoutLanguage = button.dataset.dshpwLogoutLanguage === 'zh' ? 'zh' : 'en';
    const prompt = language === 'zh' ? '确定退出当前账号吗？' : 'Sign out of the current account?';
    if (!window.confirm(prompt)) return;
    submitLogoutNavigation();
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLButtonElement) {
        markLauncherButton(record.target);
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) markLauncherButtons(node);
      }
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-label', 'title'],
  });
  document.addEventListener('click', onClickCapture, true);

  return () => {
    observer.disconnect();
    document.removeEventListener('click', onClickCapture, true);
  };
}
