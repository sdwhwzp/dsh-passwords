import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  customerModelAllowed,
  filterCustomerModelCatalogResponse,
} from '../src/model-policy.js';

const response = {
  type: 'server-response',
  rpcId: 'models-1',
  result: {
    ok: true,
    value: {
      current: { provider: 'codex', model: 'gpt-5.5' },
      groups: [
        {
          id: 'codex',
          name: 'ChatGPT (Codex)',
          models: [
            { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
            { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
            { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
            { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
            { id: 'gpt-5.5', name: 'GPT-5.5' },
          ],
        },
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },
      ],
      failures: [{ id: 'private-provider', name: 'Private', message: 'unavailable' }],
    },
  },
};

test('customer model policy allows GPT-5.6 and newer Codex routes and allows other providers', () => {
  assert.equal(customerModelAllowed('codex', 'gpt-5.6-sol'), true);
  assert.equal(customerModelAllowed('codex', 'gpt-5.6-terra'), true);
  assert.equal(customerModelAllowed('codex', 'gpt-5.6-luna'), true);
  for (const model of ['gpt-5.6', 'gpt-5.10', 'gpt-6', 'gpt-6-astra', 'gpt-6.1-test']) {
    assert.equal(customerModelAllowed('codex', model), true, model);
  }
  for (const model of ['gpt-5.5', 'gpt-5.3-codex-spark', 'gpt-5', 'gpt-4.99', 'o3', 'gpt-5.6bad', 'gpt-six-astra']) {
    assert.equal(customerModelAllowed('codex', model), false, model);
  }
  assert.equal(customerModelAllowed('deepseek-official', 'deepseek-v4'), true);
});

test('customer catalog filters Codex while retaining other providers and their failures', () => {
  const filtered = filterCustomerModelCatalogResponse(response) as typeof response;
  assert.notEqual(filtered, response);
  assert.deepEqual(
    filtered.result.value.groups.map(group => ({
      id: group.id,
      models: group.models.map(model => model.id),
    })),
    [
      { id: 'codex', models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra'] },
      { id: 'deepseek-official', models: ['deepseek-v4'] },
    ],
  );
  assert.deepEqual(filtered.result.value.failures, [{ id: 'private-provider', name: 'Private', message: 'unavailable' }]);
  assert.deepEqual(filtered.result.value.current, { provider: 'codex', model: 'gpt-5.5' });
  assert.equal(response.result.value.groups.length, 2, 'filter must not mutate the upstream object');
});

test('customer catalog passes upstream errors through and rejects malformed success bodies', () => {
  const upstreamError = { result: { ok: false, error: { code: 'internal' } } };
  assert.equal(filterCustomerModelCatalogResponse(upstreamError), upstreamError);
  assert.equal(filterCustomerModelCatalogResponse({ result: { ok: true, value: { groups: [] } } }), null);
});
