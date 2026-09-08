# 2026-09-08 插件集成与部署交接总结

Context、Routing Suite、普通账号终端、任务看板和网页 VS Code 编辑器均已部署。刷新 DSH，在本人的托管工作区会话中点击「编辑器」，即可浏览、修改和保存代码，无需安装桌面 VS Code。源码及配套记录使用各自 fork 的 `dev` 分支。

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
| 网页编辑器 | 按账号隔离 code-server 进程、数据和工作区，同源 HTTP/WebSocket 验证会话归属；会话「编辑器」内直接打开、修改和保存代码 |
| 任务看板 | 修复 `not found` 被当作 JSON 解析及后续 `forbidden`；账本按账号保存，执行经过认证网关，沿用模型、工作区、沙盒和额度检查 |

最新验收为 2026-09-08 20:37（Asia/Shanghai）：`dsh-passwords@2.6.24`、`dsh-vsceditor@0.5.1-dsh.20260908.4`、code-server `4.133.0`，Host PID `1434872`，共 16 个 bundle，PM2 已保存。Harness 仍为 `0.1.3-alpha.1-593ee89`。公网入口为 `http://wh.gr-iot.cn:3081`，SSH 使用 `wh.gr-iot.cn:3022`，以原 `192.168.10.28` 主机密钥校验连接。这些是验收快照，后续部署前须重新核对。

## dev 分支上传记录

下表保留前两项插件检查点，并记录本次编辑器与密码门适配。

| 仓库 | 分支与提交 | 内容 |
|---|---|---|
| [dsh-context](https://github.com/sdwhwzp/dsh-context/tree/dev) | 新建 `dev`，`e0988f8` | alpha 兼容、计时、会话详情权限、依赖及回归测试 |
| [dsh-routing-suite](https://github.com/sdwhwzp/dsh-routing-suite/tree/dev) | 新建 `dev`，`bd20369` | `fa550d0` 保存插件适配，`bd20369` 修复 npm 打包测试夹具 |
| [dsh-passwords](https://github.com/sdwhwzp/dsh-passwords/tree/dev) | 保留原 `dev` 历史，版本 `2.6.24` | 此前终端、看板隔离与部署记录保留；新增编辑器认证、写入权限与 WebSocket 路由及本次文档 |
| [dsh-vsceditor](https://github.com/sdwhwzp/dsh-vsceditor/tree/dev) | 已有 `dev`，`9b078fa` | 基于 `a683b58` 新增多账号网页编辑器、固定启动器和测试，保留上游实现及说明 |

四个本地仓库均位于 `/Users/wangzhipeng/macproject/`，已切换至 `dev`。没有改写远程历史，没有提交服务器凭据、私有环境文件、令牌、备份或用户截图，也没有公共 npm 发布。Harness 主仓库中的 principal 迁移修复不包含在这四个仓库的上传中，文件清单见[改动清单第 11.1 节](2026-09-08-changes-overview.md#111-尚未提交的-harness-修改)。

## 验证结果

- Context：lint、源码与测试类型检查、构建通过；1,183 项测试通过、21 项跳过，语句、分支、函数和行覆盖率均为 100%。
- Routing Suite：115 项测试通过；Graded 构建、Injector 构建及类型检查通过。打包测试补齐 prepare 脚本，并避免 npm 前台日志混入 JSON。
- 密码门：此前 35 项聚焦回归记录保留；本次构建、客户端类型检查与 12 项配置、终端网关、工作区看板回归通过，补充带版本 WebSocket 路径后对应网关测试通过。
- 编辑器：3 个入口语法检查、4 项配置与权限测试通过；候选 Profile 冻结安装及真实 `dsh` 装配通过。生产网页实际编辑保存、服务器磁盘核对和重新打开文件通过；其他账号 HTTP/WS、跨源及未登录访问拒绝。沙盒内无法访问宿主机 home、其他账号和宿主机网络。
- 本次生产回归：普通账号终端 101、UID 1000 和 `/workspace/测试`；看板状态 200；管理员与普通账号主会话均返回 14 条历史记录，模型目录各返回 14 项。没有调用付费模型。
- 此前生产验收：两类账号的 Context、模型目录、指定主会话历史和预设列表可用；普通账号终端握手成功，其他账号会话与越界目录被拒绝；看板完成双账号隔离和浏览器验证，临时验收数据已清理。

这些检查不替代 Harness 全量测试，也不证明 Router 的真实外部模型规划质量。既有全量失败、公共依赖锁缺口及其他限制保留在详细部署记录中。

## 网页编辑器部署与范围

选定仓库为 `sdwhwzp/dsh-vsceditor`，基线版本 `0.5.0`。新入口适配当前 Harness 的客户端视图、locale、会话权限与工作区服务，替换原共享编辑器入口。每账号最多一个实例，Host 默认最多 4 个，空闲无连接 15 分钟回收。密码门设置 `MCP_TENANT_EDITOR=true`，普通账号还需文件写入权限。

首次切换因 Cordis 配置 Standard Schema 接口不匹配自动回滚；修复后真实 Profile 装配通过，再部署 v3。最终 v4 修复 DSH 对话宽度拖动柄遮挡编辑器点击，实际网页保存并重新打开通过。临时验收令牌已撤销、文件已清理，PM2 已保存。部署细节、校验摘要和恢复位置见[部署记录第 32 节](server-28-deployment-runbook.md#32-2026-09-08-网页-vs-code-编辑器集成)。

编辑器网络隔离，在线扩展市场、远程 Git 和外部依赖下载不可用；公网 HTTP 限制部分剪贴板和 WebView 功能。上游全局 diff 跟随、编辑锁定、桌面后端和共享设置未接入新入口，不保证模型与用户同时改文件时自动协调。code-server 自带 Chat 未连接 DSH 模型。

## 已知限制与恢复资料

普通账号终端允许 `cd /bin`：它是沙盒内只读工具目录，不是宿主机目录。当前没有禁止 Shell 离开 `/workspace` 的导航限制；提示符改为 `sandbox:` 只说明运行环境。终端网络独立，宿主机网络及外网未开放。

一条旧子代理历史因 descriptor 位于继承区仍无法打开；浏览器曾记录 `Cannot read properties of undefined (reading 'phase')`，来源尚未定位。此前插件页面验收通过不代表整站没有这些异常。

部署详情、包 SHA256、备份与回滚方法见[服务器部署手册第 27–32 节](server-28-deployment-runbook.md#27-2026-09-08-harness-013-alpha1-部署记录)。本机私有证据分别位于 `deploy-artifacts/20260908-013-deploy/`、`deploy-artifacts/20260908-context-routing/` 、`deploy-artifacts/20260908-terminal-board/` 和 `deploy-artifacts/20260908-vsceditor/`。恢复前先保存后续新增数据和配置，不得删除会话日志、工作区、个人任务账本或已提交的数据后继，不得直接重跑已完成的切换脚本。
