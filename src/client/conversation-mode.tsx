/** Chat/development navigation uses the existing Session renderer and its live stream. */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { DshPasswordsClient } from './dsh-passwords-client';

export interface ConversationModeProps {
  sessions: Context['sessions'];
  /** Session navigation: alpha.2 keeps the main selection inside ui-workspace, not the Session Controller. */
  uiWorkspace: Pick<Context['uiWorkspace'], 'openSession' | 'startSession'>;
  layout: Context['layout'];
  client: DshPasswordsClient;
  t: PropsLocale<'dshpw'>['t'];
}

/** The Session shown in the main view: the one row the ui-workspace main view retains. */
function currentSessionOf(state: SessionListState): SessionId | undefined {
  for (const [id, summary] of Object.entries(state.byId)) {
    if ((summary.retainedBy.mainView ?? 0) > 0) return id as SessionId;
  }
  return undefined;
}

/** A server-owned mode follows the selected Session; switching modes never changes an existing Session's privileges. */
export function ConversationModeControls({ sessions, uiWorkspace, layout, client, t }: ConversationModeProps) {
  const state = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot);
  const current = currentSessionOf(state);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const [error, setError] = useState('');
  const rootIds = state.ids.filter(id => ids.includes(id) && state.byId[id] !== undefined && state.byId[id]!.origin !== 'subagent');
  const chat = current !== undefined && ids.includes(current);
  useEffect(() => {
    let active = true;
    void client.conversations().then(result => {
      if (!active) return;
      if (result.ok) setIds(result.value.sessionIds);
      else setError(result.error.message);
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [client, current, state.phase]);
  useEffect(() => {
    if (!chat) return;
    document.documentElement.dataset.dshpwConversationMode = 'chat';
    layout.closeRightbar();
    return () => { delete document.documentElement.dataset.dshpwConversationMode; };
  }, [chat, layout]);

  useEffect(() => {
    if (!chat || current === undefined || state.byId[current]?.origin !== 'subagent' || sessions.subagentAddress(current) !== undefined) return;
    // Legacy chat links carry no parent address; never resume them as root agents.
    const root = rootIds[0];
    if (root === undefined) leaveChat();
    else uiWorkspace.openSession(root);
  }, [chat, current, state, ids, sessions, uiWorkspace]);

  /**
   * Leave the chat Session. alpha.2 has no public "no Session selected" state,
   * so development mode shows the most recent development Session, or a new
   * one in the chat directory when the account has none yet.
   */
  function leaveChat() {
    const development = state.ids
      .filter(id => !ids.includes(id) && state.byId[id] !== undefined && state.byId[id]!.origin !== 'subagent')
      .sort((left, right) => state.byId[right]!.updatedAt - state.byId[left]!.updatedAt)[0];
    if (development !== undefined) { uiWorkspace.openSession(development); return; }
    const cwd = current === undefined ? undefined : state.byId[current]?.cwd;
    if (cwd === undefined) { uiWorkspace.startSession(); return; }
    void sessions.create({ cwd }).then(id => { uiWorkspace.openSession(id); })
      .catch(reason => { setError(reason instanceof Error ? reason.message : String(reason)); });
  }

  async function create() {
    if (creating.current) return;
    const blank = rootIds.find(id => state.byId[id]?.blank);
    if (blank !== undefined) { uiWorkspace.openSession(blank); return; }
    creating.current = true;
    setBusy(true); setError('');
    try {
      const result = await client.createConversation();
      if (!result.ok) throw new Error(result.error.message);
      setIds(previous => [...new Set([...previous, result.value.sessionId])]);
      await sessions.create({ sessionId: result.value.sessionId as SessionId, cwd: result.value.cwd });
      uiWorkspace.openSession(result.value.sessionId as SessionId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { creating.current = false; setBusy(false); }
  }
  function development() {
    if (chat) leaveChat();
    else layout.selectPanel(null);
  }
  function openChat() {
    const existing = rootIds[0];
    if (existing === undefined) void create();
    else uiWorkspace.openSession(existing);
  }
  return <div data-dshpw-conversation-modes="" className="dshpw-modes">
    <div className="dshpw-mode-switch" role="group" aria-label={t('conversationModes')}>
      <button type="button" aria-pressed={!chat} disabled={busy} onClick={development}>{t('developmentMode')}</button>
      <button type="button" aria-pressed={chat} disabled={busy} onClick={openChat}>{t('conversationMode')}</button>
    </div>
    {chat && <>
      <style>{`html[data-dshpw-conversation-mode=chat] [data-composer-placeholder]{font-size:0}html[data-dshpw-conversation-mode=chat] [data-composer-placeholder]::after{content:${JSON.stringify(t('conversationPlaceholder'))};font-size:14px}`}</style>
      <button type="button" disabled={busy} onClick={() => { void create(); }}>{busy ? t('conversationCreating') : t('conversationNew')}</button>
      <p>{t('conversationModeHint')}</p>
      <nav aria-label={t('conversationHistory')} className="dshpw-mode-history">
        {rootIds.filter(id => id === current || state.byId[id]!.blank === false).map(id => <button type="button" key={id} aria-current={id === current ? 'page' : undefined}
          onClick={() => { uiWorkspace.openSession(id); }}>{state.byId[id]?.title || t('conversationUntitled')}</button>)}
      </nav>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

/** Chat presentation leaves tool-generated panels available; account permissions remain server-owned. */
export const CONVERSATION_MODE_CSS = `
.dshpw-modes{display:flex;flex-direction:column;gap:8px;min-width:0;width:100%;padding:4px;box-sizing:border-box}
.dshpw-mode-switch{display:flex;gap:4px}
.dshpw-modes button{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.dshpw-mode-switch button{flex:1;text-align:center}
.dshpw-modes button[aria-pressed=true],.dshpw-modes button[aria-current=page]{background:var(--dsw-alias-interactive-bg-hover)}
.dshpw-modes button:disabled{opacity:.5;cursor:wait}
.dshpw-modes p{font-size:12px;margin:0;color:var(--dsw-alias-label-secondary)}
.dshpw-mode-history{display:flex;flex-direction:column;gap:4px;overflow:auto;max-height:60vh}
.dshpw-mode-history button{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
html[data-dshpw-conversation-mode=chat] [data-slot="sidebar.workspaces.action"] > :not([data-dshpw-conversation-modes]),
html[data-dshpw-conversation-mode=chat] [class*="workspaceActions"] ~ *,
html[data-dshpw-conversation-mode=chat] [data-slot="sidebar"] button[class*="_newSession"],
html[data-dshpw-conversation-mode=chat] [data-slot="sidebar"] button[class*="_brand"],
html[data-dshpw-conversation-mode=chat] [data-slot="conversation.session.header"],
html[data-dshpw-conversation-mode=chat] [data-slot="conversation.composer.bar"] button[class*="_add"],
html[data-dshpw-conversation-mode=chat] [data-slot="conversation.composer.bar"] [class*="_modes"],
html[data-dshpw-conversation-mode=chat] [data-conversation-header-corner],
html[data-dshpw-conversation-mode=chat] [data-dsh-better-sidebar],
html[data-dshpw-conversation-mode=chat] [class*="heroWorkspaceRow"]{display:none!important}
`;
