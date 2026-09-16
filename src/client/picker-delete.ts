// 目录选择器（"选择工作区目录"模态）的行内删除按钮。
//
// 为什么是 DOM 注入而不是组件扩展：
//   目录选择器由 dsh 官方包 @deepseek-ai/dsh-client-ui-directory-picker-browse
//   提供（本插件不拥有该槽位），服务端也没有插件化的删除原语。后端删除端点
//   POST /gateway/api/fs/delete-directory 是本仓库已有的（仅主用户）。因此这里
//   在官方对话框上叠加一层：把已有的行结构当作只读锚点，注入一个删除按钮，
//   路径从官方自己的 /api/directoryPicker/list RPC 响应里取（该响应每个 entry
//   都带绝对 path，而 DOM 里没有路径）。
//
// 稳定性契约（0.1.6-alpha.1 实测 + 源码确认）：
//   - 模态容器 [role="dialog"]，内部每一列 div[role="list"]，
//     行 span[role="listitem"] > button[type=button]
//   - 行名 = button.textContent.trim()（文件夹/chevron 图标是 svg，无文本）
//   - 选中行 button[aria-current="true"]（官方自己也用这个锚点）
//   只依赖这些 role 属性：CSS 类名带构建哈希（ZuhsRW_*），跨版本必然变化。
//
// 语言：直接读本插件的词典（locales.ts），按 navigator.language 粗略选 zh/en。
//   注入的按钮活在 dsh 的 React 树之外，拿不到 locale 服务的 t seat，这是
//   最不打扰官方渲染的取文案方式（设置里的语言与浏览器语言不一致时可能不同）。
//
// 授权：按钮只是界面便利，后端 requireAdmin 才是授权边界（子用户 403）。
//   这里连观测都不启动——非主用户页面上零副作用。
import { zh, en } from './locales';

/** 列表 RPC 路径：响应信封里同时含 parent/child 两个 entries 数组（双列）。 */
const LIST_ENDPOINT_SUFFIX = '/api/directoryPicker/list';
/** 删除端点（网关注册，见 gateway.ts）。 */
const DELETE_ENDPOINT = '/gateway/api/fs/delete-directory';
/** 路径速查表条目上限：一次删除只需相邻两列，超出丢弃最旧。 */
const MAX_LISTINGS = 64;
/** MutationObserver → scan 的去抖窗口。 */
const SCAN_DEBOUNCE_MS = 60;
/** 二次点击确认窗口：超时自动解除武装。 */
const ARM_TIMEOUT_MS = 2500;
/** toast 停留时长。 */
const TOAST_MS = 2800;
/** 行标记：存绝对路径，用于幂等判断 + 清除（React 重渲染不会保留 dataset）。 */
const PATH_ATTR = 'data-dshpwPickerDelPath';

/** 注入按钮与 toast 的样式（<style> 只注入一次；类名固定，不进官方 CSS 命名空间）。
 *  设计令牌与 index.tsx 的 .dshpw-card 同源：--dshpw-ease 柔和标准曲线、
 *  --dshpw-spring 轻过冲弹簧；注入 DOM 不在卡片内，这里在自身作用域重声明。 */
const PICKER_DEL_CSS = `
.dshpw-picker-del{--dshpw-ease:cubic-bezier(.22,1,.36,1);--dshpw-spring:cubic-bezier(.34,1.4,.64,1);position:absolute;right:26px;top:50%;transform:translateY(-50%) scale(.9);display:flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:6px;color:var(--dsw-alias-state-error-primary,#ef4444);background:transparent;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .16s var(--dshpw-ease),transform .28s var(--dshpw-spring),background-color .16s var(--dshpw-ease),color .16s var(--dshpw-ease);-webkit-user-select:none;user-select:none;z-index:1}
[role="listitem"]:hover>.dshpw-picker-del,.dshpw-picker-del:focus-visible{opacity:1;pointer-events:auto;transform:translateY(-50%) scale(1)}
.dshpw-picker-del:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 14%,transparent)}
.dshpw-picker-del:active{transform:translateY(-50%) scale(.86);transition-duration:.08s}
.dshpw-picker-del-arm{opacity:1;pointer-events:auto;color:var(--dsw-alias-label-primary-inverted,#fff);background:var(--dsw-alias-state-error-primary,#ef4444);transform:translateY(-50%) scale(1.05)}
.dshpw-picker-del-arm:hover{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dshpw-picker-toast{--dshpw-ease:cubic-bezier(.22,1,.36,1);--dshpw-spring:cubic-bezier(.34,1.4,.64,1);position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:320px;padding:9px 13px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-3,#1f2933) 86%,transparent);color:var(--dsw-alias-label-primary,#172026);font-size:12px;line-height:1.5;box-shadow:0 10px 28px rgb(0 0 0 / 26%),0 2px 8px rgb(0 0 0 / 12%);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);animation:dshpwPickerToastIn .38s var(--dshpw-spring) both}
.dshpw-picker-toast-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 92%,transparent);color:#fff}
@keyframes dshpwPickerToastIn{from{opacity:0;transform:translateY(10px) scale(.95)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.dshpw-picker-toast{animation:none}.dshpw-picker-del{transition:none}}
`;

