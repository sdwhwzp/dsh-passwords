import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import {
  installSessionModelSelectionPersistence,
  type SessionModelApiProxy,
  type SessionModelSelectionStore,
  type StoredSessionModelSelection,
} from '../src/session-model-selection.js';

function ok<T>(rpcId: unknown, value: T) {
  return { rpcId, result: { ok: true as const, value } };
}

function fakeApi(defaultSelection: StoredSessionModelSelection): {
  api: SessionModelApiProxy;
  current: Map<string, StoredSessionModelSelection>;
  selectCalls: string[];
} {
  const current = new Map<string, StoredSessionModelSelection>();
  const selectCalls: string[] = [];
  const api: SessionModelApiProxy = {
    sessions: {
      async selectModel(request) {
        selectCalls.push(request.payload.sessionId);
        const selected = {
          provider: request.payload.provider,
          model: request.payload.model,
          ...request.payload.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: request.payload.reasoningEffort },
        };
        current.set(request.payload.sessionId, selected);
        return ok(request.rpcId, { selected });
      },
      async models(request) {
        return ok(request.rpcId, { current: current.get(request.payload.sessionId) ?? defaultSelection });
      },
      async prompt(request) {
        return ok(request.rpcId, { used: current.get(request.payload.sessionId) ?? defaultSelection });
      },
    },
  };
  return { api, current, selectCalls };
}

function valueOf(response: Awaited<ReturnType<SessionModelApiProxy['sessions']['models']>>): unknown {
  assert.equal(response.result.ok, true);
  return response.result.ok ? response.result.value : undefined;
}

test('session model selection survives a Host restart without changing another session', async () => {
  const rows = new Map<string, StoredSessionModelSelection>();
  const store: SessionModelSelectionStore = {
    getSessionModelSelection: sessionId => rows.get(sessionId) ?? null,
    setSessionModelSelection: (sessionId, selection) => { rows.set(sessionId, { ...selection }); },
  };
  const defaults = { provider: 'codex', model: 'gpt-5.6-sol' };
  const first = fakeApi(defaults);
  const disposeFirst = installSessionModelSelectionPersistence(first.api, store);

  const switched = await first.api.sessions.selectModel({
    rpcId: 'select-a',
    payload: {
      sessionId: 'session-a',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    },
  });
  assert.equal(switched.result.ok, true);
  assert.deepEqual(rows.get('session-a'), {
    provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'high',
  });
  disposeFirst();

  const restarted = fakeApi(defaults);
  installSessionModelSelectionPersistence(restarted.api, store);
  assert.deepEqual(valueOf(await restarted.api.sessions.models({
    rpcId: 'models-a', payload: { sessionId: 'session-a' },
  })), {
    current: { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'high' },
  });
  assert.deepEqual(valueOf(await restarted.api.sessions.models({
    rpcId: 'models-b', payload: { sessionId: 'session-b' },
  })), { current: defaults });
  const prompt = await restarted.api.sessions.prompt({
    rpcId: 'prompt-a', payload: { sessionId: 'session-a', content: [] },
  });
  assert.deepEqual(prompt.result.ok ? prompt.result.value : undefined, {
    used: { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'high' },
  });
  assert.deepEqual(restarted.selectCalls, ['session-a']);
});

test('concurrent hydration is deduplicated and disposal restores the captured Host methods', async () => {
  const selected = { provider: 'codex', model: 'gpt-5.6-terra' };
  const store: SessionModelSelectionStore = {
    getSessionModelSelection: () => selected,
    setSessionModelSelection: () => {},
  };
  const host = fakeApi({ provider: 'codex', model: 'gpt-5.6-sol' });
  const originalSelect = host.api.sessions.selectModel;
  const originalModels = host.api.sessions.models;
  const originalPrompt = host.api.sessions.prompt;
  const dispose = installSessionModelSelectionPersistence(host.api, store);

  await Promise.all([
    host.api.sessions.models({ rpcId: 'models-1', payload: { sessionId: 'session-a' } }),
    host.api.sessions.models({ rpcId: 'models-2', payload: { sessionId: 'session-a' } }),
  ]);
  assert.deepEqual(host.selectCalls, ['session-a']);

  dispose();
  assert.equal(host.api.sessions.selectModel, originalSelect);
  assert.equal(host.api.sessions.models, originalModels);
  assert.equal(host.api.sessions.prompt, originalPrompt);
});

