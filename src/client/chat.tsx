// dsh-passwords 全局聊天入口：注入 dsh 主界面 `shell.overlay` 槽（root 作用域，
// 帧级悬浮层，叠加在所有列之上）。
//   - 左下角圆形聊天按钮 + 右上角红色未读角标
//   - 点击弹出居中面板（四周等距留白），外层黑色雾化 + 淡入淡出动画
//   - 右上角 X 关闭；面板配色跟随 dsh 设计令牌（--dsw-alias-*）
// 数据面：/gateway/api/messages（列表/发送）。实时采用轮询（4 秒），不依赖 SSE。
import { useEffect, useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

interface ChatMessage {
  id: number;
  sender_id: number;
  sender_name: string;
  recipient_id: number | null;
  content: string;
  tags: string[];
  created_at: string;
}

interface Me {
  id: number;
  username: string;
  role: 'admin' | 'user';
}

const PRESET_TAGS = ['issue', 'pr', 'discussion', 'announcement', 'question'] as const;
const POLL_MS = 4000;

// ── 聊天入口悬浮钮：中键拖动可移动（left/top 定位，localStorage 持久化）──
const FAB_SIZE = 36;
const FAB_DEFAULT_BOTTOM = 116; // 原 CSS 默认 bottom
const FAB_STORAGE_KEY = 'dshpw_fab_pos';

function defaultFabPos(): { left: number; top: number } {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  return { left: 14, top: Math.max(0, vh - FAB_SIZE - FAB_DEFAULT_BOTTOM) };
}

/** 标签显示：canonical key 走 i18n，旧标签兼容映射，未知标签原样回退 */
function tagDisplay(tag: string, tr: (key: string) => string): string {
  const legacy: Record<string, string> = { 讨论: 'discussion', 公告: 'announcement', 问题: 'question', PR: 'pr' };
  const key = legacy[tag] ?? tag;
  const localized = tr(`tag.${key}`);
  return localized === `tag.${key}` ? tag : localized;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 合并新消息：去重、按 id 升序、保留最近 200 条。
 *  无新 id 时返回原引用——每 4 秒轮询返回空时若重建数组，
 *  会触发 [messages] 滚动 effect 把用户硬拽回底部（必现缺陷）。 */
export function mergeById(prev: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return prev;
  const known = new Set(prev.map((m) => m.id));
  let hasNew = false;
  for (const m of incoming) {
    if (!known.has(m.id)) {
      hasNew = true;
      break;
    }
  }
  if (!hasNew) return prev; // 无新消息：保持原引用，滚动 effect 不触发
  const map = new Map<number, ChatMessage>();
  for (const m of prev) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort((a, b) => a.id - b.id).slice(-200);
}

/** 聊天入口 + 面板（挂在 shell.overlay 槽） */
export function ChatLauncher(props: PropsLocale<'dshpw'>) {
  const t = props.t;
  // tagDisplay 需要 (key: string) => string，而 dshpw 词典 t 是受限 key 联合类型：
  // 包一层宽松签名适配器（运行时不变）
  const tr = (key: string) => t(key as never);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unread, setUnread] = useState(0);
  const [shaking, setShaking] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastSeenId = useRef(0);
  const openRef = useRef(false);
  const initializedRef = useRef(false);
  // 用户是否停留在列表底部（只有贴着底部时才自动滚动，向上翻历史时不被 4s 轮询拽回）
  const atBottomRef = useRef(true);
  // 关闭动画的 180ms 定时器：重开面板时取消，避免“开了又被强制关”
  const closeTimerRef = useRef<number | null>(null);

  // ── 中键拖动 FAB：位置 state + ref（拖动用 ref 避免重挂监听器）──
  const fabPosRef = useRef(defaultFabPos());
  const [fabPos, setFabPosState] = useState(fabPosRef.current);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    baseLeft: number;
    baseTop: number;
    moved: boolean;
    lastPos: { left: number; top: number } | null;
  } | null>(null);

  // 挂载时恢复持久化位置
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FAB_STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { left?: unknown; top?: unknown };
        if (typeof p.left === 'number' && typeof p.top === 'number') {
          const pos = { left: p.left, top: p.top };
          fabPosRef.current = pos;
          setFabPosState(pos);
        }
      }
    } catch {
      // 损坏数据忽略，用默认位置
    }
  }, []);

  // 中键按下开始拖动（window 级监听一次挂载，拖动状态走 ref）
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const next = {
        left: Math.min(Math.max(0, d.baseLeft + dx), Math.max(0, vw - FAB_SIZE)),
        top: Math.min(Math.max(0, d.baseTop + dy), Math.max(0, vh - FAB_SIZE)),
      };
      d.lastPos = next;
      fabPosRef.current = next;
      setFabPosState(next);
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      // 触发一次 re-render：dragging 由 dragRef.current !== null 在渲染时派生，
      // 不 setState 的话 mouseup 后组件停留在最后一次 mousemove 的 dragging=true，
      // FAB 的 hover 过渡动画不会恢复（直到下一次任意 state 变化，如 4 秒轮询）
      setFabPosState((p) => ({ ...p }));
      // 实际拖动过才持久化（纯点击不落盘）；未拖动视为中键点击，无副作用
      if (d.moved && d.lastPos) {
        try {
          localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify(d.lastPos));
        } catch {
          // 存储不可用（隐私模式等）：位置本次会话有效即可
        }
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onFabMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.button !== 1) return; // 仅中键
    // 阻止中键默认行为（浏览器 autoscroll 滚动模式）
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseLeft: fabPosRef.current.left,
      baseTop: fabPosRef.current.top,
      moved: false,
      lastPos: null,
    };
  };

  // 拖动进行中：禁用 hover 放大等过渡动画，避免位置跟随抖动
  const dragging = dragRef.current !== null;

  useEffect(() => {
    openRef.current = open;
    if (open) {
      setUnread(0);
      atBottomRef.current = true; // 打开面板：跳到最新（滚动由下方 effect 执行）
    }
  }, [open]);

  // 有未读时让按钮震动一下
  useEffect(() => {
    if (unread > 0) {
      setShaking(true);
      const timer = window.setTimeout(() => setShaking(false), 520);
      return () => window.clearTimeout(timer);
    }
  }, [unread]);

  // 轮询加载 + 未读统计（不依赖 SSE，消息无需刷新页面）
  // 超时链调度（非 setInterval）：支持失败退避与 in-flight 守卫，
  // 响应超过 4s 时不再重叠堆积请求。
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let failStreak = 0; // 连续失败次数 → 指数退避（4s → 30s 封顶）
    let emptyStreak = 0; // 连续空响应次数 → 触发一次全量拉取（DB 重置后恢复基线）
    let timer: number | null = null;

    const load = () => {
      if (disposed || inFlight) return; // 上一轮未返回：跳过本轮，避免请求堆积
      inFlight = true;
      // 增量拉取：服务端只返回 id > since 的新消息（第一次全量拿基线），
      // 避免每 4 秒轮询都全量下载最近 300 条留言（长期挂机 = 长期无谓带宽/CPU）。
      const since = lastSeenId.current;
      const url = '/gateway/api/messages' + (since > 0 ? '?since=' + since : '');
      fetch(url)
        .then(async (res) => {
          const d = await res.json().catch(() => ({}));
          if (disposed) return;
          if (res.ok && d.ok) {
            failStreak = 0;
            const incoming = (Array.isArray(d.messages) ? d.messages : []) as ChatMessage[];
            // 服务端返回 id DESC（新在前），这里统一成旧在前、新在后
            incoming.sort((a, b) => a.id - b.id);
            const nextMe = (d.me ?? null) as Me | null;
            setMe(nextMe);
            const maxId = incoming.length > 0 ? incoming[incoming.length - 1].id : 0;
            if (nextMe && initializedRef.current && maxId > lastSeenId.current) {
              const fresh = incoming.filter(
                (m) => m.sender_id !== nextMe.id && m.id > lastSeenId.current,
              ).length;
              if (fresh > 0 && !openRef.current) setUnread((u) => u + fresh);
            }
            lastSeenId.current = Math.max(lastSeenId.current, maxId);
            initializedRef.current = true;
            setMessages((prev) => mergeById(prev, incoming));
            setError('');
            // 连续 3 轮空响应 → 全量拉取一次：覆盖“网关重建数据库后新消息 id
            // 从头开始，since 永远大于 maxId → 永久收不到新消息”的静默卡死。
            if (incoming.length === 0) {
              emptyStreak++;
              if (emptyStreak >= 3) {
                emptyStreak = 0;
                lastSeenId.current = 0; // 下轮 since=0 全量拿基线
              }
            } else {
              emptyStreak = 0;
            }
          } else if (!res.ok) {
            setError(d.error ?? t('chat.loadFailed'));
          }
        })
        .catch(() => {
          if (disposed) return;
          failStreak++;
          setError(t('chat.loadFailed'));
        })
        .finally(() => {
          inFlight = false;
          if (disposed) return;
          // 失败退避：4s、8s、16s、30s 封顶；成功恢复 4s
          const delay = failStreak > 0 ? Math.min(POLL_MS * 2 ** failStreak, 30_000) : POLL_MS;
          timer = window.setTimeout(load, delay);
        });
    };

    load();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // 新消息 / 打开面板时滚动到底部（仅在用户贴着底部时自动跟随）
  useEffect(() => {
    if (open && listRef.current && atBottomRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, open]);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const close = () => {
    setClosing(true);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
      setClosing(false);
      setError('');
    }, 180);
  };

  const openPanel = () => {
    // 关闭动画进行中重开：取消 pending 的 close 定时器，否则面板开了又被强制关
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(false);
    setOpen(true);
    setUnread(0);
  };

  const send = () => {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setError('');
    fetch('/gateway/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, tags }),
    })
      .then(async (res) => {
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.ok) {
          setDraft('');
          setTags([]);
          if (d.message) {
            const m = d.message as ChatMessage;
            setMessages((prev) => mergeById(prev, [m]));
          }
        } else {
          setError(d.error ?? t('chat.sendFailed'));
        }
      })
      .catch(() => setError(t('chat.sendFailed')))
      .finally(() => setBusy(false));
  };

  const toggleTag = (tag: string) => {
    setTags((prev) => (prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag]));
  };

  return (
    <>
      <button
        type="button"
        className={'dshpw-chat-fab' + (shaking ? ' shaking' : '') + (dragging ? ' dragging' : '')}
        style={{ left: fabPos.left, top: fabPos.top, bottom: 'auto' }}
        aria-label={t('chat.open')}
        title={`${t('chat.open')} · ${t('chat.dragHint')}`}
        onClick={openPanel}
        onMouseDown={onFabMouseDown}
        onAuxClick={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
      >
        <span className="dshpw-chat-fab-inner">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-4 4v-4H7a3 3 0 0 1-3-3V6z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
          {unread > 0 && (
            <span className="dshpw-chat-badge">{unread > 99 ? '99+' : String(unread)}</span>
          )}
        </span>
      </button>

      {open && (
        <div
          className={'dshpw-chat-backdrop' + (closing ? ' closing' : '')}
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-label={t('chat.title')}
        >
          <div className={'dshpw-chat-panel' + (closing ? ' closing' : '')} onClick={(e) => e.stopPropagation()}>
            <div className="dshpw-chat-header">
              <span className="dshpw-chat-title">{t('chat.title')}</span>
              <button type="button" className="dshpw-chat-close" aria-label={t('chat.close')} onClick={close}>
                ×
              </button>
            </div>

            <div className="dshpw-chat-list" ref={listRef} onScroll={onListScroll}>
              {messages.length === 0 && <div className="dshpw-chat-empty">{t('chat.empty')}</div>}
              {messages.map((m) => {
                const mine = me ? m.sender_id === me.id : false;
                return (
                  <div key={m.id} className={'dshpw-chat-msg' + (mine ? ' mine' : '')}>
                    <div className="dshpw-chat-meta">
                      <span className="dshpw-chat-author">{mine ? t('chat.you') : m.sender_name}</span>
                      <span className="dshpw-chat-time">{fmtTime(m.created_at)}</span>
                    </div>
                    <div className="dshpw-chat-content">{m.content}</div>
                    {m.tags.length > 0 && (
                      <div className="dshpw-chat-tags">
                        {m.tags.map((tag) => (
                          <span className="dshpw-chat-tag" key={tag}>
                            {tagDisplay(tag, tr)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="dshpw-chat-composer">
              <div className="dshpw-chat-tags">
                {PRESET_TAGS.map((tag) => (
                  <button
                    type="button"
                    key={tag}
                    className={'dshpw-chat-tagbtn' + (tags.includes(tag) ? ' active' : '')}
                    onClick={() => toggleTag(tag)}
                  >
                    {tagDisplay(tag, tr)}
                  </button>
                ))}
              </div>
              <div className="dshpw-chat-inputrow">
                <input
                  className="dshpw-chat-input"
                  value={draft}
                  placeholder={t('chat.placeholder')}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <button type="button" className="dshpw-chat-send" disabled={busy || !draft.trim()} onClick={send}>
                  {t('chat.send')}
                </button>
              </div>
              {error && <div className="dshpw-chat-error">{error}</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── 聊天面板样式：跟随 dsh 设计令牌，主题自动适配 ───────────────
const CHAT_CSS = `
.dshpw-chat-fab{position:fixed;z-index:2147483000;width:36px;height:36px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.18);transition:transform .18s,box-shadow .18s,background .18s;pointer-events:auto}
.dshpw-chat-fab.dragging{transition:none;cursor:grabbing;opacity:.85}
.dshpw-chat-fab:hover{transform:scale(1.05);background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 4px 12px rgba(0,0,0,.25)}
.dshpw-chat-fab:active{transform:scale(.96)}
.dshpw-chat-fab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshpw-chat-fab.shaking{animation:dshpwShake .5s ease}
.dshpw-chat-fab-inner{position:relative;display:flex}
.dshpw-chat-badge{position:absolute;top:-12px;right:-9px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#ef4444;color:#fff;font-size:10px;line-height:16px;text-align:center;font-weight:600;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2)}
.dshpw-chat-backdrop{position:fixed;inset:0;z-index:2147482990;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(10px) saturate(.9);-webkit-backdrop-filter:blur(10px) saturate(.9);animation:dshpwChatFadeIn .2s ease;transition:opacity .18s ease}
.dshpw-chat-backdrop.closing{opacity:0;pointer-events:none}
.dshpw-chat-panel{display:flex;flex-direction:column;width:min(680px,calc(100vw - 48px));height:min(640px,calc(100vh - 96px));border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 24px 60px rgba(0,0,0,.5);overflow:hidden;animation:dshpwChatPanelIn .22s cubic-bezier(.16,1,.3,1);transition:opacity .18s ease,transform .18s ease}
.dshpw-chat-panel.closing{opacity:0;transform:translateY(10px) scale(.98)}
.dshpw-chat-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dshpw-chat-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshpw-chat-close{width:28px;height:28px;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-tertiary);font-size:20px;line-height:1;cursor:pointer;transition:background .15s,color .15s}
.dshpw-chat-close:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.dshpw-chat-list{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.dshpw-chat-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;margin:auto}
.dshpw-chat-msg{align-self:flex-start;max-width:78%;padding:9px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);animation:dshpwMsgIn .28s cubic-bezier(.16,1,.3,1)}
.dshpw-chat-msg.mine{align-self:flex-end;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);animation:dshpwMsgMineIn .28s cubic-bezier(.16,1,.3,1)}
.dshpw-chat-meta{display:flex;align-items:baseline;gap:8px;margin-bottom:3px}
.dshpw-chat-author{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dshpw-chat-time{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshpw-chat-content{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.dshpw-chat-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dshpw-chat-tag{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshpw-chat-composer{border-top:1px solid var(--dsw-alias-border-l2);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dshpw-chat-tagbtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 10px;font-size:11px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:border-color .15s,color .15s,background .15s}
.dshpw-chat-tagbtn.active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.dshpw-chat-inputrow{display:flex;gap:8px}
.dshpw-chat-input{flex:1;box-sizing:border-box;min-width:0;padding:8px 12px;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;outline:none;transition:border-color .15s,box-shadow .15s}
.dshpw-chat-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.dshpw-chat-send{appearance:none;border:0;border-radius:10px;padding:8px 16px;font-size:13px;font-weight:500;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,#fff);cursor:pointer;transition:filter .15s}
.dshpw-chat-send:hover:not(:disabled){filter:brightness(1.08)}
.dshpw-chat-send:disabled{opacity:.4;cursor:default}
.dshpw-chat-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#ef4444)}
@keyframes dshpwChatFadeIn{from{opacity:0}to{opacity:1}}
@keyframes dshpwChatPanelIn{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
@keyframes dshpwMsgIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes dshpwMsgMineIn{from{opacity:0;transform:translateY(8px) translateX(8px)}to{opacity:1;transform:none}}
@keyframes dshpwShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-4px)}40%{transform:translateX(4px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}
`;

if (typeof document !== 'undefined') {
  const el = document.createElement('style');
  el.textContent = CHAT_CSS;
  document.head.appendChild(el);
}
