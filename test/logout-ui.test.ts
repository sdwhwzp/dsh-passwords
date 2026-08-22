import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isDesktopLauncherExitLabel } from '../src/client/account-logout.ts';

const root = path.resolve(import.meta.dirname, '..');

test('设置卡片使用 body 直属 POST 表单并由服务器原生跳回登录页', () => {
  const card = readFileSync(path.join(root, 'src/client/card.tsx'), 'utf8');
  const logout = readFileSync(path.join(root, 'src/client/account-logout.ts'), 'utf8');
  assert.match(card, /submitLogoutNavigation\(\)/);
  assert.match(logout, /document\.createElement\('form'\)/);
  assert.match(logout, /form\.method = 'POST'/);
  assert.match(logout, /new URL\('\/gateway\/logout', window\.location\.href\)/);
  assert.match(logout, /form\.target = '_top'/);
  assert.match(logout, /document\.body\.appendChild\(form\)/);
  assert.match(logout, /form\.submit\(\)/);
  assert.match(card, /t\('logoutConfirm'\)/);
  assert.match(card, /type: 'button'/);
  assert.doesNotMatch(card, /fetch\('\/gateway\/logout'/);
  assert.doesNotMatch(card, /window\.location\.(?:replace|assign)/);
  assert.doesNotMatch(logout, /about:blank/);
});

test('桌面启动器电源入口被捕获为账号退出，不再执行宿主关机事件', () => {
  const logout = readFileSync(path.join(root, 'src/client/account-logout.ts'), 'utf8');
  assert.equal(isDesktopLauncherExitLabel('退出 DeepSeek Harness'), true);
  assert.equal(isDesktopLauncherExitLabel('Exit DeepSeek Harness'), true);
  assert.equal(isDesktopLauncherExitLabel('退出当前账号'), false);
  assert.match(logout, /document\.addEventListener\('click', onClickCapture, true\)/);
  assert.match(logout, /data-dsh-shutdown-float/);
  assert.match(logout, /event\.stopImmediatePropagation\(\)/);
  assert.match(logout, /MutationObserver/);
  assert.doesNotMatch(logout, /requestShutdown/);
  assert.doesNotMatch(logout, /closeCurrentPage/);
});

test('退出入口具备中英文文案', () => {
  const locales = readFileSync(path.join(root, 'src/client/locales.ts'), 'utf8');
  assert.match(locales, /logout: '退出登录'/);
  assert.match(locales, /logout: 'Sign out'/);
});
