/** Agent bash commands confined to the authenticated account's managed workspace. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import path from 'node:path';
import type { PlatformConfig } from './config.js';
import type { Database } from './db.js';
import { DshPasswordsPrincipalAccessProvider } from './principal-access.js';
import { tenantDirectory } from './tenant-terminal.js';
import { runTenantCommand, type TenantCommandRequest, type TenantCommandResult } from './tenant-command.js';
import { tenantServiceTool, type TenantServiceRequest } from './tenant-service-tool.js';

/** The shared Harness policy service is resolved at execution, after profile composition. */
interface SandboxPolicy {
  resolve(request: { session: Agent['session'] }): { mode: string };
}

/** Owns account concurrency and aborts all command processes when disposed. */
export class TenantAgentShell {
  private readonly active = new Set<{ owner: number; agent: Agent; controller: AbortController; done: Promise<TenantCommandResult> }>();
  private disposed = false;
  private readonly access: DshPasswordsPrincipalAccessProvider;

  constructor(
    private readonly ctx: Context,
    private readonly db: Database,
    private readonly config: PlatformConfig,
    private readonly run: (request: TenantCommandRequest) => Promise<TenantCommandResult> = runTenantCommand,
  ) { this.access = new DshPasswordsPrincipalAccessProvider(ctx, db); }

  /** Register only in managed server workspaces; paired computers keep their own bash provider. */
  install(agent: Agent): void {
    if (this.disposed) return;
    const cwd = agent.session.header.cwd;
    if (cwd === undefined || this.db.localWorkspaceOwnerForPath(cwd) !== null) return;
    const owner = this.db.managedWorkspaceOwnerForPath(cwd);
    if (owner === null || this.db.getUserListRowById(owner)?.role !== 'user') return;
    const lifetime = new AbortController();
    agent.ctx.tools.register(this.tool(agent, owner, lifetime.signal));
    if (this.config.tenantAgentShell?.serviceLauncher) {
      agent.ctx.tools.register(tenantServiceTool((request, exec) => this.execute(agent, owner, { command: '' }, exec, lifetime.signal, request)));
      agent.ctx.systemPrompt.section({ name: 'tenant-persistent-services', order: 96,
        text: 'For a user-requested running test environment, use dev_server start with a foreground command, then inspect status and logs and verify the requested URL. Keep the service enabled after your reply; stop it only when the user explicitly asks. Bash background jobs are temporary and cannot substitute for dev_server. Use dev_server list in later conversations to find existing services. Do not claim network reachability from a listening port alone; test the requested URL. An enabled service survives Agent and Harness restarts and host reboot.',
      });
    }
    agent.ctx.systemPrompt.section({
      name: 'tenant-workspace-shell', order: 95,
      text: 'The bash tool executes commands in this account’s server workspace sandbox. The account root is /workspace; its persistent personal HOME is /home/dsh, shared with the web terminal and editor. Use relative workdir paths or /workspace paths. Install development tools in HOME (for example ~/.local/bin); sudo and host-wide installation are unavailable. Each call starts a fresh shell; files persist, shell variables and background processes do not. Explicitly load a version manager when needed. Cancellation and timeout stop the command. Inspect the command result before reporting an installation as completed.',
    });
    agent.ctx.effect(() => async () => { lifetime.abort(); await this.stop(agent); }, 'dsh-passwords: agent shell cleanup');
  }

  /** Stop accepting commands and await all owned processes. */
  async dispose(): Promise<void> { this.disposed = true; await this.stop(); }

  private async stop(agent?: Agent): Promise<void> {
    const selected = [...this.active].filter(item => agent === undefined || item.agent === agent);
    for (const item of selected) item.controller.abort();
    await Promise.allSettled(selected.map(item => item.done));
  }

