# Changelog

## 2.7.2 - 2026-09-16

### 中文

更新公告：

1. 官方适配与第三方插件适配正式分界：网关主体（`src/gateway.ts`、`src/permissions.ts`）不再包含任何第三方插件的路径、字段或请求头知识；官方 DSH `0.1.6-alpha.1` 接口（API 命名空间、事件通道、会话/工作区 RPC、上传/git 官方端点）按宿主适配继续硬编码。全部第三方插件知识集中到唯一的新模块 `src/plugin-compat.ts`。
2. 新增 `MCP_GATEWAY_PLUGIN_COMPAT` 开关，**默认关闭**：关闭时网关对第三方插件保持通用姿态——未登记的第三方路径（`/api/*` 与根级插件路由）对子用户一律 fail-closed，放行只走端点登记表；打开时才启用已知插件的细粒度适配（文件树白名单、上传/下载门控、内容清洗、轮询豁免）。
3. 根级路径通用化：新增官方根级白名单（`/`、`/index.html`、`/favicon.ico`、`/assets/*`、`/plugins/*` 与常见静态扩展名），其余非 `/api` 路径按第三方处理。依据：官方 DSH `0.1.6-alpha.1` 的根级资源模型继续由官方 bundle/静态资源服务提供，未知路径不作为网关已知业务路由。
4. 端点登记表合并为一条变量：`MCP_GATEWAY_SSH_ENDPOINTS`，规则语法 `[owner:][ws:|http:]路径`（前缀均可省略、顺序任意）。`owner:` = 仅主用户（子用户两条通道一律 403）；其余规则 = 子用户需「已登记」+「已勾选 SSH 端点权限」两把钥匙。`ws:`/`http:` 限定通道，不写则两条通道都放行；尾部 `/*` 只匹配直接子路径。
5. 清理历史遗留变量、逻辑与代码：删除 `MCP_GATEWAY_OWNER_ONLY_ENDPOINTS`（并入 `owner:` 前缀）、`MCP_GATEWAY_THIRD_PARTY_DEFAULT`（未登记第三方一律拒绝，取消 proxy 兼容模式）、旧变量 `MCP_GATEWAY_SSH_WS_ENDPOINTS` 的并集读取与启动迁移提示、CLI 弃用信息输出，以及网关内按具体第三方插件命名的放行判定；相关细粒度行为集中到默认关闭的通用兼容层。旧带前缀兼容别名（`parseWebSocketAllowlist`、`webSocketPathAllowed`、`endpointAllowedFor`）同步删除。
6. 未经证实的路径移出官方清单：`/api/live-stats` 不再视为官方命名空间（改按第三方 fail-closed）；`/api/pet/*`、`/api/pair/*` 等无法在官方 DSH `0.1.6-alpha.1` 包中证实的轮询路径从配额豁免移除（同时保留已验证的 0.1.5 兼容边界，以及通用 `heartbeat`/`poll` 正则与官方事件通道）。
7. 安装器模板移除第三方 native 构建许可：`scripts/register-plugin.mjs` 的 `allowBuilds` 只保留官方依赖链（`node-pty`、`protobufjs`），移除 `ssh2`、`cpu-features`；第三方插件需要时由 pnpm 官方提示流程按需添加。
8. 登记表运维可见性：`/gateway/api/overview` 只返回 `endpoints`（带前缀规则）与 `pluginCompat`；移除 2.7.x 兼容字段（`sshWebSocketEndpoints`、`ownerOnlyEndpoints`、`thirdPartyDefault`）。前端 `allowSsh` 开关与设置面板行为不变。
9. Docker Compose 收敛为唯一 bundled 入口：内置 DSH `0.1.6-alpha.1`，转发 `MCP_GATEWAY_SSH_ENDPOINTS` 与 `MCP_GATEWAY_PLUGIN_COMPAT`，移除旧 `MCP_GATEWAY_SSH_WS_ENDPOINTS` 与重复 Compose 文件。
10. 版本标记为 `2.7.2`。本地源码、npm 元数据、Docker 配置和文档统一使用该版本号；是否发布 npm 包与 GitHub Release 仍由发布流程单独决定。
11. 子用户新建工作区工作流收紧（D1）：`workspace/create` 只接受「主用户显式分配的精确目录、该子用户自己创建的工作区子树、刚通过目录选择器成功创建且未过期的目录（30 分钟）」三类凭据，其余一切预存在目录一律 403；目录创建的合法父目录为「授权子树（原始串+真实路径双判定堵符号链接逃逸）、主目录（picker 落点与工作区惯例父目录）、自己刚创建的目录内」，且不得落在另一子用户的工作区子树内（单向包含，共享分配根下建兄弟目录不受影响）；刚创建的目录在过期前作为临时授权根——选择器中立即可见/可进入；`workspace/create` 成功后原子写入所有权与白名单，同步更新 workspaceId→path 映射并向已建立 Remote mux 连接补发过滤后的 upsert，紧随其后的新建会话不再被 403；`directoryPicker/list`（含旧 host.listDirectory）对子用户限权：请求路径必须在授权子树/自己的临时根内（完整列表）或是通往授权根的祖先（响应仅保留通往授权根的条目，其余目录名隐藏），其余 403；`__deny__`（禁止所有工作区）下不开放任何创建/登记通道。另：孤儿所有权行（已删除用户残留）不再阻断目录可见性与登记——判定要求物主存在且为子用户，删用户级联清理所有权行，启动迁移幂等清除历史残留；`permissionPresets` 补入官方命名空间（alpha.1 官方权限预设目录），`terminal` 命名空间故意不开放（远程 shell = 沙箱逃逸）；session.create/fork 上游 4xx/5xx 非 JSON 响应原样透传，不再伪装成 502。
12. 发布收口修复：`patch` 子命令不再强制要求 `SETUP_KEY`（DSH 已卸载/`.env` 已删时回滚仍可完成，稳定退出码 34 保持）；安装器预构建依赖检测补齐 `ws`（避免残缺安装误判已构建）；gate-only Docker 镜像补默认 `CMD`（修复容器静默退出）；`install.sh` 非 root 首次安装提前报错（README 一键命令改用 `sudo bash`）；网关启用 `trust proxy = loopback`（反代后按真实客户端 IP 节流，不再全局共享计数）；目录选择器删除按钮的列表采集只信 `entries` 键（排除 `crumbs` 面包屑与 `truncated` 截断列表，子序列回退同长度歧义时拒绝注入——修复删除按钮可能误绑父目录路径的高危缺陷）；前端状态色令牌改用官方 `--dsw-alias-state-*`（原 `semantic-*` 在 0.1.6-alpha.1 主题包中不存在，深色主题下对比度不足）；聊天轮询把协议层 `ok=false` 纳入失败退避；附件重试回队调度（不再绕过并发上限）；右侧栏文件下载按钮的持续旋转改为点击瞬间轻震反馈（`navigator.vibrate` 渐进增强 + 弹簧回弹，尊重 `prefers-reduced-motion`）。
13. 发布前三件套审查修复（第二轮）：① 聊天上传队列补位——并发槽位释放后立即调度排队附件，第 4 个及之后的图片/视频不再永久卡在 queued 而阻塞发送；② 网关不再被单个叼形 WebSocket 帧击穿——Remote mux 与子用户事件通道的客户端连接补 `error` 监听，未加掩码等协议错误只断开该连接（而非 uncaughtException 终止进程）；③ `npm-shrinkwrap.json` 全部改指官方 npm registry（651 条第三方镜像地址清零，完整性校验不变）；④ `install.sh` 非 root 首次安装提前报错、重跑识别已有安装就地幂等执行，`install.bat` 同样支持就地重跑并规范化安装目录；⑤ `patch` 在补丁目标缺失时以稳定退出码 35 结束（Docker entrypoint 不再把“什么都没补”当成功）；⑥ 插件自动拉起不再为永久性错误（34/35/36）每秒无限重启；⑦ `.dockerignore` 排除 `docs/`、`test/`、`alpha1-observation/` 等非构建上下文。

