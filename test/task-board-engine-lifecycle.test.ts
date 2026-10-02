import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { HostTaskLedger as BundledLedger, TaskBoardHostService as BundledHost } from '../dist/task-board-engine.js';
import type { HostTaskLedger } from '../integrations/task-board/upstream/host-ledger.ts';
import type { TaskBoardHostService } from '../integrations/task-board/upstream/host-service.ts';
import { TaskBoardAccounts } from '../integrations/task-board/upstream/host-accounts.ts';
import { TASK_BOARD_API_VERSION, type TaskBoardExtensionHost } from '../integrations/task-board/upstream/core/extension.ts';

/** The bundle exposes the vendored Host; the adapter declaration omits its extension APIs. */
async function board(t: TestContext, accounts?: TaskBoardAccounts) {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-board-lifecycle-'));
  const Host = BundledHost as typeof TaskBoardHostService;
  const Ledger = BundledLedger as typeof HostTaskLedger;
  const host = new Host({
    invoke: async () => ({ items: [] }),
    stream: async () => ({ async *[Symbol.asyncIterator]() {} }),
  } as never, { ledger: new Ledger(directory), accounts });
  t.after(async () => { host.dispose(); await rm(directory, { recursive: true, force: true }); });
  return host;
}

function tool(name: string): ToolDefinition {
  return {
    name, description: 'Lifecycle test tool', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: {} }, render: () => [] },
    execute: async () => ({}),
  };
}

test('bundled task board stops late registrations silently when its Host is unloading', async t => {
  const host = await board(t);
  const errors = t.mock.method(console, 'error', () => {});
  let stops = 0;
  let attempts = 0;
  host.registerExtension({
    id: 'lifecycle', apiVersion: TASK_BOARD_API_VERSION,
    start(face) { face.registerTool(tool('first')); face.registerTool(tool('second')); },
    stop() { stops += 1; },
  });
  host.extensions.setToolRegistry(() => ({ register() {
    attempts += 1;
    throw Object.assign(new Error('Host is unloading'), { code: 'INACTIVE_EFFECT' });
  } }));
  assert.equal(attempts, 1);
  assert.equal(errors.mock.callCount(), 0);
  host.dispose();
  host.extensions.setToolRegistry(() => ({ register() { attempts += 1; return () => {}; } }));
  assert.equal(attempts, 1);
  assert.equal(stops, 1);
});

test('bundled task board reports real registration failures and releases recovered tools', async t => {
  const host = await board(t);
  const errors = t.mock.method(console, 'error', () => {});
  const failure = Object.assign(new Error('Duplicate name'), { code: 'DUPLICATE_TOOL' });
  host.registerExtension({
    id: 'lifecycle', apiVersion: TASK_BOARD_API_VERSION,
    start(face) { face.registerTool(tool('first')); face.registerTool(tool('second')); },
  });
  host.extensions.setToolRegistry(() => ({ register() { throw failure; } }));
  assert.equal(errors.mock.callCount(), 2);
  for (const call of errors.mock.calls) {
    assert.match(call.arguments[0], /tool "(?:first|second)" registration failed/);
    assert.equal(call.arguments[1], failure);
  }
  const names = new Set<string>();
  host.extensions.setToolRegistry(() => ({ register(definition) {
    names.add(definition.name);
    return () => { names.delete(definition.name); };
  } }));
  assert.deepEqual([...names], ['first', 'second']);
  host.dispose();
  assert.deepEqual([...names], []);
});

test('bundled extension handles lose shared task and tool access when account isolation activates', async t => {
  let accountMode = false;
  const accounts = new TaskBoardAccounts({ get: () => accountMode ? {} : undefined } as never);
  const host = await board(t, accounts);
  let face: TaskBoardExtensionHost | undefined;
  let registered: ToolDefinition | undefined;
  host.extensions.setToolRegistry(() => ({ register(definition) { registered = definition; return () => {}; } }));
  host.registerExtension({
    id: 'shared', apiVersion: TASK_BOARD_API_VERSION,
    start(value) { face = value; value.registerTool(tool('shared_tool')); value.publish({ active: true }); },
    handleAction() { throw new Error('Shared action must not run'); },
  });
  assert.ok(face);
  assert.ok(registered);
  assert.equal(host.extensions.isActive('shared'), true);
  accountMode = true;
  assert.equal(host.extensions.isActive('shared'), false);
  assert.deepEqual(host.extensions.published(), {});
  for (const read of [() => face.tasks.list(), () => face.tasks.get('private'), () => face.tasks.linked()]) {
    assert.throws(read, { code: 'account-isolation-required' });
  }
  await assert.rejects(host.extensions.handleAction({ extensionId: 'shared', action: 'sync' }), { code: 'account-isolation-required' });
  await assert.rejects(registered.execute({}, { signal: new AbortController().signal } as never), { code: 'account-isolation-required' });
});
