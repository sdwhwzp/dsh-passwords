import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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

/** A 2x2 PNG; the desktop tools only ever read its IHDR through the companion. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAACZgbYnAAAAFElEQVR4nGP8z4AAT'
  + 'AwoYFQEqwgAYkMBBMBSpwUAAAAASUVORK5CYII=';

interface Harness {
  ctx: Context;
  db: Database;
  hub: LocalWorkspaceHub;
  socket: WebSocket;
  execution: ToolRunContext;
  otherUserId: number;
}

async function startHarness(t: Parameters<typeof test>[0] extends never ? never : {
  after(fn: () => void | Promise<void>): void;
}, desktopControl: boolean): Promise<Harness> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-tools-'));
  const ctx = new Context();
  const db = new Database(path.join(temp, 'db'), createFieldCrypto('test-key', 'test-setup'));
  db.init();
  const owner = db.createUser('owner', 'hash', 'user');
  const other = db.createUser('other', 'hash', 'user');
  const token = 't'.repeat(43);
  const workspace = db.createLocalWorkspace({
    id: 'desktop-workspace', userId: owner.id, token, deviceName: 'test-mac',
    workspaceName: 'project', remoteRoot: '/Users/test/project',
    placeholderPath: path.join(temp, 'workspaces', 'project'), platform: 'darwin',
    shellEnabled: true, desktopControl,
  });
  const config = {
    gateway: { tls: null },
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: path.join(temp, 'workspaces') },
  } as PlatformConfig;
  const hub = new LocalWorkspaceHub(ctx, db, config);
  const saved: { data: Uint8Array; mediaType: string; name?: string }[] = [];
  ctx.provide('attachments', {
    saveImage(input: { data: Uint8Array; mediaType: string; name?: string }) {
      saved.push(input);
      return Promise.resolve({
        attachmentId: `attachment-${String(saved.length)}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1280,
        height: 800,
        name: input.name,
      });
    },
  });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await hub.start();

  const socket = new WebSocket(`ws://127.0.0.1:${String(hub.connectionInfo().port)}`);
  const signal = AbortSignal.timeout(5_000);
  await once(socket, 'open', { signal });
  const ready = once(socket, 'message', { signal });
  socket.send(JSON.stringify({
    type: 'resume', protocol: 2, token, workspaceId: workspace.id, deviceName: 'test-device',
    workspaceName: 'project', root: '/Users/test/project', platform: 'darwin',
    shellEnabled: true, desktopControl,
  }));
  assert.equal(JSON.parse(String((await ready)[0])).type, 'ready');

  const agent = { ctx, session: { header: { cwd: workspace.placeholder_path } } } as unknown as Agent;
  ctx.emit('agent/created', { agent });
  const execution = {
    agent, signal: new AbortController().signal,
    principal: { source: 'dsh-passwords', id: String(owner.id), username: owner.username, role: 'user' },
  } as ToolRunContext;

  t.after(async () => {
    socket.terminate();
    await hub.dispose();
    await ctx.fiber.dispose();
    db.close();
    await rm(temp, { recursive: true, force: true });
  });
  return { ctx, db, hub, socket, execution, otherUserId: other.id };
}

/** Answer the next companion request, asserting which operation the host sent. */
async function answerOnce(socket: WebSocket, operation: string, value: unknown): Promise<Record<string, unknown>> {
  const [raw] = await once(socket, 'message', { signal: AbortSignal.timeout(5_000) });
  const request = JSON.parse(String(raw)) as { id: string; operation: string; args: Record<string, unknown> };
  assert.equal(request.operation, operation);
  socket.send(JSON.stringify({ type: 'response', id: request.id, ok: true, value }));
  return request.args;
}

test('a pairing without desktop control gets no desktop tools', { timeout: 15_000 }, async (t) => {
  const { ctx } = await startHarness(t, false);
  assert.equal(ctx.tools.get('computer_screenshot'), undefined);
  assert.equal(ctx.tools.get('computer_use'), undefined);
  // The file and terminal tools are unaffected by the desktop grant.
  assert.ok(ctx.tools.get('read'));
  assert.ok(ctx.tools.get('bash'));
});

