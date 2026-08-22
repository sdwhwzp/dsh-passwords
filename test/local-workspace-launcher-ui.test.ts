import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildLocalWorkspaceLaunchUri,
  LocalWorkspaceLauncher,
  validatedLocalWorkspaceLaunchUri,
} from '../src/client/local-workspace-launcher.tsx';
import { en, zh } from '../src/client/locales.ts';

const root = path.resolve(import.meta.dirname, '..');
const ticket = 'A'.repeat(43);

test('只接受 dsh-local-workspace://connect 自定义协议入口并兼容规范化尾斜杠', () => {
  assert.equal(
    validatedLocalWorkspaceLaunchUri(`dsh-local-workspace://connect?ticket=${ticket}&server=wss%3A%2F%2Fdsh.example`),
    `dsh-local-workspace://connect?ticket=${ticket}&server=wss%3A%2F%2Fdsh.example`,
  );
  assert.equal(
    validatedLocalWorkspaceLaunchUri(`DSH-LOCAL-WORKSPACE://connect?ticket=${ticket}`),
    `dsh-local-workspace://connect?ticket=${ticket}`,
  );
  assert.equal(
    validatedLocalWorkspaceLaunchUri(`dsh-local-workspace://connect/?ticket=${ticket}`),
    `dsh-local-workspace://connect/?ticket=${ticket}`,
  );
  for (const value of [
    undefined,
    '',
    `https://connect/?ticket=${ticket}`,
    'javascript:alert(1)',
    `DSH-LOCAL-WORKSPACE://CONNECT?ticket=${ticket}`,
    `dsh-local-workspace://connect.example/?ticket=${ticket}`,
    `dsh-local-workspace://user@connect?ticket=${ticket}`,
    `dsh-local-workspace://connect:444?ticket=${ticket}`,
    `dsh-local-workspace://connect/path?ticket=${ticket}`,
    `dsh-local-workspace://connect//?ticket=${ticket}`,
    `dsh-local-workspace://connect?ticket=${ticket}#fragment`,
    'dsh-local-workspace://connect?ticket=too-short',
    `dsh-local-workspace://connect?ticket=${ticket}&ticket=${ticket}`,
    `dsh-local-workspace://connect?ticket=${ticket}&server=one&server=two`,
    `dsh-local-workspace://connect?ticket=${ticket}&unknown=value`,
    `dsh-local-workspace://connect?value=${'x'.repeat(4096)}`,
  ]) {
    assert.equal(validatedLocalWorkspaceLaunchUri(value), null, `${String(value).slice(0, 80)} 应被拒绝`);
  }
});

test('用受信 connection 推导服务器地址并覆盖 URI 内既有 server 参数', () => {
  const fallback = buildLocalWorkspaceLaunchUri(
    `dsh-local-workspace://connect?ticket=${ticket}&server=wss%3A%2F%2Fevil.example`,
    { port: 3082, secure: false, publicUrl: '' },
    'dsh.example.test',
  );
  assert.notEqual(fallback, null);
  const fallbackUrl = new URL(fallback!);
  assert.deepEqual(fallbackUrl.searchParams.getAll('server'), ['ws://dsh.example.test:3082']);
  assert.equal(fallbackUrl.searchParams.get('ticket'), ticket);

  const configured = buildLocalWorkspaceLaunchUri(
    `dsh-local-workspace://connect?ticket=${ticket}`,
    { port: 3082, secure: true, publicUrl: 'wss://assistant.example.test/socket' },
    'ignored.example.test',
  );
  assert.notEqual(configured, null);
  assert.equal(new URL(configured!).searchParams.get('server'), 'wss://assistant.example.test/socket');

  for (const connection of [
    undefined,
    { port: 0, secure: false, publicUrl: '' },
    { port: 3082, secure: false, publicUrl: 'https://assistant.example.test' },
    { port: 3082, secure: false, publicUrl: 'ws://user@assistant.example.test' },
    { port: 3082, secure: false, publicUrl: 'ws://assistant.example.test#fragment' },
  ]) {
    assert.equal(
      buildLocalWorkspaceLaunchUri(`dsh-local-workspace://connect?ticket=${ticket}`, connection, 'dsh.example.test'),
      null,
    );
  }
});

test('全局入口包含一键按钮、下载与六位码备用说明', () => {
  const markup = renderToStaticMarkup(createElement(LocalWorkspaceLauncher, {
    t: (key: string) => key,
    openWorkspacePath: async () => undefined,
  }));
  assert.match(markup, /<details class="dshpw-local-launcher-popover">/);
  assert.match(markup, />localLaunchButton</);
  assert.match(markup, /<details class="dshpw-local-launcher-fallback">/);
  assert.match(markup, /localLaunchFallbackHint/);
  assert.match(markup, /\/api\/dsh-passwords\/local-workspace\/windows/);
  assert.match(markup, /山东梯智物联AI本机助手\.exe/);
  assert.match(markup, /localConnectedHint/);
});

test('通过无会话也可见的 shell.overlay 槽注册且 launch 响应经过校验后才导航', () => {
  const indexSource = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8');
  const launcherSource = readFileSync(path.join(root, 'src/client/local-workspace-launcher.tsx'), 'utf8');

  assert.match(indexSource, /ctx\.slots\.inject\('shell\.overlay'/);
  assert.match(indexSource, /name: 'shell\.overlay'/);
  assert.match(indexSource, /id: 'dsh-passwords-local-workspace-launcher'/);
  assert.match(indexSource, /ctx\.workspaces\.connectWorkspace\(workspace\.workspaceId\)/);
  assert.match(indexSource, /ctx\.sessions\.open\(sessionId\)/);
  assert.doesNotMatch(indexSource, /conversation\.input\.bootstrap/);
  assert.match(indexSource, /order: 30/);
  assert.doesNotMatch(launcherSource, /querySelector|MutationObserver/);
  assert.match(launcherSource, /fetch\(LAUNCH_ENDPOINT/);
  assert.match(launcherSource, /result\.launch\?\.uri/);
  assert.match(launcherSource, /result\.launch\?\.connection/);
  assert.match(launcherSource, /buildLocalWorkspaceLaunchUri/);
  assert.match(launcherSource, /localWorkspaceServerAddress/);
  assert.match(launcherSource, /document\.createElement\('a'\)/);
  assert.match(launcherSource, /anchor\.click\(\)/);
  assert.match(launcherSource, /never creates an about:blank tab/);
  assert.doesNotMatch(launcherSource, /window\.open|target\s*=\s*['"]_blank/);
  assert.match(launcherSource, /open: attempted/);
});

test('一键入口具备完整中英文文案', () => {
  for (const key of [
    'localLaunchTitle',
    'localLaunchHint',
    'localLaunchButton',
    'localLaunching',
    'localLaunchRequested',
    'localLaunchInvalid',
    'localLaunchFallbackTitle',
    'localLaunchDownload',
    'localLaunchFallbackHint',
    'localConnectedHint',
    'localOpenConversation',
    'localOpeningConversation',
    'localOpenConversationFailed',
  ] as const) {
    assert.equal(typeof zh[key], 'string');
    assert.ok(zh[key].length > 0);
    assert.equal(typeof en[key], 'string');
    assert.ok(en[key].length > 0);
  }
});
