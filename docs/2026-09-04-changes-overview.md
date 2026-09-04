# 2026-09-04 本次改动清单

> 记录 2026-09-04 在一次“全仓库 fork 同步 + Harness 升级到 0.1.2-rc.1 + 本机部署”任务中实际产生的所有代码、配置与服务改动，便于复核与回退。上一轮记录见 `docs/2026-09-03-changes-overview.md`。

本轮把 `deepseek-harness` 从 `0.1.2-alpha.5` 升到 `0.1.2-rc.1`，同步了全部 11 个插件仓库，把 6 个业务插件适配到 rc.1，并完成本机（macOS 开发机）部署。28 服务器部署未开始。

## 1. 各仓库最终状态

全部已推送。

| 仓库 | 分支 | HEAD | 版本 |
|---|---|---|---|
| deepseek-harness | `tzwl` | `d3ba3b526f` | `0.1.2-rc.1` |
| macproject/dsh-web | `master` | `5e65a315` | `0.1.1` |
| macproject/dsh-passwords | `feature/principal-budget-webdav` | `da30714` | `2.6.17` |
| macproject/dsh-plugin-subscriptions | `dev` | `cccd8ee` | `0.6.3` |
| macproject/dsh-weknora | `main` | `c18031b43` | `0.1.2` |
| macproject/dsh-at-file | `dev` | `23ef15c` | `0.7.2` |
| macproject/dsh-genui | `dev` | `751fe8b` | `0.9.8` |
| macproject/dsh-better-sidebar | `main` | `f59ffd0` | `0.18.0` |
| macproject/dsh-spend | `feature/principal-budget-webdav` | `10c5f60` | `0.6.5` |
| macproject/nas | `main` | `e117e59` | `0.2.5` |
| dsh-shandong-tizhi-brand | `main` | 未改动 | `1.0.3` |

## 2. deepseek-harness：合并 upstream 到 0.1.2-rc.1

`tzwl` 合并 `upstream/master` 的 63 个提交（alpha.5 → rc.1），合并提交 `d3ba3b526f`；镜像分支 `master` 快进到 `upstream/master` 并推送，保持“fork 镜像只装作者代码”。

**唯一冲突**：`python/sdk-runtime/package.json` 的依赖清单。按并集解决——保留 fork 独有的 `dsh-api-gateway`、`dsh-principal-access`、`dsh-storage`、`dsh-storage-domain`、`dsh-workspace`，加入 upstream 新增的 `dsh-http-proxy`。解析后核验 129 个依赖全部对应真实 workspace 包，无幽灵依赖。

`pnpm install --frozen-lockfile` 通过（锁文件在合并中已正确自动合并），`pnpm run typecheck` 与 `pnpm run build` 均通过。

## 3. dsh-web：同步上游并按决定移除三个插件

先把本地 `dev` 快进到 `origin/dev`（原落后 296），再合并 `upstream/dev`；随后把 `dev` 合并进部署分支 `master`。

**移除三个插件**（经确认后执行，跟随上游）：`dsh-aionui-panel`、`dsh-chat-recovery`、`dsh-desktop-launcher`。其中 desktop-launcher 是上游提交 `55d5a1d3` 主动移除；另两个在 dev 线上早已删除。仓库内其余引用均为“已移除”的文档记述，`dsh-web-all` 未聚合它们。

**冲突处理**：
- `dsh-remote-web-ui`（5 个文件）保留 `master` 的 **0.4.0** 面貌（issued link、无桌面页脚入口），采用 dev 的依赖线（`^0.1.2-rc.1`）。合并后的 `src/client/index.ts` 经核验既无页脚入口，又保留了 dev 的 cordis `Context`、`ui-renderer` slot 注册与 `startMobileAdapt`。
- `dsh-pet/README.i18n.yaml` 与 `dsh-remote-web-ui/README.i18n.yaml` 的双语摘要**重新录制**（两侧摘要都因 README 自动合并而失效），重录值与实际文件哈希一致。
- 顺带清除删除造成的陈述性错误：根 README 的「桌面启动器」条目、remote-web-ui 的「四个控制面…桌面启动器」改为三个。

**过程中的一次纠正**：最初在过时的本地 `master`（落后 `origin/master` 309 个提交）上工作，发现后重置到 `origin/master` 重做。原先那些“未提交的 dsh-pet 改动”实为远程早已完成工作（`c7811320`、`42e72271`）的本地残留，内容经逐字节比对确认等价，无损失。