  private tool(agent: Agent, owner: number, lifetime: AbortSignal): ToolDefinition {
    const settings = this.config.tenantAgentShell!;
    return defineTool({
      name: 'bash',
      description: 'Execute a command in the current account’s server workspace sandbox and return stdout, stderr and exit status. Each call uses a fresh shell; the account workspace and HOME persist. Install user-level tools in HOME. Host files, other accounts, sudo and detached background jobs are unavailable.',
      parameters: {
        command: { type: 'string', required: true, description: 'Bash command to run.' },
        description: { type: 'string', required: true, description: 'Short purpose shown beside the command.' },
        workdir: { type: 'string', description: 'Directory relative to this session, a /workspace path, or an owned server path.' },
        timeoutMs: { type: 'integer', description: `Command deadline in milliseconds, from 1 to ${settings.maxTimeoutMs}.` },
      },
      timeoutMs: settings.maxTimeoutMs + 5000,
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          stdout: { type: 'string', required: true }, stderr: { type: 'string', required: true }, truncated: { type: 'boolean', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true }, aborted: { type: 'boolean', required: true },
        } },
        render: (_args, result) => [{ type: 'text', text: [
          result.stdout, result.stderr, result.truncated ? '[output truncated]' : '',
          result.timedOut ? '[timed out]' : '', result.aborted ? '[aborted]' : '',
          result.signal === null ? `[exit code: ${String(result.exitCode)}]` : `[signal: ${result.signal}]`,
        ].filter(Boolean).join('\n') }],
      },
      execute: async (args, exec) => {
        if (args.command.trim() === '' || args.description.trim() === '') throw new Error('command and description must not be empty');
        if (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > settings.maxTimeoutMs)) throw new Error('invalid command timeout');
        return this.execute(agent, owner, args, exec, lifetime);
      },
      presentCall: args => ({ card: 'terminal', title: args.command, description: args.description, ...(args.workdir === undefined ? {} : { cwd: args.workdir }) }),
      presentResult: (_args, result) => {
        const block = result.content[0];
        return !result.isError && block?.type === 'text' ? { card: 'terminal', output: block.text } : undefined;
      },
    });
  }

  private async execute(
    agent: Agent, owner: number,
    args: { command: string; workdir?: string; timeoutMs?: number }, exec: ToolRunContext, lifetime: AbortSignal, service?: TenantServiceRequest,
  ): Promise<TenantCommandResult> {
    exec.signal.throwIfAborted();
    if (this.disposed || exec.agent !== agent) throw new Error('agent shell is unavailable');
    const principal = exec.principal;
    if (principal === undefined || principal.role !== 'user' || principal.id !== String(owner)) throw new Error('workspace account access denied');
    this.access.assertAuthenticated(principal);
    const permissions = this.db.getPermissions(owner);
    const sessionOwner = this.db.getSessionOwner(agent.session.id);
    if ((sessionOwner !== null && sessionOwner !== owner) || permissions?.disabled_sessions.includes(agent.session.id)) throw new Error('session access denied');
    const policy = this.ctx.root.get('sandboxPolicy') as SandboxPolicy | undefined;
    if (policy === undefined) throw new Error('workspace sandbox policy is unavailable');
    if (permissions?.sandbox_mode === 'read-only' || policy.resolve({ session: agent.session }).mode === 'read-only') throw new Error('workspace shell requires write permission');
    const root = path.join(this.config.managedWorkspaceRoot, `u${owner}`);
    const sessionCwd = await tenantDirectory(this.config.managedWorkspaceRoot, principal.id, agent.session.header.cwd!);
    if (this.db.managedWorkspaceOwnerForPath(sessionCwd) !== owner) throw new Error('workspace ownership changed');
    const requested = args.workdir === undefined ? sessionCwd
      : args.workdir === '/workspace' || args.workdir.startsWith('/workspace/')
        ? root + args.workdir.slice('/workspace'.length)
        : path.isAbsolute(args.workdir) ? args.workdir : sessionCwd + path.sep + args.workdir;
    const cwd = await tenantDirectory(this.config.managedWorkspaceRoot, principal.id, requested);
    const relative = path.relative(sessionCwd, cwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('workdir must remain inside the session workspace');
    exec.signal.throwIfAborted();
    lifetime.throwIfAborted();
    if (this.disposed) throw new Error('agent shell is unavailable');
    this.access.assertAuthenticated(principal);
    const current = this.db.getPermissions(owner);
    if (current?.disabled_sessions.includes(agent.session.id) || current?.sandbox_mode === 'read-only' || policy.resolve({ session: agent.session }).mode === 'read-only') throw new Error('workspace command permission changed');
    if ([...this.active].filter(item => item.owner === owner).length >= this.config.tenantTerminal!.maxPerUser) throw new Error('account command limit reached');
    const controller = new AbortController();
    const signal = AbortSignal.any([exec.signal, lifetime, controller.signal]);
    const settings = this.config.tenantAgentShell!;
    const done = this.run({
      executable: '/usr/bin/sudo', args: service === undefined
        ? ['-n', '--', this.config.tenantTerminal!.launcher, principal.id, sessionCwd, principal.username, '--command']
        : ['-n', '--', settings.serviceLauncher!, principal.id, sessionCwd, principal.username],
      command: service === undefined ? `cd -- '${('/workspace' + cwd.slice(root.length)).replaceAll("'", "'\\''")}' || exit\n${args.command}` : JSON.stringify(service),
      timeoutMs: service === undefined ? args.timeoutMs ?? settings.timeoutMs : 30000,
      maxOutputBytes: settings.maxOutputBytes, signal,
    });
    const active = { owner, agent, controller, done };
    this.active.add(active);
    try { return await done; } finally { this.active.delete(active); }
  }
}

/** Enable the agent adapter only with an explicitly configured Linux tenant launcher. */
export function registerTenantAgentShell(ctx: Context, db: Database, config: PlatformConfig): void {
  if (!config.tenantAgentShell?.enabled) return;
  if (process.platform !== 'linux' || !config.tenantTerminal?.launcher || !path.isAbsolute(config.tenantTerminal.launcher)) {
    throw new Error('tenant agent shell requires a Linux tenant terminal launcher');
  }
  const shell = new TenantAgentShell(ctx, db, config);
  ctx.on('agent/created', ({ agent }) => shell.install(agent));
  ctx.effect(() => () => shell.dispose(), 'dsh-passwords: tenant agent shell');
}
