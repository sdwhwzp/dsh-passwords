# 28 服务器部署与运维手册

本文记录 28 服务器（Tailscale `100.64.0.5`，局域网 `192.168.10.28`）上 DeepSeek Harness 多用户服务的功能、运行结构、数据位置、部署步骤、验收方法和故障处理。内容依据 2026-09-01 的 Harness Alpha.3 实际服务器盘点整理，不包含密码、API Key、OAuth Token、Tailscale Auth Key 或数据库口令。

## 1. 使用范围

本手册用于重新部署 28、迁移到新机器、升级 dsh 或插件、恢复数据以及排查部署后功能缺失。任何复制到 Git 的版本都只能保留配置项名称和占位符，不得加入 `.env`、`settings.yaml`、`auth.json`、`mac.md` 或私钥内容。

本文包含内网 IP、主机名、目录结构和 Tailscale 控制端地址。它们不是登录凭证，但属于基础设施信息；应提交到私有仓库。若必须公开，先替换这些值并删除“当前发布标识”一节。

## 2. 当前拓扑

```text
局域网浏览器
    |
    | HTTP 100.64.0.5:3081
    v
dsh-passwords 登录网关
    |
    | HTTP 127.0.0.1:3080
    v
DeepSeek Harness Web + Web Profile + 插件
    |
    +---- MySQL 192.168.10.95:3306 / dsh_passwords_platform
    |
    +---- 子账号专属目录 /home/tzwl3/dsh-user-workspaces/u<用户ID>
    |
    +---- 本机助手 WebSocket 100.64.0.5:3082
    |
    +---- Tailscale 100.64.0.5
             |
             +---- kmMac 100.64.0.2:8080 文本模型
             +---- kmMac 100.64.0.2:8081 图片识别
             +---- kmMac 100.64.0.2:8082 图片生成
```

客户端统一访问 `http://100.64.0.5:3081`。`3080` 是只监听回环地址的 dsh 上游管理入口，不应直接暴露给客户；`3082` 是本机工作区助手的明文 WebSocket 入口，只适合受控 Tailscale 网络或可信局域网。

## 3. 当前基线

| 项目 | 当前值 |
|---|---|
| 主机名 | `tzwl3-ThinkCentre-E77` |
| 系统 | Ubuntu 24.10，Linux 6.11，x86_64 |
| CPU | Intel Core i5-10400F，12 个逻辑 CPU |
| 内存 | 14 GiB，Swap 4 GiB |
| 系统盘 | 233 GiB，盘点时使用约 17 GiB |
| 时区 | `Asia/Shanghai`，NTP 已同步 |
| 局域网地址 | `192.168.10.28/24` |
| 默认网关 | `192.168.10.243` |
| DNS | `114.114.114.114`、`223.5.5.5`，Tailscale DNS `100.100.100.100` |
| Tailscale 地址 | `100.64.0.5` |
| Node.js | `22.21.1` |
| pnpm | `11.24.0` |
| PM2 | `6.0.13` |
| Tailscale | `1.102.3` |
| dsh | `0.1.2-alpha.3`，线上构建标识 `0.1.2-alpha.3-b66a316` |
| dsh-passwords | `2.6.15`，提交 `d67159a` |
| dsh-spend | `0.6.4`，提交 `a0d1648` |
| dsh-nas-webdav | `0.2.5`，提交 `ef3b9eb` |
| dsh-plugin-subscriptions | `0.6.2`，提交 `d3f549f` |
| Office 侧栏预览 | `@huanlin/dsh-plugin-better-sidebar-plugin-office@0.1.3` |
| dsh-web 插件族 | `@linxin666/dsh-web-all@0.3.10`，提交 `0f9116c` |
| 数据库 | MySQL，`192.168.10.95:3306/dsh_passwords_platform` |

### 3.1 端口

| 端口 | 监听范围 | 用途 | 对客户开放 |
|---|---|---|---|
| `22/tcp` | `0.0.0.0`、`::` | SSH 运维 | 仅管理员网络 |
| `3080/tcp` | `127.0.0.1` | dsh Web 上游 | 否 |
| `3081/tcp` | `0.0.0.0` | dsh-passwords 登录网关 | 是 |
| `3082/tcp` | `0.0.0.0` | 本机工作区助手 WebSocket | 受控开放 |
| `3389/tcp` | 全接口 | GNOME 远程桌面 | 仅管理员网络 |
| `41641/udp` | 全接口 | Tailscale | 是 |

若服务器离开可信局域网，必须在 3081 前增加 HTTPS，3082 改用 WSS，并用防火墙限制 22、3082 和 3389 的来源地址。

## 4. 已部署功能

### 4.1 DeepSeek Harness 基础功能

- Web 对话、会话持久化、会话恢复、标题、导出、附件和文件引用。
- 工作区选择、目录浏览、文件读写、字符串替换、Bash、PowerShell、搜索和 Web 工具。
- 图片上传、粘贴、对话内显示图片，以及图片工具结果渲染。
- 模型选择、推理档位、权限预设、沙盒、审批、计划模式、Todo、Goal、Job、Workflow 和子代理。
- Skills 浏览与调用、上下文压缩、工具结果裁剪、Token 计量、消息反馈和轨迹展示。
- JSONL 会话数据、SQLite 会话查询、投影缓存、附件存储和工作区注册持久化。

### 4.2 dsh-passwords 多用户网关

- 主账号和子账号使用独立账号密码登录，Cookie 会话有效期 12 小时。
- 主账号可创建、改名、改密、封禁和删除子账号；改名、改密和退出登录会使旧会话失效。
- 登录失败退避锁定、IP 密码喷洒节流、审计日志、敏感身份字段加密和浏览器伪造身份头清理。
- 每个子账号独立配置工作区、会话、沙盒等级、上传、Git 下载、每小时 Token、每日时长和每月人民币额度。
- 达到用量或金额上限时，在客户提出问题时明确说明已用额度、额度上限、问题未发给模型以及需要联系管理员增加额度。
- 子账号只能看到获准工作区和会话，不能访问其他子账号的专属目录或主账号的运维插件接口。
- 新子账号自动创建 `/home/tzwl3/dsh-user-workspaces/u<用户ID>`，默认注册为可写工作区；删除账号只撤销访问，不删除目录和文件。
- 左侧 Workspace 区域提供“文件夹管理”，支持进入子目录、上传文件、上传整文件夹、下载文件、删除文件和递归删除非空文件夹。
- 删除专属根目录、路径穿越、符号链接逃逸和跨账号操作会被拒绝；文件与文件夹删除前有二次确认。
- 新对话输入框上方、“选择模式”旁提供“一键选择本机文件夹”。Windows 助手可注册本地目录，并在配对后直接打开对应工作区对话。
- Windows 本机工作区支持对授权目录进行读、写、编辑、搜索和 Shell 操作，并可调用 Microsoft Word；Word 不可用时回退 WPS。
- 主账号与子账号可通过页面留言，消息支持私信、广播和标签。

当前数据库有 1 个管理员、1 个子账号、1 条托管工作区记录和 1 条权限记录；子账号目录为 `u2`。这些数量是盘点快照，不是部署时应写死的值。

### 4.3 订阅模型与客户模型范围

`dsh-plugin-subscriptions` 提供 ChatGPT、Claude 和 Grok 订阅登录及模型路由。盘点时 ChatGPT Pro 和 Grok 已登录，Claude 未登录；登录状态会随授权和 Token 刷新变化，不应写入安装脚本。

子账号在 ChatGPT（Codex）提供方下只允许看到并调用以下模型：

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

服务端同时执行同一限制，不能通过手写 RPC 绕过。主账号不受此客户模型限制。订阅登录、退出、手动授权和订阅用量只对管理员显示，子账号不能调用相应凭证管理或用量 RPC。

Grok 的客户模型目录、配置、模型池、缓存、解析和流式调用统一只允许以下两个聊天模型；旧选择或手写其他 Grok 聊天模型 ID 返回 `UNKNOWN_MODEL`：

- `grok-4.6`
- `grok-4.5`

Grok 插件内部使用的图片生成、视频生成和搜索模型不属于聊天模型选择器，不受该列表限制。Claude、DeepSeek、GLM、Qwen、Kimi 和自建提供方继续按各自配置保留。

### 4.4 Spend 计量与内部价格

`dsh-spend` 按 `(sessionId, turn, step)` 幂等归集输入、输出、缓存读取、缓存写入和推理 Token。账本使用人民币微元保存，展示汇率当前按 `USD/CNY = 7.2` 计算；已有计价记录不会因以后改价而变化，未知模型先记为未计价，管理员补价后可回填未计价历史。

28 当前部署的 `dsh-agent-loop@0.1.1-rc.2` 没有把网关已认证 principal 从 `user/message` 继续传给 pre-step、模型请求、工具执行和 turn/step 事件。兼容修复由三个业务插件共同完成：dsh-passwords 从本轮已认证消息恢复身份并执行额度与模型权限检查，dsh-nas-webdav 在同一 agent turn 内为工具调用保留该身份，dsh-spend 从旧日志的 `user/message` 回填 turn/step 归属。身份只来自网关写入的 principal，不读取用户名文本、模型输入或工具参数。升级到已原生传播 principal 的新 agent-loop 后仍须保留并执行这些兼容测试，确认不会重复归户或跨账号复用。

子账号页面显示的“我的剩余额度 ¥0”表示管理员为该账号配置的自然月金额额度确实为 0，不是订阅模型不可用或页面估算值。修复前旧 agent-loop 丢失身份会让额度检查误走匿名兼容路径，因此可能出现 ¥0 仍能调用；修复后该账号下一次提问会在发给模型前收到明确的额度不足提示。2026-08-27 部署验收时，新折叠器从现有会话恢复出子账号 `u2` 的 25 次最终调用和 479,254 Token；首次刷新 Spend 或下一次额度检查会将它们幂等写入账本。

客户可见的三个 ChatGPT 模型当前内部价格如下，单位为每百万 Token：

