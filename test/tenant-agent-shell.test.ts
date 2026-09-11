import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { TenantAgentShell, registerTenantAgentShell } from '../src/tenant-agent-shell.js';
import type { TenantCommandRequest, TenantCommandResult } from '../src/tenant-command.js';
import { tenantServiceAdminTool } from '../src/tenant-service-admin.js';

const success: TenantCommandResult = { stdout: 'v22.21.1\n10.15.1\n', stderr: '', exitCode: 0, signal: null, truncated: false, timedOut: false, aborted: false };

async function harness(t: { after(fn: () => Promise<void>): void }, runner?: (request: TenantCommandRequest) => Promise<TenantCommandResult>) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tenant-shell-')));
  const db = new Database(path.join(temp, 'db'), createFieldCrypto('test-encryption', 'test-setup')); db.init();
  const owner = db.createUser('owner', 'hash', 'user');
  const other = db.createUser('other', 'hash', 'user');
  const root = path.join(temp, 'managed');
  const cwd = path.join(root, `u${owner.id}`, 'projects', "one's project");
  const otherCwd = path.join(root, `u${other.id}`);
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await mkdir(otherCwd, { recursive: true });
  await symlink(otherCwd, path.join(cwd, 'escape'));
  db.setManagedWorkspace(owner.id, path.join(root, `u${owner.id}`)); db.setManagedWorkspace(other.id, otherCwd);
  db.claimSessionOwner('owned-session', owner.id);
  const permissions = { allowedFolders: [root], hourlyTokenLimit: null, dailyMinutesLimit: null, allowUpload: true, allowGitDownload: false, banned: false, sandboxMode: 'workspace-write' };
  db.setPermissions(owner.id, permissions);
  let mode = 'workspace-write';
  let policyAvailable = true;
  const ctx = { root: { get: () => policyAvailable ? { resolve: () => ({ mode }) } : undefined } } as unknown as Context;
  const config = {
    managedWorkspaceRoot: root,
    tenantTerminal: { launcher: '/usr/local/libexec/dsh-tenant-terminal', maxPerUser: 1, reconnectGraceMs: 30000 },
    tenantAgentShell: { enabled: true, timeoutMs: 120000, maxTimeoutMs: 600000, maxOutputBytes: 262144 },
  } as PlatformConfig;
  const calls: TenantCommandRequest[] = [];
  const shell = new TenantAgentShell(ctx, db, config, async request => { calls.push(request); return runner === undefined ? success : runner(request); });
  t.after(async () => { await shell.dispose(); db.close(); await rm(temp, { recursive: true, force: true }); });
  const createAgent = (directory = cwd, id = 'owned-session') => {
    const tools: ToolDefinition[] = [];
    const sections: Array<{ name: string; text: string }> = [];
    const disposers: Array<() => Promise<void>> = [];
    const agent = { session: { id, header: { cwd: directory } }, ctx: {
      tools: { register: (tool: ToolDefinition) => { tools.push(tool); } },
      systemPrompt: { section: (section: { name: string; text: string }) => { sections.push(section); } },
      effect: (create: () => () => Promise<void>) => { disposers.push(create()); },
    } } as unknown as Agent;
    shell.install(agent);
    const principal = { source: 'dsh-passwords', id: String(owner.id), username: owner.username, role: 'user' } as const;
    const exec = { agent, principal, signal: new AbortController().signal } as ToolRunContext;
    const run = (args = { command: 'node --version && pnpm --version', description: 'Check installed development tools' }, execution = exec) => tools[0]!.execute(args, execution);
    return { agent, tools, sections, exec, run, dispose: async () => { for (const dispose of disposers) await dispose(); } };
  };
  return { shell, calls, db, config, cwd, otherCwd, owner, other, permissions, createAgent, setMode: (value: string) => { mode = value; }, noPolicy: () => { policyAvailable = false; } };
}

