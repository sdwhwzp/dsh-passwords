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
    async list() { return { items: [] }; },
    async create(request: { sessionId: string; workspaceId: string }) {
      assert.equal(f.db.getSessionOwner(request.sessionId), f.user.id);
      assert.equal(isConversationSession(f.db, request.sessionId), true);
      assert.equal(request.workspaceId, 'owned-workspace');
      created.push(request.sessionId);
    },
  } } as unknown as Context;
  const first = await createConversation(ctx, f.db, f.principal);
  const second = await createConversation(ctx, f.db, f.principal);
  assert.equal(first.cwd, f.directory);
  assert.equal(second.cwd, f.directory);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.deepEqual(created, [first.sessionId, second.sessionId]);
  await assert.rejects(createConversation(ctx, f.db, { ...f.principal, id: String(f.other.id) }), /active account/);
  assert.equal(created.length, 2);
});

test('failed Host creation retains ownership and display mode', async t => {
  const f = await fixture(t);
  let failedId = '';
  const ctx = { managedUserWorkspace: f.provider, workspaceRegistry: { resolveByPath: async (root: string) => { assert.equal(root, f.directory); return { id: 'owned-workspace' }; } }, sessionController: {
    async list() { return { items: [] }; },
    async create(request: { sessionId: string }) { failedId = request.sessionId; throw new Error('Host failed'); },
  } } as unknown as Context;
  await assert.rejects(createConversation(ctx, f.db, f.principal), /Host failed/);
  assert.equal(isConversationSession(f.db, failedId), true);

});

test('chat restoration and forks preserve display mode without restricting tools', async t => {
  const f = await fixture(t);
  let listener!: (payload: { agent: Agent }) => void;
  registerConversationMode({ on: (event: string, callback: typeof listener) => { assert.equal(event, 'agent/created'); listener = callback; } } as unknown as Context, f.db);
  const sections: { text: string }[] = [];
  const agent = (id: string) => ({ session: { id, header: { cwd: f.directory, ...(id === 'forked-chat' ? { parentSession: 'parent-chat' } : {}) } }, ctx: {
    tools: { restrict: () => assert.fail('chat must not restrict tools'), guard: () => assert.fail('chat must not install a tool guard') },
    systemPrompt: { section: (section: { text: string }) => sections.push(section) },
  } } as unknown as Agent);
  listener({ agent: agent('development') });
  assert.equal(sections.length, 0);
  f.db.setSetting('conversation_mode:parent-chat', 'chat');
  listener({ agent: agent('forked-chat') });
  assert.equal(isConversationSession(f.db, 'forked-chat'), true);
  listener({ agent: agent('forked-chat') });
  assert.equal(sections.length, 2);
  assert.match(sections[0]!.text, /validate_dsh_ui/);
  assert.match(sections[0]!.text, /account permissions and workspace sandbox/);
});

test('chat exposes inherited and late scoped tools while preserving an existing account guard', async t => {
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
  for (const name of ['validate_dsh_ui', 'render_ui', 'subagent', 'new_future_tool']) agent.ctx.tools.register(tool(name));
  const names = (await ctx.systemPrompt.assemble({ scope: agent })).tools.map(tool => tool.name);
  for (const name of ['bash', 'weknora_search', 'validate_dsh_ui', 'render_ui', 'subagent', 'new_future_tool']) assert.ok(names.includes(name), name);
  const run = (name: string) => ctx.tools.execute({ name, agent, callId: ToolCallId('chat-test'), arguments: {}, signal: new AbortController().signal });
  for (const name of ['bash', 'weknora_search', 'validate_dsh_ui', 'render_ui', 'subagent', 'new_future_tool']) assert.equal((await run(name)).isError, false, name);
  assert.equal(executions, 6);
  agent.ctx.tools.guard(exec => exec.name === 'bash' ? 'account policy denies shell' : undefined);
  const denied = await run('bash');
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /account policy denies shell/);
  assert.equal(executions, 6);
});


test('concurrent chat creation and later requests reuse the same account blank, but preserve occupied and archived chats', async t => {
  const f = await fixture(t);
  const rows: { sessionId: string; cwd: string; blank: boolean; running: boolean; projections: { values: { inbox: { 'next-turn': unknown[] }; title?: string } } }[] = [];
  const archived: string[] = [];
  let created = 0;
  const ctx = { managedUserWorkspace: f.provider,
    workspaceRegistry: { archivedSessionIds: archived, resolveByPath: async () => ({ id: 'workspace' }) },
    sessionController: {
      list: async () => ({ items: rows }),
      create: async (request: { sessionId: string }) => {
        created++;
        rows.push({ sessionId: request.sessionId, cwd: f.directory, blank: true, running: false, projections: { values: { inbox: { 'next-turn': [] } } } });
      },
    },
  } as unknown as Context;
  const results = await Promise.all(Array.from({ length: 8 }, () => createConversation(ctx, f.db, f.principal)));
  assert.equal(created, 1);
  assert.ok(results.every(result => result.sessionId === results[0]!.sessionId));
  assert.equal((await createConversation(ctx, f.db, f.principal)).sessionId, results[0]!.sessionId);
  rows[0]!.projections.values.inbox['next-turn'].push({ message: 'pending' });
  const second = await createConversation(ctx, f.db, f.principal);
  assert.notEqual(second.sessionId, results[0]!.sessionId);
  rows[1]!.running = true;
  const third = await createConversation(ctx, f.db, f.principal);
  archived.push(third.sessionId);
  const fourth = await createConversation(ctx, f.db, f.principal);
  rows[3]!.blank = false;
  const fifth = await createConversation(ctx, f.db, f.principal);
  rows[4]!.projections.values.title = 'saved draft';
  const sixth = await createConversation(ctx, f.db, f.principal);
  rows[5]!.blank = false;
  f.db.claimSessionOwner('foreign-chat', f.other.id);
  f.db.setSetting('conversation_mode:foreign-chat', 'chat');
  rows.unshift({ sessionId: 'foreign-chat', cwd: f.directory, blank: true, running: false, projections: { values: { inbox: { 'next-turn': [] } } } });
  const seventh = await createConversation(ctx, f.db, f.principal);
  assert.notEqual(seventh.sessionId, sixth.sessionId);
  assert.notEqual(seventh.sessionId, 'foreign-chat');
  assert.equal(created, 7);
});
