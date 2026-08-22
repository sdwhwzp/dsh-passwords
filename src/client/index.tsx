// dsh 浏览器侧插件：在设置页"插件"列表里注册 dsh-passwords 卡片。
// 卡片内容：
//   - 远程设置补丁状态 + "重载补丁"按钮（任何登录用户可触发；补丁强制启用）
//   - 用户管理（改密/改名/子用户） → fetch /api/dsh-passwords/*（网关
//     JWT cookie 鉴权）
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-slots/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import { DshPasswordsCard } from './card';
import { DshPasswordsSection } from './section';
import { ChatLauncher } from './chat';
import { TokenReporter } from './token';
import { LocalWorkspaceLauncher } from './local-workspace-launcher';
import { zh, en } from './locales';
import { installDesktopLauncherLogoutBridge } from './account-logout';

/** 卡片样式：全部使用 dsh 设计令牌（--dsw-alias-*），颜色/主题与官方 PluginCard 完全一致 */
const CSS = `
.dshpw-card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s;font-size:13px;line-height:1.5;overflow:hidden}
.dshpw-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dshpw-body{display:flex;flex-direction:column;gap:0;padding:4px 16px 16px}
.dshpw-section{display:flex;flex-direction:column;gap:10px;padding:16px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.dshpw-section:first-child{border-top:0}
.dshpw-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:22px}
.dshpw-label{display:block;font-size:12px;font-weight:650;letter-spacing:.01em;color:var(--dsw-alias-label-secondary)}
.dshpw-action-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dshpw-action-copy{flex:1;min-width:180px}
.dshpw-form-actions{justify-content:flex-end}
.dshpw-preference{padding-top:12px}
.dshpw-switch{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:border-color .15s,background .15s}
.dshpw-switch:hover{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-1)}
.dshpw-switch-copy{display:flex;flex-direction:column;gap:2px;min-width:0;color:var(--dsw-alias-label-primary)}
.dshpw-switch-copy strong{font-size:13px;font-weight:600;line-height:1.35}
.dshpw-switch-copy small{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.dshpw-switch-control{position:relative;display:inline-flex;flex:0 0 auto;width:42px;height:24px}
.dshpw-switch-control input{position:absolute;width:1px;height:1px;opacity:0}
.dshpw-switch-track{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-label-dimmed);transition:background .18s,box-shadow .18s}
.dshpw-switch-thumb{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-3);box-shadow:0 1px 3px #0004;transition:transform .18s}
.dshpw-switch-control input:checked + .dshpw-switch-track{background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent)}
.dshpw-switch-control input:checked + .dshpw-switch-track .dshpw-switch-thumb{transform:translateX(18px)}
.dshpw-switch-control input:focus-visible + .dshpw-switch-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.dshpw-input{width:100%;box-sizing:border-box;min-width:0;padding:7px 10px;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;transition:border-color .15s,box-shadow .15s}
.dshpw-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.dshpw-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshpw-btn{appearance:none;border:0;border-radius:8px;padding:7px 14px;font-size:13px;line-height:1.35;font-weight:600;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,#fff);cursor:pointer;white-space:nowrap;transition:filter .15s,transform .08s}
.dshpw-btn:active:not(:disabled){transform:translateY(1px)}
.dshpw-btn:hover:not(:disabled){filter:brightness(1.1)}
.dshpw-btn:disabled{opacity:.4;cursor:default}
.dshpw-btn.danger{background:none;border:1px solid var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshpw-btn.danger:hover:not(:disabled){filter:none;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent)}
.dshpw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dshpw-logout{margin-left:auto}
.dshpw-user{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dshpw-user:last-child{border-bottom:none}
.dshpw-perm{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}
.dshpw-perm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshpw-workspaces{display:flex;flex-direction:column;gap:8px}
.dshpw-workspace{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.dshpw-workspace-switch{border:0;border-radius:0;background:transparent}
.dshpw-workspace-switch:hover{background:var(--dsw-alias-bg-layer-1)}
.dshpw-session-list{display:flex;flex-direction:column;gap:6px;padding:8px 12px 10px 18px;border-top:1px solid var(--dsw-alias-border-l2)}
.dshpw-session-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;min-height:26px}
.dshpw-session-check input{accent-color:var(--dsw-alias-brand-primary);flex:0 0 auto}
.dshpw-session-check span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpw-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshpw-check input{accent-color:var(--dsw-alias-brand-primary)}
/* 下拉框自身带 dshpw-input class：用 select.dshpw-input（旧 .dshpw-input select 永远不命中，是死选择器） */
select.dshpw-input{height:auto;min-height:36px}
.dshpw-badge{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);margin-left:6px;white-space:nowrap}
.dshpw-badge.admin{border-color:var(--dsw-alias-state-warn-primary,#f7ad31);color:var(--dsw-alias-state-warn-primary,#f7ad31)}
.dshpw-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px}
.dshpw-ok{color:var(--dsw-alias-state-success-primary,#22c55e);font-size:12px}
.dshpw-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dshpw-local-command{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshpw-local-command code{min-width:0;overflow:auto;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshpw-local-command small{grid-column:1/-1}
.dshpw-local-download{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshpw-download-btn{display:inline-flex;align-items:center;text-decoration:none}
.dshpw-local-server{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshpw-local-server code{font-size:12px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;user-select:all}
.dshpw-local-approval{display:grid;grid-template-columns:minmax(0,1fr) minmax(140px,190px) auto;gap:10px;align-items:center;padding:12px;border:1px solid var(--dsw-alias-brand-primary);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-2))}
.dshpw-local-code{text-align:center;font-size:16px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:.18em}
.dshpw-local-legacy{padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshpw-local-legacy summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600}
.dshpw-local-legacy>.dshpw-hint,.dshpw-local-legacy>.dshpw-btn,.dshpw-local-legacy>.dshpw-local-command{margin-top:10px}
.dshpw-local-workspace{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshpw-local-launcher{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:1.45}
.dshpw-local-launcher-popover{position:fixed;left:14px;bottom:164px;z-index:2147482800;pointer-events:auto}
.dshpw-local-launcher-popover>summary{list-style:none;display:inline-flex;align-items:center;min-height:36px;box-shadow:0 2px 8px rgba(0,0,0,.18)}
.dshpw-local-launcher-popover>summary::-webkit-details-marker{display:none}
.dshpw-local-launcher-popover[open]>summary{filter:brightness(1.08)}
.dshpw-local-launcher-popover>.dshpw-local-launcher{position:absolute;left:0;bottom:calc(100% + 8px);width:min(380px,calc(100vw - 28px));box-sizing:border-box;box-shadow:0 12px 36px rgba(0,0,0,.3)}
.dshpw-local-launcher-main{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dshpw-local-launcher-copy{display:flex;flex-direction:column;gap:2px;min-width:0;color:var(--dsw-alias-label-primary)}
.dshpw-local-launcher-copy strong{font-size:13px;font-weight:650}
.dshpw-local-launcher-copy small,.dshpw-local-launcher-fallback{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshpw-local-launcher-status{font-size:12px;color:var(--dsw-alias-state-success-primary,#22c55e)}
.dshpw-local-launcher-fallback summary{width:max-content;max-width:100%;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshpw-local-launcher-help{display:flex;gap:6px 10px;align-items:baseline;flex-wrap:wrap;padding-top:7px}
.dshpw-local-launcher-help a{color:var(--dsw-alias-brand-primary);font-weight:600;text-decoration:none}
.dshpw-local-launcher-help a:hover{text-decoration:underline}
.dshpw-local-launcher-workspaces{display:flex;flex-direction:column;gap:6px}
.dshpw-local-launcher-workspace{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dshpw-local-launcher-workspace>span{display:flex;flex-direction:column;min-width:0}
.dshpw-local-launcher-workspace strong,.dshpw-local-launcher-workspace small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpw-local-launcher-workspace small{color:var(--dsw-alias-label-tertiary)}
@media(max-width:640px){.dshpw-local-download,.dshpw-local-server,.dshpw-local-launcher-main{align-items:stretch;flex-direction:column}.dshpw-local-approval{grid-template-columns:1fr}.dshpw-local-workspace{grid-template-columns:minmax(0,1fr) auto}.dshpw-local-workspace>.dshpw-switch-copy{grid-column:1/-1}.dshpw-local-launcher-popover{right:14px}.dshpw-local-launcher-popover>.dshpw-local-launcher{width:calc(100vw - 28px)}}
`;

