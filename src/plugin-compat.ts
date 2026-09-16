// 第三方插件兼容层（唯一允许包含第三方插件路径 / 字段协议知识的模块）。
//
// 设计边界（与官方适配分开）：
//   - 官方 dsh 接口属于宿主适配，直接硬编码在 permissions.ts / gateway.ts；
//   - 第三方插件不做逐插件适配：默认（MCP_GATEWAY_PLUGIN_COMPAT=off）本层全部
//     关闭，未登记的第三方路径对子用户一律 fail-closed，由主用户在端点登记表
//     （MCP_GATEWAY_SSH_ENDPOINTS，支持 owner:/ws:/http: 前缀）显式放行；
//   - 显式打开（=on）时，才启用下列“已知插件”的细粒度适配（等价 2.7.x 行为），
//     用于需要文件树白名单、上传 / 下载门控与内容清洗的插件面板。
//
// 通用化原则：本层只实现“底层逻辑钩子”（路径是否由本层接管、行为门控、字段
// 提取、响应清洗），网关主体（gateway.ts / permissions.ts）对这些钩子的调用
// 方式与插件无关；新增插件适配只改本文件，不改网关主体。

export type EndpointSanitizeKind = 'json' | 'stream';

export interface PluginCompat {
  readonly enabled: boolean;
  /**
   * 根级（非 /api）路径是否由兼容层显式接管：接管后不再按“未登记第三方”
   * 拒绝，而是继续走下面的细粒度门控。仅覆盖被适配的插件面板路径。
   */
  claimsRootPath(pathname: string): boolean;
  /** 插件面板路径（用于 allowedFolders 白名单校验；与 claimsRootPath 同源）。 */
  isPanelPath(pathname: string): boolean;
  /** 文件读取端点（网关按 allow_git_download 门控）。 */
  isFileRead(method: string, pathname: string): boolean;
  /** 文件写入端点（网关按 allow_upload 门控）。 */
  isFileWrite(method: string, pathname: string): boolean;
  /** git / 外带通道端点（网关按 allow_git_download 门控）。 */
  isExfilEndpoint(method: string, pathname: string): boolean;
  /**
   * 从插件请求中提取工作区根路径（`root` 字段协议）。
   * GET/HEAD/DELETE 取 query，POST/PUT 取 JSON body；提取不到返回 null，
   * 调用方必须 fail-closed。
   */
  folderRootFrom(
    method: string,
    pathname: string,
    query: URLSearchParams,
    bodyJson: unknown,
  ): string | null;
  /** 插件轮询 / 事件流端点（不计入每日使用时长配额）。 */
  isPollingEndpoint(pathname: string): boolean;
  /** 需要做“高危上传扩展名”检查的插件上传请求（配合 x-file-name 头）。 */
  isDangerousUploadRequest(method: string, pathname: string): boolean;
  /** 响应体清洗钩子：需要清洗时返回方式，否则 null。 */
  responseSanitizeKind(method: string, pathname: string): EndpointSanitizeKind | null;
}

/** 兼容层关闭时的空实现：所有钩子返回“不匹配 / 不清洗”。 */
const DISABLED: PluginCompat = {
  enabled: false,
  claimsRootPath: () => false,
  isPanelPath: () => false,
  isFileRead: () => false,
  isFileWrite: () => false,
  isExfilEndpoint: () => false,
  folderRootFrom: () => null,
  isPollingEndpoint: () => false,
  isDangerousUploadRequest: () => false,
  responseSanitizeKind: () => null,
};

// ── 已知插件 1：aionui-panel 文件树面板（根级路径 + `root` 字段协议） ──
const PANEL_PREFIX = '/aionui-panel/';

function isPanelPath(pathname: string): boolean {
  return pathname.startsWith(PANEL_PREFIX);
}

function panelFolderRootFrom(
  method: string,
  pathname: string,
  query: URLSearchParams,
  bodyJson: unknown,
): string | null {
  if (!isPanelPath(pathname)) return null;
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
    const root = query.get('root');
    if (root !== null && root.length > 0) return root;
    if (method === 'GET' || method === 'HEAD') return null;
    // DELETE：query 无 root 时兜底读 body
  }
  if (typeof bodyJson === 'object' && bodyJson !== null) {
    const root = (bodyJson as Record<string, unknown>).root;
    return typeof root === 'string' && root.length > 0 ? root : null;
  }
  return null;
}

function panelFileRead(method: string, pathname: string): boolean {
  if (pathname === '/aionui-panel/raw') return method === 'GET' || method === 'HEAD';
  return method === 'POST' && pathname === '/aionui-panel/read';
}

function panelFileWrite(method: string, pathname: string): boolean {
  if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return false;
  return (
    pathname === '/aionui-panel/write' ||
    pathname === '/aionui-panel/delete' ||
    pathname === '/aionui-panel/git-stage' ||
    pathname === '/aionui-panel/git-unstage' ||
    pathname === '/aionui-panel/git-discard'
  );
}

function panelExfil(method: string, pathname: string): boolean {
  return /^\/aionui-panel\/git[-.]/.test(pathname);
}

function panelPolling(pathname: string): boolean {
  return pathname.startsWith('/aionui-panel/events');
}

function panelSanitize(method: string, pathname: string): EndpointSanitizeKind | null {
  if (method === 'POST' && pathname === '/aionui-panel/read') return 'json';
  if ((method === 'GET' || method === 'HEAD') && pathname === '/aionui-panel/raw') return 'stream';
  return null;
}

// ── 已知插件 2：dsh-uploads 共享上传存储（专属请求头 x-file-name） ──
const UPLOAD_PATH = '/api/dsh-uploads';

function dangerousUploadRequest(method: string, pathname: string): boolean {
  return method === 'POST' && (pathname === UPLOAD_PATH || pathname.startsWith(`${UPLOAD_PATH}/`));
}

/**
 * 创建插件兼容层实例。`enabled=false`（默认）返回全空实现：网关对第三方插件
 * 保持通用 fail-closed 姿态；`enabled=true` 时启用已知插件的细粒度适配。
 */
export function createPluginCompat(enabled: boolean): PluginCompat {
  if (!enabled) return DISABLED;
  return {
    enabled: true,
    claimsRootPath: isPanelPath,
    isPanelPath,
    isFileRead: panelFileRead,
    isFileWrite: panelFileWrite,
    isExfilEndpoint: panelExfil,
    folderRootFrom: panelFolderRootFrom,
    isPollingEndpoint: panelPolling,
    isDangerousUploadRequest: dangerousUploadRequest,
    responseSanitizeKind: panelSanitize,
  };
}
