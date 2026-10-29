/** Authorize assembled attachment history before the LLM runtime projects or reads it. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type { AttachmentId } from '@deepseek-ai/dsh-attachment';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { attachmentGrantDenied, attachmentGrantKey } from './attachment-grants.js';
import { authenticatedPrincipal, type AuthenticatedPrincipal } from './principal.js';
import type { DshPasswordsPrincipalAccessProvider } from './principal-access.js';

interface ExecutionIdentity {
  readonly sessionId: string;
  readonly principal?: AuthenticatedPrincipal;
}

/** Collect every structured image/file, regardless of role or offload status. */
function attachmentIds(options: GenerateOptions): AttachmentId[] {
  const ids = new Set<AttachmentId>();
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type !== 'image' && block.type !== 'file') continue;
      const id = block.attachment?.attachmentId;
      attachmentGrantKey(id);
      ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Bind identity only from a trusted active Agent request, never from historical
 * messages, broad roles or a process-global current user. Unknown auxiliary
 * calls carrying attachments fail closed; text-only calls need no grant.
 */
export function registerAttachmentReplayGuard(
  ctx: Context,
  provider: DshPasswordsPrincipalAccessProvider,
): void {
  const executions = new WeakMap<AbortSignal, ExecutionIdentity>();
  const bind = (payload: { agent: { id: string }; signal: AbortSignal; principal?: unknown }) => {
    const principal = authenticatedPrincipal(payload.principal);
    executions.set(payload.signal, {
      sessionId: payload.agent.id,
      ...(principal === undefined ? {} : { principal: Object.freeze({ ...principal }) }),
    });
  };
  // Compaction can call the LLM from pre-step before agent/request is reached.
  ctx.on('agent/pre-step', (payload, next) => {
    bind(payload);
    return next();
  }, { global: true, prepend: true });
  ctx.on('agent/request', (payload, next) => {
    bind(payload);
    return next();
  }, { global: true, prepend: true });
  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    // Capture when the stream is constructed, not after another step can replace
    // its signal binding while this generator awaits its first iteration.
    const execution = options.signal === undefined ? undefined : executions.get(options.signal);
    return (async function* () {
      options.signal?.throwIfAborted();
      const requested = attachmentIds(options);
      if (requested.length > 0) {
        if (execution?.principal === undefined || execution.sessionId !== options.sessionId) {
          throw attachmentGrantDenied();
        }
        const access = await provider.resolve(execution.principal, { attachmentIds: requested }, options.signal);
        options.signal?.throwIfAborted();
        try { provider.assertAuthenticated(execution.principal); } catch { throw attachmentGrantDenied(); }
        if (requested.some(id => access.readableAttachmentIds?.has(id) !== true)) throw attachmentGrantDenied();
        // Trusted callers normally pass deeply frozen loop requests. Refuse a
        // mutable caller that changed its attachment identities during the await.
        const current = attachmentIds(options);
        if (current.length !== requested.length || current.some(id => !requested.includes(id))) throw attachmentGrantDenied();
      }
      yield* next();
    })();
  }, { global: true, prepend: true });
}
