---
kind: upgrade-guide
description: 账号任务看板要求 Harness rc.2、显式客户端注册以及目标运行选项。
---
# 升级账号任务看板

## 变更

网关通过原生 Peer API 要求 Harness `>=0.2.1-rc.2 <0.2.2-0`。账号看板 Host 使用 schema 6，并与 `@linxin666/dsh-client-ui-task-board@0.4.8-dsh.20261021.2` 客户端配套。目标运行需要管理员设置和每张卡片同时显式启用；未设置此字段的任务只执行单轮。

新建任务会话必须有卡片指定的工作区或账号可见的最近工作区。缺少这类工作区时，运行会被拒绝，不再使用 Host 进程目录。重试前登记账号本人的工作区，或在卡片上选择获准的工作区。新 Agent Teams 行保持禁用；显式启用后，共享 Host 小队也仅供管理员使用。

## 迁移

1. 等待所有运行会话结束后再停止 profile。备份 profile 和整个 `MCP_TENANT_TASK_BOARD_DIR`，包括每个 `u<accountId>/owner.json`、`ledger-v2.json` 和 `scheduler-v2.json`。
2. 一同安装配套 Harness 包、网关和精确版本的看板 peer。保留 `MCP_TENANT_TASK_BOARD=true` 和现有账号目录。
3. 把 `web-ui-task-board` Loader 行的 `name` 设为已安装网关内 `integrations/task-board/client-shell/index.js` 的绝对或配置相对文件路径。保留行 ID 和配置，不同时挂载源看板 Host 或独立远程桥接。Harness 不会把裸包子路径识别为客户端模块。
4. 启动隔离候选，确认每个账号只看到自己的任务、工作区分组、历史和计划。迁移保留这些记录，并把显式 `goalRun: false` 规范化为缺省字段。
5. 对需要持续执行的任务，先启用管理员 `goalRun` 设置，再逐卡选择目标运行。确认普通任务只执行单轮，终端逻辑流被拒绝时工作区分组连接仍保持。
6. 候选验收和空闲检查通过后再切换正式环境。需要恢复旧网关时，一并恢复配套 profile 和迁移前的看板备份，不向旧 Host 提交 schema 6 账本。
