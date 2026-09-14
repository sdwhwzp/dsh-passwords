/** Account-owned chat Sessions retain history without exposing development tools. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-tools';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import type { AuthenticatedPrincipal } from './principal.js';
import type {} from './managed-workspace.js';

/** Audited knowledge retrieval tools; new tools require an explicit policy change. */
const CONVERSATION_TOOLS = new Set([
  'weknora_search', 'weknora_read_document', 'weknora_list_knowledge_bases', 'weknora_ask',
]);
const key = (id: string) => `conversation_mode:${id}`;

/** Identify a durable chat Session; new forks inherit only a Host-recorded parent mode. */
export function isConversationSession(db: Database, id: string): boolean {
  return db.getSetting(key(id)) === 'chat';
}

/** Create only server-generated identities and claim ownership before publishing the Session. */
export async function createConversation(ctx: Context, db: Database, principal: AuthenticatedPrincipal): Promise<{ sessionId: SessionId }> {
  const root = await ctx.managedUserWorkspace.resolve(principal);
  if (root === undefined || db.getPermissions(Number(principal.id))?.banned) throw new Error('active account required');
  const workspace = await ctx.workspaceRegistry.resolveByPath(root)
    ?? await ctx.workspaceRegistry.create(root, principal.username);
  const sessionId = `session-${randomUUID()}` as SessionId;
  db.claimSessionOwner(sessionId, Number(principal.id));
  db.setSetting(key(sessionId), 'chat');
  // Keep the mode on a failed create: a partially persisted Session must never resume with development privileges.
  await ctx.sessionController.create({ sessionId, workspaceId: workspace.id });
  return { sessionId };
}

/** Install per-Agent restrictions on creation and restoration; development Sessions are unchanged. */
export function registerConversationMode(ctx: Context, db: Database): void {
  const chatAgents = new WeakSet<object>();
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next();
    if (context.scope === undefined || !chatAgents.has(context.scope)) return result;
    return { ...result, tools: result.tools.filter(tool => CONVERSATION_TOOLS.has(tool.name)) };
  });
  ctx.on('agent/created', ({ agent }) => {
    if (!isConversationSession(db, agent.session.id) && !(agent.session.header.parentSession !== undefined
      && isConversationSession(db, agent.session.header.parentSession))) return;
    chatAgents.add(agent);
    db.setSetting(key(agent.session.id), 'chat');
    const tools = agent.ctx.tools;
    tools.presentAs('native');
    tools.restrict({ allow: [...CONVERSATION_TOOLS].filter(name => tools.get(name) !== undefined) });
    tools.guard(exec => CONVERSATION_TOOLS.has(exec.name) ? undefined : 'CONVERSATION_MODE_TOOL_DENIED: development and code execution tools are unavailable in chat mode');
    agent.ctx.systemPrompt.section({ name: 'conversation-mode', order: 1000,
      text: 'This is a conversation-only Session. Answer questions and use the available knowledge retrieval tools when useful. No project workspace, local file access, terminal, code execution, or delegated development is available. Do not claim to have performed those actions. Ask the user to open a separate development Session when they need code changes.',
    });
  });
}
