# 会话权限与工作区归属分离

纯会话仍自动关联账号托管 Workspace，以满足 Harness 输入框和 Session 生命周期要求。不能把目录名、前端按钮状态或工作区有无当成纯会话权限依据。

服务端模式记录在 Session 发布前持久化，并随恢复与父会话分支继承。`tools.restrict` 过滤继承工具，无法独自屏蔽后注册的 Agent 自有工具；因此还必须在 `system-prompt/assemble` 返回前过滤工具列表，并通过 `tools.guard` 拒绝实际执行。组装后的列表由原生请求日志记录，模型可见内容可从历史重建。

使用、备份要求与验证入口见 [纯会话模式](../../docs/2026-09-14-conversation-mode.md)。
