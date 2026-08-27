import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildLocalWorkspaceLaunchUri,
  isWindowsBrowser,
  validatedLocalWorkspaceLaunchUri,
} from '../src/client/local-workspace-launch-uri.ts';
import { en, zh } from '../src/client/locales.ts';

const root = path.resolve(import.meta.dirname, '..');
const ticket = 'A'.repeat(43);

test('Windows 首次引导只对桌面 Windows 浏览器启用', () => {
  assert.equal(isWindowsBrowser({ platform: 'Win32', userAgent: 'Mozilla/5.0' }), true);
  assert.equal(isWindowsBrowser({ userAgentData: { platform: 'Windows' } }), true);
  assert.equal(isWindowsBrowser({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), true);
  assert.equal(isWindowsBrowser({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' }), false);
  assert.equal(isWindowsBrowser({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), false);
});

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

test('全局入口包含一键按钮、下载与首次使用说明', () => {
  const source = readFileSync(path.join(root, 'src/client/local-workspace-launcher.tsx'), 'utf8');
  assert.match(source, /className: 'dshpw-local-launcher-seat'/);
  assert.match(source, /className: 'dshpw-local-launcher-trigger'/);
  assert.match(source, /t\('localLaunchButton'\)/);
  assert.match(source, /className: 'dshpw-local-launcher-fallback'/);
  assert.match(source, /t\('localLaunchFallbackHint'\)/);
  assert.match(source, /\/api\/dsh-passwords\/local-workspace\/windows/);
  assert.match(source, /山东梯智物联AI本机助手\.exe/);
  assert.match(source, /t\('localConnectedHint'\)/);
  assert.match(source, /dshpw\.windows-local-workspace-guide\.v2/);
  assert.match(source, /role: 'dialog'/);
  assert.match(source, /'aria-modal': true/);
  assert.match(source, /t\('localGuideContinue'\)/);
  assert.match(source, /t\('localGuideReopen'\)/);
});

test('通过选择模式旁的新会话控制行注册且 launch 响应经过校验后才导航', () => {
  const indexSource = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8');
  const launcherSource = readFileSync(path.join(root, 'src/client/local-workspace-launcher.tsx'), 'utf8');
  const launchUriSource = readFileSync(path.join(root, 'src/client/local-workspace-launch-uri.ts'), 'utf8');

  assert.match(indexSource, /ctx\.slots\.inject\('conversation\.input\.bootstrap'/);
  assert.match(indexSource, /name: 'conversation\.input\.bootstrap'/);
  assert.match(indexSource, /id: 'dsh-passwords-local-workspace-launcher'/);
  assert.match(indexSource, /dshpw-local-launcher-seat\{position:relative;display:inline-flex/);
  assert.doesNotMatch(indexSource, /id: 'dsh-passwords-local-workspace-sidebar'/);
  assert.match(indexSource, /ctx\.workspaces\.connectWorkspace\(workspace\.workspaceId\)/);
  assert.match(indexSource, /ctx\.sessions\.open\(sessionId\)/);
  assert.match(indexSource, /order: 30/);
  assert.doesNotMatch(launcherSource, /querySelector|MutationObserver/);
  assert.match(launcherSource, /IconProjectAddOutline16/);
  assert.match(launcherSource, /onClick: onSummaryClick/);
  assert.match(launcherSource, /details instanceof HTMLDetailsElement && !details\.open/);
  assert.match(launcherSource, /isWindowsClient && !guideSeen/);
  assert.match(launcherSource, /setGuideOpen\(true\)/);
  assert.match(launcherSource, /launch\(\);/);
  assert.match(launcherSource, /fetch\(LAUNCH_ENDPOINT/);
  assert.match(launcherSource, /result\.launch\?\.uri/);
  assert.match(launcherSource, /result\.launch\?\.connection/);
  assert.match(launcherSource, /buildLocalWorkspaceLaunchUri/);
  assert.match(launchUriSource, /localWorkspaceServerAddress/);
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
    'localGuideTitle',
    'localGuideIntro',
    'localGuideStep1',
    'localGuideStep2',
    'localGuideStep3',
    'localGuideStep4',
    'localGuideNote',
    'localGuideDownload',
    'localGuideContinue',
    'localGuideDismiss',
    'localGuideReopen',
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
