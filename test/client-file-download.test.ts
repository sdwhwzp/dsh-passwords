// 右侧栏文件下载按钮：纯函数与词典一致性测试（无 DOM 依赖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadUrlFor, downloadText } from '../src/client/file-download';
import { zh, en } from '../src/client/locales';

test('downloadUrlFor：query 参数整体编码（防 %/#/& 与路径注入）', () => {
  assert.equal(downloadUrlFor('/root/file.md'), '/gateway/api/download?path=%2Froot%2Ffile.md');
  // Windows 混合分隔符路径（官方 data-files-path 的真实形态）
  assert.equal(
    downloadUrlFor('D:\\ws/src/report#1.md'),
    '/gateway/api/download?path=D%3A%5Cws%2Fsrc%2Freport%231.md',
  );
  assert.equal(
    downloadUrlFor('/tmp/a b&c=d%.txt'),
    '/gateway/api/download?path=%2Ftmp%2Fa%20b%26c%3Dd%25.txt',
  );
});

test('downloadText/locales：zh 与 en 键完全一致且下载文案非空', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of ['dlFile', 'dlDenied', 'dlFailed', 'dlStarted'] as const) {
    assert.ok((zh[key] as string).length > 0, `zh.${key} 非空`);
    assert.ok((en[key] as string).length > 0, `en.${key} 非空`);
  }
  for (const value of Object.values(downloadText)) assert.ok(value.length > 0);
});