验证：382/382 本地回归测试、TypeScript 构建、npm pack 内容检查（77 文件）、`git diff --check` 通过；测试服务器已部署 `2.7.2`（备份 `20260916-140748Z`），healthz/readyz/补丁状态全部通过；真实账号 E2E：模型/媒体矩阵 31/31、下载端点与终端伪装 14/14。

### English

Release notes:

1. Official vs third-party adaptation is now a hard boundary: the gateway core (`src/gateway.ts`, `src/permissions.ts`) carries no third-party plugin path, field, or header knowledge; official DSH `0.1.6-alpha.1` interfaces (API namespaces, event channels, session/workspace RPCs, and official upload/git endpoints) remain host adaptations. All third-party plugin knowledge now lives in one module, `src/plugin-compat.ts`.
2. New `MCP_GATEWAY_PLUGIN_COMPAT` switch, **off by default**: with it off the gateway keeps a generic posture — unregistered third-party paths (`/api/*` and root-level plugin routes) are fail-closed for subusers, and access is granted only through the endpoint registry; turning it on enables fine-grained adapters for known plugins (file-tree whitelisting, upload/download gating, content sanitising, polling exemptions).
3. Generic root-level posture: a new official root allowlist (`/`, `/index.html`, `/favicon.ico`, `/assets/*`, `/plugins/*`, plus common static file extensions); every other non-`/api` path is treated as third-party. Rationale: the official DSH `0.1.6-alpha.1` bundle/static resource model serves the known root assets, while unknown paths are not treated as gateway business routes.
4. One unified registry variable: `MCP_GATEWAY_SSH_ENDPOINTS` with rule syntax `[owner:][ws:|http:]path` (prefixes optional, order-agnostic). `owner:` rules are owner-only (subusers get 403 on both transports); all other rules require both the owner registration and the subuser's SSH toggle. `ws:`/`http:` restrict a rule to one transport; a trailing `/*` matches direct child paths only.
5. Removes legacy variables, logic, and code: `MCP_GATEWAY_OWNER_ONLY_ENDPOINTS` (folded into the `owner:` prefix), `MCP_GATEWAY_THIRD_PARTY_DEFAULT` (unregistered third-party paths are always denied; the `proxy` escape hatch is gone), the legacy `MCP_GATEWAY_SSH_WS_ENDPOINTS` union read and its startup migration notice, and the CLI deprecation output. Plugin-specific gateway allowlist matchers are replaced by the generic classifier and the default-off compat layer. Legacy aliases (`parseWebSocketAllowlist`, `webSocketPathAllowed`, `endpointAllowedFor`) are removed as well.
6. Moves unverified paths out of the official list: `/api/live-stats` is no longer treated as an official namespace (fail-closed as third-party), and `/api/pet/*`, `/api/pair/*` and similar polling paths that cannot be verified in the official DSH `0.1.6-alpha.1` packages are no longer exempted from usage accounting (the tested 0.1.5 compatibility boundary, generic `heartbeat`/`poll` patterns, and official event channels remain).
7. Installer template drops third-party native build permissions: `allowBuilds` in `scripts/register-plugin.mjs` now keeps only official dependency-chain entries (`node-pty`, `protobufjs`) and removes `ssh2`/`cpu-features`; third-party plugins add their keys through pnpm's own prompt flow when needed.
8. Registry ops visibility: `/gateway/api/overview` now returns only `endpoints` (prefixed rules) and `pluginCompat`; the 2.7.x compatibility fields (`sshWebSocketEndpoints`, `ownerOnlyEndpoints`, `thirdPartyDefault`) are gone. The frontend `allowSsh` toggle and settings panel behaviour are unchanged.
9. Docker Compose is consolidated to one bundled entrypoint: it includes DSH `0.1.6-alpha.1`, forwards `MCP_GATEWAY_SSH_ENDPOINTS` and `MCP_GATEWAY_PLUGIN_COMPAT`, and removes the legacy `MCP_GATEWAY_SSH_WS_ENDPOINTS` plus the duplicate Compose file.
10. Version marked `2.7.2`; npm and GitHub publication remain separate release steps.
11. Subuser workspace-creation workflow tightened (D1): `workspace/create` accepts only three credentials — a directory the owner explicitly assigned (exact match), the subuser's own created workspace subtree, or a directory just created through the directory picker (30-minute window); every other pre-existing directory is rejected with 403. Directory creation re-checks the parent against the allowed subtree using the filesystem-real path (realpath) to close symlink escapes, and neither directory creation nor registration may reach into another subuser's owned subtree (one-way containment: siblings under a shared assigned root stay allowed). A successful registration atomically records ownership and the folder grant, updates the workspaceId→path mapping, and pushes a filtered upsert to the subuser's live Remote mux connections so an immediately following session create is no longer 403. `directoryPicker/list` (and the legacy `host.listDirectory`) is now gated for subusers: the requested path must be inside the allowed subtree (full listing) or an ancestor on the way to an allowed root (responses keep only entries leading there, hiding unrelated directory names); anything else is 403.
12. Release closeout fixes: the `patch` subcommand no longer requires `SETUP_KEY` (rollback still completes after DSH removal; stable exit code 34 preserved); the installer's prebuilt-runtime check now includes `ws` (incomplete installs are no longer misdetected as built); the gate-only Docker image gains a default `CMD` (fixing silent container exit); `install.sh` fails fast for non-root first installs (the README one-liner now uses `sudo bash`); the gateway enables `trust proxy = loopback` (per-client rate limiting behind a reverse proxy instead of one shared counter); the directory-picker delete button now trusts only `entries` arrays (excluding `crumbs` ancestors and `truncated` listings, and refusing ambiguous equal-length subsequence matches — fixing a hazardous case where the button could bind a parent directory path); frontend state colours use the official `--dsw-alias-state-*` tokens (the previous `semantic-*` names do not exist in the 0.1.6-alpha.1 theme, hurting dark-theme contrast); chat polling counts protocol-level `ok=false` as failure for backoff; attachment retries re-enter the queue scheduler (no longer bypassing the concurrency cap); and the sidebar file-download button replaces its spinning animation with an instant tap feedback (`navigator.vibrate` progressive enhancement plus a spring settle, respecting `prefers-reduced-motion`).
13. Pre-release review fixes (second round): (1) the chat upload queue now promotes queued attachments as soon as a slot frees, so a 4th+ image/video no longer sticks in `queued` and blocks sending; (2) a single malformed WebSocket frame can no longer kill the gateway — the Remote mux carrier and the subuser event channels now handle client `error` events, so protocol failures such as an unmasked frame close that connection instead of raising an uncaughtException; (3) `npm-shrinkwrap.json` now resolves entirely against the official npm registry (the 651 third-party mirror URLs are gone, integrity hashes unchanged); (4) `install.sh` fails fast for non-root first installs and resumes idempotently when a dsh-passwords install already exists, and `install.bat` supports the same in-place resume with a normalised install directory; (5) `patch` exits with stable code 35 when the patch target is missing, so the Docker entrypoint no longer reports success for an unpatched container; (6) the plugin's gateway autostart no longer retries permanent failures (34/35/36) every second; (7) `.dockerignore` excludes `docs/`, `test/`, and `alpha1-observation/` from the build context.

