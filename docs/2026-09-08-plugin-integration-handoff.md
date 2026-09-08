# 2026-09-08 插件集成与部署交接总结

Context、Routing Suite 和普通账号终端、任务看板已完成部署，相关源码已上传各自 fork 的 `dev` 分支。网页 VS Code 编辑器已拉取，尚未完成适配、打包或部署。本文引用此前验收记录，本次文档整理没有重新部署或重启服务。

## 用户要求

- 在 DSH 网页内直接浏览、编辑和保存服务器工作区代码，浏览器用户不需要安装桌面 VS Code。
- 普通账号只能操作自己的工作区，编辑器接入必须保持账号隔离。
- 本次及后续相关改动提交到各自仓库的 `dev` 分支，没有该分支时创建，保留已有远程历史。
- 桌面扩展 `dsh-vscode` 的集成已取消；后续选用的是 `dsh-vsceditor`，不能混淆。

## 已完成的功能与修复

| 项目 | 结果与使用入口 |
|---|---|
| DSH 升级 | 28 服务器升级至私有 Harness `0.1.3-alpha.1-593ee89`，修复 Remote 装配并保存 PM2 启动状态 |
| 空对话列表 | 重建 28 条旧空会话摘要，保留原日志和标题 |
| 历史与模型加载 | 为 13 条旧日志生成有效 v2 后继，原代保留；用户报告的主会话历史和模型选择状态通过验收 |
| Context | 适配嵌入式 assistant stream 计时，详情读取校验会话权限；通过对话「上下文」面板及 `/context` 使用 |
| Routing Suite | 接入 Injector、Graded 和 Router Standard / React / Spec；新会话选择 Router 预设，`/graded <任务>` 启用分级规划，插件管理仅管理员可用 |
| 普通账号终端 | 修复 WebSocket 1006，校验签名身份、持久化会话归属和真实目录，通过隔离启动器只挂载本账号托管工作区 |
| 任务看板 | 修复 `not found` 被当作 JSON 解析及后续 `forbidden`；账本按账号保存，执行经过认证网关，沿用模型、工作区、沙盒和额度检查 |

最后一次部署验收版本为 `dsh-passwords@2.6.23`，Host PID 记录为 `1401411`，原 15 个 bundle 和 Router 预设保留。公网入口为 `http://wh.gr-iot.cn:3081`，部署目标为 `192.168.10.28`。这些是验收时快照，继续部署前须重新核对。

## dev 分支上传记录

下表为本次文档整理前的检查点，后续提交会推进分支。

| 仓库 | 分支与提交 | 内容 |
|---|---|---|
| [dsh-context](https://github.com/sdwhwzp/dsh-context/tree/dev) | 新建 `dev`，`e0988f8` | alpha 兼容、计时、会话详情权限、依赖及回归测试 |
| [dsh-routing-suite](https://github.com/sdwhwzp/dsh-routing-suite/tree/dev) | 新建 `dev`，`bd20369` | `fa550d0` 保存插件适配，`bd20369` 修复 npm 打包测试夹具 |
| [dsh-passwords](https://github.com/sdwhwzp/dsh-passwords/tree/dev) | 合并保留原 `dev`，`8b04696` | `fc375b8` 保存终端与看板隔离，`e0f04f4` 保存部署记录，后续合并及文档提交纳入 `dev` |
| [dsh-vsceditor](https://github.com/sdwhwzp/dsh-vsceditor/tree/dev) | 跟踪已有 `dev`，`a683b58` | 仅上游基线，尚无本次编辑器适配提交 |

四个本地仓库均位于 `/Users/wangzhipeng/macproject/`，已切换至 `dev`。没有改写远程历史，没有提交服务器凭据、私有环境文件、令牌、备份或用户截图，也没有公共 npm 发布。Harness 主仓库中的 principal 迁移修复不包含在这四个仓库的上传中，文件清单见[改动清单第 11.1 节](2026-09-08-changes-overview.md#111-尚未提交的-harness-修改)。

## 验证结果

- Context：lint、源码与测试类型检查、构建通过；1,183 项测试通过、21 项跳过，语句、分支、函数和行覆盖率均为 100%。
- Routing Suite：115 项测试通过；Graded 构建、Injector 构建及类型检查通过。打包测试补齐 prepare 脚本，并避免 npm 前台日志混入 JSON。
- 密码门：构建及终端、看板、配置和权限相关的 35 项聚焦回归通过。
- 此前生产验收：两类账号的 Context、模型目录、指定主会话历史和预设列表可用；普通账号终端握手成功，其他账号会话与越界目录被拒绝；看板完成双账号隔离和浏览器验证，临时验收数据已清理。

这些检查不替代 Harness 全量测试，也不证明 Router 的真实外部模型规划质量。既有全量失败、公共依赖锁缺口及其他限制保留在详细部署记录中。

## 网页编辑器接续事项

选定仓库为 `sdwhwzp/dsh-vsceditor`，基线版本 `0.5.0`，通过服务器端 code-server 提供网页编辑器。已阅读实现：客户端仍依赖旧 `dsh-client-runtime`，Host 使用共享编辑器状态、默认 loopback 地址及缺少账号校验的控制接口，不能直接按原样部署到当前多账号环境。

1. 在 `dsh-vsceditor/dev` 适配当前 Harness Host、客户端服务及面板注册接口。
2. 按账号隔离编辑器进程、状态和工作区；校验会话归属、真实路径及符号链接；通过密码门认证的同源 HTTP/WebSocket 入口代理访问。
3. 在服务器安装固定版本 code-server，使用受控启动器和最小运行环境，不向普通账号开放任意服务器目录、命令配置或共享管理接口。
4. 验证普通账号文件打开、编辑、保存和刷新，以及跨账号、越界路径、未登录请求和 WebSocket 拒绝路径；保留跟随 diff 功能时也须验证会话隔离。
5. 打包并验证候选 Profile，备份后切换部署，复核原历史、模型和插件功能，保存 PM2；将实现、包摘要、验收及回滚记录提交并推送到相关 `dev` 分支。

## 已知限制与恢复资料

普通账号终端允许 `cd /bin`：它是沙盒内只读工具目录，不是宿主机目录。当前没有禁止 Shell 离开 `/workspace` 的导航限制；提示符改为 `sandbox:` 只说明运行环境。终端网络独立，宿主机网络及外网未开放。

一条旧子代理历史因 descriptor 位于继承区仍无法打开；浏览器曾记录 `Cannot read properties of undefined (reading 'phase')`，来源尚未定位。此前插件页面验收通过不代表整站没有这些异常。

部署详情、包 SHA256、备份与回滚方法见[服务器部署手册第 27–31 节](server-28-deployment-runbook.md#27-2026-09-08-harness-013-alpha1-部署记录)。本机私有证据分别位于 `deploy-artifacts/20260908-013-deploy/`、`deploy-artifacts/20260908-context-routing/` 和 `deploy-artifacts/20260908-terminal-board/`。恢复前先保存后续新增数据和配置，不得删除会话日志、工作区、个人任务账本或已提交的数据后继，不得直接重跑已完成的切换脚本。
