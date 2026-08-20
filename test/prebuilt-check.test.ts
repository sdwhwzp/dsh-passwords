import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasPrebuiltRuntime } from '../scripts/prebuilt-check.mjs';

const RUNTIME_DEPS = ['bcryptjs', 'dotenv', 'express', 'jsonwebtoken'];

function hoistedFixture(): { root: string; prefix: string } {
  const prefix = mkdtempSync(path.join(os.tmpdir(), 'dshpw-prebuilt-'));
  const pkg = path.join(prefix, 'node_modules', 'dsh-passwords');
  mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), '{"name":"dsh-passwords","version":"2.5.3"}');
  writeFileSync(path.join(pkg, 'dist', 'cli.js'), '');
  writeFileSync(path.join(pkg, 'dist', 'client.js'), '');
  // 依赖提升到 prefix/node_modules（与 npm install --prefix 行为一致）
  for (const dep of RUNTIME_DEPS) {
    mkdirSync(path.join(prefix, 'node_modules', dep), { recursive: true });
    writeFileSync(path.join(prefix, 'node_modules', dep, 'index.js'), '');
  }
  return { root: pkg, prefix };
}

test('npm --prefix 安装（依赖被提升）能被识别为已构建', () => {
  const { root, prefix } = hoistedFixture();
  try {
    assert.equal(hasPrebuiltRuntime(root, RUNTIME_DEPS), true);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test('缺任一运行时依赖时不能识别为已构建', () => {
  const { root, prefix } = hoistedFixture();
  try {
    rmSync(path.join(prefix, 'node_modules', 'jsonwebtoken'), { recursive: true, force: true });
    assert.equal(hasPrebuiltRuntime(root, RUNTIME_DEPS), false);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test('缺 dist/client.js 时不能识别为已构建', () => {
  const { root, prefix } = hoistedFixture();
  try {
    rmSync(path.join(root, 'dist', 'client.js'));
    assert.equal(hasPrebuiltRuntime(root, RUNTIME_DEPS), false);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
