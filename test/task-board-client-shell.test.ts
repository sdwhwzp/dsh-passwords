import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

/** The path-mounted browser registration must not activate another Host ledger. */
test('task-board client registration uses source Config and has no Host side effects', async () => {
  const wrapper = await import('../integrations/task-board/client-shell/index.js');
  const source = await import('@linxin666/dsh-client-ui-task-board');
  assert.equal(wrapper.Config, source.Config);
  assert.equal(wrapper.name, 'task-board');
  wrapper.apply(new Proxy({}, { get() { throw new Error('browser registration attempted Host access'); } }));
  const manifest = JSON.parse(await readFile(new URL('../integrations/task-board/client-shell/package.json', import.meta.url), 'utf8'));
  const pin = JSON.parse(await readFile(new URL('../integrations/task-board/source.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, '@linxin666/dsh-client-ui-task-board');
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'));
  const client = await readFile(new URL('../integrations/task-board/client-shell/client.js', import.meta.url));
  assert.equal(createHash('sha256').update(client).digest('hex'), pin.client.sha256);
});
