import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';
import { inject } from '../src/client/inject.ts';
import { resolveDshPasswordsClient } from '../src/client/dsh-passwords-client.ts';

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

test('mounted password namespace is retained through an exact nested inject', async (t) => {
  const root = new Context();
  t.after(async () => root.fiber.dispose());

  const dshPasswords = {
    async state() {
      return { me: { username: 'admin', role: 'admin' as const }, users: [] };
    },
  };
  let disposeCalls = 0;
  class TestRemote extends Service {
    constructor(ctx: Context) {
      super(ctx, 'remote');
    }

    async $mount() {
      const namespaceFiber = this.ctx.plugin({
        name: 'remote.dshPasswords',
        apply(ctx) {
          ctx.provide('remote.dshPasswords', dshPasswords);
        },
      });
      await namespaceFiber.await();
      return async () => {
        disposeCalls += 1;
        await namespaceFiber.dispose();
      };
    }
  }
  new TestRemote(root);

  await root.plugin({
    name: 'password-client-service-provider',
    apply(ctx) {
      ctx.provide('slots', {});
      ctx.provide('locale', {});
      ctx.provide('sessions', {});
      ctx.provide('workspaces', {});
    },
  });

  let deferredLoad!: () => Promise<unknown>;
  const fiber = root.plugin({
    name: 'dsh-passwords-exact-client-inject-regression',
    inject,
    async apply(ctx) {
      const mountedRemote = ctx.remote as unknown as TestRemote & { dshPasswords: unknown };
      const disposeRemote = await mountedRemote.$mount();
      assert.throws(
        () => mountedRemote.dshPasswords,
        /cannot get property "remote\.dshPasswords" without inject/,
      );
      const client = await resolveDshPasswordsClient(ctx);
      deferredLoad = () => client.state();
      return disposeRemote;
    },
  });
  await fiber.await();

  assert.deepEqual(await deferredLoad(), {
    me: { username: 'admin', role: 'admin' },
    users: [],
  });
  await fiber.dispose();
  assert.equal(disposeCalls, 1);
});

test('browser entrypoint returns the mounted Remote disposer', () => {
  const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8');
  assert.match(source, /const disposeRemote = await remote\.\$mount\(DSH_PASSWORDS_REMOTE\)/);
  assert.match(source, /return disposeRemote;/);
});
