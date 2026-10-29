import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { Database } from '../dist/db.js';
import { createFieldCrypto } from '../dist/encrypt.js';
import { DshPasswordsPrincipalAccessProvider } from '../dist/principal-access.js';
import { registerAttachmentReplayGuard } from '../dist/attachment-replay-guard.js';

const own = `sha256:${'a'.repeat(64)}`;
const foreign = `sha256:${'b'.repeat(64)}`;
const image = (id: string) => ({ type: 'image' as const, attachment: { attachmentId: id, mediaType: 'image/png', bytes: 16, width: 1, height: 1 } });
const file = (id: string) => ({ type: 'file' as const, attachment: { attachmentId: id, name: 'private.txt', bytes: 16 } });
const denied = { code: 'PRINCIPAL_ACCESS_DENIED' };

async function fixture(t: TestContext, backend: 'sqlite' | 'mysql') {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'passwords-replay-'));
  const schema = `dshpw_replay_test_${randomUUID().replaceAll('-', '')}`;
  const port = Number(process.env.DSH_TEST_MYSQL_PORT);
  const admin = backend === 'mysql' ? await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' }) : undefined;
  let db: Database;
  t.after(async () => {
    db?.close();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${schema}`); await admin.end(); }
    await rm(temporary, { recursive: true, force: true });
  });
  if (admin) await admin.query(`CREATE DATABASE ${schema}`);
  db = new Database(backend === 'mysql'
    ? { driver: 'mysql', host: '127.0.0.1', port, user: 'root', password: '', database: schema, tls: 'off', queryTimeoutMs: 15000 }
    : path.join(temporary, 'platform.db'), createFieldCrypto('fixture', 'fixture'));
  db.init();
  const alice = db.createUser('alice', 'hash', 'user');
  const bob = db.createUser('bob', 'hash', 'user');
  const root = db.createUser('admin', 'hash', 'admin');
  const permissions = { allowedFolders: [temporary], hourlyTokenLimit: null, dailyMinutesLimit: null, allowUpload: true, allowGitDownload: false, banned: false };
  const principal = (user: typeof alice) => ({ source: 'dsh-passwords', id: String(user.id), username: user.username, role: user.role });
  const a = principal(alice), b = principal(bob), r = principal(root);
  for (const user of [alice, bob, root]) {
    db.setPermissions(user.id, permissions);
    db.claimSessionOwner(`session-${user.id}`, user.id);
  }
  db.recordAttachmentGrants(a, `session-${a.id}`, [own], 'host-validated-upload');
  db.recordAttachmentGrants(b, `session-${b.id}`, [foreign], 'host-validated-upload');
  const ctx = new Context();
  const runtime = ctx.plugin(LlmRuntime);
  await runtime;
  const reads: string[] = [];
  const paths: string[] = [];
  let dispatches = 0;
  const attachments = {
    async readImageRequest(ref: { attachmentId: string }) { reads.push(ref.attachmentId); return { data: Buffer.from('fixture bytes') }; },
    fileHostPath(ref: { attachmentId: string }) { paths.push(ref.attachmentId); return `/fixture/${ref.attachmentId}`; },
  };
  const disposeAttachments = ctx.provide('attachments', attachments as never);
  const disposeFs = ctx.provide('fs' as never, { processPathFromHostPath: (value: string) => value } as never);
  class Adapter extends LlmAdapter {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      dispatches += 1;
      for (const message of options.messages) {
        for (const block of message.content) {
          if (block.type === 'image') await attachments.readImageRequest(block.attachment);
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const disposeAdapter = ctx.llm.registerAdapter(['fixture'], new Adapter());
  const provider = new DshPasswordsPrincipalAccessProvider(ctx, db);
  // Production installs passwords in a sibling plugin scope of the shared runtime.
  await ctx.plugin((scope: Context) => { registerAttachmentReplayGuard(scope, provider); });
  t.after(async () => {
    disposeAdapter();
    disposeFs();
    disposeAttachments();
    await ctx.fiber.dispose();
  });
  const bind = async (p: typeof a | undefined, signal: AbortSignal, sessionId = `session-${p?.id ?? 'anonymous'}`) => {
    await ctx.waterfall('agent/request', { agent: { id: sessionId }, principal: p, signal, turn: 1, step: 1 } as never,
      async () => ({ provider: 'fixture', model: 'vision' }));
    return sessionId;
  };
  const request = (content: unknown[], signal?: AbortSignal, sessionId?: string): GenerateOptions => ({
    provider: 'fixture', model: 'vision', signal, sessionId: sessionId as never,
    // A historical principal is intentionally Bob: it is data, not current execution authority.
    messages: [createUserMessage({ content: content as never, source: { kind: 'user' }, principal: b })],
  });
  const consume = async (options: GenerateOptions) => {
    for await (const _chunk of ctx.llm.stream(options)) { /* consume the actual runtime boundary */ }
  };
  return { db, ctx, provider, a, b, r, permissions, bind, request, consume, reads, paths, dispatches: () => dispatches };
}

for (const backend of ['sqlite', 'mysql'] as const) {
const replayTest = (name: string, run: (t: TestContext) => Promise<void>) => test(`${backend}: ${name}`, {
  skip: backend === 'mysql' && !process.env.DSH_TEST_MYSQL_PORT ? 'requires isolated loopback MySQL test port' : false,
}, run);

replayTest('replayed foreign images are denied before adapter reads; historical principal cannot authorize them', async t => {
  const f = await fixture(t, backend);
  const signal = new AbortController().signal;
  const session = await f.bind(f.a, signal);
  await assert.rejects(f.consume(f.request([image(foreign)], signal, session)), denied);
  assert.deepEqual(f.reads, []);
  assert.equal(f.dispatches(), 0);
  await f.consume(f.request([image(own), image(own)], signal, session));
  assert.deepEqual(f.reads, [own, own]);
});

replayTest('foreign files, offloaded images, assistant content and tool-result history deny before path projection', async t => {
  const f = await fixture(t, backend);
  const signal = new AbortController().signal;
  const session = await f.bind(f.a, signal);
  for (const block of [file(foreign), { ...image(foreign), offloaded: true }, image(foreign)]) {
    for (const role of ['user', 'assistant', 'tool']) {
      const options = f.request([block], signal, session);
      options.messages[0] = { ...options.messages[0], role } as never;
      await assert.rejects(f.consume(options), denied);
    }
  }
  assert.deepEqual(f.paths, []);
  assert.deepEqual(f.reads, []);
  assert.equal(f.dispatches(), 0);
  await f.consume(f.request([file(own)], signal, session));
  assert.deepEqual(f.paths, [own]);
  assert.equal(f.dispatches(), 1);
});

replayTest('unknown, mismatched, auxiliary and anonymous execution identities never fall back to history', async t => {
  const f = await fixture(t, backend);
  const signal = new AbortController().signal;
  const session = await f.bind(f.a, signal);
  for (const options of [
    f.request([image(own)], undefined, session),
    f.request([image(own)], new AbortController().signal, session),
    f.request([image(own)], signal, 'other-session'),
    { ...f.request([image(own)], new AbortController().signal, session), purpose: 'compaction' as const },
  ]) await assert.rejects(f.consume(options), denied);
  const anonymousSignal = new AbortController().signal;
  const anonymous = await f.bind(undefined, anonymousSignal);
  await assert.rejects(f.consume(f.request([image(own)], anonymousSignal, anonymous)), denied);
  await f.consume(f.request([{ type: 'text', text: 'anonymous text remains usable' }]));
  assert.equal(f.dispatches(), 1);
  assert.deepEqual(f.reads, []);
});

replayTest('concurrent accounts use their own signals; captured streams retain the original active identity', async t => {
  const f = await fixture(t, backend);
  const signalA = new AbortController().signal, signalB = new AbortController().signal;
  const sessionA = await f.bind(f.a, signalA), sessionB = await f.bind(f.b, signalB);
  await Promise.all([
    f.consume(f.request([image(own)], signalA, sessionA)),
    f.consume(f.request([image(foreign)], signalB, sessionB)),
    assert.rejects(f.consume(f.request([image(foreign)], signalA, sessionA)), denied),
    assert.rejects(f.consume(f.request([image(own)], signalB, sessionB)), denied),
  ]);
  const stream = f.ctx.llm.stream(f.request([image(foreign)], signalA, sessionA));
  await f.bind(f.b, signalA, sessionA);
  await assert.rejects(async () => { for await (const _ of stream) { /* consume */ } }, denied);
  assert.equal(f.dispatches(), 2);
});

replayTest('same-step compaction uses trusted pre-step identity before any ordinary request', async t => {
  const f = await fixture(t, backend);
  const signal = new AbortController().signal, sessionId = `session-${f.a.id}`;
  await f.ctx.waterfall('agent/pre-step', {
    agent: { id: sessionId }, principal: f.a, signal, turn: 1, step: 1, messages: [],
    modelSelection: { provider: 'fixture', model: 'vision' },
  } as never, async () => {
    await f.consume({ ...f.request([image(own)], signal, sessionId), purpose: 'compaction' });
    await assert.rejects(f.consume({ ...f.request([image(foreign)], signal, sessionId), purpose: 'compaction' }), denied);
    return { kind: 'enter' } as never;
  });
  assert.deepEqual(f.reads, [own]);
  assert.equal(f.dispatches(), 1);
});

replayTest('prepared calls use the same guard even when the public stream method is replaced', async t => {
  const f = await fixture(t, backend);
  const signal = new AbortController().signal, session = await f.bind(f.a, signal);
  const prepared = await f.ctx.llm.prepareCall({ provider: 'fixture', model: 'vision' }, signal);
  f.ctx.llm.stream = () => { throw new Error('public stream replaced'); };
  await assert.rejects(async () => {
    for await (const _ of prepared.stream(f.request([image(foreign)], signal, session))) { /* consume */ }
  }, denied);
  assert.equal(f.dispatches(), 0);
  const ownPrepared = await f.ctx.llm.prepareCall({ provider: 'fixture', model: 'vision' }, signal);
  for await (const _ of ownPrepared.stream(f.request([image(own)], signal, session))) { /* consume */ }
  assert.deepEqual(f.reads, [own]);
});

replayTest('admin, stale identities and bans require independent active account grants', async t => {
  const f = await fixture(t, backend);
  for (const principal of [f.r, { ...f.a, username: 'stale' }, { ...f.a, source: 'foreign-provider' }]) {
    const signal = new AbortController().signal, session = await f.bind(principal, signal);
    await assert.rejects(f.consume(f.request([image(own)], signal, session)), denied);
  }
  const signal = new AbortController().signal, session = await f.bind(f.a, signal);
  f.db.setPermissions(Number(f.a.id), { ...f.permissions, banned: true });
  await assert.rejects(f.consume(f.request([image(own)], signal, session)), denied);
  assert.equal(f.dispatches(), 0);
});

replayTest('missing grant results, cancellation and identity mutation during authorization never dispatch', async t => {
  const f = await fixture(t, backend);
  const abort = new AbortController(), session = await f.bind(f.a, abort.signal);
  const resolve = f.provider.resolve.bind(f.provider);
  f.provider.resolve = async () => ({ readableSessionIds: new Set(), readableWorkspaceIds: new Set() });
  await assert.rejects(f.consume(f.request([image(own)], abort.signal, session)), denied);
  const options = f.request([image(own)], abort.signal, session);
  options.messages = structuredClone(options.messages);
  f.provider.resolve = async (...args) => {
    const result = await resolve(...args);
    options.messages[0].content.push(image(foreign) as never);
    return result;
  };
  await assert.rejects(f.consume(options), denied);
  f.provider.resolve = async (...args) => { const result = await resolve(...args); abort.abort(new Error('cancelled')); return result; };
  await assert.rejects(f.consume(f.request([image(own)], abort.signal, session)), /cancelled/);
  assert.equal(f.dispatches(), 0);
});
}