/** 垃圾桶线条图标（14×14，stroke=currentColor，跟随按钮文字色）。 */
const TRASH_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">' +
  '<path d="M2.5 4h11M6.5 4V2.8A.8.8 0 0 1 7.3 2h1.4a.8.8 0 0 1 .8.8V4M5 4l.7 9.2a.9.9 0 0 0 .9.8h3.8a.9.9 0 0 0 .9-.8L12 4M6.8 6.6v5M9.2 6.6v5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ── 语言 ───────────────────────────────────────────────────────

/** 注入层用到的文案（从词典按当前语言取出一份固定映射，便于纯函数测试）。 */
export interface PickerText {
  del: string;
  confirm: string;
  aria: string;
  done: string;
  failed: string;
}

/** 当前语言的文案；navigator 缺失（SSR/测试）时回退英文。 */
export const pickerText: PickerText = (() => {
  const dict =
    typeof navigator !== 'undefined' && typeof navigator.language === 'string' &&
    navigator.language.toLowerCase().startsWith('zh')
      ? zh
      : en;
  return {
    del: dict.pickerDel,
    confirm: dict.pickerDelConfirm,
    aria: dict.pickerDelAria,
    done: dict.pickerDelDone,
    failed: dict.pickerDelFailed,
  };
})();

// ── 列表捕获：把 RPC 响应里的 name → 绝对 path 映射留下来 ─────────

/** 一行（目录选择器里每行必是目录：后端只返回目录）。 */
export interface PickerEntry {
  path: string;
  name: string;
  hidden: boolean;
}

export function isPickerEntry(value: unknown): value is PickerEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === 'string' &&
    record.path !== '' &&
    typeof record.name === 'string' &&
    record.name !== ''
  );
}

/**
 * 递归收集响应信封里所有「目录条目数组」。
 *
 * dsh 的 RPC 回包形状是 { type, rpcId, result: { ok, value } }，value 是
 * { path, home, crumbs, entries, truncated }；目录选择器会先把选中的父目录
 * 列表放进来、再补一次子目录列表，因此一个响应可能含两个 entries 数组
 * （双列），全部收集。判据是形状而不是固定的 JSON 路径：上游加包装层也不会漏。
 *
 * @param envelope - 任意已解析的 JSON（响应体）。
 * @returns 每个条目的 path/name/hidden（深度上限防止环/深树）。
 */
export function extractPickerListings(envelope: unknown): PickerEntry[][] {
  const found: PickerEntry[][] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number, blocked = false): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      // 只遍历包装对象；裸数组不是列表信号，避免把 crumbs 或其他数组误认成 entries。
      for (const item of value) walk(item, depth + 1, blocked);
      return;
    }
    const record = value as Record<string, unknown>;
    const truncated = blocked || record.truncated === true;
    const entries = record.entries;
    if (!truncated && Array.isArray(entries)) {
      if (entries.length > 0 && entries.every(isPickerEntry)) {
        found.push(
          entries.map((entry) => {
            const entryRecord = entry as unknown as Record<string, unknown>;
            return {
              path: entry.path,
              name: entry.name,
              hidden: typeof entryRecord.hidden === 'boolean' ? entryRecord.hidden : false,
            };
          }),
        );
      }
    }
    for (const [key, item] of Object.entries(record)) {
      // entries 已在当前对象处理；crumbs 是祖先路径链，永远不是可删除的当前列。
      if (key === 'entries' || key === 'crumbs') continue;
      walk(item, depth + 1, truncated);
    }
  };
  walk(envelope, 0);
  return found;
}