| 模型 | 输入 USD / CNY | 输出 USD / CNY | 缓存读取 USD / CNY | 缓存写入 USD / CNY |
|---|---:|---:|---:|---:|
| GPT-5.6 Sol | `$5` / `¥36` | `$30` / `¥216` | `$0.5` / `¥3.6` | `$6.25` / `¥45` |
| GPT-5.6 Terra | `$2` / `¥14.4` | `$12` / `¥86.4` | `$0.2` / `¥1.44` | `$2.5` / `¥18` |
| GPT-5.6 Luna | `$0.2` / `¥1.44` | `$1.2` / `¥8.64` | `$0.02` / `¥0.144` | `$0.25` / `¥1.8` |

价表还包含其他 OpenAI、Anthropic、DeepSeek、Qwen、Kimi 和 GLM 模型。DeepSeek 的 `deepseek-v4-flash-vision-exp` 暂按 `deepseek-v4-pro` 价格计算。管理员可在 Spend 的费率管理页为自建模型设置独立价格；子账号只能查看，不能修改。

### 4.5 dsh-web 插件族

| 插件 | 当前功能 |
|---|---|
| `@linxin666/dsh-web-all` | 聚合并挂载 dsh-web 全家桶 |
| `dsh-chat-recovery` | 编辑消息时通过 fork 保留原会话，显式重试最后失败回合，避免失败消息无提示消失 |
| `dsh-aionui-panel` | 文件树、文件搜索、Git 变更、多标签预览和多格式查看 |
| `dsh-community-plugins` | 创意工坊社区插件数据源 |
| `dsh-git-graph` | 新会话 Git 分支选择和 Git 图谱 |
| `dsh-market`、`dshmarket` | 浏览并安装皮肤、宠物和社区插件 |
| `dsh-plugin-manager` | 安装、更新、启停和卸载 npm 或 Git 插件，失败时可转交修复会话 |
| `dsh-skill-explorer` | 浏览、启停、创建和删除 Skills |
| `skin-center` | 皮肤、壁纸、即时试用和无刷新应用 |
| `dsh-task-board` | 任务看板、真实会话执行和定时任务 |
| `dsh-web-settings` | dsh-web 插件配置分区和配置表单 |
| `dsh-desktop-launcher` | 桌面启动器；经 dsh-passwords 访问时隐藏机器级关机按钮，改用账号退出 |
| `dsh-doctor` | 监督进程、故障诊断、隔离恢复环境、修复和回滚；用户服务 `com.dsh.doctor.service` 已启用 |
| `dsh-liangshen` | 梁神 Agent 预设和两阶段工具模式 |
| `dsh-pet` | 按账号隔离的宠物、命名、互动和亲密度，数据位于 `~/.dsh/pet-accounts/` |
| `dsh-remote-web-ui` | 手机或电脑扫码配对、一次性配对令牌、设备状态和会话撤销 |
| `dsh-ssh` | SSH 主机管理、跳板机、命令、PTY、SFTP、上传下载、隧道和集群执行；子账号不能进入运维配置面 |
| `dsh-tool-describe-image` | 为文本模型提供图片理解，支持本地文件、URL 和附件，调用独立视觉端点 |
| `dsh-better-sidebar` | 侧栏增强 |
| `@huanlin/dsh-plugin-better-sidebar-plugin-office` | 为 better-sidebar 提供 `.docx`、`.xlsx` 和 `.pptx` 预览 |
| `dsh-archive-manager` | 会话归档管理 |
| `dsh-shandong-tizhi-brand` | 山东梯智物联品牌界面 |
| `dsh-nas-webdav` | NAS WebDAV 文件服务 |

WeKnora 知识库插件已纳入跨机器安装清单，来源固定为 `github:sdwhwzp/dsh-weknora#main`；本机存在相邻的 `dsh-weknora` 源码时优先链接并构建。插件提供 `weknora_list_knowledge_bases`、`weknora_search`、`weknora_read_document` 和 `weknora_ask`，不包含浏览器设置页。未设置 `WEKNORA_BASE_URL` 时 bundle 保持禁用。28 启用前必须先准备可达的 WeKnora API 地址和受限 API Key；同一 Web Profile 的登录账号共享这组工具和凭据，因此 API Key 本身必须只允许访问计划共享给客户的知识库。

### 4.6 WebDAV 工作区、Excel 工具和 Office 预览

每个已登录账号在“设置 → WebDAV”中独立绑定地址、WebDAV 用户名、密码和 TLS 选项。凭据按 `(principal.source, principal.id)` 隔离，密码验证成功后使用 AES-GCM 加密保存在 MySQL，不回显、不写日志，也不进入模型上下文。28 当前使用 `/usr/bin/rclone` 和 FUSE，把每个账号的远端目录挂载到其专属目录下的 `WebDAV` 子目录并注册为工作区；多个账号可同时挂载同一台或不同的 NAS，解绑只卸载当前账号，不影响其他账号或删除 NAS 文件。

模型访问 WebDAV 文件时使用 `webdav_list`、`webdav_read_text`、`excel_inspect`、`excel_read_range`、`excel_apply_changes` 和 `excel_append_rows`。Excel 写入使用精确 ETag 和 `If-Match`，检测到其他客户端已修改时拒绝覆盖。右侧 File 面板的显示能力与模型工具分开：`.xlsx` 的可视预览由 Office 侧栏插件提供，缺少该插件时会显示“此文件类型不支持预览 / 下载查看”，但不代表 Excel 工具本身不可用。

当前 Web Profile 已固定安装 Office 预览 `0.1.3` 并加入 `dsh.profile.bundles`。跨机器安装清单位于 dsh-passwords 的 `scripts/profile-plugins.json`，同时把 dsh-web 来源固定为 `master`；`dev` 只用于跟随上游 fork，不作为客户部署分支。

### 4.7 kmMac 本地模型服务

28 通过 Tailscale 访问 `kmMac`，当前三个端点均通过健康检查：

| 地址 | 模型 | 用途 | 当前参数摘要 |
|---|---|---|---|
| `http://100.64.0.2:8080/v1` | `qwen3.8-27b-uncensored-q4` | 文本生成 | Q4_K_M 目标模型、Q4_0 MTP draft、64K 上下文、并行 4、KV F16 |
| `http://100.64.0.2:8081/v1` | `qwen3-vl-30b-a3b` | 图片识别 | Q4_K_M，当前服务上下文 16K |
| `http://100.64.0.2:8082/v1` | `z-image-turbo-4bit` | 图片生成 | 本地 OpenAI 兼容服务 |

28 的 systemd 定时器 `kmmac-model-monitor.timer` 每分钟检查 kmMac 的 Tailscale 在线状态。kmMac 从离线变为在线，或 28 本次开机尚未启动过时，监控脚本通过 SSH 启动文本、图片识别和图片生成服务。

该监控只判断设备在线状态，不持续检查 8080、8081、8082 的端口健康。kmMac 保持在线但模型进程退出时，定时器不会自动重启模型；需要增强脚本的健康探测，或把状态文件改为 `failed` 后手动启动服务。

当前 `~/.dsh/settings.yaml` 的 `mac-qwen` 路由仍记录旧模型名 `qwen3.8-27b-q4`，而 8080 当前公布的别名是 `qwen3.8-27b-uncensored-q4`。迁移或验收时必须统一模型 ID，否则模型列表看似可用但请求会失败。

## 5. 目录与数据所有权

| 路径 | 内容 | 是否必须备份 |
|---|---|---|
| `/home/tzwl3/apps/dsh-runtime/current` | 指向当前 dsh 运行时发布 | 记录链接目标；源代码可重建 |
| `/home/tzwl3/apps/dsh-runtime/releases/` | 不可变运行时发布目录 | 保留最近两个可用版本 |
| `/home/tzwl3/apps/dsh-web/current` | 指向当前 dsh-web 发布 | 记录链接目标；源代码可重建 |
| `/home/tzwl3/apps/dsh-plugins/current` | 指向当前业务插件发布 | 记录链接目标 |
| `/home/tzwl3/.dsh/profiles/web/` | Web Profile 的依赖、锁文件和补丁 | 是；这是实际加载优先级最高的依赖树 |
| `/home/tzwl3/.dsh/settings.yaml` | 模型、默认模型、宠物等设置 | 是，敏感，权限 0600 |
| `/home/tzwl3/.dsh/.credentials.yaml` | dsh 凭证 | 是，敏感 |
| `/home/tzwl3/.dsh/sessions/` | 会话 JSONL 与工作区分组数据 | 是 |
| `/home/tzwl3/.dsh/attachments/` | 对话附件 | 是 |
| `/home/tzwl3/.dsh/storages/` | 工作区与投影缓存 | 是 |
| `/home/tzwl3/.dsh/spend-ledger.sqlite*` | Spend 个人账本及 WAL/SHM | 是；复制前先停服务或用 SQLite 在线备份 |
| `/home/tzwl3/.dsh/credentials/dsh-nas-webdav/` | WebDAV 主密钥引用和凭据服务配置 | 是，敏感 |
| `/home/tzwl3/.cache/dsh-nas-webdav/` | 各账号 rclone VFS 缓存 | 否；停服务并确认已回写后可重建 |
| `/home/tzwl3/.dsh/plugins/subscriptions/auth.json` | ChatGPT、Claude、Grok OAuth Token | 是，极敏感，权限 0600 |
| `/home/tzwl3/.dsh/pet-accounts/` | 按账号隔离的宠物状态 | 是 |
| `/home/tzwl3/.dsh/task-board/` | 任务看板与调度记录 | 是 |
| `/home/tzwl3/apps/dsh-plugins/current/dsh-passwords/.env` | 网关、MySQL、签名和加密密钥 | 是，极敏感，权限 0600 |
| `/home/tzwl3/dsh-user-workspaces/` | 子账号专属文件 | 是；删除账号不会删除这里的数据 |
| `/home/tzwl3/mac.md` | kmMac SSH 连接信息 | 是，极敏感，权限 0600；推荐改用 SSH Key |
| `/home/tzwl3/.pm2/dump.pm2` | PM2 开机恢复清单 | 是；当前权限 0664，建议改为 0600 |
| `/etc/systemd/system/kmmac-model-monitor.*` | kmMac 监控 service 和 timer | 是 |
| `/home/tzwl3/.local/bin/kmMac-model-monitor` | kmMac 上线监控脚本 | 是 |
| `/home/tzwl3/.local/share/kmMac-model-monitor/start-llama.sh` | 发送给 kmMac 的启动脚本 | 是 |