Validation: 382/382 local regression tests (two new WebSocket error-handling regressions), the TypeScript build, the npm pack content check (77 files), and `git diff --check` passed; the test server runs `2.7.2` (backup `20260916-140748Z`) with healthz/readyz and patch status all green; real-account E2E: model/media matrix 31/31, download-endpoint and terminal-stub checks 14/14.


## 2.7.1 - 2026-09-11

### 中文

更新公告：

1. 兼容 DSH `0.1.5` 全版本（alpha.1 / alpha.2 / rc.1 / rc.2）：补丁锚点与 Cookie 桥校验覆盖整个 rc 系列，rc.2 的反馈弹窗与交付文件卡片等界面更新已实测兼容，bundled Docker 内置 DSH `0.1.5-rc.2`。
2. 修复显式 SSH WebSocket 端点尾部通配规则未实际命中的问题；通配只放行直接子路径，不放行基路径或更深路径。
3. 加固自动更新引擎：重复启动不再叠加轮询器，释放时清理定时器；更新接口状态码统一为 202/429/422，不再把业务错误误报为 409。
4. 设置界面与登录页动效按 iOS 手感细化：分区错落进场、开关弹簧滑动、按钮按压反馈、状态与错误进场动画；全部只动 transform/opacity/box-shadow 并尊重 prefers-reduced-motion。
5. 清理无效示例配置项，完成全量逻辑、权限、生命周期、安装与依赖审计，保留旧数据库迁移所需兼容字段。

