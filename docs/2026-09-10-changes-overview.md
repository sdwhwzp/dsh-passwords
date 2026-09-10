# 2026-09-10 本体与插件更新、文件交付及模型放行总结

本轮已完成本体及在用插件的源仓库同步、适配、提交和推送，并部署到服务器 30。模型可在会话中显式交付文件，用户可点击交付卡片在右侧预览；打开或关闭预览导致历史连接断开的故障已修复。普通账号已放行 GPT-5.6 及以上的 Codex 模型，线上已确认显示并选中 GPT-6-Astra。

本文汇总 2026-09-10 的执行和验收记录，时间采用 Asia/Shanghai。版本与分支状态对应各阶段核对时点，后续部署以新的运维记录为准。

## 1. 更新范围与项目约束

本次核对 11 个在用仓库，按要求排除 `dsh-weknora`，线上仍为 `0.1.2`。已退役的 `dsh-vscode`、`dsh-vsceditor` 不纳入更新。

| 仓库 | 原作者同步源 | 自有 fork | 本轮工作分支 |
| --- | --- | --- | --- |
| deepseek-harness | [deepseek-ai/master](https://github.com/deepseek-ai/deepseek-harness/tree/master) | [sdwhwzp/deepseek-harness](https://github.com/sdwhwzp/deepseek-harness) | `tzwl` |
| dsh-web | [zhu1090093659/dev](https://github.com/zhu1090093659/dsh-web/tree/dev) | [sdwhwzp/dsh-web](https://github.com/sdwhwzp/dsh-web) | `master` |
| dsh-passwords | [slywalker2006/main](https://github.com/slywalker2006/dsh-passwords/tree/main) | [sdwhwzp/dsh-passwords](https://github.com/sdwhwzp/dsh-passwords) | `dev` |
| dsh-genui | [omdsh-dev/main](https://github.com/omdsh-dev/dsh-genui/tree/main) | [sdwhwzp/dsh-genui](https://github.com/sdwhwzp/dsh-genui) | `dev` |
| DSH-better-sidebar | [omdsh-dev/main](https://github.com/omdsh-dev/DSH-better-sidebar/tree/main) | [sdwhwzp/DSH-better-sidebar](https://github.com/sdwhwzp/DSH-better-sidebar) | `main` |
| dsh-context | [bowenliang123/main](https://github.com/bowenliang123/dsh-context/tree/main) | [sdwhwzp/dsh-context](https://github.com/sdwhwzp/dsh-context) | `dev` |
| dsh-spend | [nonewind/main](https://github.com/nonewind/dsh-spend/tree/main) | [sdwhwzp/dsh-spend](https://github.com/sdwhwzp/dsh-spend) | `codex/internal-013-deploy-20260908` |
| dsh-plugin-subscriptions | [V1ki/main](https://github.com/V1ki/dsh-plugin-subscriptions/tree/main) | [sdwhwzp/dsh-plugin-subscriptions](https://github.com/sdwhwzp/dsh-plugin-subscriptions) | `codex/internal-013-deploy-20260908` |
| dsh-at-file | [FSMargoo/main](https://github.com/FSMargoo/dsh-at-file/tree/main) | [sdwhwzp/dsh-at-file](https://github.com/sdwhwzp/dsh-at-file) | `codex/internal-013-deploy-20260908` |
| dsh-routing-suite | [yjh051108/main](https://github.com/yjh051108/dsh-routing-suite/tree/main) | [sdwhwzp/dsh-routing-suite](https://github.com/sdwhwzp/dsh-routing-suite) | `dev` |
| dsh-sidebar-vscode | [chendefine/main](https://github.com/chendefine/dsh-sidebar-vscode/tree/main) | [sdwhwzp/dsh-sidebar-vscode](https://github.com/sdwhwzp/dsh-sidebar-vscode) | `dev` |

同步约束已写入 Harness 和适用插件的项目指令；完整规则见 [Personal fork synchronization](https://github.com/sdwhwzp/deepseek-harness/blob/tzwl/AGENTS.md#personal-fork-synchronization)：

1. 记录源仓库、源分支、自有 fork 上传地址和当前分支，先 fetch 源及 fork，保留未提交工作。
2. 把源提交合并到当前工作分支；冲突优先采用源实现，再以最小改动适配现有需求，保留账号隔离和持久化数据兼容。
3. 完成适配及相关检查后再推送，检查失败时继续修复。
4. 枚举全部本地分支，上传未发布的分支和提交，逐一核对远端 SHA；保留各分支历史及远端独有分支，不使用镜像推送或裸强制推送。
5. 推送后再次 fetch，检查是否遗漏源提交及剩余源码差异；存在新提交就继续合并、适配、验证和推送。

07:33 的同步复核中，11 个仓库当前分支缺失源提交均为 0。63 个本地分支中，62 个与远端 SHA 一致；`dsh-spend/main` 的远端领先但包含本地全部提交，部署分支也包含该远端 main，未覆盖远端历史。后续文件交付适配完成时，两个侧栏仓库的 5 个和 2 个本地分支分别全部与 fork 一致；预览及模型更新的上线记录提交后，`dsh-passwords` 的 10 个本地分支全部与 fork 一致，缺失源提交为 0。

## 2. 模型显式交付文件与右侧预览

Harness `0.1.5-alpha.2` 已包含显式交付能力。此前两个外部侧栏插件优先接管会话末尾的文件区域，覆盖了原生交付卡片，因此升级本体后没有出现用户预期的入口。

本次调整 `dsh-better-sidebar` 和 `dsh-sidebar-vscode`：当前轮存在显式交付记录时显示原生交付卡片；普通文件变更列表及现有编辑器、Office 查看器继续使用各自入口。

实际流程为：模型生成文件 → 调用 `present` 显式交付 → 会话显示文件卡片 → 点击卡片在右侧预览。标准、PTC 和 Cordis 预设提供 `present`，minimal 预设不包含该工具。用户可这样提出任务：

> 请生成一份 Markdown 报告和一个 HTML 页面，完成后使用 present 工具把这两个文件显式交付给我。

真实模型验收已生成并交付 `report.md` 和 `preview.html`，日志记录两份文件的交付信息；刷新后卡片仍存在，Markdown 和 HTML 均可从卡片打开右侧栏。验收会话为“文件交付功能验收测试”，完整 ID 为 `session-c42fba2e-5835-453c-bd47-0fba306b78d3`。

文件预览还会订阅 `workspaceFiles/changes`。原账号网关未接入这个订阅端点，导致预览操作关闭承载历史的共享 WebSocket。本次补充端点接入、工作区范围解析、会话归属及目录权限检查，并在推送文件变化前复核权限；取消文件订阅后，同一连接仍可读取会话历史。

已确认的使用限制：旧会话只有文本路径而没有 `present` 记录时，不会自动补出交付卡片；30 为无桌面的服务器，“用默认应用打开”和“在文件管理器中定位”入口不可用；本次实际文件验收覆盖 Markdown 和 HTML，其他文档类型未逐一重测。

## 3. 普通账号模型放行规则

GPT-6-Astra 未出现在 30 网页下方的模型选择器，是因为 `dsh-passwords` 的普通账号策略只列出了三个 GPT-5.6 型号。模型目录、选模请求和实际模型请求均受到该策略约束。

按用户要求，规则已改为 Codex 提供方的 GPT 版本大于或等于 5.6：允许 5.6、5.10、6、6.1 等版本及对应型号，继续拒绝较早版本和无法识别版本的模型 ID。模型目录过滤、选模 RPC 与模型请求共用同一判断，管理员及其他提供方的既有策略保持不变。

普通账号线上已看到并选中 `GPT-6-Astra · Medium`，同时可见 GPT-5.6 Sol、Terra、Luna。实际可选型号仍取决于订阅后端返回的目录；此阶段验证了列表和选模，没有额外发起 Astra 计费生成请求。

## 4. 30 部署结果

网页入口：[wh.gr-iot.cn:3081](http://wh.gr-iot.cn:3081/)。SSH 使用用户提供的 `wh.gr-iot.cn:6022`，主机密钥核对为原 `192.168.10.30`。旧文档中把该网页入口记为 28 的内容已过时。

| 组件 | 本轮最终记录的线上版本 |
| --- | --- |
| Harness | `0.1.5-alpha.2`，提交 `bf3afe0077` |
| dsh-web | `0.3.19`，提交 `5f3d841eb1` |
| dsh-passwords | `2.6.31`，部署代码提交 `966dbecf6c` |
| dsh-better-sidebar | `0.19.0-alpha.1.dsh.20260910.1` |
| dsh-sidebar-vscode | `0.2.8-dsh.20260910.1` |
| dsh-context | `0.48.0-dsh.20260910.3`，保留同期更新 |
| dsh-spend | 切换时保留 `0.6.24`；后续独立更新至 `0.6.25` |
| dsh-weknora | `0.1.2`，按要求未更新 |

Harness / Web 发布目录为 `20260910-071200-bf3afe-alpha2`。显式交付卡片先部署为 `20260910-080000-delivery-cards`；最终插件发布为 `20260910-084000-preview-models`，包含上述交付适配、预览修复和模型规则。

最终插件发布于 08:40:45 切换，08:41:19 健康检查通过，08:42:21 完成 60 秒稳定观察并保存 PM2。网关健康返回 200，Host 未认证请求返回 401，内部健康接口未认证请求返回 403，认证后的内部检查全部就绪。3 个账号和备份时的 197 个会话文件保留，文件未缩短，模块链接无断链。

首次预览及模型上线尝试因另一项费用插件部署重启服务而触发观察期回滚，回滚成功；保留同期费用插件更新后重新装配，最终切换成功。随后另一次费用插件更新把 `dsh-spend` 升至 `0.6.25`；定稿核对时服务仍为 online、网关健康 200，`dsh-passwords 2.6.31` 和本次插件发布继续生效。

回滚 Profile 为 `/home/tzwl3/.dsh/profiles/web-before-20260910-084000-preview-models`。部署证据及 14 表、174 行的一致性数据库备份保留在服务器 `/home/tzwl3/apps/deploy-staging/20260910-084000-preview-models`。回滚恢复代码与配置时必须保留新增数据，不用旧库覆盖上线后的写入；凭据及数据库备份未写入 Git。

## 5. 验证与关键提交

源码同步阶段已完成各仓库相关构建、行为测试和文档检查，详见部署手册第 51 节。后续两项功能适配分别完成：

| 范围 | 实际验证结果 |
| --- | --- |
| 显式交付卡片 | better-sidebar 25 项、sidebar-vscode 44 项，共 69 项测试通过；两个插件构建通过；真实模型生成并显式交付两份文件 |
| 预览与模型策略 | Remote mux / 事件 10 项、模型策略 3 项、网关测试文件 47 项，共 60 项测试通过；相关资源夹具另经并行进程验证；插件构建及构建产物检查通过 |
| 线上文件与连接 | Markdown、HTML 文件返回 200 且包含验收文本；文件订阅收到 ready，取消后仍能在同一 WebSocket 读取历史 |
| 线上模型 | 普通账号列表显示 GPT-6-Astra，选模成功；未额外验证 Astra 生成请求 |
| Git | 改动已提交并推送；每次推送后重新抓取并核对相关仓库本地分支和源提交 |

以上是已执行的检查范围，未把聚焦测试或重复运行计为全平台 CI 通过。

| 仓库 | 提交 | 内容 |
| --- | --- | --- |
| DSH-better-sidebar | `2b44f58fa5` | 显式交付时显示原生文件卡片 |
| dsh-sidebar-vscode | `c4ae84cb80` | 保留原生显式交付卡片入口 |
| dsh-passwords | `eed004a0eb` | 文件订阅授权及历史连接修复 |
| dsh-passwords | `966dbecf6c` | 普通账号放行 GPT-5.6 及以上；部署包版本 2.6.31 |
| dsh-passwords | `754e4d9cfd` | 记录预览、模型策略及 30 上线结果 |

## 6. 详细记录

- [部署手册](server-28-deployment-runbook.md)：第 51 节为源仓库同步，第 52 节为显式交付，第 53 节为预览连接及模型放行。文件名沿用历史名称，这三节记录的目标均为 30。
- [工作区文件订阅说明](plans/2026-09-10-workspace-file-stream.md)：文件流授权、取消和共享连接行为。
- [普通账号模型版本规则](plans/2026-09-10-customer-model-versions.md)：版本判断及生效范围。