dsh-passwords 的账号、权限、使用量、留言、审计和工作区映射在 MySQL 中。`MCP_DB_PATH` 指向的 SQLite 文件仍保留，但 MySQL 模式不会自动和 SQLite 双向同步，不能把该文件当成当前账号数据库。

## 6. 密钥和配置规则

必须由部署人员单独准备以下秘密，不能提交 Git：

- dsh-passwords：`SETUP_KEY`、`MCP_JWT_SECRET`、`MCP_INTERNAL_SECRET`、`MCP_DB_ENC_KEY`。
- MySQL：`DSH_PASSWORDS_MYSQL_USER`、`DSH_PASSWORDS_MYSQL_PASSWORD`。
- 模型提供方：`~/.dsh/.credentials.yaml` 和 `~/.dsh/settings.yaml` 中引用的 API Key。
- 订阅 OAuth：`~/.dsh/plugins/subscriptions/auth.json`。
- kmMac：`/home/tzwl3/mac.md` 或替代它的 SSH 私钥。
- Tailscale：一次性或可撤销的 Auth Key。
- WeKnora：`WEKNORA_API_KEY`，以及部署专用的 `WEKNORA_BASE_URL` 和允许共享的知识库 ID。

不得修改一个已使用数据库对应的 `MCP_DB_ENC_KEY`，否则已加密用户名、IP 和审计字段无法解密。轮换 JWT 或内部签名密钥会使当前登录失效，应安排维护窗口。

dsh-passwords 当前非敏感配置如下：

```dotenv
DSH_PASSWORDS_DB_DRIVER=mysql
DSH_PASSWORDS_MYSQL_HOST=192.168.10.95
DSH_PASSWORDS_MYSQL_PORT=3306
DSH_PASSWORDS_MYSQL_DATABASE=dsh_passwords_platform
DSH_PASSWORDS_MYSQL_TLS=off
DSH_PASSWORDS_MYSQL_QUERY_TIMEOUT_MS=15000
MCP_MANAGED_WORKSPACE_ROOT=/home/tzwl3/dsh-user-workspaces
MCP_GATEWAY_HOST=0.0.0.0
MCP_GATEWAY_PORT=3081
MCP_GATEWAY_UPSTREAM=http://127.0.0.1:3080
MCP_GATEWAY_REDIRECT_PORT=0
MCP_GATEWAY_AUTO_TLS=0
MCP_LOCAL_WORKSPACE_HOST=0.0.0.0
MCP_LOCAL_WORKSPACE_PORT=3082
MCP_LOCAL_WORKSPACE_PUBLIC_URL=ws://100.64.0.5:3082
MCP_LOCAL_WORKSPACE_PLACEHOLDER_ROOT=/home/tzwl3/dsh-local-workspaces
MCP_DSH_ROOT=/home/tzwl3/apps/dsh-runtime/current/node_modules/@deepseek-ai/dsh
MCP_DSH_RESTART_SERVICE=
```

MySQL 位于另一台主机且当前 `TLS=off`，只应通过可信局域网或 VPN 访问。跨不可信网络迁移时改为 `required` 或 `verify-ca`。

## 7. 新机器部署顺序

### 7.1 安装系统依赖

使用部署时仍受支持的 Ubuntu LTS。当前 28 的 Ubuntu 24.10 只作为现状记录，不应作为新机器的系统版本模板。使用普通用户 `tzwl3` 运行 dsh，避免用 root 创建 Profile 和数据文件。

```bash
sudo apt update
sudo apt install -y build-essential ca-certificates git curl openssh-client sshpass rsync sqlite3 default-mysql-client rclone fuse3
```

安装 Node.js `22.21.1`，将其固定在 `/home/tzwl3/.local/opt/node-v22.21.1-linux-x64/`，然后安装 pnpm 11 和 PM2。所有构建、PM2 启动和运维命令必须使用同一 Node 22 PATH：

```bash
export PATH=/home/tzwl3/.local/opt/node-v22.21.1-linux-x64/bin:/home/tzwl3/.local/bin:$PATH
corepack enable
corepack prepare pnpm@11.24.0 --activate
npm install -g pm2@6.0.13
```

### 7.2 安装并加入 Tailscale 网络

先按 Tailscale 当前支持的 Ubuntu 安装方式加入其软件源并安装 `tailscale` 包，再执行：

```bash
sudo systemctl enable --now tailscaled
sudo tailscale up --reset \
  --login-server https://gr.gr-iot.cn:18443 \
  --auth-key '<TAILSCALE_AUTH_KEY>'
tailscale status
```

Auth Key 必须从部署环境注入，不得写入脚本或本文。28 当前应获得 `100.64.0.5`；若地址变化，应同步修改客户端入口、本机助手 WebSocket 地址、访问控制和文档基线。

### 7.3 准备源代码

当前自有仓库为：

- `git@github.com:sdwhwzp/deepseek-harness.git`
- `https://github.com/sdwhwzp/dsh-passwords.git`
- `https://github.com/sdwhwzp/dsh-web.git`
- `https://github.com/sdwhwzp/dsh-spend.git`
- `https://github.com/sdwhwzp/dsh-plugin-subscriptions.git`
- `https://github.com/sdwhwzp/dsh-weknora.git`
- `http://gr.gr-iot.cn:30000/deepseek-harness/nas.git`

部署前必须确认这些仓库的改动已经 commit 和 push。dsh-web 的客户开发与部署分支是 `master`；同步上游时先更新 fork 的 `dev`，验证后再合并到 `master`。2026-09-01 Alpha.3 的可重复部署基线为：Harness `b66a316`、dsh-web `0f9116c`、dsh-passwords `d67159a`、dsh-plugin-subscriptions `d3f549f`、dsh-genui `2597912`、dsh-spend `a0d1648`、dsh-weknora `619c1d0`、dsh-at-file `45a5cbe`、dsh-nas-webdav `ef3b9eb` 和品牌插件 `af49ba6`。

### 7.4 构建

```bash
cd /path/to/deepseek-harness
pnpm install --frozen-lockfile
pnpm run build

cd /path/to/dsh-web
pnpm install --frozen-lockfile
pnpm -r build

cd /path/to/dsh-passwords
npm ci
npm run build
npm test
npm pack

cd /path/to/dsh-spend
npm ci
npm test

cd /path/to/nas
npm ci
npm test

cd /path/to/dsh-plugin-subscriptions
pnpm install --frozen-lockfile
pnpm run build
pnpm test

cd /path/to/dsh-weknora
npm ci
npm run typecheck
npm test
```

若某仓库的锁文件与实际包管理器不同，以仓库 `package.json` 和锁文件为准。不要在服务器上自动更新到 `latest`；先在本机测试并固定提交或包版本。

### 7.5 发布目录与原子切换

运行时、dsh-web 和业务插件分别使用时间戳发布目录，`current` 只做软链接。不要覆盖当前发布，也不要删除上一个可用版本。

```bash
runtime_root=/home/tzwl3/apps/dsh-runtime
release="$runtime_root/releases/<RELEASE_ID>"
test ! -e "$release"
mkdir -p "$release"
# 将经过验证的运行时产物复制到 $release
ln -sfn "$release" "$runtime_root/current"
```

dsh-web 是 pnpm workspace，不能只把新发布目录的根 `node_modules` 软链接到旧发布。每个 `packages/*` 依赖的是本发布目录内由 pnpm 生成的包级 `node_modules` 链接；缺失时 Cordis 会在加载插件时以 `ERR_MODULE_NOT_FOUND` 退出，PM2 随即进入重启循环。新发布必须在自身目录完成 `pnpm install --offline --frozen-lockfile`（或完整复制一套已经验证的 pnpm 布局），切换 `current` 前至少直接导入本次修改插件的 `lib/index.js`，并观察 PM2 的 PID 与重启次数在一个验收窗口内保持不变。

业务插件也使用同一模式：

```text
/home/tzwl3/apps/dsh-plugins/releases/<RELEASE_ID>/
  dsh-passwords/
  dsh-plugin-subscriptions/
  dsh-spend/
  dsh-shandong-tizhi-brand/
  dsh-weknora/
  nas/
```

部署新的 dsh-passwords 包时，从旧发布复制 `.env`、必要的本地 `data/` 和依赖，不得覆盖或丢失密钥。先在新目录验证 `dist/client.js`、`dist/gateway.js` 和 `package.json`，再切换软链接。

### 7.6 安装 Web Profile 插件

Web Profile 是 28 实际解析插件和浏览器 bundle 的第一来源。只替换 `/home/tzwl3/apps/dsh-runtime/current` 不会自动更新 `~/.dsh/profiles/web/node_modules`。

不要对这套 Profile 逐个运行 `dsh plugin add`：该命令可能把所有声明 `dsh.bundle` 的依赖重复加入 bundles，造成 `duplicate loader entry id`。新机器应把 `dsh-web`、`dsh-passwords`、`dsh-spend` 和 `nas` 放在安装清单约定的相邻目录，然后使用 dsh-passwords 的版本化清单同步依赖、bundle、构建授权和 profile patch：

```bash
export PATH=/home/tzwl3/.local/opt/node-v22.21.1-linux-x64/bin:/home/tzwl3/.local/bin:$PATH
node /path/to/dsh-passwords/scripts/register-plugin.mjs
node /home/tzwl3/apps/dsh-runtime/current/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --dump-config >/tmp/dsh-web-config.yml
```

