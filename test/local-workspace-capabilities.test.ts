import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { WebSocket } from 'ws';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { LocalWorkspaceHub } from '../src/local-workspace-hub.js';

// Protocol deadlines bound failures; every successful transition awaits its acknowledgement.
test('existing agents receive current Shell capability after reconnect, disable and revoke', { timeout: 15_000 }, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-local-capabilities-'));
  const ctx = new Context();
  const db = new Database(path.join(temp, 'db'), createFieldCrypto('test-key', 'test-setup'));
  db.init();
  const owner = db.createUser('owner', 'hash', 'user');
  const other = db.createUser('other', 'hash', 'user');
  const token = 't'.repeat(43);
  const workspace = db.createLocalWorkspace({
    id: 'capabilities-workspace', userId: owner.id, token, deviceName: 'test-mac',
    workspaceName: 'project', remoteRoot: '/Users/test/project',
    placeholderPath: path.join(temp, 'workspaces', 'project'), platform: 'darwin', shellEnabled: true,
  });
  const config = {
    gateway: { tls: null },
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: path.join(temp, 'workspaces') },
  } as PlatformConfig;
  const hub = new LocalWorkspaceHub(ctx, db, config);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
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
  const bash = ctx.tools.get('bash')!;
  assert.ok(bash);
  const execution = { agent, signal: new AbortController().signal,
    principal: { source: 'dsh-passwords', id: String(owner.id), username: owner.username, role: 'user' },
  } as ToolRunContext;
  const run = (exec = execution) => bash.execute({ command: 'git status --short --branch', description: 'Inspect branch' }, exec);
  const contexts: Record<string, string> = {};
  const capture = async (name: string) => {
    const assembly = await ctx.systemPrompt.assemble();
    contexts[name] = assembly.contexts.find(item => item.name === 'local-workspace-capabilities')!.text;
  };
  const connect = async (shellEnabled: boolean, platform = 'darwin') => {
    const socket = new WebSocket(`ws://127.0.0.1:${hub.connectionInfo().port}`);
    sockets.push(socket);
    const signal = AbortSignal.timeout(3_000);
    await once(socket, 'open', { signal });
    const ready = once(socket, 'message', { signal });
    socket.send(JSON.stringify({ type: 'resume', protocol: 2, token, workspaceId: workspace.id,
      deviceName: 'test-device', workspaceName: 'project', root: '/Users/test/project', platform, shellEnabled }));
    assert.equal(JSON.parse(String((await ready)[0])).type, 'ready');
    return socket;
  };

  await capture('offline');
  await assert.rejects(run(), { code: 'OFFLINE' });
  await connect(false);
  await capture('disabled');
  await assert.rejects(run(), { code: 'SHELL_DISABLED' });

  const enabled = await connect(true);
  await capture('enabled');
  assert.equal(db.getLocalWorkspace(workspace.id)!.shell_enabled, true);
  const request = once(enabled, 'message', { signal: AbortSignal.timeout(3_000) });
  const result = run();
  const operation = JSON.parse(String((await request)[0]));
  assert.equal(operation.operation, 'bash');
  assert.equal(operation.args.command, 'git status --short --branch');
  const value = { stdout: '## dev\n', stderr: '', exitCode: 0, timedOut: false };
  enabled.send(JSON.stringify({ type: 'response', id: operation.id, ok: true, value }));
  assert.deepEqual(await result, value);
  await assert.rejects(run({ ...execution, principal: { ...execution.principal!, id: String(other.id) } }), { code: 'FORBIDDEN' });

  await connect(true, 'win32');
  await capture('windows');
  const disabled = await connect(false);
  await capture('disabledAfterReconnect');
  let dispatched = false;
  disabled.on('message', () => { dispatched = true; });
  await assert.rejects(run(), { code: 'SHELL_DISABLED' });
  assert.equal(dispatched, false);
  assert.equal(await hub.revoke(owner.id, workspace.id), true);
  await capture('revoked');
  await assert.rejects(run(), { code: 'OFFLINE' });
  assert.equal(db.authenticateLocalWorkspace(token), null);

  assert.deepEqual({ description: bash.description, contexts }, JSON.parse(await readFile(
    new URL('./expected/local-workspace-capabilities.json', import.meta.url), 'utf8',
  )));
});
