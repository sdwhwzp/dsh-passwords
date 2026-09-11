/** Administrator control of child-account development service lifetimes. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { PlatformConfig } from './config.js';
import type { Database } from './db.js';
import { AgentTurnPrincipalTracker } from './principal.js';
import { DshPasswordsPrincipalAccessProvider } from './principal-access.js';
import { runTenantCommand } from './tenant-command.js';

/** Build a control tool whose execution always revalidates the administrator. */
export function tenantServiceAdminTool(ctx: Context, agent: Agent, db: Database, config: PlatformConfig, run = runTenantCommand): ToolDefinition {
  const access = new DshPasswordsPrincipalAccessProvider(ctx, db);
  return defineTool({
    name: 'dev_server_admin',
    description: 'Administrator-only: list account development services, inspect status, or stop a specified account service when the administrator requests it. Stop also disables restart after host reboot. This tool does not start services or disclose their command text or application logs.',
    parameters: {
      action: { type: 'string', enum: ['list', 'status', 'stop'], required: true },
      accountId: { type: 'string', description: 'Account id from list, required for status and stop.' },
      name: { type: 'string', description: 'Exact service name from list, required for status and stop.' },
    },
    timeoutMs: 35000,
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    execute: async (args, execution) => {
      execution.signal.throwIfAborted();
      if (execution.agent !== agent || execution.principal?.role !== 'admin') throw new Error('authenticated administrator required');
      access.assertAuthenticated(execution.principal);
      if (args.action !== 'list' && (args.accountId === undefined || !/^[1-9][0-9]{0,15}$/.test(args.accountId)
        || args.name === undefined || !/^[a-z][a-z0-9-]{0,47}$/.test(args.name))) throw new Error('account id and service name required');
      const result = await run({ executable: '/usr/bin/sudo', args: ['-n', '--', config.tenantAgentShell!.serviceLauncher!, '--admin'],
        command: JSON.stringify(args), signal: execution.signal, timeoutMs: 30000, maxOutputBytes: config.tenantAgentShell!.maxOutputBytes });
      if (result.exitCode !== 0 || result.aborted || result.timedOut) throw new Error(result.stderr || 'service management interrupted; inspect status');
      if (args.action === 'stop') db.audit('tenant_service_admin_stop', { username: execution.principal.username,
        detail: JSON.stringify({ administrator: execution.principal.id, accountId: args.accountId, service: args.name }) });
      return result.stdout;
    },
    presentCall: args => ({ card: 'terminal', title: `dev_server_admin ${args.action}${args.accountId === undefined ? '' : ' u' + args.accountId}${args.name === undefined ? '' : ' ' + args.name}` }),
    presentResult: (_args, result) => {
      const first = result.content[0];
      return !result.isError && first?.type === 'text' ? { card: 'terminal', output: first.text } : undefined;
    },
  });
}

/** Expose administration only after a verified administrator begins an Agent step. */
export function registerTenantServiceAdministration(ctx: Context, db: Database, config: PlatformConfig): void {
  if (!config.tenantAgentShell?.enabled || !config.tenantAgentShell.serviceLauncher) return;
  const tracker = new AgentTurnPrincipalTracker();
  const installed = new WeakSet<Agent>();
  const access = new DshPasswordsPrincipalAccessProvider(ctx, db);
  ctx.on('agent/pre-step', (payload, next) => {
    const principal = tracker.resolve(payload);
    if (principal?.role === 'admin' && !installed.has(payload.agent)) {
      access.assertAuthenticated(principal);
      payload.agent.ctx.tools.register(tenantServiceAdminTool(ctx, payload.agent, db, config));
      installed.add(payload.agent);
    }
    return next();
  });
}
