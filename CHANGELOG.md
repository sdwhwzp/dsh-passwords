# Changelog

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