该清单会安装 `dsh-at-file` 的 `dev` 分支、`@huanlin/dsh-plugin-better-sidebar-plugin-office@0.1.3` 和 `@wxg-prc-cpg/dsh-weknora`。安装后检查 `~/.dsh/profiles/web/package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml` 和 `node_modules` 都指向新发布，且三个包同时存在于 dependencies 和 `dsh.profile.bundles`。`dsh-at-file` 的搜索端点必须经过会话归属校验，子账号只能读取本人获准工作区的过滤设置并且不能修改共享设置；插件索引和手工 `@path` 引用都必须拒绝规范目标位于工作区外部的符号链接。清单安装器只为实际命中相邻源码的插件执行本地构建；Profile 中指向 `/home/tzwl3/apps/dsh-web/current` 等独立发布目录的既有链接会原样保留，不会再误查 `dsh-passwords` 旁边不存在的 `dsh-web`。发布目录内已有 `dsh-plugin-subscriptions` 和 `dsh-at-file` 时优先使用相邻链接，服务器无需安装 Git；只有源码缺失时才拉取 GitHub `dev`。本地 at-file 链接安装前会运行 `scripts/link-runtime-peers.mjs`，从 `~/apps/dsh-runtime/current/node_modules` 解析当前版本的 Typert、Settings、LLM 和 Invariants Host 包，并把 `protobufjs` 加入 Profile 的 `allowBuilds`；非标准布局必须设置 `DSH_RUNTIME_NODE_MODULES`。不要手工只改 `package.json` 而不更新锁文件和依赖目录。已有服务器采用独立不可变发布目录时，先备份整套 Profile，再用清单脚本更新依赖和锁文件；验证失败时同时恢复 Profile 备份和 plugins `current` 软链接。

WeKnora 配置必须通过 PM2 进程环境或仅部署人员可读的环境文件注入，并在 `pm2 restart dsh-web --update-env` 后生效：

```dotenv
WEKNORA_BASE_URL=https://weknora.example.com/api/v1
WEKNORA_API_KEY=<restricted-api-key>
WEKNORA_TENANT_ID=<platform-key-tenant-id-if-required>
WEKNORA_KNOWLEDGE_BASE_IDS=<shared-kb-id-1>,<shared-kb-id-2>
WEKNORA_AGENT_ID=<optional-agent-id>
```

不要照抄示例地址。先从 28 验证 `${WEKNORA_BASE_URL}/knowledge-bases` 可达，再检查 `dsh --profile web --dump-config` 只包含环境表达式或已注入的运行时值，不把 API Key 复制进仓库和部署文档。`WEKNORA_KNOWLEDGE_BASE_IDS` 只设置默认范围，不能阻止调用方传入其他知识库 ID；多账号环境必须在 WeKnora 服务端限制该 API Key 的实际权限。

### 7.7 配置 dsh-passwords 和 MySQL

把备份的 `.env` 恢复到新 dsh-passwords 发布目录并执行：

```bash
chmod 600 /home/tzwl3/apps/dsh-plugins/current/dsh-passwords/.env
mkdir -p /home/tzwl3/dsh-user-workspaces
chmod 700 /home/tzwl3/dsh-user-workspaces
```

首次连接空 MySQL 时插件会创建表。现有环境必须先恢复 MySQL dump，再启动网关。切换 SQLite/MySQL 只改变当前驱动，不会自动迁移历史行。

### 7.8 启动 PM2 并配置开机恢复

```bash
export PATH=/home/tzwl3/.local/opt/node-v22.21.1-linux-x64/bin:/home/tzwl3/.local/bin:$PATH
cd /home/tzwl3/dsh-workspace
pm2 start /home/tzwl3/apps/dsh-runtime/current/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --name dsh-web \
  --interpreter /home/tzwl3/.local/opt/node-v22.21.1-linux-x64/bin/node \
  -- web --no-open --port 3080
pm2 save
chmod 600 /home/tzwl3/.pm2/dump.pm2
```

当前机器通过用户 crontab 的 `@reboot ... pm2 resurrect` 恢复，不依赖 `pm2-tzwl3.service`。迁移时必须恢复该 crontab，并在重启后验证 PM2 真正在线。

### 7.9 安装 kmMac 监控

恢复以下文件并保持权限：

- `/etc/systemd/system/kmmac-model-monitor.service`
- `/etc/systemd/system/kmmac-model-monitor.timer`
- `/home/tzwl3/.local/bin/kmMac-model-monitor`
- `/home/tzwl3/.local/share/kmMac-model-monitor/start-llama.sh`
- `/home/tzwl3/mac.md`，权限 0600；推荐改用 SSH Key 后移除密码字段。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kmmac-model-monitor.timer
systemctl list-timers kmmac-model-monitor.timer
```

kmMac 必须预先放好文本 target/draft GGUF、视觉模型、图片生成虚拟环境和启动脚本，并确认 Tailscale Serve 将 8081、8082 转发到对应回环服务。

## 8. 升级与回滚

### 8.1 升级原则

1. 在本机构建并完成相关测试，不在生产目录直接编译。
2. 创建全新的发布目录，旧发布保持不变。
3. 复制配置和数据时保留权限，不复制临时上传文件。
4. 验证新发布的 bundle、配置清单和依赖路径。
5. 原子切换 `current` 软链接。
6. `pm2 restart dsh-web --update-env`。
7. 执行本文验收清单；失败立即把软链接切回旧发布并重启。
8. 运行稳定后执行 `pm2 save`。

### 8.2 Web Profile 覆盖陷阱

“一键选择本机文件夹”曾出现 dsh-passwords bundle 已含入口、页面却不显示的情况。原因是 `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 仍是旧副本，不包含 `conversation.input.bootstrap`。

升级后必须执行：

```bash
grep -q 'conversation.input.bootstrap' \
  /home/tzwl3/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js

grep -q 'dsh-passwords-local-workspace-launcher' \
  /home/tzwl3/apps/dsh-plugins/current/dsh-passwords/dist/client.js
```

两项必须同时成功。当前正确的 conversation bundle 短 SHA-1 为 `2440832da50b`，dsh-passwords 客户端 bundle 短 SHA-1 为 `d40def448ef9`；未来代码变化会产生新哈希，因此验收应同时检查功能标记，不能永久写死哈希。

若 Profile 仍旧，优先用同一版本 dsh CLI 重新安装 Web Profile 依赖。紧急恢复时应先备份 Profile 内旧文件，再从经过验证的运行时复制包含该插槽的 `client.js`，重启并检查首页启动清单中的 `rev` 已变化。

### 8.3 回滚

```bash
ln -sfn /home/tzwl3/apps/dsh-runtime/releases/<LAST_GOOD> \
  /home/tzwl3/apps/dsh-runtime/current
ln -sfn /home/tzwl3/apps/dsh-plugins/releases/<LAST_GOOD> \
  /home/tzwl3/apps/dsh-plugins/current
ln -sfn /home/tzwl3/apps/dsh-web/releases/<LAST_GOOD> \
  /home/tzwl3/apps/dsh-web/current
pm2 restart dsh-web --update-env
```

如果升级修改了 Web Profile，还要恢复 `~/.dsh/profiles/web/` 的同批备份。数据库迁移必须单独确认可逆性，不能只回滚代码而保留不兼容数据库结构。

## 9. 备份与迁移

### 9.1 备份

先停止入口，防止 SQLite WAL、会话和配置在复制中变化：

```bash
pm2 stop dsh-web
```

备份以下内容：

```bash
backup=/path/to/backup/server-28-$(date +%Y%m%d-%H%M%S)
mkdir -p "$backup"
rsync -a /home/tzwl3/.dsh/ "$backup/dsh-home/"
rsync -a --one-file-system --exclude='u*/WebDAV/' /home/tzwl3/dsh-user-workspaces/ "$backup/dsh-user-workspaces/"
rsync -a /home/tzwl3/apps/dsh-plugins/current/dsh-passwords/.env "$backup/dsh-passwords.env"
rsync -a /home/tzwl3/.pm2/dump.pm2 "$backup/pm2-dump.pm2"
rsync -a /home/tzwl3/.local/bin/kmMac-model-monitor "$backup/"
rsync -a /home/tzwl3/.local/share/kmMac-model-monitor/ "$backup/kmMac-model-monitor/"
sudo rsync -a /etc/systemd/system/kmmac-model-monitor.service "$backup/"
sudo rsync -a /etc/systemd/system/kmmac-model-monitor.timer "$backup/"
```

MySQL 使用一致性 dump，密码通过受控环境或 MySQL option file 提供，不写在命令历史：

```bash
mysqldump --single-transaction --routines --triggers \
  -h 192.168.10.95 -P 3306 -u '<MYSQL_USER>' \
  dsh_passwords_platform >"$backup/dsh_passwords_platform.sql"
```

备份完成后重新启动：

```bash
pm2 start dsh-web
```

### 9.2 恢复顺序

1. 创建同名系统用户并安装固定 Node、pnpm、PM2 和 Tailscale。
2. 恢复代码发布目录和 `current` 软链接。
3. 恢复 MySQL dump。
4. 恢复 dsh-passwords `.env`，保持原 `MCP_DB_ENC_KEY`。
5. 恢复 `~/.dsh/`、专属工作区和插件数据。
6. 恢复 Web Profile，随后用当前 dsh CLI 重新安装一次链接依赖并执行 `--dump-config`。
7. 恢复 kmMac 监控、PM2 dump 和 crontab。
8. 启动 dsh，执行完整验收。

不迁移 OAuth `auth.json` 时，ChatGPT、Claude、Grok 需要重新登录；不迁移 `.dsh/sessions` 时，会话不会出现在新机器；不迁移 `dsh-user-workspaces` 时，子账号的工作区记录仍在数据库但目录内容缺失。

## 10. 部署验收清单

### 10.1 进程和端口

```bash
export PATH=/home/tzwl3/.local/opt/node-v22.21.1-linux-x64/bin:/home/tzwl3/.local/bin:$PATH
pm2 status
curl -sS -o /dev/null -w '3080=%{http_code}\n' http://127.0.0.1:3080/
curl -sS -o /dev/null -w '3081=%{http_code}\n' http://127.0.0.1:3081/
ss -lntp | grep -E ':3080|:3081|:3082'
```