/** 一份已被抓到的列列表（按列名序列索引行 → 绝对路径）。 */
export interface CapturedListing {
  names: string[];
  byName: Map<string, PickerEntry>;
}

/** 内存态：最新抓到的列列表在前，上限 MAX_LISTINGS。 */
const capturedListings: CapturedListing[] = [];

function rememberListings(entries: PickerEntry[]): void {
  if (entries.length === 0) return;
  const listing: CapturedListing = { names: [], byName: new Map() };
  for (const entry of entries) {
    listing.names.push(entry.name);
    // 同名目录在同一列内不可能出现（同目录下的子项名唯一），直接覆盖即可
    listing.byName.set(entry.name, entry);
  }
  // 去重：同一列重复上报时把它挪到最前，避免刷掉真正更早的另一列
  const existing = capturedListings.findIndex(
    (item) => item.names.length === listing.names.length && item.names.every((name, i) => name === listing.names[i]),
  );
  if (existing >= 0) capturedListings.splice(existing, 1);
  capturedListings.unshift(listing);
  if (capturedListings.length > MAX_LISTINGS) capturedListings.length = MAX_LISTINGS;
}

/** 供 scan 读取的当前列表快照（最新在前）。 */
export function pickerListings(): readonly CapturedListing[] {
  return capturedListings;
}

// ── 列 ↔ 列表匹配 ──────────────────────────────────────────────

/**
 * 在已抓到的列表里找与某一列的可见行名序列对应的那份。
 *
 * 为什么不是精确相等就够：列会按官方前端的显示过滤（隐藏文件开关、路径
 * 输入框的前缀过滤）少显示若干行。因此先精确命中（DOM 刚渲染完的常见情形），
 * 否则退化为「有序子序列」匹配，取 listing 最长者（最具体的候选）。
 *
 * 注：因为「过滤」只会隐藏行，子序列匹配天然安全——错配最多是给某行注入了
 * 指向其目录列表里同名条目的路径，而同名即同目录下的同一项。
 *
 * @param names - 该列当前可见行的名字序列（textContent.trim()）。
 * @param listings - 候选列表（通常来自 pickerListings()）。
 * @returns 命中下标；无候选/无命中为 null。
 */
export function matchPickerListing(
  names: readonly string[],
  listings: readonly { names: readonly string[] }[],
): number | null {
  if (names.length === 0) return null;
  // 1) 精确序列相等（最新优先：列表本身最新在前）
  for (let i = 0; i < listings.length; i++) {
    const candidate = listings[i].names;
    if (candidate.length !== names.length) continue;
    let same = true;
    for (let k = 0; k < names.length; k++) {
      if (candidate[k] !== names[k]) {
        same = false;
        break;
      }
    }
    if (same) return i;
  }
  // 2) 有序子序列（显示被过滤）：取 listing 最长者
  let best: number | null = null;
  let bestLength = 0;
  let bestCount = 0;
  for (let i = 0; i < listings.length; i++) {
    const candidate = listings[i].names;
    if (candidate.length < names.length || candidate.length < bestLength) continue;
    let cursor = 0;
    let matched = true;
    for (const name of names) {
      while (cursor < candidate.length && candidate[cursor] !== name) cursor++;
      if (cursor >= candidate.length) {
        matched = false;
        break;
      }
      cursor++;
    }
    if (!matched) continue;
    if (candidate.length > bestLength) {
      best = i;
      bestLength = candidate.length;
      bestCount = 1;
    } else if (candidate.length === bestLength) {
      bestCount++;
    }
  }
  return bestCount === 1 ? best : null;
}

// ── 幂等注入 ───────────────────────────────────────────────────

function findStyleHost(): ParentNode | null {
  if (typeof document === 'undefined') return null;
  return document.head ?? document.documentElement;
}

function injectStyleOnce(): void {
  const host = findStyleHost();
  if (host === null || typeof document.querySelector !== 'function') return;
  if (document.querySelector('style[data-dshpw-picker-style="1"]') !== null) return;
  const style = document.createElement('style');
  style.dataset.dshpwPickerStyle = '1';
  style.textContent = PICKER_DEL_CSS;
  host.appendChild(style);
}

