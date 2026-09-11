/** Persistent development services in an authenticated server workspace. */
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { TenantCommandResult } from './tenant-command.js';

export interface TenantServiceRequest {
  action: 'start' | 'status' | 'logs' | 'stop' | 'list';
  name?: string;
  command?: string;
  port?: number;
  expose?: boolean;
}

/** Register the model-facing lifecycle; the caller supplies account and path authorization. */
export function tenantServiceTool(run: (request: TenantServiceRequest, execution: ToolRunContext) => Promise<TenantCommandResult>): ToolDefinition {
  return defineTool({
    name: 'dev_server',
    description: 'Manage persistent development servers in this account’s current project. Services survive bash calls, chat completion, Agent disposal and Harness restarts; systemd restarts exited services and starts them after host reboot. Use start for user-requested test environments, then status and logs to verify readiness. Start does not replace an enabled service. Stop only when the user asks to stop that environment. Use list to recover service names in later conversations. Public access requires expose=true and a separately configured network port mapping.',
    parameters: {
      action: { type: 'string', enum: ['start', 'status', 'logs', 'stop', 'list'], required: true },
      name: { type: 'string', description: 'Stable project service name, lowercase letters, numbers and hyphens, up to 48 characters. Required except for list.' },
      command: { type: 'string', description: 'Required for start. A foreground Bash command in the current project. Explicitly load tools from personal HOME and bind the requested port; never use nohup, setsid or a trailing &.' },
      port: { type: 'integer', description: 'Required for start. Listening TCP port from 1024 to 65535, excluding deployment-reserved ports.' },
      expose: { type: 'boolean', description: 'For start, permit replies to LAN/public clients on this port. Defaults to false; enable only for requested network access. Configure the application’s bind address and allowed hosts in command.' },
    },
    timeoutMs: 35000,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        stdout: { type: 'string', required: true }, stderr: { type: 'string', required: true },
        exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
        signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        truncated: { type: 'boolean', required: true }, timedOut: { type: 'boolean', required: true }, aborted: { type: 'boolean', required: true },
      } },
      render: (_args, result) => [{ type: 'text', text: [result.stdout, result.stderr,
        result.timedOut || result.aborted ? 'Management request interrupted; use status to determine service state.' : '',
        `[exit code: ${String(result.exitCode)}]`,
      ].filter(Boolean).join('\n') }],
    },
    execute: async (args, execution) => {
      if (args.action !== 'list' && (args.name === undefined || !/^[a-z][a-z0-9-]{0,47}$/.test(args.name))) throw new Error('invalid service name');
      if (args.action === 'start' && (args.command === undefined || args.command.trim() === '' || Buffer.byteLength(args.command) > 32768
        || args.port === undefined || !Number.isSafeInteger(args.port) || args.port < 1024 || args.port > 65535)) throw new Error('start requires a foreground command and valid port');
      return run(args, execution);
    },
    presentCall: args => ({ card: 'terminal', title: `dev_server ${args.action}${args.name === undefined ? '' : ' ' + args.name}` }),
    presentResult: (_args, result) => {
      const first = result.content[0];
      return !result.isError && first?.type === 'text' ? { card: 'terminal', output: first.text } : undefined;
    },
  });
}
