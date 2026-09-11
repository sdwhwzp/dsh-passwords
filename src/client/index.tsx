import { ServicesLauncher } from './services-launcher';
// dsh 浏览器侧插件：在设置页"插件"列表里注册 dsh-passwords 卡片。
// 卡片内容：
//   - 远程设置补丁状态 + "重载补丁"按钮（任何登录用户可触发；补丁强制启用）
//   - 用户管理（改密/改名/子用户） → fetch /api/dsh-passwords/*（网关
//     JWT cookie 鉴权）
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import { DshPasswordsCard } from './card';
import { DshPasswordsSection } from './section';
import { ChatLauncher } from './chat';
import { TokenReporter } from './token';
import { LocalWorkspaceLauncher } from './local-workspace-launcher';
import { ManagedFilesLauncher } from './managed-files-launcher';
import { zh, en } from './locales';
import { AccountLogoutRow, installDesktopLauncherSuppression } from './account-logout';
import { DSH_PASSWORDS_REMOTE, type DshPasswordsRemoteClient } from './remote';
import { loadDshPasswordsState, resolveDshPasswordsClient } from './dsh-passwords-client';

export { inject } from './inject';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'dsh-passwords.plugin.item': {
      kind: 'list';
      scope: 'root';
    };
  }
}

/** 卡片样式：全部使用 dsh 设计令牌（--dsw-alias-*），颜色/主题与官方 PluginCard 完全一致 */
import { CARD_CSS as CSS } from './styles';
import { AccountsLauncher } from './accounts-launcher';

export async function apply(ctx: ClientContext): Promise<() => void | Promise<void>> {
  const remote = ctx.remote as unknown as DshPasswordsRemoteClient;
  const disposeRemote = await remote.$mount(DSH_PASSWORDS_REMOTE);
  const dshPasswords = await resolveDshPasswordsClient(ctx);
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

  // 登录网关是多用户入口；隐藏第三方启动器的机器级关机按钮，账号退出由
  // “通用设置”内的独立条目承担。
  ctx.effect(() => {
    let disposed = false;
    let disposeSuppression = () => {};
    void isBehindGateway().then((behindGateway) => {
      if (!disposed && behindGateway) disposeSuppression = installDesktopLauncherSuppression();
    });
    return () => {
      disposed = true;
      disposeSuppression();
    };
  }, 'dsh-passwords: desktop launcher suppression');

  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'dsh-passwords-account-logout',
        order: 1000,
        locale: 'dshpw',
      },
      AccountLogoutRow,
    ),
  );

  // 独立设置分区（参考 @linxin666 的 settings.section 模式）：在设置页左侧导航
  // 注册 dsh-passwords 一级分区，分区体内渲染注册进 dsh-passwords.plugin.item
  // 的卡片——设置不再挤在官方"插件"列表里，而是单独成区。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-passwords',
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
        order: 55,
        locale: 'dshpw',
        inject: () => ({ loadState: () => loadDshPasswordsState(dshPasswords) }),
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
        order: 100,
        locale: 'dshpw',
      },
      ChatLauncher,
    ),
  );

  // 不可见 token 上报器：会话作用域（conversation.composer.dock 供应 useProjection），
  // 读取 dsh 的 tokenUsage 投影并把增量上报给密码门，用于子用户每小时 token 配额。
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'dsh-passwords-token', order: 90 },
      TokenReporter,
    ),
  );

  // 新会话控制行入口：紧跟 Workspace 和“选择模式”控件。
  ctx.slots.inject('conversation.input.bootstrap', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.bootstrap',
        id: 'dsh-passwords-local-workspace-launcher',
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
            if (workspace === undefined) {
              throw new Error(ctx.locale.bind('dshpw')('localOpenConversationFailed'));
            }
            const sessionId = await ctx.uiWorkspace.connectWorkspace(workspace.workspaceId);
            ctx.sessions.open(sessionId);
          },
        }),
      },
      LocalWorkspaceLauncher,
    ),
  );

  ctx.slots.inject('sidebar.workspaces.action', () =>
    ctx.slots.register({ name: 'sidebar.workspaces.action', id: 'dsh-passwords-accounts', order: 5, locale: 'dshpw',
      inject: () => ({ loadState: () => loadDshPasswordsState(dshPasswords) }),
    }, AccountsLauncher),
  );

  ctx.slots.inject('sidebar.workspaces.action', () =>
    ctx.slots.register({ name: 'sidebar.workspaces.action', id: 'dsh-passwords-services', order: 6, locale: 'dshpw' }, ServicesLauncher),
  );

  // 子账号的专属文件管理固定在 Workspace 列表上方。
  ctx.slots.inject('sidebar.workspaces.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces.action',
        id: 'dsh-passwords-managed-files',
        order: 10,
        locale: 'dshpw',
      },
      ManagedFilesLauncher,
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
  return disposeRemote;
}