预期：PM2 `dsh-web` 为 `online`，3080 返回 200，未登录访问 3081 返回 302，3082 正在监听。

### 10.2 浏览器 bundle

```bash
curl -sS http://127.0.0.1:3080/ >/tmp/dsh-index.html
grep -o 'dsh-passwords[^}]*rev[^}]*' /tmp/dsh-index.html
grep -q 'conversation.input.bootstrap' \
  /home/tzwl3/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js
grep -q 'managedFilesDeleteConfirmDirectory' \
  /home/tzwl3/apps/dsh-plugins/current/dsh-passwords/dist/client.js
curl -fsS http://127.0.0.1:3080/plugins/@huanlin/dsh-plugin-better-sidebar-plugin-office/client.js \
  >/tmp/dsh-office-preview-client.js
grep -q 'xlsx' /tmp/dsh-office-preview-client.js
```

### 10.3 登录和权限

- 管理员可使用账号密码登录 3081，并能进入账号管理。
- 子账号可登录，但看不到订阅登录、退出和订阅用量。
- 子账号的 Codex 模型只有 Sol、Terra、Luna；Grok 聊天模型只有 4.6 和 4.5；Claude、DeepSeek 和自建提供方按各自配置保留。
- 月额度为 0 的子账号提问时收到明确额度不足提示。
- 子账号刷新 Spend 后只看到自己的调用和金额，不显示订阅计划用量；旧日志中的已认证 `user/message` 能正确回填到该账号。
- 子账号不能访问 SSH、皮肤管理、共享上传列表或其他账号工作区。
- 子账号登录后的 WebSocket 实时工作区、会话和归档事件也只包含本账号数据；不会先显示管理员内容再在刷新后消失。
- 管理员删除子账号后，专属目录及文件仍保留。

### 10.4 文件和本机工作区

- 左侧 Workspace 上方显示“文件夹管理”。
- 可上传单文件、整个文件夹、下载、删除文件和递归删除文件夹。
- 右侧 File 面板可下载普通文件；关闭“git 下载”只禁止 git、会话导出和共享下载通道，不影响已授权工作区内的普通文件。
- 删除专属根目录、`..` 路径和符号链接逃逸会失败。
- 空白新对话的“选择模式”旁显示“一键选择本机文件夹”。
- Windows 助手可配对、选择目录并显示“打开对话”。
- 本机工作区只允许访问用户授权的目录。
- 每个账号绑定 WebDAV 后都能同时看到自己的 `WebDAV` 工作区，并可在其中创建目录和选择子目录。
- 重启 dsh 后不打开任何浏览器，已绑定账号的 rclone 挂载也会自动恢复；`findmnt -T ~/dsh-user-workspaces/u2/WebDAV` 应显示 `fuse.rclone`。
- 右侧 File 面板可预览 `.xlsx`；模型可用 `excel_inspect` 和 `excel_read_range` 读取同一文件，不再报 `authenticated principal required`。

### 10.5 Tailscale 和模型

```bash
tailscale status
curl -fsS http://100.64.0.2:8080/v1/models
curl -fsS http://100.64.0.2:8081/health
curl -fsS http://100.64.0.2:8082/health
```

确认 `~/.dsh/settings.yaml` 的模型 ID 与 `/v1/models` 返回值一致。文本模型当前应使用 `qwen3.8-27b-uncensored-q4`。

### 10.6 重启验收

完成一次服务器重启，再检查：

- `tailscaled` 自动启动并恢复 `100.64.0.5`。
- crontab 成功执行 `pm2 resurrect`。
- `kmmac-model-monitor.timer` 为 active，下一次触发时间正常。
- 3080、3081、3082 恢复监听。
- MySQL 连接日志指向 `dsh_passwords_platform`。
- 浏览器强制刷新后插件没有白屏或 loader 错误。

## 11. 常见故障

### 11.1 新对话没有“一键选择本机文件夹”

先检查 dsh-passwords bundle 是否注册入口，再检查 Web Profile 的 conversation bundle 是否提供插槽。只有前者存在没有用，Profile 旧副本会覆盖 runtime。

```bash
grep -q 'dsh-passwords-local-workspace-launcher' \
  /home/tzwl3/apps/dsh-plugins/current/dsh-passwords/dist/client.js
grep -q 'conversation.input.bootstrap' \
  /home/tzwl3/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js
```

修复 Profile 后重启 PM2，并在浏览器执行 `Ctrl+F5` 或 `Ctrl+Shift+R`。

### 11.2 3081 正常但 3080 的配置与客户页面不同

3080 是回环地址上的 dsh 上游，3081 是带账号身份和权限的客户网关。模型过滤、订阅用量隐藏、工作区隔离和文件权限都依赖 3081；不要让客户直接访问 3080。

### 11.3 `settings are unavailable in this browser`

确认访问的是 3081、登录 Cookie 有效、插件 Host 半侧已经挂载，并检查目标设置命名空间是否存在于 Host 白名单。Web Profile 的旧依赖也可能让设置卡片有客户端代码但没有可用命名空间。

### 11.4 `/api/usageStats/query` 返回 404 或要求 principal

客户页面必须通过 3081，由 dsh-passwords 写入签名 principal。确认请求没有绕过网关，dsh-passwords Host 插件已挂载，Spend 与 subscriptions 使用当前版本，并检查浏览器是否仍保留旧 bundle。

若会话日志中的 `user/message.data.principal` 存在，但 `turn/start`、`step/start` 和工具执行仍没有 principal，说明服务器仍在运行未原生传播身份的旧 agent-loop。28 必须至少使用 dsh-passwords `2.5.10`、dsh-nas-webdav `0.2.2` 和 dsh-spend `0.4.9` 的兼容组合；只升级其中一个会分别留下额度绕过、WebDAV 工具认证失败、重启后挂载为空或 Spend 归户为空的问题。

### 11.5 子账号显示 ¥0 但仍能调用模型

先在账号管理中确认月额度是否确实为 0。若为 0，正常行为是在 pre-step 阶段明确拒绝，调用不会发给模型。若仍能调用，检查 dsh-passwords 是否为 `2.5.9` 以上、请求是否经过 3081，以及会话 `user/message` 是否带网关 principal；不要把匿名兼容会话当成已登录子账号。修复后要继续使用模型，必须由管理员给该账号分配大于 0 的月额度。

### 11.6 WebDAV Excel 工具提示 `authenticated principal required`

确认 dsh-nas-webdav 为 `0.2.2` 以上，并与 dsh-passwords `2.5.10` 的 principal 与账号枚举服务一起部署。重启后重新登录 3081，再从当前账号的 WebDAV 工作区选择文件。错误仍存在时检查 pre-step 消息是否带 principal；不要让模型改用 Bash、Python 或安装库绕过 WebDAV 凭据隔离。

### 11.7 WebDAV 工作区存在但文件为空

先用 `findmnt -T ~/dsh-user-workspaces/u2/WebDAV` 检查该目录是否真正挂载为 `fuse.rclone`，不要只检查目录是否存在。如果只是普通空目录，确认 dsh-passwords `2.5.10` 和 dsh-nas-webdav `0.2.2` 成对部署，然后重启 dsh；新版会在 Host 启动时枚举已绑定账号并恢复挂载，定时巡检也会继续重试。查看 `pm2 logs dsh-web` 中的 `workspace reconcile failed` 可区分 MySQL、NAS、rclone 和 FUSE 故障。

### 11.8 `.xlsx` 显示“不支持预览”

确认 `@huanlin/dsh-plugin-better-sidebar-plugin-office@0.1.2` 同时存在于 Web Profile dependencies、`dsh.profile.bundles` 和 `node_modules`。直接请求 `/plugins/@huanlin/dsh-plugin-better-sidebar-plugin-office/client.js` 应返回 200，文件应包含 `xlsx`。重启 dsh 后在浏览器强制刷新；Office 预览客户端约 22.4 MB，首次加载会比文本预览慢。

### 11.9 插件 loader 失败或页面白屏

```bash
pm2 logs dsh-web --lines 200
node /home/tzwl3/apps/dsh-runtime/current/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --dump-config >/tmp/dsh-config.yml
```

检查 Profile 的 link 目标存在、所有插件已构建 `lib/` 或 `dist/`、`package.json` 的客户端导出存在、启动清单的 `rev` 与实际文件内容一致。不要同时保留已停用的 `@linxin666/dsh-web-ui-all` 和新的 `@linxin666/dsh-web-all`。

### 11.10 插件管理器提示 `dsh CLI not found on PATH`

启动 PM2、Doctor 和插件管理操作时统一加入：

```bash
export PATH=/home/tzwl3/.local/opt/node-v22.21.1-linux-x64/bin:/home/tzwl3/.local/bin:$PATH
```

不要依赖交互式 Shell 才有的 PATH。

### 11.11 自建 Qwen 模型无响应

比较 `~/.dsh/settings.yaml` 的模型 ID 和 `http://100.64.0.2:8080/v1/models`。当前服务别名是 `qwen3.8-27b-uncensored-q4`，旧别名 `qwen3.8-27b-q4` 需要更新。再检查 Tailscale、kmMac 端口、llama-server 日志和 64K 上下文的并发占用。

### 11.12 kmMac 在线但模型进程没有恢复

当前 timer 只处理 Tailscale 在线状态变化。检查：

```bash
systemctl status kmmac-model-monitor.timer
systemctl status kmmac-model-monitor.service
journalctl -u kmmac-model-monitor.service -n 100 --no-pager
cat /home/tzwl3/.local/state/kmMac-model-monitor/status
```

需要强制重试时先把状态改为 `failed`，再启动 service。长期方案是在监控脚本中增加 8080、8081、8082 健康探测。

### 11.13 MySQL 登录失败或账号消失

确认驱动为 MySQL、主机和库名正确、28 能连接 192.168.10.95:3306，并检查 `.env` 的用户和密码。SQLite 和 MySQL 不会自动互相迁移；驱动切错会表现为进入另一个空账号库。

