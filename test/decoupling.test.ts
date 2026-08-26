import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('dsh-passwords contains no WebDAV credential, route or MySQL dependency', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.mysql2, undefined);
  for (const relative of ['src/auth.ts', 'src/config.ts', 'src/plugin.ts', 'src/client/card.tsx']) {
    const source = readFileSync(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, /webdav|WebDav|MCP_MYSQL/i, relative);
  }
});