export const inject = ['slots', 'locale', 'sessions', 'workspaces'] as const;

export function apply(ctx: ClientContext): void {
  let gatewayDetected: boolean | null = null;
  const isBehindGateway = async (): Promise<boolean> => {
    if (gatewayDetected !== null) return gatewayDetected;
    try {
      const resp = await fetch('/gateway/login', {
        method: 'HEAD',
        credentials: 'same-origin',
      });
      gatewayDetected = resp.headers.get('x-dsh-gateway') === '1';
    } catch {
      gatewayDetected = false;
    }
    return gatewayDetected;
  };

  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {};
    const existing = document.querySelector('style[data-dshpw-style="1"]');
    if (existing) return () => {};
    const el = document.createElement('style');
    el.dataset.dshpwStyle = '1';
    el.textContent = CSS;
    document.head.appendChild(el);
    return () => el.remove();
  }, 'dsh-passwords: styles');

  // 经 3081 登录网关访问时，右下角第三方“退出 DeepSeek Harness”电源按钮
  // 必须表示退出当前账号，而不是关闭全体用户共用的 dsh 服务。捕获阶段拦截
  // 第三方 React onClick，杜绝其 requestShutdown + about:blank 路径。
  ctx.effect(() => {
    let disposed = false;
    let disposeBridge = () => {};
    void isBehindGateway().then((behindGateway) => {
      if (!disposed && behindGateway) disposeBridge = installDesktopLauncherLogoutBridge();
    });
    return () => {
      disposed = true;
      disposeBridge();
    };
  }, 'dsh-passwords: account logout bridge');

  // 独立设置分区（参考 @linxin666 的 settings.section 模式）：在设置页左侧导航
  // 注册 dsh-passwords 一级分区，分区体内渲染注册进 dsh-passwords.plugin.item
  // 的卡片——设置不再挤在官方"插件"列表里，而是单独成区。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-passwords',
        key: 'dsh-passwords',
        order: 105,
        label: () => ctx.locale.bind('dshpw')('sectionTitle'),
        locale: 'dshpw',
        children: { 'dsh-passwords.plugin.item': { kind: 'list', scope: 'root' } },
      },
      DshPasswordsSection,
    ),
  );

  // 设置卡片：注册进上面分区声明的子槽（分区体 renderSlot 渲染）
  ctx.slots.inject('dsh-passwords.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'dsh-passwords.plugin.item',
        id: 'dsh-passwords-card',
        key: 'dsh-passwords-card',
        order: 55,
        locale: 'dshpw',
        inject: () => ({}),
      },
      DshPasswordsCard,
    ),
  );

  // 全局聊天入口：左下角圆形按钮 + 居中弹窗（shell.overlay 槽，root 作用域）
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-passwords-chat',
        key: 'dsh-passwords-chat',
        order: 100,
        locale: 'dshpw',
        inject: () => ({}),
      },
      ChatLauncher,
    ),
  );

  // 不可见 token 上报器：会话作用域（conversation.composer.dock 供应 useProjection），
  // 读取 dsh 的 tokenUsage 投影并把增量上报给密码门，用于子用户每小时 token 配额。
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'dsh-passwords-token', key: 'dsh-passwords-token', order: 90 },
      TokenReporter,
    ),
  );

  // 根作用域悬浮入口：没有会话或工作区时仍提供首次本机目录选择。
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-passwords-local-workspace-launcher',
        key: 'dsh-passwords-local-workspace-launcher',
        order: 30,
        locale: 'dshpw',
        inject: () => ({
          openWorkspacePath: async (workspacePath: string) => {
            const findWorkspace = () => ctx.workspaces.list.getSnapshot().items
              .find((workspace) => workspace.path === workspacePath);
            let workspace = findWorkspace();
            if (workspace === undefined) {
              workspace = await new Promise((resolve, reject) => {
                let settled = false;
                let dispose = () => {};
                const timer = window.setTimeout(() => {
                  settled = true;
                  dispose();
                  reject(new Error(ctx.locale.bind('dshpw')('localOpenConversationFailed')));
                }, 15_000);
                const listener = () => {
                  const next = findWorkspace();
                  if (settled || next === undefined) return;
                  settled = true;
                  window.clearTimeout(timer);
                  dispose();
                  resolve(next);
                };
                dispose = ctx.workspaces.list.subscribe(listener);
                if (settled) dispose();
                else listener();
              });
            }
            const sessionId = await ctx.workspaces.connectWorkspace(workspace.workspaceId);
            ctx.sessions.open(sessionId);
          },
        }),
      },
      LocalWorkspaceLauncher,
    ),
  );

  // ── 远程文件下载（Issue #4）──────────────────────────────────
  // 经 dsh-passwords 网关远程访问时，点击对话里的“生成文件”标签会调用
  // workspaces.openPath → host.openPath → 服务器容器里 xdg-open（无桌面环境
  // → spawn xdg-open ENOENT）。这里包装 openPath：检测到经网关访问时改为
  // 跳转 /gateway/api/download 下载到浏览器；本地桌面访问保持原 RPC 行为。
  // 网关检测：探测一次响应头 X-Dsh-Gateway（网关在代理/自身响应里注入）。
  ctx.inject(['workspaces'], (scope) => {
    const workspaces = scope.workspaces as {
      openPath?: (path: string) => Promise<unknown>;
    };
    const original = workspaces.openPath?.bind(workspaces);
    if (typeof original !== 'function') return;
    const wrapped = async (filePath: string) => {
      if (await isBehindGateway()) {
        // 经网关：下载到浏览器（路径由网关侧再做目录/敏感校验）
        const url = '/gateway/api/download?path=' + encodeURIComponent(filePath);
        window.location.assign(url);
        return { opened: true };
      }
      return original(filePath);
    };
    workspaces.openPath = wrapped;
    // ctx.inject 的回调返回值由 Cordis 作为 fiber disposer 收集；恢复共享服务，
    // 避免插件重载后包装层叠加或禁用插件后残留网关下载行为。
    return () => {
      if (workspaces.openPath === wrapped) workspaces.openPath = original;
    };
  });

  // 双语词典（zh/en）：卡片文字跟随 dsh 设置里的语言
  // （设置 → 通用 → 语言 / Settings → General → Language），切换即时生效
  ctx.effect(() => ctx.locale.register('dshpw', { zh, en }), 'dsh-passwords: dicts');
}