### 11.14 子账号删除自己的 Workspace 返回 403

确认实际加载的是 dsh-passwords `2.6.15` 或更高版本，并检查目标 Workspace 的规范目录仍属于当前子账号的允许范围。网关只允许子账号移除本人拥有且当前获准的 Workspace 登记；其他账号拥有、没有 durable owner、路径不再获准或请求身份缺失时继续返回 403。

“删除工作区”只删除 Host 的 Workspace 登记，不删除目录、文件、会话或本机助手配对记录。若本机助手仍保持配对，后续重连或服务重启可以重新注册该目录；要永久停止自动恢复，应在“本机工作区”中撤销对应设备或目录授权。

## 12. 上传 Git 前检查

1. 确认 dsh-passwords、dsh-spend、dsh-nas-webdav、dsh-plugin-subscriptions、dsh-at-file、dsh-genui、dsh-weknora、品牌插件和 dsh-web 的包版本与提交号一致，避免同一版本号对应不同内容。
2. 将 deepseek-harness 和所有自有插件仓库的部署改动分别 commit 并 push；第三方固定安装包只记录来源版本和 SHA-256，不虚构自有提交。
3. 在本文记录最终 Git commit 或 release tag；不要把未提交工作树当作可重复部署源。
4. 检查没有提交 `.env`、`settings.yaml`、`.credentials.yaml`、`auth.json`、`mac.md`、数据库 dump、PM2 dump、SSH 私钥或 Tailscale Auth Key。
5. 对文档执行敏感词和私钥头检查：

```bash
rg -n '(PASSWORD|SECRET|TOKEN|AUTH_KEY|API_KEY)=.+|BEGIN .*PRIVATE KEY' \
  docs/server-28-deployment-runbook.md
```

6. 运行相关仓库的构建和定向测试，并在提交说明中列出实际执行的命令。

## 13. 当前发布标识

| 组件 | 当前目标 |
|---|---|
| runtime | `/home/tzwl3/apps/dsh-runtime/releases/20260901-162100-b66a316-alpha3` |
| plugins | `/home/tzwl3/apps/dsh-plugins/releases/20260901-170745-d67159a-alpha3` |
| dsh-web | `/home/tzwl3/apps/dsh-web/releases/20260901-140500-0f9116c3-alpha3` |
| runtime 源提交 | `b66a31652d47db8683916c3284521f1029b7f232` |
| dsh-web 源提交 | `0f9116c33ce6ab2a5bb5d8162e53e4fea3cb7467` |
| dsh-passwords 安装包 | SHA-256 `ed3083151e1374927044538a151964c6f7d3d3a30e96b447419b35c5426547b7` |
| dsh-plugin-subscriptions 安装包 | SHA-256 `c0ad6a0fb025c96aace7cf8049a995c275e27cdccbb999dbdc1e6c1b14998553` |
| dsh-spend 安装包 | SHA-256 `dbcc1b89db6277a3caaf54a88854d7f945f37049f6b93b92f981ca9a7db7bde1` |
| dsh-nas-webdav 安装包 | SHA-256 `c849bb27ab623e887385646b8b37f130e20551464e592adbf2ec5172ed1eb31b` |
| dsh-at-file 安装包 | SHA-256 `39871f3d5377ae02fa83dc26a1b0e204298fb5176aa0a34fb47491c7cbfcdb48` |
| dsh-genui 安装包 | SHA-256 `f0c447f0b64d63e78c4ac9de1836101389d9d03e0094f20523b367bc404ad98b` |
| dsh-weknora 安装包 | SHA-256 `ebfd99d18df709b03f0dc2d97cab662c42132eb1bf326cae1b8810bc614adca0` |
| 品牌插件安装包 | SHA-256 `15d3d51ca465ca76574995d3b0fae6a953aa507d2acda043815d895bbe150a11` |
| Office 预览安装包 | SHA-256 `0f85a98a2470eef6d372c1c31ad2dc6a88ed642b2a1e2100910b8fcb4c779230` |
| better-sidebar 安装包 | SHA-256 `f464ce910b591245a667a5c48c637170f3eeb25b7b2712a3fcdd92580c9b7932` |
| Alpha.3 整体回滚备份 | `/home/tzwl3/apps/dsh-backups/20260901-162732-alpha3` |
| dsh-passwords 2.6.15 回滚备份 | `/home/tzwl3/apps/dsh-backups/20260901-171539-dsh-passwords-2.6.15` |

这些标识用于确认 2026-09-01 的 Alpha.3 服务器快照。任何后续构建都应创建新的发布标识和内容哈希，不应复用目录名或把新内容覆盖到旧发布中。插件发布目录内的 `DEPLOYMENT.json` 是完整包版本、源码提交和 SHA-256 的权威清单。

## 14. 2026-08-27 principal、Spend 与 Excel 预览部署记录

本次故障表现为 WebDAV Excel 工具报 `authenticated principal required`，子账号 Spend 显示 ¥0 和 0 Token，但同一账号仍能调用模型，右侧 File 面板对 `.xlsx` 只显示下载。排查确认 3081 已把签名 principal 写入 `user/message`，但服务器的旧 agent-loop 没有继续传播该身份；`.xlsx` 预览则是 better-sidebar 缺少独立 Office viewer，不是 WebDAV 或 Excel 解析器故障。

本次部署同时上线 dsh-passwords `5007b5c`、dsh-nas-webdav `3ff3e15`、dsh-spend `9c55954` 和 Office viewer `0.1.2`。新插件发布目录经独立构建后原子切换，旧目录未覆盖；Web Profile 在安装 Office 依赖前备份到本节上方记录的回滚目录。dsh-passwords 的跨机器插件清单已包含 Office viewer，并将 dsh-web 默认部署分支改为 `master`。

部署验证结果：dsh-passwords 构建通过，principal、插件清单、额度相关定向测试 11/11；dsh-nas-webdav 35/35；dsh-spend 21/21；并发全量测试中曾有 3 个 Windows 本机助手模拟连接超时，单独重跑对应文件 7/7 通过。运行态 PM2 为 online，3080 返回 200，3081 未登录返回 302，Office client 返回 200 且包含 XLSX viewer，近期日志没有 plugin loader、principal 或 Spend 错误。

## 15. 2026-08-27 子账号实时隔离与 WebDAV 挂载恢复记录

本次故障有两个独立原因。工作区和会话的 HTTP 列表已经按子账号过滤，但 Host 的 WebSocket 实时事件仍会原样转发，因此管理员工作区或会话可能先进入子账号内存，刷新后才被干净基线覆盖。WebDAV 另一侧只会对浏览器主动请求过的账号建立 rclone 挂载，进程重启后持久凭据仍在，但内存活动集合为空，所以页面看到的只是一个普通空目录。

修复由 dsh-passwords `2.5.10` 提供：子账号的 `/api/events.host` 与 `/api/events.mux` 在网关终止，每帧按工作区路径、会话归属、禁用列表和归档集合过滤，未知全局事件默认丢弃；同时 `managedUserWorkspace.listPrincipals()` 只向受信 Host 插件提供当前账号身份。dsh-nas-webdav `0.2.2` 在启动和定时巡检时遍历这些账号，只为已绑定的账号恢复独立挂载，单个账号失败不阻塞其他账号。对应提交为 dsh-passwords `a6ea992` 和 dsh-nas-webdav `2653b52`。

部署使用新的不可变发布目录 `20260827-a6ea992-2653b52-tenant-events-webdav-restore`，原子切换 `current` 后重启 PM2。服务器内定向回归为 dsh-passwords 27/27、dsh-nas-webdav 36/36；运行态验证为 3080=200、3081 匿名=302、PM2 online。`wzp` 的 WebDAV 已自动恢复为 `fuse.rclone` 并列出 7 个根目录条目；使用 90 秒临时诊断 JWT 调用 3081 时，工作区仅有 `u2`、`u2/测试`和 `u2/WebDAV`，归档 ID 为 0，Mux 收到 3 帧且外账号会话帧为 0，WebDAV 浏览接口返回 200 与 7 个条目。

## 16. 2026-08-27 WeKnora 插件接入记录

`@wxg-prc-cpg/dsh-weknora@0.1.1` 已加入 Web Profile dependencies、bundle 和 pnpm 构建授权，模块链接到不可变发布目录 `20260827-weknora-0.1.1`。插件注册知识库列表、检索、文档读取和问答四项工具，注册由 `ctx.effect()` 持有，卸载或重配置时会撤销工具。默认配置读取 `WEKNORA_BASE_URL`、`WEKNORA_API_KEY`、`WEKNORA_TENANT_ID`、`WEKNORA_KNOWLEDGE_BASE_IDS` 和 `WEKNORA_AGENT_ID`。

28 当前没有配置任何 `WEKNORA_*` 进程环境变量，也没有本机 WeKnora 服务，因此 loader 行保持禁用，不向客户暴露必然失败的工具。后续启用必须使用服务端受限 API Key；同一 Web Profile 的主账号和子账号共享该凭据，不能依赖默认知识库 ID 作为权限隔离。

部署前后插件测试均为 52/52，通过类型检查和文件哈希核对。最终运行态为 PM2 online、3080=200、3081 匿名=302，近期 WeKnora loader 错误为 0；`wzp` 的 WebDAV 仍为 `fuse.rclone` 且根目录 7 项。Profile 回滚文件保存在 `/home/tzwl3/.dsh/profile-backups/20260827-weknora-before`，旧插件发布目录未删除。

## 17. 2026-08-27 dsh-at-file 插件接入记录

`dsh-at-file@0.6.10` 基于 `sdwhwzp/dsh-at-file` 的 `dev` 分支接入 Web Profile。客户端在输入框键入 `@` 时枚举当前会话工作区内的文件和文件夹；Host 搜索 RPC 由 dsh-passwords 按 `agentId` 校验会话归属，子账号只能读取获准工作区的过滤设置且不能修改共享设置。插件枚举与手工 `@path` 都会解析符号链接的规范路径，目标落在工作区外时拒绝访问。

