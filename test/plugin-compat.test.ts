// 第三方插件兼容层（plugin-compat）单元测试：
//   - 默认关闭时所有钩子返回“不接管 / 不匹配”（网关对第三方插件保持通用 fail-closed）；
//   - 打开时只接管已知插件的面板路径，并提供门控 / 字段提取 / 清洗 / 轮询钩子；
//   - 网关主体对钩子的调用与插件无关（本层是唯一含插件路径知识的模块）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPluginCompat } from '../src/plugin-compat.js';
import net from 'node:net';
import { once } from 'node:events';
import { isPermanentGatewayExitCode, waitForGatewayPortFree } from '../dist/plugin.js';

test('网关永久错误码不会进入自动重启循环', () => {
  for (const code of [1, 30, 31, 32, 33, 34, 35, 36, 37]) {
    assert.equal(isPermanentGatewayExitCode(code), true, `exit ${code}`);
  }
  for (const code of [0, 2, 143, 'unknown']) {
    assert.equal(isPermanentGatewayExitCode(code), false, `exit ${String(code)}`);
  }
});

test('兼容层默认关闭：全部钩子不接管任何路径（第三方一律走登记表 / fail-closed）', () => {
  const off = createPluginCompat(false);
  assert.equal(off.enabled, false);
  assert.equal(off.claimsRootPath('/aionui-panel/raw'), false);
  assert.equal(off.isPanelPath('/aionui-panel/read'), false);
  assert.equal(off.isFileRead('POST', '/aionui-panel/read'), false);
  assert.equal(off.isFileRead('GET', '/aionui-panel/raw'), false);
  assert.equal(off.isFileWrite('POST', '/aionui-panel/write'), false);
  assert.equal(off.isExfilEndpoint('GET', '/aionui-panel/git-status'), false);
  assert.equal(off.folderRootFrom('GET', '/aionui-panel/raw', new URLSearchParams('root=/w'), null), null);
  assert.equal(off.isPollingEndpoint('/aionui-panel/events'), false);
  assert.equal(off.isDangerousUploadRequest('POST', '/api/plugin-uploads'), false);
  assert.equal(off.responseSanitizeKind('POST', '/aionui-panel/read'), null);
  assert.equal(off.responseSanitizeKind('GET', '/aionui-panel/raw'), null);
});

test('兼容层打开：面板路径接管与三类门控（读 / 写 / 外带）', () => {
  const on = createPluginCompat(true);
  assert.equal(on.enabled, true);

  assert.equal(on.claimsRootPath('/aionui-panel/read'), true);
  assert.equal(on.claimsRootPath('/aionui-panel/'), true);
  assert.equal(on.claimsRootPath('/other-panel/read'), false);
  assert.equal(on.claimsRootPath('/api/aionui-panel/read'), false, '只接管根级面板路径');

  // 读取端点（allow_git_download 门控）
  assert.equal(on.isFileRead('GET', '/aionui-panel/raw'), true);
  assert.equal(on.isFileRead('HEAD', '/aionui-panel/raw'), true);
  assert.equal(on.isFileRead('POST', '/aionui-panel/raw'), false);
  assert.equal(on.isFileRead('POST', '/aionui-panel/read'), true);
  assert.equal(on.isFileRead('GET', '/aionui-panel/read'), false);

  // 写入端点（allow_upload 门控）
  for (const path of ['/aionui-panel/write', '/aionui-panel/delete', '/aionui-panel/git-stage', '/aionui-panel/git-unstage', '/aionui-panel/git-discard']) {
    assert.equal(on.isFileWrite('POST', path), true, `${path} 属写入`);
  }
  assert.equal(on.isFileWrite('GET', '/aionui-panel/write'), false);

  // 外带通道（allow_git_download 门控）
  assert.equal(on.isExfilEndpoint('GET', '/aionui-panel/git-status'), true);
  assert.equal(on.isExfilEndpoint('POST', '/aionui-panel/other'), false);

  assert.equal(on.isPollingEndpoint('/aionui-panel/events'), true);
  assert.equal(on.isPollingEndpoint('/aionui-panel/events/stream'), true);
  assert.equal(on.isPollingEndpoint('/aionui-panel/read'), false);
});

test('兼容层打开：root 字段提取与响应清洗钩子', () => {
  const on = createPluginCompat(true);
  const q = new URLSearchParams('root=/workspace/a&path=sub/file.txt');

  assert.equal(on.folderRootFrom('GET', '/aionui-panel/raw', q, null), '/workspace/a');
  assert.equal(on.folderRootFrom('POST', '/aionui-panel/write', new URLSearchParams(), { root: '/workspace/b' }), '/workspace/b');
  assert.equal(on.folderRootFrom('POST', '/aionui-panel/write', new URLSearchParams(), { path: 'x' }), null, '缺 root → null（调用方 fail-closed）');
  assert.equal(on.folderRootFrom('GET', '/aionui-panel/raw', new URLSearchParams('root='), null), null, '空 root → null');
  assert.equal(on.folderRootFrom('GET', '/non-panel', q, null), null, '非面板路径不提取');

  assert.equal(on.responseSanitizeKind('POST', '/aionui-panel/read'), 'json');
  assert.equal(on.responseSanitizeKind('GET', '/aionui-panel/raw'), 'stream');
  assert.equal(on.responseSanitizeKind('HEAD', '/aionui-panel/raw'), 'stream');
  assert.equal(on.responseSanitizeKind('GET', '/aionui-panel/list'), null);
});

test('兼容层打开：高危上传扩展名检查只覆盖已知上传插件的 POST', () => {
  const on = createPluginCompat(true);
  assert.equal(on.isDangerousUploadRequest('POST', '/api/dsh-uploads'), true);
  assert.equal(on.isDangerousUploadRequest('POST', '/api/dsh-uploads/nested'), true);
  assert.equal(on.isDangerousUploadRequest('GET', '/api/dsh-uploads'), false);
  assert.equal(on.isDangerousUploadRequest('POST', '/api/other'), false);
});

test('gateway port handoff preserves its listener and detects release', async () => {
  const server = net.createServer((socket) => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  try {
    assert.equal(await waitForGatewayPortFree(port, 0), false);
    assert.equal(server.listening, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.equal(await waitForGatewayPortFree(port, 0), true);
});
