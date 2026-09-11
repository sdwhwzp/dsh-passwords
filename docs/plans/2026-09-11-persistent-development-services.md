# 按账号持续运行测试环境

状态：已实现；上线验收和具体服务状态以部署记录为准。

Agent 在普通账号的服务器工作区中使用 `dev_server` 管理测试服务。`start` 接收当前项目的前台命令、稳定名称和端口；`status`、`logs`、`list` 用于验收和跨会话查找，`stop` 仅在用户要求停止该环境时调用。已启用的同名服务不会被重复启动覆盖；修改启动命令前应先取得用户停止或重启的指示。

管理员通过 `dev_server_admin` 列出子账号服务、查看状态并停止指定账号的服务；停止同时禁用自启动。工具在已验证的管理员 turn/start 记录提交后、首次提示词组装前注册，执行时再次检查当前身份及封禁状态，并记录停止操作审计。管理工具不返回启动命令或应用日志；普通账号不能借此管理其他账号服务。

网页左侧“运行服务”打开 `/gateway/services`。普通账号查看自己所有项目的托管服务，管理员查看所有账号的服务；列表显示项目、端口、状态和重启次数，支持搜索及状态筛选，每 10 秒刷新可见页面。停止前确认账号、服务名称和端口；停止会撤销自动重启及开机启动。页面只管理登记的测试服务，不列出任意系统进程，不返回启动命令或应用日志。

网页接口每次验证当前账号、角色和封禁状态，停止请求要求相同 Origin。普通账号只能使用由登录身份确定的 `--account` 管理范围，跨账号目标直接拒绝；管理员使用 `--admin`。两种停止操作都记录操作者和目标账号。页面可跨自己的项目停止服务；Agent 的 `dev_server` 仍限定当前项目。

服务由 systemd 托管，独立于工具调用、Agent、网页连接和 Harness 进程。`Restart=always` 在进程退出后重启，启用的 unit 在服务器启动后恢复；显式 `stop` 同时停止并禁用自启动。主机故障或应用持续启动失败仍会导致不可用，状态和日志必须如实报告。`listening` 只代表本机 TCP 端口可连接，不能代替应用 HTTP 或外部地址验收。

单次 `bash` 保持前台命令的取消、超时与进程清理规则；不得通过移除 PID 隔离或 `--die-with-parent` 来保留后台作业。持久服务的 unit 只执行现有租户启动器，启动器再进入当前账号的沙箱和项目。命令文本从 root 所有的文件经 stdin 传入，不能拼接为 systemd 指令。启动操作检查用户名称、服务名称、端口、当前身份、会话写入权限与规范化目录。账号停用后拒绝新的工具操作，已运行服务由管理员处置，不能把禁用账号等同于自动停止进程。

## 部署

管理员安装 `scripts/tenant-service-launcher.py` 到 root 所有且不可被普通账号写入的 `/usr/local/libexec/dsh-tenant-service`，为服务账号配置只允许该启动器及其 SHA-256 的 sudoers 规则。不能授权任意 `systemctl`、任意脚本或 root shell。`MCP_TENANT_AGENT_SHELL=true` 且 `MCP_TENANT_SERVICE_LAUNCHER` 为此绝对路径时注册工具；修改环境变量后重启 Harness。

启动器读取 root 所有的 `/etc/dsh-tenant-services.json`，包含部署字段 `workspaceRoot`、`launcher`、`stateDir`、`unitDir`、`portsFile`、`firewallUnit`、`restartSeconds`、`reservedPorts`、`maxPerUser`。状态目录只能由 root 写入，不能挂进用户沙箱。服务器 30 使用 `/var/lib/dsh-tenant-services`，每账号最多 8 个服务，重启间隔 5 秒，保留 3080、3081、3082 端口。

防火墙 `inet dsh_sandbox` 表包含 `service_ports` 集合，在 sandbox 输出链添加 `tcp sport @service_ports ct direction reply ct state established accept`。仅 `expose=true` 且已启用服务的端口进入集合，允许响应已进入服务器的 LAN/公网连接；原有主动出站限制继续生效。集合的 root 所有持久化 include 由管理器维护，firewall unit 必须先于服务启动。端口映射、防火墙入站规则、应用 bind 地址和 allowed hosts 仍须单独配置；工具不能创建路由器映射。

生命周期操作使用全局文件锁，账号和项目归属、端口占用及数量检查在同一锁内完成。管理请求中断可能留下已启用服务，调用者应查询状态，不能假定取消工具就取消部署。服务命令、unit 和启用记录是持续运行所需的数据，不属于部署后删除的临时测试材料。

## 验证

本地测试覆盖账号/项目拒绝、无权限时不触达启动器、名称和端口校验、重复启动、数量与端口冲突、停止后撤销网络响应许可、systemd 参数转义与销毁 Agent 时不停止服务。Linux 验收需另用独立账号目录启动实际服务，关闭发起连接后检查 HTTP，验证进程退出后恢复、另一账号无法访问管理记录、显式停止后端口消失，再清理测试 unit、目录与 HOME。真实业务服务必须保留。