验证：282/282 本地回归测试、TypeScript 构建、npm 官方 registry 生产依赖审计、发布包内容与 Git 差异检查通过；测试服务器以 DSH `0.1.5-rc.2` 实际部署，反馈与交付文件 bundle 与官方 npm 产物逐字节一致。

### English

Release notes:

1. Compatible with the whole DSH `0.1.5` line (alpha.1 / alpha.2 / rc.1 / rc.2): patch anchors and the Cookie-bridge check cover the full rc series, the rc.2 feedback-dialog and delivered-file-card UI refinements are verified compatible, and the bundled Docker image ships DSH `0.1.5-rc.2`.
2. Fixes explicit SSH WebSocket endpoint suffix wildcards that were accepted by configuration but never matched at upgrade time; wildcards now allow direct child paths only, never the base or deeper descendants.
3. Hardens the automatic-update engine: repeated starts cannot stack polling timers, disposal clears the active timer, and update API statuses are normalized to 202/429/422 instead of misreporting business errors as 409.
4. Refines the settings UI and sign-in page motion to an iOS-like feel: staggered section entrances, spring-loaded toggles, pressed-button feedback, and entrance animations for statuses and errors; all motion stays on transform/opacity/box-shadow and respects prefers-reduced-motion.
5. Removes an ineffective example configuration option and completes a full logic, authorization, lifecycle, installation, and dependency audit while retaining the legacy database field required for migration compatibility.