## 4. 各插件仓库同步

反复出现的模式：**多个仓库的“未提交改动”其实是远程已完成工作的陈旧本地残留**。凡逐字节比对确认等价的均丢弃或 stash；真正独有的工作全部保全。

- **dsh-plugin-subscriptions**：快进 75 个提交。本地新增的 `src/image-commands.ts`、`test/image-commands.spec.ts` 与远程**逐字节相同**。WIP 存入 `stash@{0}`。
- **dsh-weknora**：快进 2 个提交。本地改动是更旧版本（0.1.1 / dsh 0.1.0-rc.8），被远程 0.1.2 完全取代。WIP 已 stash。
- **dsh-at-file**：本地提交 `06b57ca` 的内容（含 `scripts/link-runtime-peers.mjs`）与远程**逐字节相同**，重置到 `origin/dev`，备份 ref `backup/dev-before-sync-20260904`。
- **dsh-genui**：快进 21 个提交。丢弃对 `lib/assets/echarts.js` 的本地修改——上游提交 `4cffdba` 已**停止跟踪 `lib/`**（改为 npm 安装）。
- **dsh-better-sidebar**：原 `origin` 指向第三方原作者 `omdsh-dev/DSH-better-sidebar`。已重配为 `origin` = 自己的 fork `sdwhwzp/DSH-better-sidebar`、`upstream` = 原作者。本地检出落后 557 个提交；其未提交的**编辑器下载按钮**经核实为真正独有工作（上游 `api.ts` 有 `downloadUrl` 但 `EditorHost.tsx` 无该按钮），已提交并推送到新分支 `fix/universal-file-download` 保全，本地 `main` 更新到 `upstream/main`（0.18.0）。
- **dsh-spend / nas / dsh-shandong-tizhi-brand**：本已与 origin 同步。

**删除的旧克隆**：`~/dsh-passwords`（独立的第二个克隆，0 个独有提交、无 stash、无任何配置引用，profile 用的是 `macproject/dsh-passwords`）。

## 5. 六个插件适配 Harness 0.1.2-rc.1

升级 harness 后，所有业务插件仍钉在 alpha.3/alpha.4，`dsh-passwords` 因对等依赖冲突（`dsh-session-projection@rc.1` 要求 `dsh-session@^rc.1`，与 `dsh-agent@alpha.4` 互斥）连依赖都装不上。

各仓库的 `@deepseek-ai/*` 声明升到 `0.1.2-rc.1`，`@deepseek-ai/cordis` 升到 `^4.0.2`：dsh-passwords 43 处、dsh-at-file 13 处、dsh-plugin-subscriptions 9 处、nas 8 处、dsh-spend 6 处、dsh-weknora 2 处。

### 关键约束：插件必须对着 fork 的 harness 构建编译

升到 npm 的 `0.1.2-rc.1` 后 `dsh-passwords` 仍报 3 个类型错误（`ConnectionPrincipalRequest`、`RequestPrincipalProvider`、`TypertGateway.currentPrincipal` 不存在）。核实后确认：**principal / 租户隔离 API 是本 fork 独有的自定义，npm 上游包（alpha.4 与 rc.1 都）没有**；此前能编译是因为 `node_modules/@deepseek-ai/*` 指向本地 fork 构建产物。

按 `scripts/link-runtime-peers.mjs` 的思路，把 fork harness 的对应包链接进各插件的 `node_modules`（dsh-passwords 23、dsh-plugin-subscriptions 23、dsh-at-file 16、nas 9、dsh-spend 8、dsh-weknora 2，共 58 个，0 缺失），类型错误随即全部归零。

**跨机器部署必须复现这一步**：只改版本号而不把依赖解析指向 fork 构建，编译必然失败。

### 构建与测试

全部构建通过。`dsh-passwords` 测试 384 项中 369 通过、2 失败：
- `Harness peer and compiler dependencies stay pinned to Alpha.4` —— 该测试断言依赖钉在 alpha.4，已随行为一起更新为 rc.1（重跑 20/20 通过）。
- `Windows 网页 URI 自动启用 Shell…` —— `companion did not connect and send hello` 超时；单独重跑 **7/7 通过**，确认为并发下的子进程时序抖动，非 rc.1 回归。

## 6. dsh-task-board：停止重试部署已拒绝的读取

提交 `5e65a315`（dsh-web）。

`dsh-task-board` 的后台轮询以匿名身份调 `session/list`，在本部署下每轮都抛 `PrincipalAccessDeniedError` 并打 error 日志。