test('managed parent and child agents receive bash with logged terminal output and persistent-home guidance', async (t) => {
  const h = await harness(t);
  for (const id of ['owned-session', 'delegated-child']) {
    const a = h.createAgent(h.cwd, id);
    assert.equal(a.tools.length, 1);
    assert.equal(a.tools[0]!.name, 'bash');
    const value = await a.run();
    assert.deepEqual(value, success);
    assert.deepEqual(h.calls.at(-1)!.args, ['-n', '--', h.config.tenantTerminal!.launcher, String(h.owner.id), h.cwd, h.owner.username, '--command']);
    assert.ok(h.calls.at(-1)!.command.includes("one'\\''s project"));
    const rendered = a.tools[0]!.output.render({}, value);
    const presentation = a.tools[0]!.presentResult!({ command: 'node --version && pnpm --version', description: 'Check installed development tools' }, { content: rendered, isError: false });
    assert.deepEqual({ tool: a.tools[0]!.name, output: rendered, presentation }, JSON.parse(await readFile(new URL('./expected/tenant-agent-shell.json', import.meta.url), 'utf8')));
    assert.match(a.sections[0]!.text, /persistent personal HOME/);
  }
});

test('anonymous, other-account, revoked, read-only and foreign-directory calls never reach the launcher', async (t) => {
  const h = await harness(t); const a = h.createAgent();
  for (const principal of [undefined, { ...a.exec.principal!, id: String(h.other.id), username: h.other.username }, { ...a.exec.principal!, source: 'forged' }, { ...a.exec.principal!, username: 'forged' }]) {
    await assert.rejects(a.run(undefined, { ...a.exec, principal }), /access denied|active account/);
  }
  await assert.rejects(a.run(undefined, { ...a.exec, agent: h.createAgent().agent }), /unavailable/);
  for (const workdir of [h.otherCwd, 'escape', '../..', '/workspace/../outside', '/etc']) {
    await assert.rejects(a.tools[0]!.execute({ command: 'pwd', description: 'Inspect directory', workdir }, a.exec));
  }
  h.db.claimSessionOwner('foreign-session', h.other.id);
  await assert.rejects(h.createAgent(h.cwd, 'foreign-session').run(), /session access denied/);
  for (const timeoutMs of [0, -1, 1.5, 600001]) {
    await assert.rejects(a.tools[0]!.execute({ command: 'pwd', description: 'Inspect directory', timeoutMs }, a.exec), Number.isInteger(timeoutMs) ? /invalid command timeout/ : /must be an integer/);
  }
  for (const change of [{ banned: true }, { sandboxMode: 'read-only' }, { disabledSessions: ['owned-session'] }]) {
    h.db.setPermissions(h.owner.id, { ...h.permissions, ...change });
    await assert.rejects(a.run());
    h.db.setPermissions(h.owner.id, { ...h.permissions, disabledSessions: [] });
  }
  h.setMode('read-only'); await assert.rejects(a.run(), /write permission/);
  h.setMode('workspace-write'); h.noPolicy(); await assert.rejects(a.run(), /policy is unavailable/);
  assert.equal(h.calls.length, 0);
});

test('relative and sandbox workdirs resolve within the immutable session workspace', async (t) => {
  const h = await harness(t); const a = h.createAgent();
  for (const workdir of ['src', '/workspace/projects/one\'s project/src', path.join(h.cwd, 'src')]) {
    await a.tools[0]!.execute({ command: 'pwd', description: 'Inspect directory', workdir }, a.exec);
    assert.ok(h.calls.at(-1)!.command.startsWith("cd -- '/workspace/projects/one'\\''s project/src' || exit\n"));
    assert.equal(h.calls.at(-1)!.args[4], h.cwd);
  }
});

test('concurrency is per account, and disposal cancels and awaits running commands', async (t) => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  let released = false;
  const h = await harness(t, request => new Promise(resolve => {
    request.signal.addEventListener('abort', () => { released = true; resolve({ ...success, aborted: true }); }, { once: true });
    started();
  }));
  const a = h.createAgent(); const pending = a.run(); await ready;
  await assert.rejects(h.createAgent(h.cwd, 'child').run(), /command limit/);
  await a.dispose(); assert.equal(released, true); await pending;
  await assert.rejects(a.run(), /abort/i);
  await h.shell.dispose(); assert.equal(h.createAgent().tools.length, 0);
});