跨机器安装清单把该插件固定为 `github:sdwhwzp/dsh-at-file#dev`，相邻发布源码存在时强制切换到相邻链接，不继续保留旧发布目录。`scripts/link-runtime-peers.mjs` 自动链接当前 DSH 运行时的 Typert、Settings、LLM 和 Invariants Host 包，清单同时批准 `protobufjs` 的安装脚本；28 不再依赖手工创建 peer 链接或预装 Git。

部署包 `dsh-at-file-0.6.10.tgz` 的 SHA-256 为 `9ec6139a6089942c34d6c16fcf3aaa848df39ca1394d0839f302509581564bc8`。本机插件测试 169/169、类型检查和构建通过；加入连接重置与请求取消回归后，dsh-passwords 部署定向测试为 52/52。最终发布目录为 `/home/tzwl3/apps/dsh-plugins/releases/20260827-at-file-0.6.10-gateway-reset`，回滚 Profile 为 `/home/tzwl3/.dsh/profile-backups/20260827-at-file-0.6.10-gateway-reset-before`，旧 0.6.9、首个 0.6.10 和中间修复发布仍保留。

上线前的本机验证还发现两个取消连接竞态。浏览器旧 WebSocket 在网关重启期间复连并立即重置时，未转发的升级 Socket 会产生无人监听的 `ECONNRESET`；浏览器取消 `@` 搜索且工作区快照刷新同时失败时，上游错误与权限分支可能对同一响应重复写头并触发 `ERR_HTTP_HEADERS_SENT`。升级入口现在吸收已不可恢复连接的错误，异步权限检查只向仍可写的响应发送结果；20 次连续 WebSocket 重置和取消搜索回归均通过。本机重启后 PID 与启动次数保持不变，3081 连续返回 302。相同补丁已包含在 28 的最终发布中。

上线后 PM2 为 online，重启次数在观察窗口内保持 339，服务器本机 3080=200、3081 匿名=302，局域网 3081=302；插件客户端返回 200 和 611715 字节，重启后新增日志中的 loader、缺失模块和 dsh-at-file 错误为 0。3080 继续仅允许服务器本机访问，客户入口为 3081。`wzp` 的 WebDAV 仍挂载为 `fuse.rclone`，根目录保持 7 项。

## 18. 2026-08-27 工作区、实时事件和历史可靠性修复

本轮同时处理四个关联表现：右侧 File 面板的普通下载被 git 权限误拒绝；旧子账号的空工作区清单仍按旧语义开放普通宿主目录；新会话刚创建时，后续实时帧可能在工作区注册写回前被过滤；历史与实时连接每次都同步等待 `workspace.list`，上游短暂失败时分别表现为 502 和前台停止更新。

dsh-passwords 现在把普通文件预览和下载与 git 外带通道分开授权；服务启动会把托管子账号的旧空清单收紧为自己的专属目录，同时保留显式分配的共享目录；新会话进入待确认集合并保留到下一次权威工作区快照；已有可信快照时，工作区刷新改为后台执行并带失败退避，未知会话仍同步刷新并保持 fail-closed。定向测试覆盖下载权限、旧账号迁移、新会话连续事件和 `workspace.list` 暂时失败时的历史加载。

## 19. 2026-08-28 首屏工作区缓存隔离修复

子账号刷新后短暂出现其他账号工作区、约 3 秒后自动消失的原因是首屏使用 GET 加载 `workspace.list` 和 `session.list`，旧响应没有账号私有缓存指令。浏览器可能直接复用上一账号的 GET 缓存，随后 WebSocket 就绪触发的 POST 基线才用当前账号过滤结果覆盖页面。工作区列表本身没有写入 localStorage；Host/Mux WebSocket 的服务器端租户过滤继续保留。

dsh-passwords `2.5.12` 对认证 HTML、`workspace.list`、`session.list`、`session.search` 和 `session.history` 强制返回 `Cache-Control: private, no-store`、`Pragma: no-cache`、`Expires: 0` 和 `Vary: Cookie`。注入到 HTML 最前部的兼容脚本同时把首屏列表的浏览器 fetch 改为 `cache: no-store`，确保升级前已经保存的旧缓存也不会被读取。服务端仍按工作区路径、不可变会话归属、禁用列表和归档集合过滤响应，缓存控制不能替代权限检查。

本次创建不可变业务插件发布目录 `/home/tzwl3/apps/dsh-plugins/releases/20260828-dsh-passwords-2.5.12-history-gzip`，再把 `dsh-passwords-2.5.12.tgz` 安装到实际优先加载的 Web Profile。部署包 SHA-256 为 `57c6a555b03dccf74cbade241e2c31532bdeef11c70f25ccf2428ee6e06d2cb6`，Profile 回滚备份为 `/home/tzwl3/.dsh/profile-backups/20260828-history-gzip-before`。Profile 中的 `dist/gateway.js` 和 `dist/client.js` 已与本机构建哈希一致。

上线验证结果：PM2 `dsh-web` 为 online，3080 返回 200，3081 匿名访问返回 302；短期诊断子账号请求 `/api/workspace.list` 返回可解析 JSON、3 个获准工作区路径和上述私有禁缓存响应头，认证 HTML 含首屏 fetch 防缓存脚本。3080、3081、3082 均正常监听，重启后的日志没有新增 loader、JSON 解析或重复响应头错误。

同一子账号的一条尾页历史响应达到 15,774,235 字节，远程浏览器可能在 30 秒 RPC 截止时间前无法完成下载并显示请求被中止。网关处理 `session.history` 后会按浏览器的 `Accept-Encoding` 重新 gzip，并追加 `Vary: Accept-Encoding`；该生产样本压缩后为 1,271,360 字节，服务器本机请求耗时 0.60 秒。历史 JSON 的租户过滤和隐藏 Unicode 清洗仍在压缩前完成，压缩不会改变其授权语义。

## 20. 2026-08-28 会话隔离、历史连接和宠物默认值修复

子账号页面反复显示“载入历史”的直接原因是租户事件 WebSocket 把 `ws.send()` 成功回调传入的 `null` 当作发送失败，每收到一帧就关闭浏览器连接；客户端重连后重新同步当前会话，因此形成周期性历史加载。网关现在同时接受 `null` 和 `undefined` 为成功结果，上游事件流短暂断开时只在网关内部指数退避重连，不再关闭浏览器连接。改密、改名、删除账号、内部会话失效和退出登录会主动关闭旧租户连接；每帧及每次上游重连前还会重新验证 JWT、账号身份和 `credential_version`。

历史响应的异常分支也已收紧。子账号的 `session.history` 若收到 HTML、坏 JSON、损坏 gzip 或重写异常，网关统一返回 `application/json`、HTTP 502 和 `UPSTREAM_UNAVAILABLE`，不会再把 `<!doctype ...>` 交给客户端解析；管理员仍保留既有兼容回退。上线后的普通体量真实子账号历史只读探测返回 HTTP 200、合法 JSON 和业务成功，说明部署前用户看到的通用 502 已不再由当前发布复现。

会话身份改为不可变归属：显式 `session.create` ID 只有在 Host 注册表确认不存在、上游创建成功且返回相同 ID 后才能领取，并用按 ID reservation 阻止两个账号并发抢占；旧未归属 ID、其他账号 ID 和不可见 ID 都在转发前拒绝。`agentPreset.select` 复用同一所有权检查，模型选择按 `session_id` 持久化到 `session_model_selections`，不会再把某个会话的模型写成所有账号共享的默认值。子账号的 Session 引用候选端点返回 JSON 403，`dsh-at-file` bundle 禁用内置 `ui-reference`，因此输入 `@` 只显示当前工作区的文件和目录。

宠物由独立 Web 发布 `/home/tzwl3/apps/dsh-web/releases/20260828-1110-pet-default-off-fixed` 提供。没有账号级持久设置的新账号默认 `enabled=false`，客户端在设置加载完成且显式启用前不挂载宠物或启动轮询；已有账号的显式开关保持不变。每个 dsh-web 发布仍必须自带完整 pnpm 包级 `node_modules` 布局，不能只复用旧发布根目录的链接。

最终业务插件发布为 `/home/tzwl3/apps/dsh-plugins/releases/20260828-120830-dsh-passwords-2.5.14-final`，安装包 SHA-256 为 `a099730170a5b9b425707bb8ef45eba53201d91ffb2ab61f529a54d3570552b7`。本机 Node 22 全量测试 250/250、构建和 `git diff --check` 通过；服务器安装文件与本机构建的 gateway/client 哈希一致。上线后 PM2 只增加一次计划内重启并保持 online，3080=200、3081 匿名=302、3082 服务可达；真实子账号会话列表为合法 JSON，其他账号 `agentPreset.select` 返回 JSON 403，自己的历史返回业务成功，宠物设置为 `false`，事件 WebSocket 在 12 秒观察窗口内持续打开并接收 4 个过滤后帧。

## 21. 2026-08-28 大历史响应 502 修复

一条特定会话的 `session.history` 在 Host 3080 返回合法 JSON，但未压缩正文达到 20,014,188 字节。网关此前在 JSON 解析、隐藏 Unicode 清洗、租户过滤和出站 gzip 之前统一使用 16 MiB 原始响应上限，因此该会话稳定返回 JSON 502；强制刷新不能改变响应大小，也不能绕过该限制。

dsh-passwords `2.5.15` 仅把 `session.history` 改写分支的原始响应上限提高到 32 MiB。其他 API 继续使用 16 MiB，全局解压上限继续使用 64 MiB，历史内容仍须完整经过 JSON 校验、清洗和子账号沙盒降级后才能发送，超限响应继续 fail-closed 为 JSON 502。回归测试用分块响应验证 20 MiB 历史成功、超过 32 MiB 失败，避免测试本身一次性占用同等内存。