/** 单例 toast（右下角小条，同页复用）。 */
let toastEl: HTMLElement | null = null;
let toastTimer = 0;

function showToast(message: string, error: boolean): void {
  if (typeof document === 'undefined') return;
  if (toastEl === null || !toastEl.isConnected) {
    toastEl = document.createElement('div');
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    toastEl.className = 'dshpw-picker-toast';
    (document.body ?? document.documentElement).appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.className = error ? 'dshpw-picker-toast dshpw-picker-toast-error' : 'dshpw-picker-toast';
  if (toastTimer !== 0) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = 0;
    toastEl?.remove();
    toastEl = null;
  }, TOAST_MS);
}

/** 调用删除端点；返回服务端错误文案（没有则 null 表示成功）。 */
async function requestDelete(path: string): Promise<string | null> {
  try {
    const response = await fetch(DELETE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ path }),
    });
    const data = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
    if (response.ok && data?.ok === true) return null;
    // 服务端错误文案已是中文兜底；非中文界面下优先本地化失败文案
    return typeof data?.error === 'string' && data.error !== '' ? data.error : pickerText.failed;
  } catch {
    return pickerText.failed;
  }
}

/** 删除后从界面移除该行；若删的正是选中行，其后的（子目录）列已无意义，一并移除。 */
function dropRowAfterDelete(button: HTMLButtonElement): void {
  const rowHost = button.closest('[role="listitem"]');
  if (rowHost === null) return;
  const column = rowHost.closest('[role="list"]');
  const selected = button.getAttribute('aria-current') === 'true';
  if (selected && column !== null) {
    // 该列之后的所有兄弟列 = 选中目录的子列（父目录已删，子列表随即失效）
    let sibling = column.nextElementSibling;
    while (sibling !== null) {
      const next = sibling.nextElementSibling;
      if (sibling.getAttribute('role') === 'list') sibling.remove();
      sibling = next;
    }
  }
  rowHost.remove();
}

/** 给一行注入删除按钮（幂等：React 重建行后旧按钮消失，会重新注入）。 */
function injectRowButton(rowHost: Element, button: HTMLButtonElement, entry: PickerEntry): void {
  const path = entry.path;
  const existing = rowHost.querySelector(':scope > .dshpw-picker-del');
  if (existing !== null) {
    // 已注入：只更新路径标记（行复用/列表刷新后路径可能变）
    existing.setAttribute(PATH_ATTR, path);
    return;
  }
  // 行容器不是定位上下文时给一个（绝对定位的按钮以此行为定位基准）
  const host = rowHost as HTMLElement;
  if (
    host.style !== undefined &&
    typeof getComputedStyle === 'function' &&
    getComputedStyle(rowHost).position === 'static'
  ) {
    host.style.position = 'relative';
  }
  const node = document.createElement('span');
  node.className = 'dshpw-picker-del';
  node.setAttribute('data-dshpw-picker-del', '1');
  node.setAttribute(PATH_ATTR, path);
  node.setAttribute('role', 'button');
  node.setAttribute('tabindex', '-1');
  const label = `${pickerText.aria}: ${entry.name}`;
  node.setAttribute('aria-label', label);
  node.setAttribute('title', label);
  node.innerHTML = TRASH_ICON;

  let armTimer = 0;
  node.addEventListener('click', (event) => {
    // 行 button 自己带 onClick（进入该目录）：绝不能让它收到这次点击
    event.preventDefault();
    event.stopPropagation();
    const current = node.getAttribute(PATH_ATTR);
    if (current === null || current === '') return;
    if (!node.classList.contains('dshpw-picker-del-arm')) {
      node.classList.add('dshpw-picker-del-arm');
      node.setAttribute('title', pickerText.confirm);
      armTimer = window.setTimeout(() => {
        armTimer = 0;
        node.classList.remove('dshpw-picker-del-arm');
        node.setAttribute('title', label);
      }, ARM_TIMEOUT_MS);
      return;
    }
    // 已武装：第二次点击 = 确认
    if (armTimer !== 0) window.clearTimeout(armTimer);
    armTimer = 0;
    node.classList.remove('dshpw-picker-del-arm');
    node.setAttribute('title', label);
    void requestDelete(current).then((failure) => {
      if (failure !== null) {
        // 失败保留行与按钮（可重试），只提示原因
        showToast(failure, true);
        return;
      }
      showToast(`${pickerText.done}: ${entry.name}`, false);
      dropRowAfterDelete(button);
    });
  });

  rowHost.appendChild(node);
}