Validation: 282/282 local regression tests, the TypeScript build, the official-registry production dependency audit, package-content checks, and Git whitespace checks passed; the test server runs DSH `0.1.5-rc.2`, and the feedback/deliverable bundles are byte-identical to the official npm artifacts.

## 2.7.0 - 2026-09-10

### 中文

更新公告：

1. 兼容 DSH `0.1.5` 全系列（alpha.1 / alpha.2 / rc.1）：会话、Remote mux、Cookie 桥与设置补丁全部按 `0.1.5` 边界验证，bundled Docker 内置 DSH `0.1.5-rc.1`。
2. 网关通用化：SSH 端点完全由 `MCP_GATEWAY_SSH_WS_ENDPOINTS` 显式配置，不再探测任何特定插件；非 SSH 第三方 WebSocket 对子用户一律 fail-closed，移除插件专属放行。
3. 退役逐路径 WebSocket 授权（`allowed_websocket_paths`）死代码与废弃环境变量，数据层保留旧列兼容既有数据库。
4. 设置页优化：权限保存确认就地显示在子用户权限块内；添加子用户表单置顶；SSH 权限仅显示开关名称；移除多条静默提示；修复更新状态轮询在「发现新版本但未开始下载」时的空转循环。
5. 清理发布物与文档：安装器、Docker、README、兼容性矩阵与示例配置全部与当前通用模型对齐，移除历史插件残留引用。
6. 本次审计使用模型 deepseek-V4.1-flash。

验证：277/277 本地回归测试、TypeScript 构建、Git 差异检查通过；本地以 DSH `0.1.5-rc.1` 实际部署验证前后端基础功能。

### English

Release notes:

1. Compatible with the whole DSH `0.1.5` line (alpha.1 / alpha.2 / rc.1): sessions, Remote mux, the Cookie bridge and the settings patch are all verified against the `0.1.5` boundaries; the bundled Docker image ships DSH `0.1.5-rc.1`.
2. Gateway generalization: SSH endpoints are configured exclusively through `MCP_GATEWAY_SSH_WS_ENDPOINTS` with no plugin-specific probing; all other third-party WebSocket paths stay fail-closed for subusers.
3. Retires the per-path WebSocket grant dead code (`allowed_websocket_paths`) and deprecated environment variables; the database column is kept for compatibility with existing databases.
4. Settings UI polish: the save confirmation now appears inside the subuser permissions block, the add-subuser form moves to the top, the SSH toggle shows only its label, several passive hints are removed, and the update-status polling no longer spins while a new version is discovered but not yet downloading.
5. Release hygiene: installers, Docker, README, the compatibility matrix and the example configuration are all aligned with the current generic model, with historical plugin-specific references removed.
6. This audit used model deepseek-V4.1-flash.

Validation: 277/277 local regression tests, the TypeScript build, and Git whitespace checks passed; frontend and backend basics were verified against a locally deployed DSH `0.1.5-rc.1`.

## 2.6.11 - 2026-09-05

### 中文

更新公告：