查明这是**设计使然而非缺陷**：`packages/identity/principal-access` 的 `resolvePrincipalAccess` 是 fail-closed 的——一旦部署注册了 `principalAccess` 提供方（dsh-passwords 正是），**所有无身份调用一律拒绝，没有内部调用的例外通道**。后台轮询器不可能满足它。

**未采用**给轮询器一个管理员身份的做法：那会让看板跨租户读到全部会话。改为沿用插件已有的降级模式——识别 `PRINCIPAL_ACCESS_DENIED` 后只警告一次、关闭名单自动发现、执行检查保持 pending。验证：重启后 `PrincipalAccessDeniedError` 出现 0 次，一次性警告恰好 1 次；插件测试 314 passed / 1 skipped / 0 失败。

## 7. Web Profile 配置改动

`~/.dsh/profiles/web/`。备份见 `~/.dsh/profile-backups/20260904-160639-remove-3-plugins/` 与 `20260904-163418-upgrade-sidebar-genui/`（含 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`、两个 plist 及 `.env` 与其 SHA-256）。

- **移除三个已删插件**：`@linxin666/dsh-chat-recovery`、`@linxin666/dsh-client-ui-aionui-panel`、`@linxin666/dsh-desktop-launcher` 从 `dependencies` 与 `dsh.profile.bundles` 中删除（30 → 27 项），并同步删除 `dsh-passwords/scripts/profile-plugins.json` 中对应的 3 个 `localWorkspacePackages` 条目，避免清单把它们装回。
- **`dshmarket` `^1.19.0` → `^1.39.0`（实装 1.40.0）**：旧版 import 了 rc.1 已移除的 `installSettingsSection`，导致插件树加载失败。harness 的 `apps/cli` 自身依赖的正是 `^1.39.0`。
- **`dsh-better-sidebar` `0.15.2` → `0.18.0`**。
- **`@changfenhuang/dsh-genui`** 指向新构建的 `plugin-artifacts/dsh-genui/dev-751fe8b/changfenhuang-dsh-genui-0.9.8.tgz`（原为 `dev-d8e82c5` 的 0.9.6）。genui 必须用 **pnpm** 安装（它依赖 `link:../deepseek-harness/vendor/cordis`，npm 不支持该协议）。
- **`cordis.patch.yml` 修正重复条目**：原先用 `insert` 插入 `dsh-nas-webdav`，而该 id 已由 nas 的 bundle patch 插入，导致 `duplicate loader entry id: dsh-nas-webdav`（错误日志累计 112 次）。改为**按 id 覆盖配置**，与文件中 `web-ui-remote-web-ui` 的写法一致。这正是运维手册 `## 7.6` 警告过的重复条目问题。

`pnpm install` 期间 `.env`（`~/macproject/dsh-passwords/.env`）的 SHA-256 全程未变，未触发手册 `## 23` 记录的 `.env` 被删问题。

## 8. launchd 服务配置改动

本机服务由 launchd 托管，不是手工进程。两个 plist 均已备份到 `~/.dsh/profile-backups/20260904-163418-upgrade-sidebar-genui/`。

- **`cn.sdwhwzp.dsh-nas`**（运行 web，`KeepAlive`，工作目录 `~/deepseek-harness`，源码经 tsx 启动）：
  - **移除 `DSH_PASSWORDS_NO_AUTOSTART=1`**。该变量在 dsh-passwords 的 README 中是「临时禁止自动拉起（调试用）」的开关，此前被设为常态。新版 dsh-passwords（提交 `8f75499`）在 Host 返回 401 时**只支持 Host 托管的网关**——standalone 网关需要经 IPC 通道取认证 URL，独立进程没有该通道，`assertStandaloneUpstreamSupported` 会直接拒绝。改回后由 Host 派生网关子进程，3081 恢复正常。
  - **新增 `DSH_DOCTOR_REAL_DSH=/Users/wangzhipeng/deepseek-harness/apps/cli/lib/bin.js`**，供 doctor 插件调用真实 dsh（本机无全局 `dsh` 命令；该构建产物实测 `--version` 输出 `0.1.2-rc.1`）。
- **`cn.sdwhwzp.dsh-passwords-gateway`**：已 `bootout`。独立 standalone 网关与新版不兼容（见上）。
- **`com.dsh.doctor`**：已 `bootout`。其 **plist 文件早已被删除，但 job 仍注册在 launchd 中**，累计重启 **13,906 次**、每次 `exit 1`，`deployed.json` 里的 `spawn dsh ENOENT` 即其产物。这是一个纯空转的孤儿任务，提供不了任何监督；doctor 功能本身作为进程内插件 `@linxin666/dsh-doctor` 在 bundles 中运行，不受影响。