本机 Node 22 全量测试 251/251、构建和 `git diff --check` 通过。不可变发布目录为 `/home/tzwl3/apps/dsh-plugins/releases/20260828-180633-dsh-passwords-2.5.15-large-history`，安装包 SHA-256 为 `a0db3c263963b3781bc3b81b0d429d37ea896fe3f3a2455489116c6d75a5de2c`，Web Profile 回滚备份位于 `/home/tzwl3/apps/deploy-backups/20260828-180633-dsh-passwords-2.5.15-large-history`。上线后原故障会话以管理员和所属子账号身份请求均返回 HTTP 200、合法 JSON 和业务成功；解压正文为 20,014,164 字节，gzip 线上传输约 1.65 MB，服务器本机耗时 1.2 至 1.7 秒。PM2 只增加一次计划内重启并保持 online，3080=200、3081 匿名=302。

## 22. 2026-08-28 未分组与归档历史 403 修复

删除 Workspace 登记后，Host 会保留会话并把它投影到“未分组”。网关此前把当前 Workspace 成员关系同时当成会话归属条件，因此本人拥有、目录仍获授权的保留会话会在 `session.history` 被拒绝。旧会话补登记现在只读取 Host 返回的完整最早历史页，并校验首条人工消息上由 `dsh-passwords` 写入的 principal；目录位置不能证明账号身份，空白、旧格式、损坏或无法验证的历史不会分配给子账号。安全复审曾阻止按专属目录直接认领的初版方案，最终实现保持不可变账号归属、当前 cwd 路径授权和逐会话禁用三项检查。

生产目标会话完成安全补登记后仍返回 403，进一步确认它同时存在于 Host 的全局 `archivedSessionIds`。归档只是会话整理状态，不是账号授权边界；dsh-passwords `2.5.17` 因此允许子账号列出、搜索、读取和接收本人归档会话的实时帧，但仍要求 durable owner 匹配、cwd 存在、目录当前获准且未被逐条禁用。Workspace 响应继续删除跨账号归档枚举源，归档事件也只保留当前账号拥有的 ID。其他账号、缺少 cwd 或目录权限已撤销的归档会话继续 fail-closed。

本机 Node 22 聚焦测试 79/79、全量测试 251/251、`npm run build` 和 `git diff --check` 通过；独立复审未发现 HIGH 或 MEDIUM 级跨账号绕过。不可变发布目录为 `/home/tzwl3/apps/dsh-plugins/releases/20260828-194748-dsh-passwords-2.5.17-archived-history`，安装包 SHA-256 为 `3c9ce7dc7e89468a208517ccc26f37c024823fad609e30875c0293871ff5538e`，gateway/client SHA-1 分别为 `8262267ae4ad0e636ad1396301d3ae82ff2ab1c8` 和 `ed90595fdbe831026025b3c4cfee55ac6aca6b1e`，Profile 回滚备份位于 `/home/tzwl3/apps/deploy-backups/20260828-194748-dsh-passwords-2.5.17-archived-history`。

上线后的真实账号验收为：管理员看到 17 个会话和 4 个未分组会话；目标子账号看到 9 个会话，其中 1 个为本人未分组会话；该会话出现在列表且 `session.history` 返回 HTTP 200 和业务成功，活动会话对照同样返回 200。其余 3 个未分组会话对该子账号均返回 403，管理员对照返回 200。PM2 保持 online，3080 返回 200，3081 匿名访问返回 302，运行版本为 `2.5.17`。

## 23. 2026-09-01 Harness Alpha.3、构建版本、Grok 模型范围与工作区删除修复

本轮把运行时升级到 Harness `0.1.2-alpha.3`，线上源提交为 `b66a31652d47db8683916c3284521f1029b7f232`。展开侧栏底部由 Harness 外壳显示精确构建版本 `0.1.2-alpha.3-b66a316`，该标识不由品牌插件拥有，因此自定义品牌不能遮蔽。dsh-web 使用 `@linxin666/dsh-web-all@0.3.10` 和源提交 `0f9116c33ce6ab2a5bb5d8162e53e4fea3cb7467`；业务插件按本节上方 `DEPLOYMENT.json` 对应的版本、提交和安装包哈希组成同一 Alpha.3 cohort。

`dsh-plugin-subscriptions@0.6.2` 把 Grok 客户聊天模型统一收紧为 `grok-4.6` 和 `grok-4.5`。目录发现、设置、模型池、缓存、解析和流式请求共用同一允许列表，旧选择或手写其他 Grok 聊天模型 ID 返回 `UNKNOWN_MODEL`；图片、视频和搜索工具内部使用的模型不进入客户聊天模型选择器。Codex 客户范围仍为 Sol、Terra 和 Luna，其他厂商按各自配置保留。

`dsh-passwords@2.6.15` 修复子账号删除本人 Workspace 时被上游 403 拒绝的问题。网关只为当前身份转发本人拥有且当前获准的 Workspace 删除，并继续拒绝跨账号、未归属和未授权目录。操作只移除 Workspace 登记，目录、文件、会话和本机助手配对记录保留；仍处于配对状态的助手可以在后续连接时重新注册目录。

发布按 runtime、dsh-web 和业务插件三个不可变目录分别构建并原子切换，回滚点为 `/home/tzwl3/apps/dsh-backups/20260901-162732-alpha3` 与 `/home/tzwl3/apps/dsh-backups/20260901-171539-dsh-passwords-2.6.15`。上线后 PM2 为 online，3080 未认证返回 401，3081 未登录返回 302，3082 正常监听；Workspace 删除聚焦测试 34/34，通过 dsh-passwords 全量测试 354 项、跳过 13 项、失败 0 项和构建。只读生产验收有 42 项当前行为检查通过，另保留一项旧子代理会话归属 `sessionOwnerBootstrap=partial` 警告；该旧会话的分页接口被拒绝并保持隔离，不影响公开 readiness、账号/会话/工作区/历史/WebDAV/下载/Spend/订阅隐藏和插件 bundle 检查。

源码远端已确认包含本次部署提交。完成本手册提交和 dsh-web 上游同步后，远端分支快照为：Harness `tzwl` `b66a316`；dsh-web `dev` `80a7f61`、`master` `83a4ff0`，线上 `0f9116c` 是其祖先；dsh-passwords `feature/principal-budget-webdav` 包含线上 `d67159a` 及后续部署文档提交；subscriptions `dev` `d3f549f`；genui `dev` `2597912`；spend `feature/principal-budget-webdav` `a0d1648`；weknora `main` `619c1d0`；at-file `dev` `45a5cbe`；NAS `main` `ef3b9eb`；品牌插件 `main` `af49ba6`。Office `0.1.3` 和 better-sidebar `0.18.0-alpha.0` 是固定第三方安装包，没有自有源码提交，以本节上方 SHA-256 和实际安装包为恢复依据。

## 24. 2026-09-01 插件源码提交与推送收尾

本轮完成源码收尾，不执行 28 服务器部署或进程重启。dsh-web 的 `dev` 继续只跟踪 fork 上游，客户定制开发合并到 `master`；`master` 新增 better-sidebar 右侧编辑器的统一下载入口，所有文件类型都通过当前会话生成同源 `/sidebar/file` 地址，点击时重新读取当前文件路径和 Session，且在上游已有原生下载入口时不重复显示。

dsh-passwords 的普通文件下载和 HTML 预览现在都绑定到当前账号持久拥有、未禁用且目录仍获授权的 Session。网关不再让共享 Host 按浏览器传入路径重新打开文件，而是在规范路径校验后以 `O_NOFOLLOW` 和非阻塞模式打开，核对实际打开对象仍位于授权工作区，再从同一文件描述符读取。实现同时拒绝跨账号 Session、伪造 cwd、路径越界、编码前缀别名、符号链接逃逸、FIFO 阻塞、带正文的读取请求和不支持的方法；响应按 Cookie 私有禁缓存，HTML 下载保持原始字节，HTML 预览保留 sandbox CSP，客户端断开时主动销毁读取流。

远端分支在本轮收尾前后核对如下。表中的 SHA 是功能代码提交；dsh-passwords 还会在其后追加本节文档提交。

| 仓库 | 分支 | 功能提交 |
|---|---|---|
| `sdwhwzp/dsh-web` | `dev` | `80a7f61dc24aecc1fdce96e43235ea6af23df6df` |
| `sdwhwzp/dsh-web` | `master` | `501d586981d30b89730e058eacc9b27ed8b2a020` |
| `sdwhwzp/dsh-passwords` | `feature/principal-budget-webdav` | `8a1e413507e59cb23a45b932e3b4d6f8847ce61d` |
| `sdwhwzp/dsh-spend` | `feature/principal-budget-webdav` | `a0d16483697305a2a7d272bf7ed49a7cff4cbab5` |
| `sdwhwzp/dsh-plugin-subscriptions` | `dev` | `d3f549f85b8b90a725a589acfafdbbcf44c244b3` |
| `sdwhwzp/dsh-at-file` | `dev` | `45a5cbe6c8362eda137186fd617effc05cf898a5` |
| `sdwhwzp/dsh-weknora` | `main` | `619c1d089d153a552a9b64fee9df1978ed84c149` |
| `sdwhwzp/dsh-genui` | `dev` | `2597912d5237e0b0ebf7346bbdb4a4978d933792` |
| `deepseek-harness/nas` | `main` | `ef3b9eb4bface16a4dedfe3bdab430347128d015` |
| `deepseek-harness/dsh-shandong-tizhi-brand` | `main` | `af49ba6f38d4126b42eb14135f859ecf961b01d1` |

本机验证结果：dsh-web 聚焦测试、包构建、全仓类型检查、文档检查、i18n 检查、全量测试、脚本测试和安装包内容检查均通过；dsh-passwords 全量测试为 375 项，其中 362 通过、13 跳过、0 失败，构建与 `git diff --check` 通过，两轮独立安全复核均未发现高、中级阻断。

28 的运行态仍保持本手册第 3 节记录的 cohort：Harness `b66a316`、业务插件 `d67159a`、dsh-web `0f9116c`。后续上线必须重新创建不可变发布目录，核对 Profile 实际解析的插件来源和包内源码标识，通过 3080/3081、主账号、子账号、Workspace 删除、HTML 预览及各类文件下载验收后再原子切换；不能把本节“已推送”误认为“已部署”。
