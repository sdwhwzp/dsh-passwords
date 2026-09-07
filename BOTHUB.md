# 可选 BotHub Bridge

`src/bot-bridge.ts` 在现有 DSH Host 内注册服务端桥接。只有 Host 环境包含 `DSH_BOT_BRIDGE_PORT` 时才启用；默认关闭，固定监听 loopback。通过原有 `dsh --profile ...` 启动方式运行，必须由该 profile 加载此本地账号插件版本。

```sh
# 加到现有 DSH Host 的启动环境，随后按原有方式重启 Host。
DSH_BOT_BRIDGE_PORT=3099
# 可选：指定允许的 Agent preset ID。
DSH_BOT_AGENT_PRESET=your-bot-preset
```

构建插件：`npm run build`，使用与当前 Harness 兼容的 Node 22.21+。本次没有修改现有账号、模型配置或重启服务。

配套管理平台：`/Volumes/External/projects/wechat-bot`，设置 `DSH_BRIDGE_URL=http://127.0.0.1:3099`。管理界面复用 DSH 登录，普通用户只能为自己授权，管理员可为普通子账号授权。Bot 不允许绑定管理员。

每次绑定创建账号托管目录中的 `bots/<botId>` 专用工作空间。Grant 及幂等记录保存在现有数据库 `platform_settings`；Grant token 只保存哈希。管理登录 token 仅保存在进程内，12 小时到期；账号改密或重启需要重新登录。长期 Bot grant 不依赖登录 Cookie，可显式撤销。撤销、封禁、删除或账号角色提升会阻止后续执行。

`/run` 只接受 Grant bearer，Principal 来自账号数据库。运行前校验工作空间真实路径、PrincipalAccess、会话所有权和 Agent preset 允许列表，调用现有 Typert Session Remote 并保留账号 Principal。模型每一步仍走原有权限/额度钩子。群会话使用稳定 ID；定时任务每个 runId 对应独立会话。Agent 输出通过匹配当前请求 rpcId 的会话事件获取，重复 runId 不重复调用模型，失败结果不自动重放。

最多 8 个并发会话，同一 grant 的同一会话串行；280 秒超时，客户端断开或撤销会取消执行。需要交互审批的工具不会被桥接自动批准。机器人专用 preset 应仅开放业务需要的工具。

测试：`node --import tsx --test test/bot-bridge.test.ts`。测试使用临时目录和模拟账号/Agent 服务，无真实模型调用。完整平台配置、运行边界与 MySQL 说明见配套平台 README。
