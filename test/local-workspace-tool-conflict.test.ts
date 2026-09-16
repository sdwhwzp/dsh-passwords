import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createScope, type Scope } from '@deepseek-ai/dsh-scope';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { LocalWorkspaceHub } from '../src/local-workspace-hub.js';

/** A stand-in for the read/bash tools an Agent preset mounts into the Agent scope. */
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

interface Harness {
  ctx: Context;
  scope: Scope;
  /** The scope key registry lookups are resolved against. */
  key: Agent;
  agent: Agent;
  workspaceId: string;
}

/**
 * Stand up the hub with one paired folder and an Agent scope, the shape
 * `presets.mount(agentCtx, …)` produces before `agent/created` runs.
 */
async function startHarness(t: { after(fn: () => void | Promise<void>): void }): Promise<Harness> {
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

  // The Agent is its own scope key in production, and `agent/created` is
  // dispatched against that same object, so the harness must not split them.
  const agent = {
    id: 'conflict-session',
    session: { header: { cwd: workspace.placeholder_path } },
  } as unknown as Agent;
  let scope!: Scope;
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent); },
    { inject: ['tools', 'systemPrompt'] }));
  Object.assign(agent, { ctx: scope.ctx });
  return { ctx, scope, key: agent, agent, workspaceId: workspace.id };
}

/** Read the capability context this Agent's assembled prompt carries. */
async function capabilities(ctx: Context, agent: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent });
  return assembly.contexts.find(item => item.name === 'local-workspace-capabilities')!.text;
}

// The regression this guards: an Agent preset mounts read/write/edit/glob/grep/
// bash into the Agent scope, and a plain registration cannot take a name that
// scope already holds. The Host-side tool would stay, aimed at the empty
// placeholder directory, and succeed against the wrong machine.
test('a paired folder takes the tool names its Agent preset already mounted', { timeout: 15_000 }, async (t) => {
  const { ctx, scope, key, agent } = await startHarness(t);
  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'bash']) {
    agent.ctx.tools.register(presetTool(name));
  }
  ctx.emit('agent/created', { agent });

  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'bash']) {
    assert.match(ctx.tools.get(name, key)!.description, /paired (local workspace|computer)/, name);
  }
  assert.doesNotMatch(await capabilities(ctx, agent), /WARNING/);
});

test('an unclaimed preset leaves every paired tool attached just the same', { timeout: 15_000 }, async (t) => {
  const { ctx, scope, key, agent } = await startHarness(t);
  ctx.emit('agent/created', { agent });
  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'bash']) {
    assert.match(ctx.tools.get(name, key)!.description, /paired (local workspace|computer)/, name);
  }
  assert.doesNotMatch(await capabilities(ctx, agent), /WARNING/);
});

test('the replacement is lifted with the Agent scope, restoring the preset tools', { timeout: 15_000 }, async (t) => {
  const { ctx, scope, key, agent } = await startHarness(t);
  agent.ctx.tools.register(presetTool('bash'));
  ctx.emit('agent/created', { agent });
  assert.match(ctx.tools.get('bash', key)!.description, /paired computer/);
  await scope.dispose();
  assert.equal(ctx.tools.get('bash', key), undefined);
});

// A profile whose harness predates tools.override() must not fail closed into
// silently operating this Host while the model believes it operates the user's
// computer, so the lost names are named to the operator and to the model.
test('a harness without override reports the names it could not attach', { timeout: 15_000 }, async (t) => {
  const { ctx, scope, key, agent } = await startHarness(t);
  // `override` lives on the prototype, so an older profile is simulated by
  // masking it on this instance rather than deleting an own property.
  const registry = agent.ctx.tools as unknown as Record<string, unknown>;
  Object.defineProperty(registry, 'override', { value: undefined, configurable: true });
  t.after(() => { delete registry.override; });

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  t.after(() => { console.error = originalError; });

  agent.ctx.tools.register(presetTool('read'));
  agent.ctx.tools.register(presetTool('bash'));
  ctx.emit('agent/created', { agent });

  assert.equal(ctx.tools.get('read', key)!.description, 'preset read');
  assert.equal(ctx.tools.get('bash', key)!.description, 'preset bash');
  assert.match(ctx.tools.get('write', key)!.description, /paired local workspace/);

  assert.equal(errors.some(line => line.includes('2 个工具被预设覆盖')), true);
  assert.equal(errors.some(line => line.includes('会作用于服务器而不是用户电脑')), true);

  const context = await capabilities(ctx, agent);
  assert.match(context, /WARNING: read, bash could not be attached to the paired computer/);
  assert.match(context, /run on the DSH server, whose directory for this folder is empty by construction/);
});
