import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';
import { inject } from '../src/client/inject.ts';
import { loadDshPasswordsState, resolveDshPasswordsClient } from '../src/client/dsh-passwords-client.ts';

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
      ctx.provide('uiWorkspace', {});
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
      return {
        ok: true as const,
        value: { me: { username: 'admin', role: 'admin' as const }, users: [] },
      };
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
      ctx.provide('uiWorkspace', {});
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
      deferredLoad = () => loadDshPasswordsState(client);
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

test('password state loader rejects a Remote failure instead of presenting an empty account', async () => {
  const client = {
    state: async () => ({
      ok: false as const,
      error: { code: 'forbidden', message: 'principal required', details: { retryable: false } },
    }),
  };
  await assert.rejects(
    loadDshPasswordsState(client),
    (error: Error & { code?: string; details?: unknown }) => {
      assert.equal(error.message, 'principal required');
      assert.equal(error.code, 'forbidden');
      assert.deepEqual(error.details, { retryable: false });
      return true;
    },
  );
});

test('browser entrypoint returns the mounted Remote disposer', () => {
  const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8');
  const buildSource = readFileSync(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dsh: { client: { inject: string[] } };
  };
  assert.match(source, /const disposeRemote = await remote\.\$mount\(DSH_PASSWORDS_REMOTE\)/);
  assert.match(source, /loadState: \(\) => loadDshPasswordsState\(dshPasswords\)/);
  assert.match(source, /@deepseek-ai\/dsh-client-ui-renderer\/client/);
  assert.match(source, /@deepseek-ai\/dsh-client-ui-workspace\/client/);
  assert.doesNotMatch(source, /@deepseek-ai\/dsh-client-ui-slots\/client/);
  assert.doesNotMatch(buildSource, /@deepseek-ai\/dsh-client-ui-slots\/client/);
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'));
  assert.ok(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'));
  assert.match(source, /return disposeRemote;/);
});
