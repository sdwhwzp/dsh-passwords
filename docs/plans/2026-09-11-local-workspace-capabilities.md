# 本机终端能力状态

Mac 和 Windows 桌面端通过配对协议的 `shellEnabled` 字段报告终端权限。工具说明只定义执行位置和结果；实时权限由 `systemPrompt.context` 的 `local-workspace-capabilities` 提供，每次模型请求读取当前 WebSocket 握手，核心负责将变化记入上下文快照。在线启用、在线禁用及离线必须明确区分，历史拒绝回复不能作为当前权限依据。

Agent 实例可跨多次重连存活，因此不能捕获创建 Agent 时的数据库权限用于后续提示。服务端执行前读取当前连接的权限，禁用时拒绝 `bash`，所有者主体校验与本机助手的权限校验继续执行。撤销接入先关闭连接，旧 Agent 不能继续派发命令。工具使用当前系统账号权限，不能自动获得管理员或 root 权限。

回归由 `test/local-workspace-capabilities.test.ts` 覆盖真实 WebSocket 恢复连接、现存 Agent 的提示组装、命令往返、禁用、跨账号拒绝及撤销。模型可见文本基线位于 `test/expected/local-workspace-capabilities.json`。本机进程执行继续由 `test/local-workspace.test.ts` 覆盖；线上验收使用已连接客户端执行只读 Git 查询。
