import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTenantMuxLimits } from '../src/tenant-mux-limits.js';
import { deploymentGatewayEnv } from '../src/config.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('tenant limits default to active capacity and a bounded burst queue', () => {
  assert.deepEqual(resolveTenantMuxLimits({}), { maxStreams: 1024, pendingMessages: 8192, pendingBytes: 2097152 });
});

test('explicit tenant capacities reject malformed and out-of-range values', () => {
  for (const key of ['MCP_GATEWAY_MUX_MAX_STREAMS', 'MCP_GATEWAY_MUX_PENDING_MESSAGES', 'MCP_GATEWAY_MUX_PENDING_BYTES']) {
    for (const value of ['0', '-1', '1.5', '1e3', 'no', '9007199254740992']) {
      assert.throws(() => resolveTenantMuxLimits({ [key]: value }), new RegExp(key));
    }
    assert.equal(Object.values(resolveTenantMuxLimits({ [key]: '1' })).includes(1), true);
  }
});

test('deployment environment forwards tenant limits to the gateway child', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tenant-limits-'));
  try {
    const file = path.join(root, '.env');
    writeFileSync(file, 'MCP_GATEWAY_MUX_MAX_STREAMS=2048\nMCP_GATEWAY_MUX_PENDING_MESSAGES=4096\nMCP_GATEWAY_MUX_PENDING_BYTES=4194304\n');
    assert.deepEqual(resolveTenantMuxLimits(deploymentGatewayEnv(file, {})), {
      maxStreams: 2048, pendingMessages: 4096, pendingBytes: 4194304,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
