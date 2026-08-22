import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalWorkspacePanel } from '../src/client/local-workspace.tsx';
import { en, zh } from '../src/client/locales.ts';

const root = path.resolve(import.meta.dirname, '..');

test('本机工作区设置页只保留 Windows 一键助手和设备管理', () => {
  const markup = renderToStaticMarkup(createElement(LocalWorkspacePanel, {
    t: (key: string) => key,
    busy: false,
    setBusy: () => undefined,
    setError: () => undefined,
    setNotice: () => undefined,
  }));
  assert.match(markup, /\/api\/dsh-passwords\/local-workspace\/windows/);
  assert.match(markup, />localWindowsDownload</);
  assert.match(markup, />localShellWarning</);
  assert.doesNotMatch(markup, /dshpw-local-device-code|dshpw-local-server|dshpw-local-approval|dshpw-local-legacy/);
  assert.doesNotMatch(markup, /localServer|localApprove|localLegacy|--pair/);

  const source = readFileSync(path.join(root, 'src/client/local-workspace.tsx'), 'utf8');
  assert.doesNotMatch(source, /local-workspace\/(?:info|approve|pair)|deviceCode|legacyCommand|createLegacyPairing|--pair/);
});

test('Windows 一键设置说明具备完整中英文文案', () => {
  for (const key of [
    'localTitle',
    'localHint',
    'localWindowsTitle',
    'localWindowsHint',
    'localWindowsDownload',
    'localWindowsUnsigned',
    'localShellWarning',
  ] as const) {
    assert.equal(typeof zh[key], 'string');
    assert.ok(zh[key].length > 0);
    assert.equal(typeof en[key], 'string');
    assert.ok(en[key].length > 0);
  }
});
