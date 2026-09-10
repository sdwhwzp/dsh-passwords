# Changelog

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