// ── 扫描（幂等） ───────────────────────────────────────────────

/** 扫一遍所有已挂载的目录选择器模态，为其行注入/更新删除按钮。 */
export function scanPickerDialogs(): void {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (const dialog of dialogs) {
    const columns = dialog.querySelectorAll('[role="list"]');
    for (const column of columns) {
      const rows = column.querySelectorAll(':scope > [role="listitem"] > button');
      if (rows.length === 0) continue;
      const names: string[] = [];
      for (const row of rows) names.push((row.textContent ?? '').trim());
      const hit = matchPickerListing(names, capturedListings);
      if (hit === null) continue; // 没有路径就绝不注入（安全侧）
      const listing = capturedListings[hit];
      for (let i = 0; i < rows.length; i++) {
        const button = rows[i] as HTMLButtonElement;
        const entry = listing.byName.get(names[i]);
        if (entry === undefined) continue;
        const rowHost = button.parentElement;
        if (rowHost === null) continue;
        injectRowButton(rowHost, button, entry);
      }
    }
  }
}

// ── 启动 ───────────────────────────────────────────────────────

let observer: MutationObserver | null = null;
let scanTimer = 0;

function scheduleScan(): void {
  // land() 里 200ms 双帧重建会连打多轮 MutationRecord，去抖后只扫最后一次
  if (scanTimer !== 0) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    scanTimer = 0;
    scanPickerDialogs();
  }, SCAN_DEBOUNCE_MS);
}

function startObserver(): void {
  if (observer !== null || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
  observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleScan();
}

/**
 * 包装 window.fetch，捕获官方列表 RPC 的响应（不改变响应本身）。
 *
 * 只有在确认主用户之后才会调用；解析始终用 clone()，任何异常都被吞掉，
 * 原响应照常返回——最坏情况只是拿不到路径（于是不注入按钮），不影响官方功能。
 */
function wrapFetchForListings(): void {
  const original = window.fetch;
  if (typeof original !== 'function') return;
  const wrapped: typeof window.fetch = (input, init) => {
    const response = original.call(window, input as RequestInfo, init as RequestInit);
    void response
      .then((res) => {
        try {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
          const method = (
            init?.method ??
            (input instanceof Request ? input.method : 'GET')
          ).toUpperCase();
          if (method !== 'POST' || !url.endsWith(LIST_ENDPOINT_SUFFIX)) return;
          void res
            .clone()
            .json()
            .then((envelope: unknown) => {
              try {
                for (const entries of extractPickerListings(envelope)) rememberListings(entries);
              } catch {
                /* 形状不符：忽略 */
              }
            })
            .catch(() => {});
        } catch {
          /* 非标准 input：忽略 */
        }
        return res;
      })
      .catch(() => {});
    return response;
  };
  window.fetch = wrapped;
}

/** 启动幂等：插件重载/多次 apply 时不会叠加 observer 或包装层。 */
let started = false;

/**
 * 主用户才启用的目录选择器删除按钮。
 *
 * 先向本插件自己的 /api/dsh-passwords/state 确认角色：非主用户（或探测失败、
 * 未登录）直接返回，连 MutationObserver 都不装——子用户页面零行为变化。
 * 授权由服务端 /gateway/api/fs/delete-directory（requireAdmin）兜底，这里
 * 只是不把用不上的界面递过去。
 */
export function startPickerDelete(): void {
  if (started || typeof document === 'undefined' || typeof window === 'undefined') return;
  started = true;
  void fetch('/api/dsh-passwords/state', { credentials: 'same-origin' })
    .then((response) => response.json())
    .then((data: unknown) => {
      const me = (data as { me?: { role?: unknown } } | null)?.me;
      if (me?.role !== 'admin') return;
      injectStyleOnce();
      wrapFetchForListings();
      startObserver();
    })
    .catch(() => {
      /* 探测失败 = 不启用（fail-closed） */
    });
}