## 9. 操作事故与教训：`kill -9` 造成的陈旧锁

排障期间为抢回 3080 端口，对无响应的进程使用了 `kill -9`。强杀使两个文件锁未被释放，导致后续启动反复失败：

- `~/.dsh-doctor/state/reconcile.lock`（0 字节 `owner.json`）——doctor 插件启动时反复读取，表现为“CPU 停在 2%、内存却在增长、无任何对外连接”的假性卡死，一次卡了 11 分钟。
- `~/.dsh/.credentials.yaml.lock` —— 直接让 `@deepseek-ai/dsh-client-connection` 加载超时（`atomic-write: timed out waiting for the writer lock`），插件树崩溃，launchd 反复拉起，形成崩溃循环。

两个锁清除后启动恢复正常。**教训：停止本机 dsh 服务必须走 `launchctl bootout`，不要 `kill -9`。** 本轮最后一次改用优雅停止，停止后检查确认无残留进程、无残留锁，启动稳定在 139 秒。

排障中另一个误判也记录在此：曾把“启动慢”归因于源码 tsx 编译，实际那次是被陈旧锁卡住（CPU 无增长即可区分“在编译”与“卡住”）。正常冷启动约 **120–140 秒**。

## 10. 本机部署验收

按运维手册 `## 10.1`：

| 项目 | 结果 |
|---|---|
| 3080（dsh Web 上游，回环） | `401`（要求浏览器认证，属预期） |
| 3081（dsh-passwords 登录网关） | `302`（跳转登录页） |
| 3082（本机工作区助手 WS） | 监听中 |
| 登录页 | `<title>登录 · DeepSeek Harness</title>` 正常加载 |
| launchd 作业 | 仅 `cn.sdwhwzp.dsh-nas`（网关为其子进程） |
| 启动后新错误 | 0 |

## 11. 待办与遗留

- **Office 预览未做端到端验证**。`dsh-better-sidebar` 从 `0.15.2` 升到 `0.18.0`（跨越 `ctx.betterSidebar` 注册表服务化重构），而 `@huanlin/dsh-plugin-better-sidebar-plugin-office@0.1.2` 声明的 peer 是 `dsh-better-sidebar: ^0.6.0`，npm 上无更新版本。静态核对通过：office bundle 完整（22.4 MB，含 xlsx/docx/pptx 处理），经 `ctx.betterSidebar.registerFileViewer` 注册，而 0.18.0 仍提供 `betterSidebar` 服务且 `registerFileViewer`/`registerTab` 均在。**需登录后打开一个 `.xlsx` 确认**；若失效，把 profile 钉回 `0.15.2`。
- **dsh-weknora 未合并 Tencent 上游**。相对 `upstream/main` 落后 2913 个提交，那是整个 WeKnora 产品而本仓库只是插件包装器；历史做法是子树合并。本轮按决定跳过。
- **28 服务器部署（Phase 2）未开始**。本机验证已完成，可按运维手册的原子发布 + PM2 + 回滚流程另行安排。上线前需确认：插件依赖解析指向 fork 构建（见第 5 节）、profile 的三处版本变更、以及 launchd/systemd 侧的网关托管方式改动。
- **本机代理端口 7897 无监听**。LaunchAgent 设有 `HTTP_PROXY=http://127.0.0.1:7897` 与 `NODE_USE_ENV_PROXY=1`。经确认与本次故障无关，但会影响需要联网的功能。

## 12. 回退材料

- Profile：`~/.dsh/profile-backups/20260904-160639-remove-3-plugins/`、`~/.dsh/profile-backups/20260904-163418-upgrade-sidebar-genui/`（后者含两个 plist 备份、`.env` 及 SHA-256）。
- deepseek-harness：分支 `backup/tzwl-before-rc1-merge`（`b80f7752a3`）。
- dsh-web：分支 `backup/master-before-sync`（`f7ff6bd0`）、`backup/dev-before-sync`（`6164ab32`）。
- dsh-passwords：分支 `backup/feature-before-sync-20260904`（`dc5ac61`）。
- dsh-at-file：分支 `backup/dev-before-sync-20260904`（`06b57ca`）。
- dsh-plugin-subscriptions、dsh-weknora：各自 `stash@{0}`。