test('a granted pairing publishes each capture and names its coordinate space', { timeout: 15_000 }, async (t) => {
  const { ctx, socket, execution } = await startHarness(t, true);
  const screenshot = ctx.tools.get('computer_screenshot');
  assert.ok(screenshot);

  const pending = screenshot.execute({ display: 1 }, execution);
  const args = await answerOnce(socket, 'screenshot', {
    mediaType: 'image/png', data: TINY_PNG, bytes: 82,
    width: 1280, height: 800, screenWidth: 1440, screenHeight: 900,
    scale: 1.125, display: 1, displays: 2,
  });
  assert.deepEqual(args, { display: 1 });

  const value = await pending as Record<string, unknown>;
  // Every published fact comes from the attachment store's reference, not from
  // the byte count the companion claimed alongside the image.
  assert.deepEqual(value.image, {
    attachmentId: 'attachment-1', mediaType: 'image/png', bytes: 77, width: 1280, height: 800,
  });
  assert.equal(value.screenWidth, 1440);
  assert.equal(value.display, 1);

  const blocks = screenshot.output!.render!({ display: 1 }, value as never);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.type, 'text');
  const envelope = (blocks[0] as { text: string }).text;
  assert.match(envelope, /<display>2 of 2<\/display>/);
  assert.match(envelope, /<screen>1440x900 logical px<\/screen>/);
  assert.match(envelope, /<screenshot>1280x800 px<\/screenshot>/);
  assert.match(envelope, /x from 0 to 1279, y from 0 to 799/);
  // The published image matched the capture, so no rescaling advice is added.
  assert.doesNotMatch(envelope, /<attached>/);
  assert.deepEqual(blocks[1], {
    type: 'image',
    attachment: { attachmentId: 'attachment-1', mediaType: 'image/png', bytes: 77, width: 1280, height: 800 },
  });
});

test('a capture the attachment store resized carries the multiplier back', { timeout: 15_000 }, async (t) => {
  const { ctx } = await startHarness(t, true);
  const screenshot = ctx.tools.get('computer_screenshot');
  assert.ok(screenshot);
  const resized = {
    image: { attachmentId: 'a', mediaType: 'image/png', bytes: 10, width: 640, height: 400 },
    display: 0, displays: 1, width: 1280, height: 800,
    screenWidth: 1440, screenHeight: 900, scale: 1.125,
  };
  const envelope = (screenshot.output!.render!({}, resized as never)[0] as { text: string }).text;
  assert.match(envelope, /<attached>640x400 px/);
  assert.match(envelope, /multiply coordinates measured on it by 2\.000 horizontally and 2\.000 vertically/);
});

test('input actions reach the companion in the screenshot coordinate space', { timeout: 15_000 }, async (t) => {
  const { ctx, socket, execution } = await startHarness(t, true);
  const computerUse = ctx.tools.get('computer_use');
  assert.ok(computerUse);

  const reply = {
    action: 'left_click', cursor: { x: 640, y: 400 }, width: 1280, height: 800,
    screenWidth: 1440, screenHeight: 900, scale: 1.125, display: 0, displays: 1,
  };
  const pending = computerUse.execute(
    { action: 'left_click', coordinate: [640, 400], display: 0 },
    execution,
  );
  const args = await answerOnce(socket, 'input', reply);
  // The tool's snake_case parameters become the companion's wire names.
  assert.deepEqual(args, { action: 'left_click', coordinate: [640, 400], display: 0 });
  assert.deepEqual(await pending, reply);

  const drag = computerUse.execute(
    { action: 'left_click_drag', coordinate: [10, 20], start_coordinate: [1, 2], scroll_amount: 4 },
    execution,
  );
  const dragArgs = await answerOnce(socket, 'input', reply);
  assert.deepEqual(dragArgs, {
    action: 'left_click_drag', coordinate: [10, 20], startCoordinate: [1, 2], scrollAmount: 4,
  });
  await drag;

  const rendered = computerUse.output!.render!({}, reply as never);
  assert.equal(rendered.length, 1);
  assert.match((rendered[0] as { text: string }).text, /left_click done; pointer at \(640, 400\)/);
});

test('each desktop call names what it is about to do', { timeout: 15_000 }, async (t) => {
  const { ctx } = await startHarness(t, true);
  const screenshot = ctx.tools.get('computer_screenshot')!;
  const computerUse = ctx.tools.get('computer_use')!;
  assert.deepEqual(screenshot.presentCall!({}), {
    card: 'generic', kind: 'read', title: '截取配对电脑的屏幕',
  });
  assert.deepEqual(screenshot.presentCall!({ display: 1 }), {
    card: 'generic', kind: 'read', title: '截取配对电脑的第 2 块屏幕',
  });
  assert.deepEqual(computerUse.presentCall!({ action: 'left_click', coordinate: [12, 34] }), {
    card: 'generic', kind: 'execute', title: 'left_click @ (12, 34)',
  });
  assert.deepEqual(computerUse.presentCall!({ action: 'type', text: 'hello' }), {
    card: 'generic', kind: 'execute', title: 'type hello',
  });
  // A malformed call has nothing worth showing, so the default row is used.
  assert.equal(computerUse.presentCall!({}), undefined);
});

test('another account cannot drive the owner’s desktop', { timeout: 15_000 }, async (t) => {
  const { ctx, execution, otherUserId } = await startHarness(t, true);
  const intruder = { ...execution, principal: { ...execution.principal!, id: String(otherUserId) } } as ToolRunContext;
  for (const name of ['computer_screenshot', 'computer_use']) {
    const tool = ctx.tools.get(name);
    assert.ok(tool);
    await assert.rejects(
      () => tool.execute({ action: 'left_click' }, intruder) as Promise<unknown>,
      { code: 'FORBIDDEN' },
    );
  }
});
