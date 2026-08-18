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
import { zh, en } from './locales';

/** 卡片样式：全部使用 dsh 设计令牌（--dsw-alias-*），颜色/主题与官方 PluginCard 完全一致 */
const CSS = `
.dshpw-card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s;font-size:13px;line-height:1.5;overflow:hidden}
.dshpw-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dshpw-body{display:flex;flex-direction:column;gap:14px;padding:14px 16px}
.dshpw-section{display:flex;flex-direction:column;gap:8px}
.dshpw-label{display:block;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dshpw-input{width:100%;box-sizing:border-box;min-width:0;padding:7px 10px;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;transition:border-color .15s,box-shadow .15s}
.dshpw-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.dshpw-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshpw-btn{appearance:none;border:0;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;font-weight:500;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,#fff);cursor:pointer}
.dshpw-btn:hover:not(:disabled){filter:brightness(1.1)}
.dshpw-btn:disabled{opacity:.4;cursor:default}
.dshpw-btn.danger{background:none;border:1px solid var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshpw-btn.danger:hover:not(:disabled){filter:none;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent)}
.dshpw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dshpw-user{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dshpw-user:last-child{border-bottom:none}
.dshpw-perm{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}
.dshpw-perm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshpw-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshpw-check input{accent-color:var(--dsw-alias-brand-primary)}
/* 下拉框自身带 dshpw-input class：用 select.dshpw-input（旧 .dshpw-input select 永远不命中，是死选择器） */
select.dshpw-input{height:auto;min-height:36px}
.dshpw-badge{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);margin-left:6px;white-space:nowrap}
.dshpw-badge.admin{border-color:var(--dsw-alias-state-warn-primary,#f7ad31);color:var(--dsw-alias-state-warn-primary,#f7ad31)}
.dshpw-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px}
.dshpw-ok{color:var(--dsw-alias-state-success-primary,#22c55e);font-size:12px}
.dshpw-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
`;

if (typeof document !== 'undefined') {
  const el = document.createElement('style');
  el.textContent = CSS;
  document.head.appendChild(el);
}

export const inject = ['slots', 'locale'] as const;

export function apply(ctx: ClientContext): void {
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

  // ── 远程文件下载（Issue #4）──────────────────────────────────
  // 经 dsh-passwords 网关远程访问时，点击对话里的“生成文件”标签会调用
  // workspaces.openPath → host.openPath → 服务器容器里 xdg-open（无桌面环境
  // → spawn xdg-open ENOENT）。这里包装 openPath：检测到经网关访问时改为
  // 跳转 /gateway/api/download 下载到浏览器；本地桌面访问保持原 RPC 行为。
  // 网关检测：探测一次响应头 X-Dsh-Gateway（网关在代理/自身响应里注入）。
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

  ctx.inject(['workspaces'], (scope) => {
    const workspaces = scope.workspaces as {
      openPath?: (path: string) => Promise<unknown>;
    };
    const original = workspaces.openPath?.bind(workspaces);
    if (typeof original !== 'function') return;
    workspaces.openPath = async (filePath: string) => {
      if (await isBehindGateway()) {
        // 经网关：下载到浏览器（路径由网关侧再做目录/敏感校验）
        const url = '/gateway/api/download?path=' + encodeURIComponent(filePath);
        window.location.assign(url);
        return { opened: true };
      }
      return original(filePath);
    };
  });

  // 双语词典（zh/en）：卡片文字跟随 dsh 设置里的语言
  // （设置 → 通用 → 语言 / Settings → General → Language），切换即时生效
  ctx.effect(() => ctx.locale.register('dshpw', { zh, en }), 'dsh-passwords: dicts');
}
