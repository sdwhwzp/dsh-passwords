/** Browser service control uses the current account and requires same-origin JSON stops. */
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Database } from '../src/db.js';
import type { PlatformConfig } from '../src/config.js';
import { registerTenantServiceRoutes } from '../src/tenant-service-routes.js';
import type { TenantCommandRequest } from '../src/tenant-command.js';

test('service inventory and stop enforce owner, administrator, origin and audit attribution', async t => {
  const app = express(); const calls: TenantCommandRequest[] = []; const audits: unknown[] = [];
  let identity: { userId: number; username: string; role: 'user' | 'admin' } | null = { userId: 2, username: 'owner', role: 'user' };
  const config = { tenantAgentShell: { enabled: true, serviceLauncher: '/trusted/service' } } as PlatformConfig;
  const db = { getUserById: () => ({ username: 'owner' }), audit: (...args: unknown[]) => audits.push(args) } as unknown as Database;
  registerTenantServiceRoutes(app, config, db, (_req, res) => { if (!identity) res.sendStatus(401); return identity; }, async request => {
    calls.push(request);
    return { stdout: JSON.stringify({ services: [{ accountId: '2', name: 'app' }] }), stderr: '', exitCode: 0, truncated: false, signal: null, timedOut: false, aborted: false };
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = (body: unknown, source = origin) => fetch(origin + '/gateway/api/services/stop', { method: 'POST', headers: { 'content-type': 'application/json', origin: source }, body: JSON.stringify(body) });
  const list = await fetch(origin + '/gateway/api/services?accountId=9');
  assert.equal(list.status, 200); assert.equal((await list.json()).services[0].accountName, 'owner');
  assert.deepEqual(calls[0].args.slice(-2), ['--account', '2']);
  assert.equal((await stop({ accountId: '9', name: 'app' })).status, 403);
  assert.equal((await stop({ accountId: '2', name: '../escape' })).status, 400);
  assert.equal((await stop({ accountId: '2', name: 'app' }, 'http://sibling.invalid')).status, 403);
  assert.equal((await stop({ accountId: '2', name: 'app' }, '')).status, 403);
  assert.equal(calls.length, 1);
  assert.equal((await stop({ accountId: '2', name: 'app' })).status, 200);
  assert.match(JSON.stringify(audits), /tenant_service_stop/);
  identity = { userId: 1, username: 'admin', role: 'admin' };
  assert.equal((await stop({ accountId: '2', name: 'app' })).status, 200);
  assert.equal(calls.at(-1)!.args.at(-1), '--admin');
  assert.match(JSON.stringify(audits), /tenant_service_admin_stop/);
  identity = { userId: 1, username: 'admin', role: 'user' };
  assert.equal((await stop({ accountId: '2', name: 'app' })).status, 403);
  identity = null; assert.equal((await fetch(origin + '/gateway/api/services')).status, 401);
  assert.equal((await stop({ accountId: '2', name: 'app' })).status, 401);
});
