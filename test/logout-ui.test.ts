import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountLogoutRow } from '../src/client/account-logout.ts';

const root = path.resolve(import.meta.dirname, '..');

test('通用设置退出条目使用 body 直属 POST 表单并由服务器原生跳回登录页', () => {
  const card = readFileSync(path.join(root, 'src/client/card.tsx'), 'utf8');
  const logout = readFileSync(path.join(root, 'src/client/account-logout.ts'), 'utf8');
  const index = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8');
  const markup = renderToStaticMarkup(createElement(AccountLogoutRow, {
    t: (key: string) => key,
  }));
  assert.match(markup, /dshpw-general-row/);
  assert.match(markup, /logoutHint/);
  assert.match(markup, /<button class="dshpw-general-logout" type="button">logout<\/button>/);
  assert.match(index, /ctx\.slots\.inject\('settings\.general\.item'/);
  assert.match(index, /id: 'dsh-passwords-account-logout'/);
  assert.match(index, /order: 1000/);
  assert.match(logout, /document\.createElement\('form'\)/);
  assert.match(logout, /form\.method = 'POST'/);
  assert.match(logout, /new URL\('\/gateway\/logout', window\.location\.href\)/);
  assert.match(logout, /form\.target = '_top'/);
  assert.match(logout, /document\.body\.appendChild\(form\)/);
  assert.match(logout, /form\.submit\(\)/);
  assert.match(logout, /t\('logoutConfirm'\)/);
  assert.doesNotMatch(card, /dshpw-logout/);
  assert.doesNotMatch(card, /fetch\('\/gateway\/logout'/);
  assert.doesNotMatch(card, /window\.location\.(?:replace|assign)/);
  assert.doesNotMatch(logout, /about:blank/);
});

test('登录网关隐藏桌面启动器电源入口，不再捕获为账号退出', () => {
  const logout = readFileSync(path.join(root, 'src/client/account-logout.ts'), 'utf8');
  assert.match(logout, /data-dsh-shutdown-float/);
  assert.match(logout, /display:none!important/);
  assert.match(logout, /installDesktopLauncherSuppression/);
  assert.doesNotMatch(logout, /addEventListener\('click'/);
  assert.doesNotMatch(logout, /MutationObserver/);
  assert.doesNotMatch(logout, /requestShutdown/);
  assert.doesNotMatch(logout, /closeCurrentPage/);
});

test('退出入口具备中英文文案', () => {
  const locales = readFileSync(path.join(root, 'src/client/locales.ts'), 'utf8');
  assert.match(locales, /logout: '退出登录'/);
  assert.match(locales, /logoutHint: '退出当前账号并返回登录页，不会关闭共享服务。'/);
  assert.match(locales, /logout: 'Sign out'/);
  assert.match(locales, /logoutHint: 'Sign out of this account and return to login without stopping the shared service.'/);
});
