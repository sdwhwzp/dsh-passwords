/** Account-owned chat Sessions use a simplified interface and the account’s normal tools. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-tools';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import type { AuthenticatedPrincipal } from './principal.js';
import type {} from './managed-workspace.js';

const key = (id: string) => `conversation_mode:${id}`;

/** Identify a durable chat display mode; forks inherit the Host-recorded parent mode. */
export function isConversationSession(db: Database, id: string): boolean {
  return db.getSetting(key(id)) === 'chat';
}

type Conversation = { sessionId: SessionId; cwd: string };
const creations = new WeakMap<Database, Map<string, Promise<Conversation>>>();

/** Coalesce concurrent requests per account, including requests from different clients. */
export async function createConversation(ctx: Context, db: Database, principal: AuthenticatedPrincipal): Promise<Conversation> {
  let accounts = creations.get(db);
  if (accounts === undefined) { accounts = new Map(); creations.set(db, accounts); }
  const pending = accounts.get(principal.id);
  if (pending !== undefined) return pending;
  const attempt = resolveConversation(ctx, db, principal).finally(() => { accounts.delete(principal.id); });
  accounts.set(principal.id, attempt);
  return attempt;
}

/** Create only server-generated identities and claim ownership before publishing the Session. */
async function resolveConversation(ctx: Context, db: Database, principal: AuthenticatedPrincipal): Promise<Conversation> {
  const root = await ctx.managedUserWorkspace.resolve(principal);
  if (root === undefined || db.getPermissions(Number(principal.id))?.banned) throw new Error('active account required');
  const workspace = await ctx.workspaceRegistry.resolveByPath(root)
    ?? await ctx.workspaceRegistry.create(root, principal.username);
  const { items } = await ctx.sessionController.list({}, new AbortController().signal);
  const reusable = items.find(session => {
    const values = session.projections?.values;
    if (values === undefined) return false;
    const inbox = values.inbox;
    return session.blank && !session.running && session.cwd === root
      && db.getSessionOwner(session.sessionId) === Number(principal.id)
      && isConversationSession(db, session.sessionId)
      && !ctx.workspaceRegistry.archivedSessionIds.includes(session.sessionId)
      && !values.title && !values.subagent && (values.subagentCatalog === undefined || (Array.isArray(values.subagentCatalog) && values.subagentCatalog.length === 0))
      && (!inbox || Object.values(inbox).every(queue => queue.length === 0));
  });
  if (reusable !== undefined) return { sessionId: reusable.sessionId, cwd: root };
  const sessionId = `session-${randomUUID()}` as SessionId;
  db.claimSessionOwner(sessionId, Number(principal.id));
  db.setSetting(key(sessionId), 'chat');
  // Keep ownership and display mode when creation partially persists.
  await ctx.sessionController.create({ sessionId, workspaceId: workspace.id });
  return { sessionId, cwd: root };
}

/** Restore chat presentation and inherit it on forks without changing tool permissions. */
export function registerConversationMode(ctx: Context, db: Database): void {
  ctx.on('agent/created', ({ agent }): undefined => {
    if (!isConversationSession(db, agent.session.id) && !(agent.session.header.parentSession !== undefined
      && isConversationSession(db, agent.session.header.parentSession))) return undefined;
    db.setSetting(key(agent.session.id), 'chat');
    agent.ctx.systemPrompt.section({ name: 'conversation-mode', order: 1000,
      text: 'This Session uses a simplified chat interface. Use any available tools when useful, subject to the authenticated account permissions and workspace sandbox. The account workspace is attached automatically. For structured visual answers, use a dsh-ui fenced block, never a json block with a separate dsh-ui label. If UI rendering fails, use validate_dsh_ui when available to diagnose and repair it. Grid columns use cols; card bodies use items containing text nodes.',
    });
    return undefined;
  });
}
