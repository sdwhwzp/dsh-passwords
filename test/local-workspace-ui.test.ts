import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LocalWorkspacePanel,
  localWorkspaceServerAddress,
  normalizeDeviceCode,
} from '../src/client/local-workspace.tsx';
import { en, zh } from '../src/client/locales.ts';

const root = path.resolve(import.meta.dirname, '..');

test('六位设备码允许空格与连字符，并在提交前规范化', () => {
  assert.equal(normalizeDeviceCode('123456'), '123456');
  assert.equal(normalizeDeviceCode('123 456'), '123456');
  assert.equal(normalizeDeviceCode('12-34-56'), '123456');
  assert.equal(normalizeDeviceCode(' 123 - 456 '), '123456');

  for (const value of ['', '12345', '1234567', '123 45x', '１２３４５６', '123_456']) {
    assert.equal(normalizeDeviceCode(value), null, `${JSON.stringify(value)} 应被拒绝`);
  }
});

test('助手地址优先使用 publicUrl，否则按网页主机名和独立端口推导', () => {
  assert.equal(
    localWorkspaceServerAddress({ port: 3082, secure: true, publicUrl: ' wss://assistant.example.test/ws ' }, 'ignored'),
    'wss://assistant.example.test/ws',
  );
  assert.equal(
    localWorkspaceServerAddress({ port: 3082, secure: false, publicUrl: '' }, 'dsh.example.test'),
    'ws://dsh.example.test:3082',
  );
  assert.equal(
    localWorkspaceServerAddress({ port: 3082, secure: true, publicUrl: '' }, '2001:db8::1'),
    'wss://[2001:db8::1]:3082',
  );
});

test('默认网页是六位确认主流程，长 --pair 命令只位于折叠兼容区', () => {
  const markup = renderToStaticMarkup(createElement(LocalWorkspacePanel, {
    t: (key: string) => key,
    busy: false,
    setBusy: () => undefined,
    setError: () => undefined,
    setNotice: () => undefined,
  }));
  assert.match(markup, /name="dshpw-local-device-code"/);
  assert.match(markup, /autoComplete="one-time-code"/);
  assert.match(markup, />localApprove</);
  assert.match(markup, /<details class="dshpw-local-legacy">/);
  assert.doesNotMatch(markup, /--pair/);
  assert.match(markup, /\/api\/dsh-passwords\/local-workspace\/windows/);

  const source = readFileSync(path.join(root, 'src/client/local-workspace.tsx'), 'utf8');
  assert.match(source, /\/api\/dsh-passwords\/local-workspace\/info/);
  assert.match(source, /setConnection\(result\)/);
  assert.doesNotMatch(source, /setConnection\(result\.connection\)/);
  assert.match(source, /api\('\/api\/dsh-passwords\/local-workspace\/approve', \{ code \}\)/);
  assert.match(source, /\/api\/dsh-passwords\/local-workspace\/pair/);
  assert.match(source, /onClick: createLegacyPairing/);
});

test('六位确认流程具备完整中英文文案', () => {
  for (const key of [
    'localServerTitle',
    'localServerHint',
    'localServerCopy',
    'localApproveTitle',
    'localApproveHint',
    'localCodePlaceholder',
    'localCodeInvalid',
    'localApprove',
    'localApproved',
    'localLegacyTitle',
    'localLegacyHint',
  ] as const) {
    assert.equal(typeof zh[key], 'string');
    assert.ok(zh[key].length > 0);
    assert.equal(typeof en[key], 'string');
    assert.ok(en[key].length > 0);
  }
});
