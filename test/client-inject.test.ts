import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { inject } from '../src/client/inject.ts';

test('browser entrypoint can read a sibling-provided Remote service through Cordis v4 injection', async (t) => {
  const root = new Context();
  t.after(async () => root.fiber.dispose());

  const mountCalls: unknown[] = [];
  const remote = {
    async $mount(contribution: unknown) {
      mountCalls.push(contribution);
      return () => {};
    },
  };

  await root.plugin({
    name: 'client-service-provider',
    apply(ctx) {
      ctx.provide('slots', {});
      ctx.provide('remote', remote);
      ctx.provide('locale', {});
      ctx.provide('sessions', {});
      ctx.provide('workspaces', {});
    },
  });

  await root.plugin({
    name: 'dsh-passwords-client-inject-regression',
    inject,
    async apply(ctx) {
      const injectedRemote = (ctx as unknown as { remote: typeof remote }).remote;
      await injectedRemote.$mount('dsh-passwords');
    },
  });

  assert.deepEqual(mountCalls, ['dsh-passwords']);
});
