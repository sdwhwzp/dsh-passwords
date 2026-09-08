import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('消息气泡接入鼠标左键与触摸指针拖动，并阻止拖动后误打开面板', () => {
  const source = readFileSync(path.join(root, 'src/client/chat.tsx'), 'utf8');
  assert.match(source, /onPointerDown=\{onFabPointerDown\}/);
  assert.match(source, /onPointerMove=\{onFabPointerMove\}/);
  assert.match(source, /onPointerUp=/);
  assert.match(source, /onPointerCancel=/);
  assert.match(source, /suppressClickRef\.current/);
  assert.match(source, /touch-action:none/);
});