test('disabled deployments and non-managed workspaces do not receive a host shell', async (t) => {
  const h = await harness(t);
  registerTenantAgentShell({} as Context, h.db, { ...h.config, tenantAgentShell: undefined });
  assert.equal(h.createAgent(os.tmpdir()).tools.length, 0);
  const admin = h.db.createUser('admin', 'hash', 'admin');
  h.db.setManagedWorkspace(admin.id, '/unused-admin-root');
  assert.equal(h.createAgent('/unused-admin-root').tools.length, 0);
});

test('persistent service commands retain account authorization and do not stop services on disposal', async (t) => {
  const h = await harness(t);
  h.config.tenantAgentShell!.serviceLauncher = '/usr/local/libexec/dsh-tenant-service';
  const a = h.createAgent();
  const tool = a.tools.find(item => item.name === 'dev_server')!;
  assert.ok(tool);
  assert.match(a.sections.find(section => section.name === 'tenant-persistent-services')!.text, /stop it only when the user explicitly asks/);
  const start = { action: 'start', name: 'vite-front', command: 'exec pnpm exec vite --host 0.0.0.0 --port 7111', port: 7111, expose: true };
  await tool.execute(start, a.exec);
  assert.deepEqual(h.calls[0]!.args, ['-n', '--', h.config.tenantAgentShell!.serviceLauncher, String(h.owner.id), h.cwd, h.owner.username]);
  assert.deepEqual(JSON.parse(h.calls[0]!.command), start);
  for (const action of ['status', 'logs', 'stop', 'list']) {
    await assert.rejects(tool.execute({ action, name: 'vite-front' }, { ...a.exec, principal: { ...a.exec.principal!, id: String(h.other.id), username: h.other.username } }), /access denied/);
  }
  for (const bad of [{ ...start, name: '../other' }, { ...start, port: 22 }, { ...start, command: '' }, { ...start, port: 65536 }]) {
    await assert.rejects(tool.execute(bad, a.exec));
  }
  h.db.setPermissions(h.owner.id, { ...h.permissions, banned: true });
  await assert.rejects(tool.execute({ action: 'stop', name: 'vite-front' }, a.exec), /active account/);
  h.db.setPermissions(h.owner.id, h.permissions);
  await tool.execute({ action: 'status', name: 'vite-front' }, a.exec);
  assert.equal(h.calls.length, 2);
  await a.dispose();
  assert.equal(h.calls.length, 2);
  await assert.rejects(tool.execute({ action: 'stop', name: 'vite-front' }, a.exec), /abort/i);
  const next = h.createAgent();
  await next.tools.find(item => item.name === 'dev_server')!.execute({ action: 'list' }, next.exec);
  assert.deepEqual(JSON.parse(h.calls[2]!.command), { action: 'list' });
});

test('only an active administrator can stop another account service and the action is audited', async (t) => {
  const h = await harness(t); const a = h.createAgent();
  h.config.tenantAgentShell!.serviceLauncher = '/usr/local/libexec/dsh-tenant-service';
  const admin = h.db.createUser('administrator', 'hash', 'admin');
  const calls: TenantCommandRequest[] = [];
  const tool = tenantServiceAdminTool({} as Context, a.agent, h.db, h.config, async request => { calls.push(request); return { ...success, stdout: '{"enabled":false}' }; });
  const args = { action: 'stop', accountId: String(h.owner.id), name: 'vite-front' };
  await assert.rejects(tool.execute(args, a.exec), /administrator/);
  const principal = { source: 'dsh-passwords', id: String(admin.id), username: admin.username, role: 'admin' as const };
  await assert.rejects(tool.execute(args, { ...a.exec, principal: { ...principal, id: String(h.owner.id) } }), /active account/);
  assert.equal(calls.length, 0);
  assert.equal(await tool.execute(args, { ...a.exec, principal }), '{"enabled":false}');
  assert.deepEqual(calls[0]!.args, ['-n', '--', h.config.tenantAgentShell!.serviceLauncher, '--admin']);
  assert.deepEqual(JSON.parse(calls[0]!.command), args);
  h.db.setPermissions(admin.id, { ...h.permissions, banned: true });
  await assert.rejects(tool.execute(args, { ...a.exec, principal }), /active account/);
  assert.equal(calls.length, 1);
});