1. 兼容 DSH `0.1.2` 与 `0.1.3` 的接口和运行时结构，bundled Docker 继续以内置 DSH `0.1.2-rc.1` 为主目标。
2. 修复 Issue #29 相关的 Remote mux 历史加载可靠性：浏览器连接增加 heartbeat，支持 DSH `0.1.2`/`0.1.3` 的大历史快照，并校验 `session/follow` 快照身份后再转发。
3. 补齐新会话 API 的子用户资源授权：文件上传与引用、Skill、消息反馈、目标、动态 Cordis runner、模型选择和会话引用检索均在到达 DSH 前按当前会话授权过滤。
4. 清理过期会话授权：保存权限时移除已失效的历史会话，但仍拒绝从未验证过的会话 ID，避免陈旧授权阻塞有效分配。
5. 简化子用户 SSH：主用户配置的主机摘要可供开启 SSH 且勾选 SSH 端点的子用户使用；子用户不能新增、导入、修改主机或使用 cluster/tunnel，主机密码与私钥仍不会返回浏览器。

验证：275/275 本地回归测试、TypeScript 构建、npm 官方 registry 生产依赖审计、发布包内容和 Git 差异检查通过。Docker 镜像发布前以 DSH `0.1.2-rc.1` 构建并核验。

### English

Release notes:

1. Adds compatibility with the DSH `0.1.2` and `0.1.3` API and runtime boundaries; bundled Docker continues to target the included DSH `0.1.2-rc.1` runtime.
2. Fixes Remote mux history-loading reliability related to Issue #29: browser connections now send heartbeats, large DSH `0.1.2`/`0.1.3` history snapshots are supported, and `session/follow` snapshot identity is verified before forwarding.
3. Completes subuser resource authorization for newer session APIs. File uploads and references, Skills, message feedback, goals, dynamic Cordis runner calls, model selection, and session-reference lookup are filtered against the current session grant before reaching DSH.
4. Improves multi-user assignment saves: stale historical session grants are removed while never-validated session IDs remain rejected, so obsolete grants no longer block valid assignments.
5. Simplifies subuser SSH access: an owner-configured host summary can be used by a subuser only when SSH and the SSH endpoint are enabled; subusers cannot add, import, modify hosts, or use cluster/tunnel operations, and passwords/private keys never reach the browser.

Validation: 275/275 local regression tests, the TypeScript build, the official-registry production dependency audit, package-content checks, and Git whitespace checks passed. The Docker image is built with DSH `0.1.2-rc.1` and verified before publication.

## 2.6.10 - 2026-09-04

### 中文

更新公告：

1. 兼容 DSH `0.1.2-rc.1`。安装器、bundled Docker 默认运行时、补丁探测与启动前 Cookie bridge 校验已切换到 rc.1，并继续保留已知 `0.1.2-alpha.1` 至 `alpha.5` 布局的兼容适配。
2. 增加 RC.1 子代理基础兼容：已获父会话授权的用户可使用普通会话与 `subagent` 地址格式的历史分页、实时 `session/follow`、继续任务和中断；`parentSessionId`、`childSessionId` 与 `mode` 原样交由 DSH 校验，child session 不会写入普通授权表。
3. 修复多用户搜索隔离：`session/search` 仅向子用户返回其当前已授权且未被禁用的会话结果，避免暴露未授权会话 ID 与消息摘要。
4. 增加子用户 SSH 连接权限开关和主机 alias 归属隔离。启用后，子用户只能查看、创建和使用自己通过网关认领的 SSH 主机；共享导入、隧道和管理员全局主机仍保持主用户专属。
5. 完整移除部署 profile 中不兼容的 `@linxin666/dsh-web-all` 聚合插件，避免其独立设备配对传输干扰网关认证和造成插件加载失败；DSH 核心 Web App 与 dsh-passwords 保持独立运行。

验证：全量本地回归测试 263/263、TypeScript 构建、npm 官方 registry 生产依赖审计和发布包内容检查通过。Docker 镜像在发布前执行构建并校验内置版本。

### English

Release notes:

1. Adds compatibility with DSH `0.1.2-rc.1`. The installers, bundled Docker runtime, patch detection, and startup Cookie-bridge validation now target rc.1 while retaining adapters for the known `0.1.2-alpha.1` through `alpha.5` layouts.
2. Adds baseline RC.1 subagent compatibility. Users authorized for a parent session can use ordinary and `subagent` address forms for history paging, live `session/follow`, continuation, and interruption. `parentSessionId`, `childSessionId`, and `mode` are forwarded unchanged for DSH validation, and child sessions are not persisted as ordinary grants.
3. Fixes multi-user search isolation: `session/search` now returns only currently authorized, enabled sessions to a subuser, preventing exposure of unauthorized session IDs and message summaries.
4. Adds a subuser SSH permission toggle and per-user SSH host-alias ownership. When enabled, a subuser can only view, create, and use SSH hosts claimed through the gateway; shared imports, tunnels, and administrator-global hosts remain owner-only.
5. Fully removes the incompatible `@linxin666/dsh-web-all` aggregate plugin from the deployment profile. Its independent device-pairing transport could conflict with gateway authentication and trigger plugin-loader failures; the core DSH Web App and dsh-passwords now run independently.

Validation: 263/263 local regression tests, the TypeScript build, the npm official-registry production dependency audit, and package-content checks passed. The Docker image is built and its embedded versions are verified before publication.

## 2.6.9 - 2026-09-03

### 中文

更新公告：

1. 修复弱网络下新建会话的最终工作区归属同步：即使首次 `workspace/follow` 增量丢失，创建成功后也会向现有连接补发经过权限校验的工作区更新，避免会话落入“未分组”。
2. 加强主用户权限分配清单的实时校验：已删除、已归档、目录缺失或当前不可用的工作区/会话不再显示为可分配资源，资源状态不可确认时保存操作安全失败。

验证：本地全量测试、TypeScript 检查、构建、生产依赖审计和发布包内容检查均通过后发布。

### English

Release notes:

1. Fixes final workspace assignment under weak networks: even when the first `workspace/follow` delta is lost, a successful session creation sends a permission-checked compensating workspace update to existing connections, preventing the session from appearing under “Ungrouped”.
2. Strengthens the owner-side assignment inventory with live validation: deleted, archived, missing-directory, or otherwise unavailable workspaces and sessions are no longer assignable, and saving fails closed when the resource authority cannot be confirmed.

Validation: the release is published after the full local test suite, TypeScript check, build, production dependency audit, and package-content checks pass.

## 2.6.8 - 2026-09-03

### 中文

更新公告：

1. 兼容 DSH `0.1.2-alpha.1` 至 `0.1.2-alpha.5`。alpha.1 为源码运行时兼容目标，npm/Docker bundled 安装默认使用并内置 alpha.5。
2. 修复 Issue #25：主用户授予子用户既有工作区和会话后，子用户可以正确看到并选择这些资源；工作区与会话加载竞态不会再把授权资源显示为“无工作区”或在选择后清退。
3. 完善 alpha Remote mux 的多用户隔离：workspace/session 基线、显式会话授权、事件流和权限变更后的连接刷新均按当前用户权限重新校验。
4. 加固子用户权限端到端执行：沙盒确认失败时拒绝创建会话，工作区创建与管理、上传、Git 下载、Agent preset、WebSocket、封禁和逐会话关闭保持独立边界；部分权限更新不会意外恢复既有限制。
5. bundled Docker 默认携带 DSH `0.1.2-alpha.5`，npm 包、GitHub 源码和 Docker 构建使用同一份预构建产物。

验证：本地全量测试、TypeScript 检查、构建、生产依赖审计和发布包内容检查均通过后发布。

### English

Release notes:

1. Supports DSH `0.1.2-alpha.1` through `0.1.2-alpha.5`. Alpha.1 remains a source-runtime compatibility target; npm/Docker bundled installs use and include alpha.5 by default.
2. Fixes Issue #25: when the owner grants an existing workspace and its sessions to a subuser, the subuser can see and select them correctly. Workspace/session loading races no longer turn granted resources into “no workspace” or remove them after selection.
3. Strengthens multi-user isolation for the alpha Remote mux: workspace/session baselines, explicit session grants, event streams, and reconnects after permission changes are revalidated against the current user.
4. Enforces subuser permissions end to end: failed sandbox confirmation rejects session creation; workspace management, uploads, Git downloads, Agent presets, WebSockets, bans, and per-session disablement retain separate boundaries. Partial permission updates cannot accidentally restore existing restrictions.
5. The bundled Docker image now includes DSH `0.1.2-alpha.5`; the npm package, GitHub source, and Docker build use the same prebuilt artifacts.

Validation: the release is published after the full local test suite, TypeScript check, build, production dependency audit, and package-content checks pass.