test('wrapper refuses an in-memory Host selector that still writes the shared default', () => {
  const host = fakeApi({ provider: 'codex', model: 'gpt-5.6-sol' });
  const defaults = { saveDefaultModelSelection: (_selection: StoredSessionModelSelection) => Promise.resolve() };
  host.api.sessions.selectModel = async request => {
    const selected = { provider: request.payload.provider, model: request.payload.model };
    await defaults.saveDefaultModelSelection(selected);
    return ok(request.rpcId, { selected });
  };
  const store: SessionModelSelectionStore = {
    getSessionModelSelection: () => null,
    setSessionModelSelection: () => {},
  };

  assert.throws(
    () => installSessionModelSelectionPersistence(host.api, store),
    /still writes the shared default/,
  );
});

test('first prompt hydrates a cold session before the Host evaluates its model', async () => {
  const selected = { provider: 'glm', model: 'glm-5.3-flash' };
  const store: SessionModelSelectionStore = {
    getSessionModelSelection: sessionId => sessionId === 'session-prompt' ? selected : null,
    setSessionModelSelection: () => {},
  };
  const host = fakeApi({ provider: 'codex', model: 'gpt-5.6-sol' });
  installSessionModelSelectionPersistence(host.api, store);

  const response = await host.api.sessions.prompt({
    rpcId: 'prompt',
    payload: { sessionId: 'session-prompt', content: [] },
  });
  assert.equal(response.result.ok, true);
  assert.deepEqual(response.result.ok ? response.result.value : undefined, { used: selected });
  assert.deepEqual(host.selectCalls, ['session-prompt']);
});

test('a durable storage failure is returned instead of claiming the switch was saved', async () => {
  const store: SessionModelSelectionStore = {
    getSessionModelSelection: () => null,
    setSessionModelSelection: () => { throw new Error('disk unavailable'); },
  };
  const host = fakeApi({ provider: 'codex', model: 'gpt-5.6-sol' });
  installSessionModelSelectionPersistence(host.api, store);

  const response = await host.api.sessions.selectModel({
    rpcId: 'select',
    payload: { sessionId: 'session-a', provider: 'codex', model: 'gpt-5.6-luna' },
  });
  assert.deepEqual(response, {
    rpcId: 'select',
    result: {
      ok: false,
      error: {
        code: 'internal',
        message: '会话模型选择无法持久化，请稍后重试。',
        details: {},
      },
    },
  });
  assert.deepEqual(host.current.get('session-a'), {
    provider: 'codex', model: 'gpt-5.6-sol',
  });
  assert.deepEqual(host.selectCalls, ['session-a', 'session-a']);
});

test('database stores the complete model selection per session', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-session-model-'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  try {
    db.init();
    db.setSessionModelSelection('session-a', {
      provider: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'max',
    });
    db.setSessionModelSelection('session-b', { provider: 'glm', model: 'glm-5.3-flash' });
    assert.deepEqual(db.getSessionModelSelection('session-a'), {
      provider: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'max',
    });
    assert.deepEqual(db.getSessionModelSelection('session-b'), {
      provider: 'glm', model: 'glm-5.3-flash',
    });

    db.setSessionModelSelection('session-a', { provider: 'codex', model: 'gpt-5.6-luna' });
    assert.deepEqual(db.getSessionModelSelection('session-a'), {
      provider: 'codex', model: 'gpt-5.6-luna',
    });
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
