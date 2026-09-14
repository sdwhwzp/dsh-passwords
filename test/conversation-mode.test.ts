import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createConversation, isConversationSession, registerConversationMode } from '../src/conversation-mode.js';
import { ManagedUserWorkspaceProvider } from '../src/managed-workspace.js';
import type { PlatformConfig } from '../src/config.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-conversation-')));
  const db = new Database(path.join(root, 'db'), createFieldCrypto('test', 'test')); db.init();
  const user = db.createUser('chat-user', 'hash', 'user');
  const other = db.createUser('other-user', 'hash', 'user');
  const directory = path.join(root, `u${user.id}`); await mkdir(directory);
  db.setManagedWorkspace(user.id, directory);
  const principal = { source: 'dsh-passwords', id: String(user.id), username: user.username, role: 'user' } as const;
  const provider = new ManagedUserWorkspaceProvider(db, { managedWorkspaceRoot: root } as PlatformConfig);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { db, root, directory, user, other, principal, provider };
}

test('chat creation claims the authenticated owner and durable mode before Host publication', async t => {
  const f = await fixture(t);
  const created: string[] = [];
  const ctx = { managedUserWorkspace: f.provider, workspaceRegistry: { resolveByPath: async (root: string) => { assert.equal(root, f.directory); return { id: 'owned-workspace' }; } }, sessionController: {
    async create(request: { sessionId: string; workspaceId: string }) {
      assert.equal(f.db.getSessionOwner(request.sessionId), f.user.id);
      assert.equal(isConversationSession(f.db, request.sessionId), true);
      assert.equal(request.workspaceId, 'owned-workspace');
      created.push(request.sessionId);
    },
  } } as unknown as Context;
  const first = await createConversation(ctx, f.db, f.principal);
  const second = await createConversation(ctx, f.db, f.principal);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.deepEqual(created, [first.sessionId, second.sessionId]);
  await assert.rejects(createConversation(ctx, f.db, { ...f.principal, id: String(f.other.id) }), /active account/);
  assert.equal(created.length, 2);
});

test('failed Host creation retains its restriction', async t => {
  const f = await fixture(t);
  let failedId = '';
  const ctx = { managedUserWorkspace: f.provider, workspaceRegistry: { resolveByPath: async (root: string) => { assert.equal(root, f.directory); return { id: 'owned-workspace' }; } }, sessionController: {
    async create(request: { sessionId: string }) { failedId = request.sessionId; throw new Error('Host failed'); },
  } } as unknown as Context;
  await assert.rejects(createConversation(ctx, f.db, f.principal), /Host failed/);
  assert.equal(isConversationSession(f.db, failedId), true);

});

test('chat restoration and forks receive native allowlisting and an execution guard; development is untouched', async t => {
  const f = await fixture(t);
  let listener!: (payload: { agent: Agent }) => void;
  registerConversationMode({ on: (event: string, callback: typeof listener) => { if (event === 'agent/created') listener = callback; } } as unknown as Context, f.db);
  const modes: string[] = [], restrictions: unknown[] = [];
  let guard!: (exec: { name: string }) => string | undefined;
  const agent = (id: string, cwd: string) => ({ session: { id, header: { cwd, ...(id === 'forked-chat' ? { parentSession: 'parent-chat' } : {}) } }, ctx: {
    tools: { presentAs: (mode: string) => modes.push(mode), get: (name: string) => name === 'weknora_search' ? {} : undefined,
      restrict: (value: unknown) => restrictions.push(value), guard: (value: typeof guard) => { guard = value; } },
    systemPrompt: { section: () => {} },
  } } as unknown as Agent);
  listener({ agent: agent('development', f.directory) });
  assert.equal(modes.length, 0);
  f.db.setSetting('conversation_mode:parent-chat', 'chat');
  listener({ agent: agent('forked-chat', path.join(f.directory, '.dsh-conversations')) });
  assert.deepEqual(restrictions, [{ allow: ['weknora_search'] }]);
  assert.deepEqual(modes, ['native']);
  assert.equal(guard({ name: 'weknora_search' }), undefined);
  for (const name of ['bash', 'read_file', 'write_file', 'run_code', 'subagent', 'new_future_tool']) {
    assert.match(guard({ name })!, /CONVERSATION_MODE_TOOL_DENIED/);
  }
  assert.equal(isConversationSession(f.db, 'forked-chat'), true);
  listener({ agent: agent('forked-chat', '/different-directory') });
  assert.equal(modes.length, 2);
});

test('real registry blocks a late scoped shell even after permissive pre-execute policy', async t => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { createScope } = await import('@deepseek-ai/dsh-scope');
  const { default: Tools } = await import('@deepseek-ai/dsh-tools');
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
  const { ToolCallId } = await import('@deepseek-ai/dsh-llm');
  const f = await fixture(t);
  const ctx = new Context();
  t.after(async () => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  let executions = 0;
  const tool = (name: string) => ({ name, description: name, parameters: { type: 'object' as const, properties: {} },
    output: { schema: { type: 'string' as const }, render: (_args: unknown, result: unknown) => [{ type: 'text' as const, text: String(result) }] },
    execute: async () => { executions++; return 'ran'; } });
  ctx.tools.register(tool('bash'));
  ctx.tools.register(tool('weknora_search'));
  const agent = { id: 'chat-registry', session: { id: 'chat-registry', header: { cwd: path.join(f.directory, '.dsh-conversations') } } } as unknown as Agent;
  await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { Object.assign(agent, { ctx: createScope(inner, agent).ctx }); } });
  f.db.setSetting('conversation_mode:chat-registry', 'chat');
  registerConversationMode(ctx, f.db);
  ctx.emit('agent/created', { agent });
  assert.deepEqual(ctx.tools.schemas(agent).map(x => x.name), ['weknora_search']);
  agent.ctx.tools.register(tool('bash'));
  agent.ctx.tools.register(tool('subagent'));
  assert.deepEqual((await ctx.systemPrompt.assemble({ scope: agent })).tools.map(tool => tool.name), ['weknora_search']);
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));
  const run = (name: string) => ctx.tools.execute({ name, agent, callId: ToolCallId('chat-test'), arguments: {}, signal: new AbortController().signal });
  const denied = await run('bash');
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /CONVERSATION_MODE_TOOL_DENIED/);
  assert.equal((await run('run_code')).isError, true);
  assert.equal(executions, 0);
  assert.equal((await run('weknora_search')).isError, false);
  assert.equal(executions, 1);
  assert.equal((await ctx.tools.execute({ name: 'bash', callId: ToolCallId('dev-test'), arguments: {}, signal: new AbortController().signal })).isError, false);
  assert.equal(executions, 2);
});
