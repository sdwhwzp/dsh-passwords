import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { LocalWorkspaceHub } from '../src/local-workspace-hub.js';

/** A stand-in for the read/bash tools an Agent preset mounts into the same scope. */
function presetTool(name: string) {
  return {
    name,
    description: `preset ${name}`,
    parameters: { type: 'object' as const, additionalProperties: false, required: [], properties: {} },
    output: {
      schema: { type: 'object' as const, additionalProperties: false, required: [], properties: {} },
      render: () => [{ type: 'text' as const, text: 'preset' }],
    },
    execute: () => Promise.resolve({}),
  };
}

// An Agent preset mounts its own file and shell tools into the Agent scope
// before `agent/created` runs, and the 0.1.6 registry rejects a repeated name in
// that scope instead of shadowing it. Every rejected name leaves a Host-side
// tool aimed at the empty placeholder directory, which succeeds against the
// wrong machine, so the refusal must reach both the operator and the model.
test('tools an Agent preset already owns are reported instead of silently lost', { timeout: 15_000 }, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-tool-conflict-'));
  const ctx = new Context();
  const db = new Database(path.join(temp, 'db'), createFieldCrypto('test-key', 'test-setup'));
  db.init();
  const owner = db.createUser('owner', 'hash', 'user');
  const workspace = db.createLocalWorkspace({
    id: 'conflict-workspace', userId: owner.id, token: 't'.repeat(43), deviceName: 'test-mac',
    workspaceName: 'project', remoteRoot: '/Users/test/project',
    placeholderPath: path.join(temp, 'workspaces', 'project'), platform: 'darwin',
    shellEnabled: true, desktopControl: false,
  });
  const config = {
    gateway: { tls: null },
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: path.join(temp, 'workspaces') },
  } as PlatformConfig;
  const hub = new LocalWorkspaceHub(ctx, db, config);
  t.after(async () => {
    await hub.dispose();
    await ctx.fiber.dispose();
    db.close();
    await rm(temp, { recursive: true, force: true });
  });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await hub.start();

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  t.after(() => { console.error = originalError; });

  // The preset takes read and bash first, exactly as `presets.mount` does.
  ctx.tools.register(presetTool('read'));
  ctx.tools.register(presetTool('bash'));

  const agent = { ctx, session: { header: { cwd: workspace.placeholder_path } } } as unknown as Agent;
  ctx.emit('agent/created', { agent });

  // The taken names keep the preset's implementation; the free ones attach.
  assert.equal(ctx.tools.get('read')!.description, 'preset read');
  assert.equal(ctx.tools.get('bash')!.description, 'preset bash');
  assert.match(ctx.tools.get('write')!.description, /paired local workspace/);
  assert.match(ctx.tools.get('glob')!.description, /paired local workspace/);

  // The operator sees which names were lost and that they now hit the server.
  assert.equal(errors.filter(line => line.includes('read')).length >= 1, true);
  assert.equal(errors.filter(line => line.includes('bash')).length >= 1, true);
  assert.equal(errors.some(line => line.includes('2 个工具被预设覆盖')), true);
  assert.equal(errors.some(line => line.includes('会作用于服务器而不是用户电脑')), true);

  // The model is told not to trust them, by name.
  const assembly = await ctx.systemPrompt.assemble();
  const capabilities = assembly.contexts.find(item => item.name === 'local-workspace-capabilities')!.text;
  assert.match(capabilities, /WARNING: read, bash could not be attached to the paired computer/);
  assert.match(capabilities, /run on the DSH server, whose directory for this folder is empty by construction/);
  assert.match(capabilities, /Do not use read, bash to inspect or change the user’s files|Do not use read, bash to inspect or change the user's files/);
});

test('a preset that leaves the names free attaches every paired tool', { timeout: 15_000 }, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-tool-conflict-clear-'));
  const ctx = new Context();
  const db = new Database(path.join(temp, 'db'), createFieldCrypto('test-key', 'test-setup'));
  db.init();
  const owner = db.createUser('owner', 'hash', 'user');
  const workspace = db.createLocalWorkspace({
    id: 'clear-workspace', userId: owner.id, token: 't'.repeat(43), deviceName: 'test-mac',
    workspaceName: 'project', remoteRoot: '/Users/test/project',
    placeholderPath: path.join(temp, 'workspaces', 'project'), platform: 'darwin',
    shellEnabled: true, desktopControl: false,
  });
  const config = {
    gateway: { tls: null },
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: path.join(temp, 'workspaces') },
  } as PlatformConfig;
  const hub = new LocalWorkspaceHub(ctx, db, config);
  t.after(async () => {
    await hub.dispose();
    await ctx.fiber.dispose();
    db.close();
    await rm(temp, { recursive: true, force: true });
  });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await hub.start();

  const agent = { ctx, session: { header: { cwd: workspace.placeholder_path } } } as unknown as Agent;
  ctx.emit('agent/created', { agent });

  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'bash']) {
    assert.match(ctx.tools.get(name)!.description, /paired (local workspace|computer)/, name);
  }
  const assembly = await ctx.systemPrompt.assemble();
  const capabilities = assembly.contexts.find(item => item.name === 'local-workspace-capabilities')!.text;
  assert.doesNotMatch(capabilities, /WARNING/);
});
