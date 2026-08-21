import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('设置卡片使用同源 POST 退出并显式替换为完整登录地址', () => {
  const card = readFileSync(path.join(root, 'src/client/card.tsx'), 'utf8');
  assert.match(card, /fetch\('\/gateway\/logout', \{ method: 'POST', credentials: 'same-origin' \}\)/);
  assert.match(card, /t\('logoutConfirm'\)/);
  assert.match(card, /window\.location\.replace\(new URL\('\/gateway\/login', window\.location\.origin\)\.href\)/);
  assert.match(card, /type: 'button'/);
  assert.doesNotMatch(card, /action: '\/gateway\/logout'/);
});

test('退出入口具备中英文文案', () => {
  const locales = readFileSync(path.join(root, 'src/client/locales.ts'), 'utf8');
  assert.match(locales, /logout: '退出登录'/);
  assert.match(locales, /logout: 'Sign out'/);
});
