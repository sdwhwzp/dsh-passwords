/** Authenticated browser control of account-owned development services. */
import express, { type Express, type Request, type Response } from 'express';
import type { PlatformConfig } from './config.js';
import type { Database } from './db.js';
import { runTenantCommand } from './tenant-command.js';

interface Viewer { userId: number; username: string; role: 'admin' | 'user' }

/** Register inventory and explicit stop; the gateway supplies a current, unbanned identity. */
export function registerTenantServiceRoutes(app: Express, config: PlatformConfig, db: Database,
  authenticate: (req: Request, res: Response) => Viewer | null, run = runTenantCommand): void {
  const handler = (stop: boolean) => async (req: Request, res: Response) => {
    const me = authenticate(req, res);
    if (me === null) return;
    res.setHeader('Cache-Control', 'no-store');
    if (!config.tenantAgentShell?.enabled || !config.tenantAgentShell.serviceLauncher) {
      res.status(503).json({ code: 'SERVICES_UNAVAILABLE' }); return;
    }
    // JSON alone permits a same-site sibling to submit a credentialed form. Require an exact Origin for stops.
    if (stop && req.headers.origin !== `${req.protocol}://${req.get('host')}`) {
      res.status(403).json({ code: 'FORBIDDEN_CSRF' }); return;
    }
    const body: unknown = req.body;
    let target = String(me.userId);
    let name: string | undefined;
    if (stop) {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) { res.status(400).json({ code: 'INVALID' }); return; }
      const input = body as Record<string, unknown>;
      if (typeof input.name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(input.name)
        || typeof input.accountId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(input.accountId)) { res.status(400).json({ code: 'INVALID' }); return; }
      if (me.role !== 'admin' && input.accountId !== target) { res.status(403).json({ code: 'FORBIDDEN' }); return; }
      target = input.accountId; name = input.name;
    }
    try {
      const result = await run({ executable: '/usr/bin/sudo', args: ['-n', '--', config.tenantAgentShell.serviceLauncher,
        ...(me.role === 'admin' ? ['--admin'] : ['--account', String(me.userId)])],
      command: JSON.stringify(stop ? { action: 'stop', accountId: target, name } : { action: 'list' }),
      signal: AbortSignal.timeout(35000), timeoutMs: 30000, maxOutputBytes: 4 * 1024 * 1024 });
      if (result.exitCode !== 0 || result.aborted || result.timedOut || result.truncated) throw new Error('service manager failed');
      const data = JSON.parse(result.stdout);
      if (stop) {
        db.audit(me.role === 'admin' ? 'tenant_service_admin_stop' : 'tenant_service_stop', { username: me.username,
          detail: JSON.stringify({ actorId: String(me.userId), accountId: target, service: name, source: 'services-page' }) });
        res.json({ ok: true, service: data });
      } else {
        res.json({ ok: true, me: { id: String(me.userId), role: me.role, username: me.username },
          services: data.services.map((service: Record<string, unknown>) => ({ ...service,
            accountName: db.getUserById(Number(service.accountId))?.username ?? `#${service.accountId}` })) });
      }
    } catch {
      // Never return root-helper stderr, which can include private deployment paths.
      res.status(502).json({ code: 'SERVICE_OPERATION_FAILED' });
    }
  };
  app.get('/gateway/api/services', handler(false));
  app.post('/gateway/api/services/stop', express.json({ limit: '4kb' }), handler(true));
}
