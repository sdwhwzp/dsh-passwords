# 个人工作区的 Agent 命令执行

网页终端与 Agent 工具分别注册。启用网页终端不会自动给模型提供 `bash`；服务器个人工作区需要独立的 Agent 适配器。

`MCP_TENANT_AGENT_SHELL=true` 将 `bash` 注册到托管工作区的 Agent，包括继承该工作区和账号主体的子代理。配对电脑保留本机助手提供的工具，管理员不使用普通账号的执行器。每次执行都核对可信模型步骤主体、当前账号状态、工作区归属、会话禁用状态和共享 `sandboxPolicy`。只读模式拒绝执行；工具参数不能扩大权限。

命令通过 stdin 交给 root 所有的固定启动器，文本不会在宿主 Shell 中执行。启动器以 `--command` 模式挂载个人根目录为只读，当前会话项目及账号 HOME 为可写；其他账号、服务 HOME 和服务凭据不挂载。进程使用无 capabilities 的服务 UID 与 `dsh-sandbox` GID，由现有网络规则控制联网。HOME 与网页终端、编辑器共用，`~/.local/bin` 和 pnpm 用户目录加入 PATH。用户级 Node/pnpm 安装可持续使用；系统级 sudo 不可用。

每次调用使用新的 Shell。命令输出、退出码、超时和取消结果进入 Harness 工具日志并使用终端卡片呈现。进程数量按账号限制；停止会话、卸载插件、取消调用或超时会终止进程并等待退出。后台进程不能脱离调用长期保留。

默认关闭该功能。发布时先验证新启动器，更新 root 启动器及 sudoers 的固定文件 SHA-256，再启用环境配置；旧启动器拒绝新的五参数调用，不会回落到宿主执行。默认超时 120 秒、最大 600 秒、每条输出流保留 256 KiB，可通过 `.env.example` 所列配置调整。候选测试必须覆盖真实 Linux 隔离、账号越权、取消、超时及两种终端调用方式。

服务器预设必须明确关闭原生 `tool-bash`、`tool-pwsh` 和 `persistent-bash`，由个人工作区适配器提供账号范围内的 `bash`；同一个 Agent 不能同时注册两个同名工具。复制源预设时保留 `!!js` 标签，不得用不保留标签的 YAML 解析再序列化。`disabled: process.platform === 'win32'` 是普通非空字符串，不能替代 `disabled: !!js process.platform === 'win32'`。部署专用预设使用独立目录，保留每个工作流的并发上限 3；其他用户的运行环境不受服务器预设约束。

行为回归由 `test/tenant-agent-shell.test.ts`、`test/tenant-command.test.ts` 和 `test/tenant-terminal-launcher.test.py` 维护。终端呈现基线在 `test/expected/tenant-agent-shell.json`。
