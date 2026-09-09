# 28 服务器部署与运维手册

本文记录 28 服务器（Tailscale `100.64.0.5`，局域网 `192.168.10.28`）上 DeepSeek Harness 多用户服务的功能、运行结构、数据位置、部署步骤、验收方法和故障处理。内容依据 2026-09-01 的 Harness Alpha.3 实际服务器盘点整理，不包含密码、API Key、OAuth Token、Tailscale Auth Key 或数据库口令。

最新部署及修复状态见 §47（2026-09-09，服务器 30）；工作区源码修改清单、证据索引和后续事项见 [本次改动清单 §11](2026-09-08-changes-overview.md)。早期章节保留对应日期的盘点背景。

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

本次 alpha.1 cohort 已完成私有部署及限定范围验收，2026-09-08 12:58:29 记录为 accepted，PM2 startup 已保存；保留 legacy bootstrap partial 警告及 browser UI 未验证。详情见 §27，旧 rc.1 基线保留于 §26。

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
| dsh | `0.1.3-alpha.1`，发布 `20260908-104825-593ee89-alpha1`，源提交 `593ee89aa6` |
| dsh-passwords | `2.6.20` |
| dsh-spend | `0.6.6` |
| dsh-nas-webdav | `0.2.6`，内部部署提交 `36c9dd9508` |
| dsh-plugin-subscriptions | `0.6.4`，内部部署提交 `048176fbb4` |
| Office 侧栏预览 | `@huanlin/dsh-plugin-better-sidebar-plugin-office@0.1.3` |
| dsh-web 插件族 | Pet/聚合包 `0.3.18-dsh.20260908.1`，remote-web-ui 为 `0.4.0`，其余版本以本批冻结锁为准，发布 `20260908-104825-593ee89-alpha1` |
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
| `/home/tzwl3/.pm2/dump.pm2` 与 `.bak` | PM2 开机恢复清单及备份 | 是；本次验收后两者权限均为 0600 |
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

#### 运行时发布目录怎么产生

运行时发布是一个名为 `dsh-runtime-deploy` 的私有包：`npm/` 存放构建机产出的全部 tarball，`package.json` 的每个依赖写成 `file:./npm/<tarball>`，在该目录执行 `pnpm install` 得到 pnpm 布局的 `node_modules`。`pnpm deploy --legacy` 不适用，它解析不全这套依赖树。

构建机产出 tarball：

```bash
cd /path/to/deepseek-harness
export DSH_BUILD_CLIENT_PROFILE=official
export DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD)
export DSH_CLIENT_VERSION=$(node -p "require('./package.json').version")
pnpm run build
pnpm exec tsx scripts/release/pack.ts --family dsh --out /tmp/dsh-pack
```

官方制品画像有两个硬性前提，否则 `pack` 直接失败：

- **工作树必须完全干净**。判定使用 `git status --porcelain=v1 --untracked-files=normal`，**未跟踪文件同样算 dirty**。临时把本地产物移开再移回。
- **必须先用该环境重新构建**。校验读的是产物记录的构建环境，不是打包时的环境；沿用旧构建会一直报 `client build environment differs from the required artifact profile`。

`--family dsh` 只产出 dsh 成员，`cordis`/`cosmokit`/`schemastery` 等 vendor 包属于 `--family vendor`。它们版本固定，跨版本升级时直接从旧发布的 `npm/` 复用即可。

#### 跨版本升级时清单必须逐项对账

新发布的清单不能照抄旧发布，以下四处都要改，漏一处安装就会失败：

1. **`pnpm-workspace.yaml` 同样含一整份 tarball 路径清单**（`overrides` 与 `allowBuilds` 两处），必须与 `package.json` 同步改写。只改 `package.json` 会让 pnpm 仍按 workspace 覆盖去找旧版本文件而报 `ENOENT`。
2. **上游已移除的包**要从清单和 `npm/` 中一并剔除。`0.1.2-rc.1` 移除了 `@deepseek-ai/dsh-code-runtime-python` 与 `@deepseek-ai/dsh-tool-subagent-report`。
3. **上游新增的包**要补进清单。`0.1.2-rc.1` 新增 `@deepseek-ai/dsh-http-proxy`；清单缺它时 pnpm 会转向 npm registry 并以 404 失败（fork 包不在公共 registry）。
4. **对账方法**：提取 `package.json` 与 `pnpm-workspace.yaml` 中全部 `file:./npm/<file>` 引用，与 `npm/` 实际文件求差集，直到依赖数与 tarball 数一致。从旧发布复用制品时注意别把已移除包的旧 tarball 一并带进来。

fork 独有包容易掉队。`@deepseek-ai/dsh-principal-access` 曾停留在 `0.1.2-alpha.4`，而 `release:pack` 要求同一 family 版本一致，会拒绝打包。发现版本掉队时正式对齐并提交，不要临时改完再还原——否则每次发布都会重复踩到。

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

新发布目录只放 `artifacts/` 是不够的：`dsh-passwords` 需要解包成目录，`.env` 也要单独恢复，否则切换后网关拿不到配置。

```bash
new=/home/tzwl3/apps/dsh-plugins/releases/<RELEASE_ID>
mkdir -p "$new/dsh-passwords"
tar xzf "$new/artifacts/dsh-passwords-<版本>.tgz" -C "$new/dsh-passwords" --strip-components=1
cp -p <备份>/dsh-passwords.env "$new/dsh-passwords/.env"
chmod 600 "$new/dsh-passwords/.env"
sha256sum <备份>/dsh-passwords.env "$new/dsh-passwords/.env"   # 两行摘要必须相同
```

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
export DSH_DOCTOR_REAL_DSH=/home/tzwl3/apps/dsh-runtime/current/node_modules/.bin/dsh
export DSH_DOCTOR_PACKAGE_DIR=/home/tzwl3/apps/dsh-web/current/packages/dsh-doctor
cd /home/tzwl3/dsh-workspace
pm2 start /home/tzwl3/apps/dsh-runtime/current/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --name dsh-web \
  --kill-timeout 30000 \
  --interpreter /home/tzwl3/.local/opt/node-v22.21.1-linux-x64/bin/node \
  -- web --no-open --port 3080
pm2 save
chmod 600 /home/tzwl3/.pm2/dump.pm2
# pm2 save 若已生成备份，同样保护其中的环境变量。
if [ -f /home/tzwl3/.pm2/dump.pm2.bak ]; then chmod 600 /home/tzwl3/.pm2/dump.pm2.bak; fi
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

两项必须同时成功。前次验收时的 conversation bundle 短 SHA-1 为 `2440832da50b`，dsh-passwords 客户端 bundle 短 SHA-1 为 `d40def448ef9`；未来代码变化会产生新哈希，因此验收应同时检查功能标记，不能永久写死哈希。

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

### 11.15 线上大量接口返回 404 或 405

先分清功能属于哪个发布单元：runtime、dsh-web 和业务插件是三条独立发布线，`current` 各自指向不同发布，但**版本必须同批对齐**——客户端调用的 Host 接口随版本变化，任一条落后都会让请求打不到路由，落入 `frontend-static` 兜底处理器（非 GET/HEAD 返回 405，GET 返回 404）。

```bash
for d in dsh-runtime dsh-web dsh-plugins; do echo "$d=$(readlink -f /home/tzwl3/apps/$d/current)"; done
export PATH=/home/tzwl3/.local/opt/node-v22.21.1-linux-x64/bin:$PATH
cd /home/tzwl3/.dsh/profiles/web
node -p "require('./node_modules/@linxin666/dsh-web-all/package.json').version"
node -p "require('./node_modules/dsh-passwords/package.json').version"
```

注意 Profile 的依赖是绝对路径，切 `current` 不会改变它实际加载的插件，两处都要核对。

失败路径若带 `/remote/` 前缀，见 `## 26` 的远程通道一节：需要 `dsh-passwords` `2.6.18` 以上，且必须同时剥离 `req.url` 与 `req.originalUrl`。用匿名 curl 验证会得到误导性的 401，必须用已登录的浏览器请求确认。

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

下表为已 accepted 的本次 cohort，PM2 startup 已保存。验收范围、警告和旧基线见 §27。

| 组件 | 当前目标 |
|---|---|
| runtime | `/home/tzwl3/apps/dsh-runtime/releases/20260908-104825-593ee89-alpha1` |
| plugins | `/home/tzwl3/apps/dsh-plugins/releases/20260908-104825-593ee89-alpha1` |
| dsh-web | `/home/tzwl3/apps/dsh-web/releases/20260908-104825-593ee89-alpha1` |
| runtime 源提交 | `593ee89aa6ec8496e26dd2f4d3fbaab76b41c65a`（`sdwhwzp/deepseek-harness` `tzwl`） |
| runtime 版本 | `0.1.3-alpha.1` |
| dsh-genui 安装包 | SHA-256 `5f119f312014aeb00ff9c4587f340c8981cb4e0255138f465adb58b5c82fc55e` |
| dsh-at-file 安装包 | SHA-256 `6c426ce4487129ab936ca8125ccb5099c3cf65a25e902790bb1f80580831dd4d` |
| better-sidebar 安装包 | SHA-256 `a6124113e28680c9fb0b3ec71e6c49fb35e5ae0a62f272fba0919afb4f3f51af` |
| dsh-nas-webdav 安装包 | SHA-256 `b4ff63131a95c3db1577a8ce8264fc2e405af7d3887a03fab9d808eb5c862d7a` |
| dsh-passwords | `2.6.20`，内部部署提交 `fce5ceb386` |
| dsh-plugin-subscriptions 安装包 | SHA-256 `d834a448cbd0e36b8159f1b21a3cd37c844b98df492d21132ca4eb4f2e8f804b` |
| 品牌插件安装包 | SHA-256 `15d3d51ca465ca76574995d3b0fae6a953aa507d2acda043815d895bbe150a11` |
| dsh-spend 安装包 | SHA-256 `684a742391d99bcfa83919527bfd1bfb9e660d8fa5e3dde5407cd9b808a8776c` |
| Office 预览安装包 | SHA-256 `0f85a98a2470eef6d372c1c31ad2dc6a88ed642b2a1e2100910b8fcb4c779230` |
| dsh-weknora 安装包 | SHA-256 `fcb63bbd94070a8796c5f44a76fb62e7bb42e3c5dff35b6c9dc211fc9c5083db` |
| rc.1 升级前整体备份 | `/home/tzwl3/apps/deploy-backups/pre-rc1-20260904-202228` |
| 上一个可用 runtime | `/home/tzwl3/apps/dsh-runtime/releases/20260904-204003-bf8d4921d9-rc1` |
| 上一个可用 plugins | `/home/tzwl3/apps/dsh-plugins/releases/20260904-204003-bf8d4921d9-rc1` |
| 本次完整回退备份 | `/home/tzwl3/apps/deploy-backups/pre-20260908-104825-593ee89-alpha1`，五 data roots 与 MySQL，v4 完成 |
| 上一个可用 Web | `/home/tzwl3/apps/dsh-web/releases/20260905-083633-5e65a315-rc1` |

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

## 25. 2026-09-03 历史会话不可见回滚记录

### 现象

管理员与子账号刷新后历史会话全部消失；诊断过程中一度出现“选择不了工作区”。会话数据本身未丢失：磁盘上 `.dsh/sessions/<cwd>/session-<uuid>/session.jsonl.zstd` 完整可读（zstd 解压为合法 JSONL，含数 MB 历史会话），`session_owners` 归属表与 `managed_workspaces` 白名单均正常。

### 根因

09-02 17:41 发布把 runtime 切到 `0.1.2-alpha.4`（`releases/20260902-170500-434f632-alpha4`）并同时部署 dsh-passwords `2.6.17`。该组合下 dsh-passwords 2.6.17 的“旧会话归属证据读取”通过 `session/page` RPC 推断无归属表记录的老会话；当 runtime 返回非 `bad-request` 错误码时，网关抛出 `session ownership page was rejected` 并把该会话保持为不可见，于是 UI 看不到历史会话。runtime 0.1.2-alpha.3 + dsh-passwords 2.6.15 组合则正常。

### 恢复步骤（2026-09-03）

1. 保留旧 runtime（alpha.4）与旧 live profile，不回滚 DB/数据。
2. 回滚 runtime：`/home/tzwl3/apps/dsh-runtime/current` → `releases/20260901-162100-b66a316-alpha3`（`0.1.2-alpha.3`），原子替换软链后 `pm2 restart dsh-web --update-env`。
3. 回滚 profile：把 live profile `~/.dsh/profiles/web` 的 `node_modules`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.dsh-module-fallback` 切换为 09-02 09:36 的快照 `~/.dsh/profile-backups/20260902-093650-dsh-spend-0.6.5-cny-before`（dsh-passwords `2.6.15` + 当时全部插件的一致组合）。
4. 叠加当前 `.env`：把原始 live `.env` 覆盖回 `node_modules/dsh-passwords/.env`（权限 600），避免沿用旧密钥。
5. `pm2 restart dsh-web --update-env`。
6. 验收：3080/3081/3082 正常，3081 匿名 302，网关连 MySQL，日志自重启后 `保持不可见` 出现 0 次；管理员历史会话与工作区选择恢复正常。

### 关键教训

在已安装的 profile 内执行 `pnpm install --offline --ignore-scripts` 会移除 `node_modules/dsh-passwords/.env`；网关因此回退到空/默认配置，导致工作区与会话列表读不到。任何 profile 依赖重装后必须恢复 `.env`（可由发布目录或备份拷贝，权限 600），并确认 `DSH_PASSWORDS_DB_DRIVER=mysql`、`MCP_INTERNAL_SECRET` 等关键项在位。

### 备份

- 旧 runtime：`/home/tzwl3/apps/dsh-runtime/releases/20260902-170500-434f632-alpha4`（未删除，可切回）。
- 旧 live profile：`/home/tzwl3/apps/deploy-backups/profile-web-20260903-094809`。
- dsh-passwords `2.6.17` 插件：`/home/tzwl3/apps/deploy-backups/dshpasswords-2.6.17-20260903-093012`。

### 长期修复

正式修复方向是部署合并 upstream 后的 `0.1.2-alpha.5` runtime（`sdwhwzp/deepseek-harness` 分支 `tzwl` → `b80f7752a3`，含 upstream 的 session/ownership 修复）。上线前需在构建机用离线安装流程生成 runtime release（`pnpm deploy --legacy` 对该 workspace 会缺少部分传递依赖，不能直接等效还原服务器现有 release 目录），需提供该离线安装命令后再升级。

## 26. 2026-09-04/05 Harness 0.1.2-rc.1 升级部署记录

把 28 从 `0.1.2-alpha.3` 升到 `0.1.2-rc.1`，三条发布线与全部插件同批更新。最终线上组合：runtime `0.1.2-rc.1`（发布 `20260904-204003-bf8d4921d9-rc1`）、`@linxin666/dsh-web-all` `0.3.14`（发布 `20260905-083633-5e65a315-rc1`）、`dsh-passwords` `2.6.19`。

升级前先在 macOS 开发机完成同等升级并验证，六个业务插件的 `@deepseek-ai/*` 声明已从 alpha.3/alpha.4 升到 `0.1.2-rc.1`、`@deepseek-ai/cordis` 升到 `^4.0.2`。

### 三条发布线必须版本对齐

runtime、dsh-web 和业务插件各有独立的 `current`，但它们并非可以各自升级：客户端调用的 Host 接口随版本变化，任意一条落后都会让请求打不到路由。本次两种错配都实测过，症状相同（选不了工作区、历史加载不出来）：

- **rc.1 runtime + 旧 dsh-web `0.3.10`**：旧客户端调用 rc.1 已移除的接口。
- **alpha.3 runtime + 新 dsh-web `0.3.14`**：新客户端调用 alpha.3 尚未提供的接口。

未匹配的请求会落到 `frontend-static` 兜底处理器，**非 GET/HEAD 返回 405、GET 返回 404**。浏览器里看到成片的 404/405 时，先核对三条线的版本是否同批。

### Web Profile 不读 `current`

`~/.dsh/profiles/web/package.json` 的依赖是**绝对路径**，直接钉在某个发布目录的 `artifacts/` 或 `packages/` 上。切换 `apps/*/current` 软链接**不会**改变 Profile 实际加载的插件，而运行中的网关正是从 Profile 加载的。

本次首轮部署只切了软链接，结果 runtime 升到 rc.1 而全部插件仍是 09-01 的旧版（`dsh-passwords` 停在 `2.6.15`、`dsh-at-file` 停在 `0.6.11`）。发布插件必须同时改写 Profile 依赖路径并重装。

Profile 的 `pnpm-workspace.yaml` 还有独立的 `overrides`：`dsh-better-sidebar` 曾被其中一行钉在旧发布，只改 `package.json` 无效，装出来仍是旧版本。

### 远程通道前缀：`/remote` 与 `originalUrl`

新版 `dsh-remote-web-ui`（0.4.0）在**非回环来源**访问时，启动阶段先临时启用 `/remote/` 通道重写，再靠 `/api/pair/status` 的策略回包撤销它。该探测请求自身也被重写，网关若不认这个前缀就永远回不出策略，重写便无法撤销，所有 API 随之 404/405。

开发机用 `127.0.0.1` 访问不触发重写，因此这个故障只在经域名或 LAN 地址访问 28 时出现。

修复分两步，缺一不可（`dsh-passwords` `2.6.18`、`2.6.19`）：

1. 在所有路由之前剥掉 `req.url` 的 `/remote` 前缀。
2. **同时剥掉 `req.originalUrl`**。反向代理用 `originalUrl` 重建上游地址，而 Express 不会随 `req.url` 同步更新它。

只做第一步会产生极具误导性的现象：**未登录探测返回 401（在认证层就结束，没走到代理），已登录请求返回 405（走到代理，上游收到未剥离的路径）**。排查时若只用 curl 匿名验证，会误以为已经修好。

### 与开发机的差异必须先对照

28 的 Profile 与开发机差别很大，本机的 profile 改动大多不适用：bundles 只有 12 个（开发机 27）；`dsh-chat-recovery`、`dsh-client-ui-aionui-panel`、`dsh-desktop-launcher` 在 28 上本就不存在；`dshmarket` 不在 profile 依赖里；`dsh-better-sidebar` 与 Office 预览用的是自建 tgz（`0.18.1-alpha.0`、`0.1.3`，后者 npm 上没有）。

网关托管方式无需改动：28 早已是 Host 派生网关子进程的形态，PM2 环境中没有 `DSH_PASSWORDS_NO_AUTOSTART`。

### 执行步骤

1. 停服完整备份到 `/home/tzwl3/apps/deploy-backups/pre-rc1-20260904-202228`：`~/.dsh/` 共 22G、MySQL dump（13 张表，以 `Dump completed` 结束）、`.env`、`pm2 dump`、三个 `current` 的原始指向。28 上原本没有 `mysqldump`，先 `apt-get install default-mysql-client`。Profile 另有 `profile-pre-rc1-20260905-083029`。
2. 构建机产出 244 个 rc.1 tarball 与插件 tgz，rsync 到新发布目录；`dsh-better-sidebar` 与 Office 预览两个制品从旧发布复用。dsh-web 传源码与已构建的 `lib/`（268M），在服务器 `pnpm install` 建立 workspace 链接。
3. 生成运行时清单并逐项对账（见 `## 7.5`），最终 254 依赖对应 254 个 tarball。
4. 切换前用新运行时执行 `--profile web --dump-config`，成功解析 682 行。
5. 切换三条 `current`，改写 Profile 依赖路径并重装，解包 `dsh-passwords` 并恢复 `.env`（SHA-256 与备份一致），`pm2 restart dsh-web --update-env`。

### 验收结果

3080 返回 `401`、3081 返回 `302`、3082 监听；登录页正常；PM2 `online` 且重启次数不增长；启动后错误日志为 0。经用户实测确认：工作区选择、历史记录、右侧栏文件下载均正常。

`3080` 返回 `401` 而非 `## 10.1` 写的 `200`：rc.1 对根路径启用了浏览器认证，开发机升级后表现相同，属预期变化。

`## 10.2` 中检查 `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 的那条命令在当前布局下已不适用——该包不在 Profile 的 `node_modules`，由运行时提供；应改查 `/home/tzwl3/apps/dsh-runtime/current/node_modules/` 下的同一文件。

### 排查方法

服务端日志对这类故障帮助有限：请求被兜底处理器接走，不会留下错误记录。**决定性证据来自浏览器 F12 → Network 的失败请求 URL 与状态码**，本次三轮定位全部依赖它。

日志中的「旧会话归属证据读取失败，保持不可见」在 alpha.3 与 rc.1 下**都会出现**，是长期噪音，不能作为本类故障的判据；实际缺归属记录的只有 2 个会话（含 1 个探针会话），`session_owners` 41 条对应磁盘 42 个会话。

### 功能验收

按 `## 10` 逐项实测通过：工作区选择、历史记录、右侧栏文件下载、子账号权限与额度、WebDAV 挂载、Office 预览、Spend 计量。

Office 预览这一项跨越了 `dsh-better-sidebar` 的 `ctx.betterSidebar` 注册表服务化重构（`0.18.0-alpha.0` → `0.18.1-alpha.0`），而 `@huanlin/dsh-plugin-better-sidebar-plugin-office@0.1.3` 声明的 peer 仍是旧范围；实测确认注册接口未受影响。

### 回滚

```bash
ln -sfn /home/tzwl3/apps/dsh-runtime/releases/20260901-162100-b66a316-alpha3 /home/tzwl3/apps/dsh-runtime/current
ln -sfn /home/tzwl3/apps/dsh-plugins/releases/20260902-173500-434f632-alpha4 /home/tzwl3/apps/dsh-plugins/current
ln -sfn /home/tzwl3/apps/dsh-web/releases/20260902-170500-f43c9bf-alpha4 /home/tzwl3/apps/dsh-web/current
cd /home/tzwl3/.dsh/profiles/web
cp -p /home/tzwl3/apps/deploy-backups/profile-pre-rc1-20260905-083029/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,cordis.patch.yml} .
pnpm install --no-frozen-lockfile
cp -p /home/tzwl3/apps/deploy-backups/profile-pre-rc1-20260905-083029/dsh-passwords.env node_modules/dsh-passwords/.env
chmod 600 node_modules/dsh-passwords/.env
pm2 restart dsh-web --update-env
```

三条 `current` 必须一起切回，Profile 也必须同批恢复，否则会落入上文的版本错配。

## 27. 2026-09-08 Harness 0.1.3-alpha.1 部署记录

**本次私有部署已完成，2026-09-08 12:58:29（Asia/Shanghai）state=accepted、pm2Saved=true。** release 为 `20260908-104825-593ee89-alpha1`，三条 current 均指向该 release；最终 Host PID `1348895`、restartCount `23`、kill_timeout `30000`。生产报告 passed-with-warnings，保留 LEGACY_SESSION_OWNER_BOOTSTRAP_PARTIAL 与 browserUiVerified=false。公共 npm 发布门禁不在此结论内。

### 源码、制品与实际安装

七仓源码经正常 hooks 推送并核对 live refs，准确提交见 [部署源码表](2026-09-08-changes-overview.md#1-各仓库部署源码状态)。Harness 为 `593ee89aa6`，Web 为 `56b9de30ee`；Pet/all 内部版本 `0.3.18-dsh.20260908.1`，其余本批 Web 版本保持。五插件版本为 passwords 2.6.20、subscriptions 0.6.4、at-file 0.7.3、Spend 0.6.6、NAS 0.2.6，21 文件内部部署提交与五 tgz 的 389 文件来源匹配。本次没有公共 npm publish。

原不可变 tgz 与真实冻结锁用于私有部署，Web/Profile 引用三条新 release 的绝对路径；Profile 保留 270 个直接依赖、原 12 bundles 及固定第三方版本。market 仅保留安装，未启用。Linux 四组 fresh frozen 安装均通过，Node 22.21.1，runtime pnpm 11.7.0、Web/Profile 11.24.0，输入摘要不变。cutover 在 live Profile 最终路径重新安装同锁并检查链接，不移动 staging node_modules，不上传 macOS node_modules；native optional 平台包保持 exact 0.1.1 registry resolution/integrity。

### 隔离 smoke 与 Doctor 副作用历史

smoke1–3 依次修复密码、目录与 descriptor 参数 fixture；smoke4 拒绝默认 Doctor socket，smoke5 拒绝 Doctor rescue 初始化的 npm 请求，五轮整体失败记录保留。smoke6 六项及整体隔离通过：Linux native full、Host/gateway、真实 Doctor capsule、mock会话/图片/principal、子账号跨账号拒绝和同 PID HMR恢复，进程组清理为空。该 smoke 使用 mock 模型和 SQLite，不代替真实模型、NAS、MySQL生产数据或浏览器验收。

早期未覆盖 Doctor home，guard 拒绝连接没有阻止控制文件写入。Root 备份并只隔离已退出的 smoke4 PID 1330600 所有 reconcile lock，token 未变、未手写 policy/deployed；旧 Doctor 自行恢复 socket 和 0.3.14 成功标记。旧版本 graceful restart 约 12 秒通过，PID `545700` → `1338243`、30 秒停止预算，旧重复 Doctor 进程退出。完整副作用及精确恢复证据见 [续跑记录](2026-09-08-changes-overview.md#1013-doctor-共享控制文件副作用与恢复)，不能写生产文件始终未改。

### 完整备份与失败恢复历史

v2 因受保护系统进程 environ 读取失败，在停服前退出。v3 停服后发现 `.dsh/attachments` 为原有本地 ext4 bind mount（/dev/sda1:/dsh-attachments，约 13 MB），因未独立纳入原root清单而退出，脚本自动恢复旧 cohort ready、PID `1340994`、state failed-old-ready。恢复旧服务不是备份成功。

v4 将附件作为第 5 个独立root，父 `.dsh` excludes 保留挂载点；约 76.9 秒完成停服一致备份，state complete-service-stopped，含 `.dsh`、用户工作区、本机工作区、Doctor 与附件五 root 的完整快照；前三者用 rsync/checksum 核验，Doctor 与附件另有完整 manifest，MySQL 13 表 dump 43,402 字节，spend-ledger.sqlite quick_check通过。完整备份 `/home/tzwl3/apps/deploy-backups/pre-20260908-104825-593ee89-alpha1` 和旧release保留。Doctor live-copy、MySQL live dump preflight只是非一致性预拷贝/预演。

rollback28-v4没有实际执行数据恢复演练，且只接受未accepted/failed状态。当前已accepted；未来回滚须重新审查当时状态、先保存之后新产生的数据，不能直接运行旧脚本。原备份不包含本次accepted之后的新增用户数据。

### aggregate shell 的 remote 配置修复

首轮生产流检查是过期路径fixture错误；第二轮流检查通过，却发现真实 `/api/pair/status` 404。旧private patch覆盖整个shell config，丢失config.plugin，导致Host未挂载remote及pair routes；浏览器仍载aggregate child。这不是3082、Origin或鉴权问题。正确非敏感配置为：

```yaml
- id: web-ui-remote-web-ui
  config:
    plugin: '@linxin666/dsh-remote-web-ui'
    config:
      autoTunnel: false
      requirePairingForLan: false
```

原patch SHA256 `8bcf783c9f655c4be633b4741a30df2c1d5e079dca4dca715d4c6e9cdacbd3f6` → 新patch `1625f2b49da6d0109d5f4ecd50e9266a962f286e37edc4d32b08f5438d1415ad`。旧patch/state/完整PM2env/Doctor报告/日志offset私有保存在 `/home/tzwl3/apps/deploy-staging/20260908-104825-593ee89-alpha1/remote-config-repair-private`。repair job约 43.5 秒退出 0，两次隔离dump的174 条目只改目标config、!!js未执行；live patch0600原子替换，仅重启一次，完整env/launch不变，新PID `1348895` / restartCount `23`健康稳定30 秒。原失败记录未覆盖，修复后全部验收按新state时间重跑。

### 修复后验收与启动保存

production-acceptance-v3、doctor-acceptance-postrepair、operational-verification-postrepair均退出0。生产所有required检查通过，两身份pair/status200且requirePairingForLan=false，HTML无旧rewrite，HTTP/static/identity/session/workspace流与历史page通过；两个临时token全撤销。报告唯一warning是既有LEGACY_SESSION_OWNER_BOOTSTRAP_PARTIAL，browserUiVerified=false。管理员汇总列表的ownershipVerified=false保留，未宣称所有历史归属已完成核对。

Doctor armed/fullProtectiontrue/capsuleVerified，版本0.3.17/dsh0.1.3-alpha.1、实际配置可组合、token未变。五root身份保持、两个既有WebDAV mounts恢复、增量日志无fatal；未额外验证NAS读写。3080=401、3081readyz=200且数据库ready、根路径302登录、3082监听；Mac实测gateway/login HTTP200。HTTP检查不能替代浏览器视觉交互验收。

finalization退出0、pm2Savedtrue、serviceRestartedfalse，PID `1348895` / restartCount `23`保持。保存前私有备份原startup dump，新dump和.bak均0600，exe/cwd/args/30 秒kill_timeout及两项Doctor环境与live一致，最终state accepted。用户crontab恰有一条@reboot pm2 resurrect，旧机制未改；pm2-tzwl3 systemd不存在是预期，未新增服务，未执行整机重启演练。

### 验证范围和保留门禁

Harness完整测试仍18196通过/118跳过/9失败，原预算聚焦九项通过不替代全量；Spend公开一致性42/43保留。公共registry缺exact alpha.1、五插件旧公共锁、passwords npm ci和Web旧开发锁/CI smoke未恢复，私有Profile安装通过不能代替这些门禁。npm Arborist、Mac native file override和全部早期fixture失败保留。没有公共npm publish、真实外部模型、浏览器视觉或数据恢复演练。

本机完整journal与JSON在 `deploy-artifacts/20260908-013-deploy/records/deployment-journal.*`，服务器state/report和jobs在本次staging。隔离Host必须分别设置DSH/Doctor/XDG根；网络guard不隔离文件。后续备份应保留五root及原bind mount，不能把旧staging依赖树移动为live或批量清理Doctor锁。

## 28. 2026-09-08 升级后空会话列表修复

2026-09-08 14:36:12（Asia/Shanghai）完成修复。alpha.1 的冷会话列表不再通过读取小日志判空；旧投影缓存缺少新的格式身份，未命中时 `blank` 默认为 false，导致历史空会话进入聊天列表。部署后的接口验收未覆盖这一旧缓存场景。

完整逐帧读取压缩日志后，确认 28 条无 `turn/start` 的非 seeded 会话，且与旧缓存的 blank=true、空标题一致；另 13 条因格式或大小限制未纳入维护。早期 v2 诊断只解压首个 Zstandard frame，其 40 条判空结论已作废，未据此修改生产数据。有效 v3 计划 SHA256 为 `6f50fcd00a0960a583b5a956adba5fe61d3f0a0d6fd6b90b331a42ed7deb8411`。

维护前备份了目标的全部现存日志代、投影缓存及原 Profile patch；通过临时 Host 插件执行官方完整读取和摘要重建，逐项确认缓存持久化。28 个旧日志代及备份哈希保持，官方读取新增 28 个 v2 后继日志，28 个 v7 缓存均标记 blank=true。没有删除会话、激活 Agent 或发送提示。临时插件已卸载，原 patch SHA256 `1625f2b49da6d0109d5f4ecd50e9266a962f286e37edc4d32b08f5438d1415ad` 恢复；三条 current、Host PID `1348895`、restartCount `23` 保持，服务未重启，未执行 PM2 save。

修复后管理员仍有 49 条记录，blank=true 从 8 条变为 36 条；子账号仍有 18 条记录，blank=true 从 8 条变为 13 条。两账号的会话编号集合与标题映射哈希均未变化，标题数分别保持 11 和 4；临时验证 token 全部撤销。网关和数据库健康检查通过。前端已打开列表需刷新页面以重新应用空会话过滤；未执行浏览器视觉验收。

本地验证包含完整多帧诊断、真实持久化与缓存服务的 7 项检查、维护编排的 15 项检查及实际 Loader/HMR 生命周期检查。生产备份和私有结果位于本次 staging 的 `blank-session-repair-v3-private`；本机汇总在 `records/blank-session-repair-api-verification.json`、`records/blank-session-repair-storage-verification.json` 和 `records/jobs/blank-session-cache-maintenance/`。该维护只修复已核实的 28 条历史空会话摘要，未改变产品源码或其余记录。

## 29. 2026-09-08 principal 历史迁移修复

2026-09-08 15:03:31（Asia/Shanghai）完成 13 条旧日志的 v2 后继发布，15:18:11 完成接口复核。用户报告的历史失败来自 v0→v1 迁移校验未接受既有用户消息、turn/start 和 step/start 的 principal 字段；会话快照失败同时阻断模型选择状态加载。模型目录接口本身可正常返回。

Harness 工作区已补充 principal 的四个字段及角色校验，迁移和旧 steering/message、turn.trigger 归一化保留身份；畸形身份仍拒绝读取。该源码修复尚未提交或推送，线上运行包仍为原 alpha.1 cohort。维护程序使用修正后的迁移库，在私有副本中通过官方 ensureJsonlGenerationCurrent 生成后继，并以线上未修改的持久化后端逐条验证 list/stat/read。13 条日志的 477 处身份记录、标题及模型选择事件保留，随后采用排他发布写入新代；13 个原 v0 文件哈希保持。

首批候选虽通过逻辑解码，却把头部与正文压入同一 Zstandard frame，违反生产后端的独立头帧要求，导致列表读取失败。确认所有候选未被追加后，已撤回这 13 个未验收的新文件并保留其字节；没有改动原 v0。失败候选保存在 staging 的 history-principal-repair-private/failed-physical-candidates，失败记录未覆盖。最终候选改用官方磁盘写入器，13 条均通过实际生产后端读取后才重新发布。

有效计划 SHA256 为 `c6d64b4b07d5f391e9c777f12d8a1bf60327b9e23fe47552b5bbe06cabb87177`，迁移库 SHA256 为 `5bfd4357784424d9141e443c31309eed4a58c4ce3e85e4dd02a4eefdb4b4cc96`。最终备份、私有副本及发布结果位于本次 staging 的 history-principal-repair-v2-private。最终校验确认 13 个原代哈希和 13 个新代已发布前缀保持；服务 PID 1348895、restartCount 23、Profile patch 与三条 current 均未改变，网关和数据库健康，未重启服务。

真实接口复核通过管理员 12 条普通历史分页及子账号 5 条有权访问的普通历史分页。用户报告的会话在两种身份下都返回历史快照与模型选择投影，cursor 保持 225，未发送提示或调用外部模型。最终目录返回管理员 17 个、子账号 14 个模型，各 5 组且 failures=0；动态模型数可能变化。两个临时 token 均已撤销。未执行浏览器视觉验收。

仍有一条旧子代理历史不能通过 API 打开：其唯一 descriptor 位于继承区，当前服务返回 subagent descriptor is unavailable；未猜测或改写其归属。该项在最终验收中单独列为失败，普通历史与用户指定会话通过，报告状态为 passed-with-warnings，不能据此宣称全部子代理历史兼容。

源码验证：迁移及语料聚焦检查 12 文件、244 项通过；补充旧 steering 身份用例后，legacy 文件 21 项通过。类型构建和变更文件 oxlint 通过，test:docs 15 项通过。doc-sync 首次 32 项通过、doc-typecheck 因新测试的 flatMap 类型推断失败；修正显式类型后单独重跑 doc-typecheck，通过 86 个代码块。其余已通过门禁未重复运行，原全量测试缺口不变。本机最终记录为 records/history-principal-repair-storage-verification.json 和 records/jobs/history-model-repair-final-acceptance/。

## 30. 2026-09-08 Context 与 Routing Suite 插件部署

2026-09-08 16:29:10（Asia/Shanghai）完成验收与 PM2 启动配置保存，目标为 `http://192.168.10.28:3081`。Harness 运行包仍为 `0.1.3-alpha.1`，runtime、web、plugins 三条 current 仍指向 `20260908-104825-593ee89-alpha1`；本次增加 Profile 插件和三个用户预设。

| 组件 | 线上版本 / 位置 | 使用入口 |
|---|---|---|
| `dsh-context` | `0.46.0-dsh.20260908.1` | 打开已有对话 →「上下文」，或 `/context` |
| `@dsh-external/dsh-super-injector` | `0.3.3-dsh.20260908.2` | 管理员「设置 → 插件管理」；输入服务器上的插件目录 |
| `@dsh-external/dsh-graded-mode` | `0.0.1-dsh.20260908.1` | `/graded <任务描述>` 启动分级规划，`/graded off` 关闭 |
| Router Standard / React / Spec | `$DSH_HOME/.agent-presets/router-{standard,react,spec}` | 新会话的 Agent 预设选择器 |

### 来源、适配与权限

按用户提供的两个仓库克隆：`sdwhwzp/dsh-context` 基线 `40a054b99b09bf15e044885e2bc92b1746c8c674`，`sdwhwzp/dsh-routing-suite` 基线 `e3f00b24db442cb45d12496915fabd7f3302d785`。本机源码分别位于 `/Users/wangzhipeng/macproject/dsh-context` 与 `/Users/wangzhipeng/macproject/dsh-routing-suite`；本轮修改尚未提交或推送，私有包来自这些工作区。

Context 适配 alpha.1 内嵌 assistant stream 的首 token 时间，并为详情接口增加会话读取权限校验。Injector 统一使用当前 scoped Cordis/Schema SDK，保留宿主共享 SDK，更新客户端依赖声明；管理工具和 HTTP 接口要求管理员身份，卸载使用 unlink 移除目录链接并保留源目录。Graded 接入身份与会话归属检查，前端徽章按当前会话取状态，首次无状态目录时返回空清单。Router React 的旧 `session.events` 读取改为兼容 `snapshotEvents()`，未改变路由决策规则。

Profile 的原 12 个 bundle 保留，新增上述 3 个 bundle。原 `cordis.patch.yml` SHA256 保持 `1625f2b49da6d0109d5f4ecd50e9266a962f286e37edc4d32b08f5438d1415ad`；密码门环境文件字节校验一致，PM2 的启动参数、环境及 30 秒退出等待配置保持。

### 安装过程与验收证据

最初候选安装通过，但锁文件包含依赖本地 tarball 的相对路径，首次线上固定锁安装因此失败；自动恢复原 Profile 后，网关、数据库和工作区监听恢复正常。保留该次失败记录，未使用失败依赖树继续启动。将文件与链接依赖统一为绝对路径后，在不同深度目录完成固定锁安装及 Linux 运行检查，再进行第二次切换。pnpm 为 `11.24.0`，Node 为 `22.21.1`，最终线上固定锁安装耗时约 4.3 秒，四个配置输入哈希保持一致。

Context：74 个测试文件、1178 个用例通过，语句、分支、函数和行覆盖率均为 100%；源码和测试类型检查、lint、构建通过。Graded：63 个用例通过并重新构建。Injector：类型检查、构建以及真实注入、卸载、effect 释放、链接删除通过。Router Standard 自测通过。隔离 Linux Host 使用最终插件包和本地模拟模型，标准模式及三个 Router 预设均完成回复，Context 详情、分级命令、状态和跨账号拒绝检查通过；未调用外部模型。

生产必需接口检查全部通过。管理员模型目录 17 个模型，普通账号 14 个模型，均无 provider failure；指定历史 `session-c71bea90-4832-478d-8489-e65cf8a38860` 在两种身份下均返回 14 条开场记录及模型选择投影，cursor 为 225。Context 详情两种身份均返回 200；普通账号访问全局插件管理、全局分级清单返回 403。验收前后会话清单无新增、删除或 blank 标记变化。

生产浏览器已实际打开两类账号的 Context 面板，普通账号截图覆盖用户此前报错的历史；管理员插件管理页可见，两个账号均可列出三个 Router 预设且无 broken 标记。浏览器直连内网失败后，改经本机仅转发 28:3081 的临时代理完成验证。接口验收签发的 2 个临时 token 和三轮浏览器验证共 6 个临时 token 均已退出撤销。截图和界面文字含用户数据，仅保留在本机私有验收材料。

最终 Host PID 为 `1388496`，PM2 restartCount 为 `23`；stop/start 场景下不能用该计数推断本次没有重启。最终健康检查通过，PM2 save 已执行且保存前备份原 dump，保存过程未再重启服务。Doctor 状态检查通过，原 capsule 可组合。

### 记录、备份与限制

本机证据根目录为 `/Users/wangzhipeng/macproject/deploy-artifacts/20260908-context-routing/`。`records/deployment-summary.json` 为汇总，`records/artifacts.json` 记录三个最终插件包和 Router 归档的 SHA256；源码补丁、含新增测试的源码归档、构建测试日志、接口结果及截图一并保留。服务器 staging 为 `/home/tzwl3/apps/deploy-staging/20260908-context-routing`，不可变包为 `/home/tzwl3/apps/dsh-plugins/addons/20260908-context-routing`。

有效部署前备份为 `/home/tzwl3/apps/deploy-backups/pre-20260908-context-routing-v2`，其中 `profile/` 为原 Profile，另有原密码门环境与 PM2 私有快照。首次失败备份、候选目录及日志另行保留。以后若需回滚，须先保存新增 Profile 配置、预设和插件状态，再恢复原 Profile、移走本次新增预设并重启验收；不能直接再次运行已完成的切换脚本。用户会话日志、原有预设和旧发布代不应随插件回滚删除。

既有一条旧子代理历史的 descriptor/继承区兼容问题仍未解决。浏览器启动时捕获了 `Cannot read properties of undefined (reading 'phase')`，但两种账号的 Context 及管理员插件管理页面均正常渲染；该异常来源尚未定位，未据此宣称浏览器无错误。Router 的真实外部模型规划质量、Injector 自动造插件与发布流程不在本次模拟模型验收范围内；原 Harness 全量测试及公共依赖锁的限制继续保留。

## 31. 2026-09-08 普通账号终端与任务看板修复

17:29 完成 28 服务器第二轮切换与 PM2 保存。最终密码门为 `dsh-passwords@2.6.23`，Host PID `1401411`；运行时仍为 `0.1.3-alpha.1-593ee89`，15 个 bundle、Router 预设与原会话数据保留。公网入口仍为 `http://wh.gr-iot.cn:3081`。

### 故障原因与修复

侧栏终端的 `/sidebar/ws/terminal` 没有通过网关 WebSocket 路由准入，浏览器显示 1006。原终端以共享服务器账号直接启动 Shell，不具备租户文件或进程隔离，不能直接对普通账号放行。新网关只将普通账号的这个精确路径转发至私有终端入口；Host 验证签名身份、当前账号状态、持久化会话归属和真实目录，拒绝其他账号会话、越界 cwd、符号链接逃逸及共享 agent PTY UUID。其他侧栏升级路径保持关闭，管理员沿用原有终端。

普通账号终端由 root 所有的 `/usr/local/libexec/dsh-tenant-terminal` 启动 bubblewrap，挂载自己的 `u<ID>` 到 `/workspace`，隔离挂载、PID、IPC、UTS 和网络命名空间，清除服务环境变量，再由固定 `setpriv` 命令降为 UID/GID 1000、清空 capabilities 并启用 no-new-privileges。sudoers 只授权固定启动器及其 SHA256，不授权任意 bwrap。启动器最终 SHA256 为 `6bb4efc28ae1d7951c1b08e701712ea28ac0d8c2625c3adb276d26b5b79ae76f`。

任务看板原 Host entry `web-ui-task-board` 被禁用，但客户端仍访问 `/api/task-board/*`，因此把 `not found` 当作 JSON 解析。新增账号适配层复用固定版本的看板 Host 引擎，按账号持久化账本；原全局 Host 继续禁用，客户端保留。后台执行、权限命令和历史读取均通过本机认证网关，以当前账号身份执行工作区、模型、沙盒和额度检查。只读 session/list 与 session/page 轮询不累计交互时长。浏览器实测还修复了 HTTP 页面 GET 不带 Origin 时被原看板路由误拒绝的问题：仅在签名身份和当前账号验证通过后补齐内部同源标记。

部署增加四项环境配置：`MCP_TENANT_TERMINAL_LAUNCHER=/usr/local/libexec/dsh-tenant-terminal`、`MCP_TENANT_TASK_BOARD=true`、`MCP_TENANT_TASK_BOARD_DIR=/home/tzwl3/.dsh/tenant-task-boards`、`MCP_TENANT_TASK_BOARD_GATEWAY=http://127.0.0.1:3081`。已同步安装包 `.env` 与 canonical 密码门 `.env`，其他配置字节保留。终端默认每账号最多 8 个，断线 30 秒后回收；任务账本恢复后继续调度。

### 范围说明：`cd /bin`

用户反馈终端可以 `cd /bin`。已复现并确认 `/bin` 指向沙盒中的只读系统工具，写入失败；宿主机 home、其他账号目录与宿主机网络仍不可访问。当前实现允许进入沙盒内的 `/bin`、`/usr` 等只读运行目录，不承诺把 Shell 的当前目录固定在 `/workspace`。自己的持久化文件写入 `/workspace`，另有沙盒内临时 `/tmp` 和虚拟设备。提示符由 `workspace:` 改为 `sandbox:` 以准确显示运行环境；提示符更名不限制 `cd`，也不是安全控制。关于是否进一步禁止交互终端切换至只读运行目录，已向用户单独澄清。

### 验收与记录

本地构建通过；初轮网关、账号权限、终端和看板聚焦回归 20 项通过；补充轮询分类的相关检查 28 项通过；最终无 Origin 修复及终端路由检查 5 项通过。新增无外部模型的任务执行验证确认 create → rename → permission → prompt 全部经网关并携带同一账号身份，另验证账本重载、其他账号删除拒绝及符号链接逃逸拒绝。没有调用付费模型进行任务内容验收。

Linux 原生 PTY、交互 Shell、UID 1000、零 capabilities、工作区文件写入与宿主机文件所有者、只读 `/bin` 写入拒绝、独立 PID 和网络均验证通过。生产账号 2 的内网及公网终端握手均为 101，账号 3 访问账号 2 会话、账号 2 指定账号 3 目录和共享 PTY UUID 均被 403 拒绝。看板创建验证任务后，另一账号不可见且删除返回 400；验证任务已删除。原报错会话仍返回 14 条历史记录，管理员模型目录 17 项、普通账号 14 项。浏览器已实际打开普通账号看板，原 404/JSON 错误与后续 forbidden 均消失；截图保存在本机私有证据目录。

最终包 `dsh-passwords-2.6.23.tgz` 的 SHA256 为 `6b414498318366dcbc7ffd85d3330855c01c4c3b47928fc0f22174063ca3442c`。Profile patch 的 SHA256 保持 `1625f2b49da6d0109d5f4ecd50e9266a962f286e37edc4d32b08f5438d1415ad`。本机证据目录为 `/Users/wangzhipeng/macproject/deploy-artifacts/20260908-terminal-board`，服务器 staging 为 `/home/tzwl3/apps/deploy-staging/20260908-terminal-board`；最终状态在 `accepted.json`，包清单在 `artifacts-v23.json`。2.6.21 仅用于候选检查；2.6.22 经过接口验收后，在浏览器验证中发现缺少 Origin 的问题，后由 2.6.23 修复。

初次切换前备份为 `/home/tzwl3/apps/deploy-backups/pre-20260908-terminal-board`（原 2.6.20 Profile、环境与 PM2 快照）；2.6.23 切换前备份为 `/home/tzwl3/apps/deploy-backups/pre-20260908-terminal-board-v23`。恢复前先保存后续新增配置与个人任务账本，停止服务后恢复目标 Profile 和对应密码门环境，再验收并保存 PM2；不能重跑已经完成的切换脚本。root 启动器与 sudoers 独立于 Profile，回滚时需核对匹配的摘要；旧提示符启动器保留在 `/usr/local/libexec/dsh-tenant-terminal.20260908-v1`。不得删除用户工作区、会话日志或个人任务账本来回滚插件。

普通账号终端的宿主机网络与外网均未开放；管理员终端不使用该隔离启动器。既有旧子代理日志兼容问题及浏览器启动时两条 `Cannot read properties of undefined (reading 'phase')` 仍记录为未解决项，不影响本次看板页面验收，不宣称整站无错误。源码与文档已提交到密码门 `dev` 分支；各插件的归档记录见 [变更概览第 14 节](2026-09-08-changes-overview.md#14-2026-09-08-dev-分支归档)。

## 32. 2026-09-08 网页 VS Code 编辑器集成

在会话「编辑器」中直接浏览、修改和保存本人托管工作区文件，无需安装桌面 VS Code。生产使用 `dsh-vsceditor@0.5.1-dsh.20260908.4`、`dsh-passwords@2.6.24` 和服务器端 code-server `4.133.0`；Harness 保持 `0.1.3-alpha.1-593ee89`。新增编辑器后共 16 个 bundle，原 Context、Routing Suite、终端、任务看板及 Router 预设保留。网页入口为 `http://wh.gr-iot.cn:3081`；本轮使用用户提供的 SSH `wh.gr-iot.cn:3022`，以原 `192.168.10.28` 主机密钥校验连接。

### 接入与账号隔离

新 Host 与客户端入口分别为 `lib/tenant-host.cjs`、`lib/tenant-client.js`，通过当前会话视图和 locale 服务注册「编辑器」。同源 `/dsh-vsceditor/open` 与 `/dsh-vsceditor/ide/<sessionId>/` 的 HTTP、资源请求及 WebSocket 每次校验身份、会话读取权限、持久化 cwd 和托管根目录的真实路径。其他账号会话、越界目录与符号链接逃逸拒绝访问。密码门新增 `MCP_TENANT_EDITOR=true`，普通账号还必须具有文件写入权限；跨源请求拒绝，认证凭据不会转交 code-server。

每账号复用一个编辑器实例，独立 Unix socket、状态和工作区。root 所有的 `/usr/local/libexec/dsh-tenant-editor` 仅接受固定账号参数；sudoers 绑定该文件摘要。启动器经 bubblewrap 隔离挂载、PID、IPC、UTS 与网络，清理环境并降为 UID/GID 1000；只挂载本账号根目录到 `/workspace`，宿主机 home、其他账号与服务密钥不挂载。配置位于 root 所有的 `/etc/dsh-vsceditor.json`，运行状态位于 `/var/lib/dsh-vsceditor`，固定运行时位于 `/opt/dsh-vsceditor/code-server-4.133.0-linux-amd64`。

Host 默认最多 4 个账号实例，启动超时 30 秒，无连接且空闲 15 分钟后回收，Host 退出时也回收进程。`codeServerCommit` 与已安装 VS Code 提交 `d2f7a122522456b351e9b3ddd39e4f3fb9fd5318` 匹配，以代理其带版本的 WebSocket 路径。编辑器打开时禁用 DSH 对话文本宽度拖动柄，避免透明区域截获编辑器点击。

### 候选问题与恢复

候选阶段修正了 Linux 沙盒隐式父目录权限和 code-server 带版本的 WebSocket 路径。首次线上切换因缺少 Cordis Standard Schema 配置接口而未通过健康检查，已自动恢复原 Profile 和环境；修复 `Config['~standard'].validate` 后，使用真实 `dsh` Profile 装配验证，再次切换成功。v3 浏览器验收发现对话宽度拖动柄遮挡，最终 v4 加入视图范围内的 CSS 修复。失败候选、日志和自动回滚状态保留，不将失败轮次计为成功验收。

有效的原 2.6.23 备份为 `/home/tzwl3/apps/deploy-backups/pre-20260908-vsceditor-v3`；最终界面修复前的 v3 备份为 `/home/tzwl3/apps/deploy-backups/pre-20260908-vsceditor-v4`。二者含 Profile、对应密码门环境和 PM2 快照。恢复前须先保存后续配置及编辑器状态，停止服务后恢复目标 Profile 与匹配环境，再验收并保存 PM2。启动器、sudoers 和 code-server 独立于 Profile，须核对所选版本；不得删除工作区、会话日志或任务账本，也不得重跑已完成的切换脚本。

### 包摘要与证据

| 文件 | SHA256 |
|---|---|
| `dsh-passwords-2.6.24.tgz` | `f36b92cde3ff47b2f3c01b832d8f180b09707f8344c2ba165c6ca59df8d84fae` |
| `dsh-vsceditor-0.5.1-dsh.20260908.4.tgz` | `596475e0a32c7f3cfebeb0815c9652107ac6b84fb61d83add9c7d9fc8c4b493b` |
| `code-server-4.133.0-linux-amd64.tar.gz` | `a4e0f8f8c76e7de8e7424289f74e507af4c97bfe104c3e8ee272b8cc7b46c6f1` |
| `dsh-tenant-editor` | `82bcc6c0dcfe966122c1d05758c2b8834e27433e3bbeaab73b1020d619d57185` |

最终插件包分别位于服务器 `apps/dsh-plugins/addons/20260908-vsceditor-v2/` 和 `20260908-vsceditor-v4/`。本机证据根为 `/Users/wangzhipeng/macproject/deploy-artifacts/20260908-vsceditor`，服务器 staging 为 `/home/tzwl3/apps/deploy-staging/20260908-vsceditor`。`accepted.json` 记录最终验收、PM2 保存、文件重新打开及临时数据清理结果，`acceptance.json` 与 `regression.json` 记录接口验收，`prepared-v4.json` 记录冻结输入；`cutover-state-v4.json` 仅记录切换结束时等待验收的阶段状态，最终完成状态以 `accepted.json` 为准；私有环境、临时令牌、PM2 私有快照和用户截图不加入 Git。

### 验收结果

20:37（Asia/Shanghai）完成 PM2 保存，Host PID `1434872`、restartCount `37`，配置与 Profile 冻结输入一致，数据库及网关健康。编辑器新增 4 项单元测试和 3 个入口语法检查通过；密码门构建、客户端类型检查及 12 项配置、终端网关和工作区看板回归通过，补充版本路径后对应网关测试通过。候选冻结安装及真实 `dsh` Profile 装配通过。

生产浏览器中打开验收文件、修改保存、服务器磁盘核对和重新打开文件通过。最初自动化焦点误入内置 Chat 的尝试未计为成功；最终精确定位代码输入区域后验收。账号 2 的编辑器 HTTP 200、WebSocket 101；账号 3 访问该会话均为 403；跨源 403、未登录 302 登录。实际编辑器命名空间内确认 UID 1000、本账号工作区可见、宿主机 home 和其他账号不可见、宿主机网络不可达。

原普通账号终端返回 101，UID 1000、目录 `/workspace/测试`；看板状态返回 200。管理员与普通账号的指定主会话均返回 14 条历史记录，模型目录各返回 14 项。3 个临时令牌已注销，专用验收文件已删除，私有证据保留；没有修改用户代码文件。

### 已知限制

系统运行目录只读但可进入，编辑器不承诺禁止导航到 `/bin`；写入权限限于本账号工作区、编辑器私有状态及沙盒临时目录。编辑器进程不能访问宿主机网络或互联网，因此在线扩展安装、远程 Git 和依赖下载不可用。公网 HTTP 下部分剪贴板和 WebView 功能受限，需要 HTTPS 才能完整使用。

上游全局跟随 diff、编辑锁定、桌面后端和共享设置未接入租户入口；不保证模型与用户同时修改文件时自动协调。code-server 自带 Chat 不是 DSH 模型接口，本次未配置。既有旧子代理历史兼容问题和两条前端 `phase` 异常仍存在；本次没有执行付费模型调用、整机重启或完整灾备恢复演练。

## 33. 2026-09-08 编辑器界面融合部署

`dsh-vsceditor` 从 `0.5.1-dsh.20260908.4` 升级到 `0.5.2-dsh.20260908.1`，只改插件客户端入口，Host 入口、root 启动器、sudoers、code-server 与 Harness `0.1.3-alpha.1-593ee89` 均未变动。Profile 仍为 16 个 bundle。切换后 Host PID `1457337`，restartCount `37`，`pm2 save` 已执行。

### 改动范围

会话「编辑器」页签的工具栏改用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Button` 与 `--dsw-alias-*` 设计 token，路径、加载与错误提示随 DSH 主题渲染。编辑器代理与 DSH 同源，面板把当前 DSH token 写入 code-server 文档的 `--vscode-*` 主题值，覆盖标题栏、活动栏、侧栏、分区头、标签栏与状态栏；列表与滚动条变量声明在 `.part.sidebar` 上，不外溢到快速打开和编辑器浮层。切换 DSH 主题由 `data-ds-dark-theme` 的 MutationObserver 触发重绘，编辑器整页重载由 iframe `onLoad` 重新套用。code-server 自带菜单栏与 Chat 入口按 `aria-label`/`title` 匹配隐藏。代码区、面包屑、终端面板与快速打开保留 code-server 自身配色。

`require('@deepseek-ai/dsh-client-ui-primitives')` 由 Web shell 的冻结 seed 表应答，已在部署运行时 `@deepseek-ai/dsh-client-web/lib/index.js` 中确认该键存在，插件包同时声明 `dsh.client.external`。

### 部署过程

本机 `npm pack` 产出 `dsh-vsceditor-0.5.2-dsh.20260908.1.tgz`，SHA256 `8279897337e35d83fb4256d0fa93404de73b8ef661158d656e969e66f0faeecf`，上传至 `apps/dsh-plugins/addons/20260908-vsceditor-v5/` 后服务器端摘要一致。候选 Profile `apps/deploy-staging/20260908-vsceditor/final-v5/profile` 由线上 Profile 改写 tarball 路径与 `sha512` 完整性生成，`pnpm install --frozen-lockfile` 后四份输入摘要未漂移。切换前以真实 `dsh --profile web` 在隔离 home 与 34087 端口装配候选，插件挂载且未授权会话返回 403。

切换沿用 v4 脚本结构：`deploy-backups/pre-20260908-104825-593ee89-alpha1/deployment.lock` 排他锁、备份 Profile 与 PM2 快照到 `pre-20260908-vsceditor-v5`、停服、换入候选、`pnpm install --frozen-lockfile`、恢复密码门 `.env`、重启，并要求健康检查连续 30 秒通过；PM2 启动路径与环境比对一致。失败路径自动恢复 Profile、`.env` 与服务。

### 验收结果

Host 3080 返回 401、网关 `/gateway/readyz` 200 且数据库健康、登录 302、工作区 3082 可连接，连续 7 次采样稳定。线上 Profile 内 `dsh-vsceditor` 版本为 `0.5.2-dsh.20260908.1`，客户端入口 SHA256 `1ce0ed7ebcbd1a6d62323c1e0fd125ae1d125f40f29c99c9dc7f55dbdafcb8e5`，包含界面融合标记；`dsh --profile web --dump-config` 正常输出 `vsceditor` 条目。新进程启动后日志中没有 `dsh-vsceditor` 相关错误。

启动后 8 秒出现两条 `[dsh-task-board] session/list failed; treating the host session roster as unknown TypeError: fetch failed`：任务看板在 Host HTTP 就绪前轮询，属既有启动竞态，与本次改动无关，插件自身按未知处理。

浏览器视觉验收尚未执行，`accepted-v5.json` 记为 `healthy-pending-visual-acceptance`、`browserVisualVerified: false`。本次没有签发临时令牌、没有写入用户工作区文件、没有调用付费模型。

### 回滚

`apps/deploy-backups/pre-20260908-vsceditor-v5` 含切换前 Profile、密码门环境与 PM2 快照。恢复前先保存后续新增配置与编辑器状态，停服后恢复该 Profile 与匹配 `.env`，重启验收再 `pm2 save`。启动器、sudoers 与 code-server 本次未变，无需回滚。不得删除工作区、会话日志或任务账本，也不得重跑已完成的 v4/v5 切换脚本。

### 已知限制

活动栏与状态栏本身未隐藏：VS Code 工作台栅格按脚本计算的内联尺寸布局，纯 CSS 隐藏只留同色空条；真正移除需要把 `workbench.activityBar.location` 与 `workbench.statusBar.visible` 写入 code-server 用户设置目录，该目录仅 root 启动器可写，须重新部署启动器。语法高亮仍由 code-server 主题决定，DSH 亮色主题配暗色编辑器主题时外壳与代码区呈现两个明暗分区。第 32 节的其余限制保持不变。

## 34. 2026-09-08 编辑器主题接管、chrome 精简与账号 git

`dsh-vsceditor` 从 `0.5.2-dsh.20260908.1` 升级到 `0.5.3-dsh.20260908.1`，并在宿主机安装 git。Host PID `1463610`，restartCount `37`，`pm2 save` 已执行；Profile 仍为 16 个 bundle，Harness 仍 `0.1.3-alpha.1-593ee89`。root 启动器、sudoers 与 code-server 未变动。

### 为什么改掉 0.5.2 的做法

0.5.2 由浏览器把 DSH token 注入同源 iframe 覆盖 `--vscode-*`，只影响外壳；代码区与语法高亮仍由 code-server 自带主题决定，DSH 切暗色时出现外壳与代码区明暗不一致。核查发现 `/etc/dsh-vsceditor.json` 的 `account` 就是 DSH 运行账号 `tzwl3`，启动器创建的 `/var/lib/dsh-vsceditor/<租户>/data` 为 `tzwl3:tzwl3 0700`，Host 本就可读写，因此改用 code-server 用户设置，不需要修改 root 启动器。

### 改动范围

Host 在启动实例后写 `<stateRoot>/<租户>/data/user/User/settings.json`：按 DSH 明暗写 `workbench.colorTheme`（`Default Dark Modern` / `Default Light Modern`），把 DSH token 写进 `workbench.colorCustomizations`，并按 `hiddenChrome` 写 `window.menuBarVisibility`、`workbench.activityBar.location`、`workbench.statusBar.visible`。新增 `POST /dsh-vsceditor/theme`，与 `/open` 同一套身份、会话与托管根目录校验；客户端监听 body 全部属性变化，配色载荷变化时提交。

DSH 只拥有上述五个键，每次写入前重读该账号设置文件并保留其余键，经临时文件重命名落盘；文件不是 JSON 时报错并原样保留。浏览器提交的配色经固定键名白名单与 `#rrggbb[aa]` 校验，载荷上限 16 KiB。`/open` 上的设置失败不阻断编辑器打开，响应回报 `settings` 状态。

`gitIdentity` 开启时首次打开编辑器在 `<stateRoot>/<租户>/data/.gitconfig` 以 `wx` 写入账号 git 身份，已存在则不改写。账号名取自 gateway principal 的 `username`，不满足 `^[A-Za-z0-9._-]{1,64}$` 时回退为 `u<id>`。新增 Config 字段 `followTheme`、`hiddenChrome`、`gitIdentity`、`gitEmailDomain`，均在装载时校验。

宿主机执行 `apt-get install -y --no-install-recommends git`，安装 git `2.45.2`（含 `git-man`、`liberror-perl`）。git 及其依赖全部位于 `/usr`，而两个沙盒都以只读方式绑定 `/usr`，因此终端与编辑器内立即可用，未修改启动器。编辑器与终端沙盒仍为 `--unshare-net`，远程 git 操作依旧不可用。

### 部署过程

本机 `npm pack` 产出 `dsh-vsceditor-0.5.3-dsh.20260908.1.tgz`，SHA256 `1335baf96974b5a90ae7fcc364ca2db36887e47a03d6fe4bc27f2b32e53016ac`，上传至 `addons/20260908-vsceditor-v6/` 后摘要一致。候选 Profile `final-v6/profile` 由线上 Profile 改写 tarball 路径与 `sha512` 生成，`pnpm install --frozen-lockfile` 后输入摘要未漂移。切换前以真实 `dsh --profile web` 在隔离 home 与 34088 端口装配候选，插件挂载且未授权会话返回 403。切换沿用 v4 脚本结构，健康检查连续 30 秒通过，PM2 启动路径与环境比对一致。

### 验收结果

Host 3080 返回 401、网关 `/gateway/readyz` 200 且数据库健康、登录 302、工作区 3082 可连接。线上 `dsh-vsceditor` 版本 `0.5.3-dsh.20260908.1`，客户端入口 SHA256 `b7af7a049be17f98977d366c00e53b75a51927b2d47ca24f7caddab723eddf34`，其中已无 `monaco-workbench` 字样，确认 CSS 注入路径移除。

以线上安装的 `lib/tenant-settings.cjs` 对临时状态根执行一次真实写入：`editor.background` 因不在白名单被丢弃，`workbench.colorTheme` 为 `Default Dark Modern`，三个 chrome 键按配置写入，`.gitconfig` 正确落盘，临时目录已删除。插件自测 12 项通过。`git --version` 在宿主机返回 `2.45.2`。新进程日志中除既有的任务看板启动竞态（`session/list failed`，Host HTTP 就绪前轮询）外无错误。

浏览器视觉验收仍未执行，`accepted-v6.json` 记为 `healthy-pending-visual-acceptance`。本次没有签发临时令牌，没有写入任何账号的真实编辑器设置或工作区文件。

### 回滚

`apps/deploy-backups/pre-20260908-vsceditor-v6` 含切换前 Profile、密码门环境与 PM2 快照。回滚插件不会卸载 git，也不会删除已写入账号的 `settings.json` 与 `.gitconfig`；需要还原编辑器外观时手工删除对应账号的这两个文件。不得删除工作区、会话日志或任务账本。

### 已知限制

账号把 `settings.json` 手工改成非 JSON 后主题不再跟随，直到该文件恢复为合法 JSON；DSH 报错但不覆盖。终端的 git 身份不在本插件范围内：终端 HOME 是账号的工作区根目录，需由密码门写入。git 身份是便利设置而非审计手段，git 允许从命令行或环境指定作者。远程 git 仍被网络命名空间阻断，开放需要修改 root 启动器。第 32、33 节的其余限制保持不变。

## 35. 2026-09-08 沙盒联网、账号 git 与出站策略

目标是让每个账号在自己的终端和编辑器里用自己的 git 账号 clone/pull/push。宿主机安装 git，两个租户沙盒改为共享宿主网络命名空间并以专用组运行，出站由一张按组过滤的 nftables 表约束。`dsh-vsceditor` 升级到 `0.5.4-dsh.20260908.1`，Host PID `1482230`，`pm2 save` 已执行，Profile 仍为 16 个 bundle，Harness 仍 `0.1.3-alpha.1-593ee89`。

### 为什么不是独立网络命名空间

初版设计是每沙盒一个 netns + veth + 网桥，默认全断按需开洞。核查发现两件事推翻了它：宿主 `ufw` 处于 active 且 FORWARD 默认 DROP（nftables 语义下任一表 DROP 即丢包，我们的放行救不回来），而 `net.ipv4.ip_forward` 为 `0`。要走通就得开全局转发并给网桥加一条笼统的 `ufw route allow`，为一个**本就发布在公网**的登录网关和一个**每台办公电脑本就可达**的局域网增加一层路由基础设施。改为共享网络命名空间 + 按组过滤：不动 `ip_forward`（仍为 `0`）、不动 ufw。

pasta 方案也被否决：Ubuntu 24.10 的 2024-08 版 pasta 默认把宿主 loopback 映射进命名空间，`--no-map-gw` 实测无效，该版本没有关闭开关。

### 宿主机改动

安装 git `2.45.2`（`apt-get install -y --no-install-recommends git`，带 `git-man`、`liberror-perl`）。git 及其依赖全部位于 `/usr`，两个沙盒均以只读方式绑定 `/usr`，因此无需修改启动器即可使用。原型验证期间安装的 `passt` 已 `apt-get purge`。

新增系统组 `dsh-sandbox`（gid `984`）。规则文件 `/etc/dsh-sandbox.nft` 由 `dsh-sandbox-nft.service`（oneshot、`RemainAfterExit`、`ExecStop` 删表）装载，已 enable。表 `inet dsh_sandbox` 的 output 链只在 `meta skgid 984` 时跳转到 sandbox 链，无 socket 的包不跳转，宿主自身流量不受影响。sandbox 链依次：放行回环 53；丢弃回环上 1024 以下端口与 3080/3081/3082；放行其余回环端口；`::1` 同规则后丢弃全部 IPv6；放行 `192.168.10.73:30000`；丢弃 `10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`；丢弃本部署公网地址 `221.2.171.165`；放行 tcp 443；其余丢弃。

### 启动器改动

`dsh-tenant-editor` 与 `dsh-tenant-terminal` 均去掉 `--unshare-net`，`setpriv --regid` 由账号 gid 改为 `dsh-sandbox`，并只读绑定 `/etc/ssl` 与 `resolv.conf`、`hosts`、`nsswitch.conf`、`passwd`、`group`——沙盒的 `/etc` 原为空目录，缺根证书会让 HTTPS 直接失败。源码分别在 `dsh-vsceditor/scripts/tenant-editor-launcher.py` 与 `dsh-passwords/scripts/tenant-terminal-launcher.py`。

摘要变化：编辑器 `82bcc6c0…` → `4952114cad3393468b48e772cdcfb35cd2e0e5957bcd8317d05d2bcb810d683f`，终端 `6bb4efc2…` → `ddb8b89b9a5e8493e68860f952287529e6144db1cf8e9cb38a7bcfc3f50f2428`。两条 sudoers 记录已按新摘要重新 pin，安装前经 `visudo -c` 校验。旧文件保留为 `/usr/local/libexec/*.20260908-v2`，旧 sudoers 保留为 `/root/sudoers-*.20260908-v2.bak`。

`dsh-vsceditor` 升级到 `0.5.4` 的唯一目的是让包内 `scripts/tenant-editor-launcher.py` 与已安装的 root 启动器一致：包内该文件摘要与 `/usr/local/libexec/dsh-tenant-editor` 相同，`lib/` 内容与 `0.5.3` 相同（客户端 bundle SHA 未变）。

### 验收结果

以 `setpriv --regid 984` 直接跑的可达性矩阵：内网 GitLab `:30000` 通、`github.com:443` 通、DNS 通；DSH API、登录网关（回环 / LAN / 公网三条路径）、宿主 SSH、GitLab 那台的 22/80/443、NAS、内网网关、GitLab 公网路径、`github.com:22`、tailnet 全部断。同一矩阵以 gid 1000 运行时宿主自身不受影响。

经真实终端启动器的端到端测试：`id` 返回 `gid=984(dsh-sandbox)`，`git version 2.45.2`，GitLab 可达，DNS 可用，登录网关与 NAS 被拦，CA 包存在。沙盒内 `git ls-remote https://github.com/git/git HEAD` 返回真实 SHA，证明 DNS、TLS、CA 与 git 全链路可用。

`dsh-vsceditor` 自测 12 项通过；候选 Profile 经真实 `dsh --profile web` 在隔离 home 与 34089 端口装配通过；切换后健康检查连续 30 秒通过。浏览器视觉验收仍未执行，`accepted-v7.json` 记为 `healthy-pending-visual-acceptance`。

### 已知限制

出站策略是「默认通、按规则拦」，不是「默认断、按需放」；规则错漏即是缺口，规则集存档在 `deploy-artifacts/20260908-vsceditor/records/dsh-sandbox.nft`。放行公网 443 意味着沙盒可访问**任意 HTTPS 站点**，`npm install`、`pip install` 与 code-server 在线扩展市场随之可用，数据也可经 HTTPS 外发——这是部署方明确接受的取舍。沙盒之间不再有网络命名空间隔离，可互相访问对方在高位端口监听的本地服务。所有沙盒仍以同一 uid 1000 运行，隔离依靠挂载命名空间；联网后一次逃逸的价值上升。

内网 GitLab 为 HTTP，git over HTTP 的 PAT 以明文传输，仅限局域网内；公网路径 `221.2.171.165:30000` 已被规则拦掉，避免 PAT 明文穿越互联网。GitLab 对 git over HTTP 通常不接受账号密码，需在 GitLab 建 Personal Access Token。

**终端的 git 身份尚未自动写入**：编辑器 HOME 是每账号独立的 `/editor-data`，`dsh-vsceditor` 会在首次打开时 seed `.gitconfig`；终端 HOME 是账号的工作区根目录，由密码门负责，目前未实现。各账号首次在终端提交前需自行执行 `git config --global user.name`/`user.email`，凭据若用 `credential.helper store` 会落在工作区根目录。

### 回滚

装回 `/usr/local/libexec/*.20260908-v2` 并从 `/root/sudoers-*.20260908-v2.bak` 恢复两条 sudoers（`visudo -c` 校验后再替换），沙盒即恢复 `--unshare-net` 且以账号 gid 运行。`systemctl disable --now dsh-sandbox-nft.service` 删表；`groupdel dsh-sandbox` 可选。git 与 nftables 单元独立于 Profile，回滚 `dsh-vsceditor` 到 `pre-20260908-vsceditor-v7` 不会撤销它们。

## 36. 2026-09-09 侧栏编辑器接管、dsh-vsceditor 退役与两处既有缺陷修复

编辑器 UI 换成 `dsh-sidebar-vscode` 的侧栏标签页（整页编辑器 + 右侧会话框），`dsh-vsceditor` 从 Profile 中移除、其运行时并入前者。同轮修复了两处与本次改动无关的既有缺陷。线上 `dsh-sidebar-vscode@0.2.8-dsh.20260909.9`、`dsh-passwords@2.6.26`、`dsh-better-sidebar@0.18.1-alpha.0`，Host PID `1553119`，Profile 17 个 bundle，`pm2 save` 已执行。root 启动器内容与摘要全程未变（`e5338ecb…`），sudoers 未重新 pin。

### 为什么不是直接换插件

`dsh-sidebar-vscode` 上游按单一信任边界设计：其 README 自述内置反代面向单上游、全局共享，且「能访问该端口的客户端即可使用被代理的工作台」；`src/` 中没有任何 principal 或会话校验，而 spool 目录按 `slug(工作区路径)` 寻址——多租户下每个账号看到的都是 `/workspace/...`，会直接撞进同一个目录，那是跨账号读写通道而非功能缺失。因此改为在 fork 中补隔离：停用其内置反代，spool 按认证账号寻址且使用鉴权返回的 folder 而非浏览器所报，随后把 `dsh-vsceditor` 的运行时按字节搬入 `runtime/`（鉴权与沙盒边界以已验证的形态搬迁，不重写为 TypeScript）。

### 部署过程中暴露的三个坑

**Cordis 的 inject 形态**：`{ required, optional }` 对象形式被这个版本读成服务名，条目永远 pending。改用嵌套可选 inject，单账号组合仍可装载，服务未就绪的 spool 请求一律拒绝。装配冒烟捕获。

**锁文件的相对路径**：候选 Profile 放在与线上不同深度的目录时，`pnpm install` 重解析会按候选目录重写 `file:` 相对路径，正式路径随后 `--frozen-lockfile` 安装即失败（找 `/home/tzwl3/dsh-plugins/...` 而非 `/home/tzwl3/apps/dsh-plugins/...`）。前几次切换用冻结安装不重解析，从未暴露。候选改放 `.dsh/profiles/` 下的同层兄弟目录。自动回滚正常，生产全程健康。此外锁文件同时以绝对与相对两种形式记录同一 tarball，只替换其一会静默保留旧解析——换包必须同时替换两种形式与 `sha512` 完整性。

**网关的路径白名单**：把编辑器路由改名为 `/sidebar-vscode/editor/` 后，工作台报 `WebSocket close 1006`。`dsh-passwords/dist/gateway.js` 硬编码了它转发的路径前缀，其中有 `/dsh-vsceditor/` 而无 `/sidebar-vscode/`；HTTP 走通用转发路径仍然可用，只有 WebSocket 升级被静默丢弃，两侧日志皆无记录。前缀改回 `/dsh-vsceditor/`——这个名字要活得比它来源的那个包更久，除非网关先动。原因已写进 `runtime/tenant-access.cjs` 与 fork 的 FORK.md。

### 同轮修复的两处既有缺陷

**新建工作区需刷新才可见**。`/api/session/list` 读取前要过一轮有界归属扫描（单次 15 秒截止，`partial` 后 30 秒不重扫）。一条 2026-09-01 起就无法读取归属的子代理会话（Session 服务对其历史分页返回 `session/agent-busy`，即交接文档中「descriptor 位于继承区仍无法打开」的那条）每轮都吃满预算，扫描永远 `partial`，窗口内所有读取都拿不完整快照，新建工作区因而被当作「认不出归属」过滤。日志此前只说「被拒绝」不带错误码，先发 2.6.25 把 sessionId、transport 与上游错误码带进日志才定位到。2.6.26 把「已尝试且确定读不了」的行记入内存集合，不再每轮重试、也不再让整轮判定不完整；该行仍不可见（归管理员，安全的答案），但不再拖累其他读取。重启后该警告从每 30 秒一次降为共 1 次。

顺带修正 `test/update.test.ts`：它硬编码 `assert.equal(pkg.version, '2.6.20')`，断言的是一个时刻而非行为，自 2.6.21 起一直失败，线上运行的 2.6.24 也在失败之列；改为断言版本领先于 2.6.19 基线，即更新流程真正依赖的关系。

**新建工作区仍不即时出现（未修）**。`packages/api/workspace-controller/src/principal-feed.ts` 的 `upsert` 分支要先向 `principalAccess` 确认可读性，不可读即整帧丢弃；而 `dsh-passwords/src/principal-access.ts` 以 `workspaceRegistry.list()` 快照解析 id→路径，新建工作区此刻尚不在快照中，`workspacePath` 为 `undefined` 判定不可读。刷新走 `baseline` 分支时快照已包含它，故表现为「刷新才有」。位置与机制已定位，改动未做。

### 合并过程中引入并已修复的两处回归

**编辑器不再跟随 DSH 主题**：开启调用从 `dsh-vsceditor` 的客户端移到侧栏插件后发送空载荷，主机半判定「无主题」并删除主题键。账号 `settings.json` 中只剩四个 chrome 键是发现线索。0.2.8-dsh.20260909.8 把调色板随开启调用送出，并以 body 属性观察者推送后续变化。

**背景色全部丢失**：客户端手写正则只认 `rgb()` 与 hex，而注册主题（品牌皮肤）把 token 以内联样式写成其它 CSS 颜色形式，不认识即静默丢弃——前景色与边框写入而所有 `bg-*` 键缺失。0.2.8-dsh.20260909.9 改由浏览器自身解析归一化。

### 验收结果

装配冒烟（真实 `dsh --profile web`，隔离 home）：`proxy.status` 宣告租户模式、`open.capability` 与编辑器 `open` 对未授权会话均返回 `Session access denied`。插件自测 480 项 + 运行时 10 项通过；`dsh-passwords` 384 项通过。切换后健康检查连续 30 秒通过。

产品侧已由使用者确认：侧栏 VSCode 标签页可加载工作台；编辑器内选中代码右键发送可在对话输入框生成引用 chip（走 `refs.json` 队列，因公网 HTTP 无 `navigator.clipboard`，原剪贴板桥静默失效）；沙盒内 `git clone`/`pull` 可用；工作区可创建并显示；Git 图谱分支显示正常。主题跟随在 0.2.8-dsh.20260909.9 后尚未复验。

### 已知限制

`dsh-better-sidebar` 为首次挂载，版本为 `0.18.1-alpha.0`（Profile 原有 spec 决定），整个侧边栏 UI 随之改变。VS Code 扩展 `dsh.selection-reference@0.1.5` 目前逐账号手工安装，`admin-u1` 与 `u3` 尚未安装，其文件打开通道在装好前降级为 URL payload。Git 图谱只列本地分支，`git clone` 只创建默认分支，其余需 `git branch --track` 建出。第 32–35 节的其余限制保持不变。

### 回滚

`apps/deploy-backups/pre-20260909-sidebar-editor` 含切换前 Profile、密码门环境与 PM2 快照。root 启动器、sudoers、nftables 单元与 git 安装均独立于 Profile，回滚插件不会撤销它们。

## 37. 2026-09-09 沙盒 HOME 迁至数据盘与 git 身份修复

每账号沙盒 HOME 与编辑器状态从系统盘迁到 916G 数据盘 `/dev/sda1`，并修复改用 `/home/dsh` 后 git 身份失效的缺陷。两个 root 启动器更新为 `dsh-tenant-editor` `d87bd17b…`、`dsh-tenant-terminal` `d4491d77…`，sudoers 已重新 pin。DSH 主进程全程未重启（Host PID `1560213`，重启计数 38 不变），未部署任何插件，Profile 未改。

### 落盘位置

`/etc/fstab` 新增两条 bind，沿用该机既有的数据盘接入方式：

```
/srv/dsh-data/dsh-sandbox-home /var/lib/dsh-sandbox-home none bind 0 0
/srv/dsh-data/dsh-vsceditor /var/lib/dsh-vsceditor none bind 0 0
```

必须是 bind 而非软链：两个启动器的 `trusted()` 与 `sandbox_home()` 都要求 `path.resolve(strict=True) == path`，软链会被直接拒绝；bind 不改变路径解析，且路径与其全部父目录仍是 root 属主、无组/他人写位，三道检查均通过。挂载选项从 `/srv/dsh-data` 继承 `nosuid,nodev,noatime`。

迁移前停掉 u2 的编辑器与终端沙盒（杀持锁的特权父进程，`--die-with-parent` 使整棵沙盒退出），`rsync -aHAX --numeric-ids` 复制后逐项核对元数据树摘要、文件内容摘要与顶层属主权限，三者一致才写 fstab。原数据保留在挂载点之下未删除，`umount` 即回到迁移前状态。已演练 `umount` 后 `mount -a` 复原。

会话日志 `~/.dsh/sessions`（当前 14M）仍在系统盘，增长慢，本次不动。

### git 身份失效的原因与修复

`seedGitIdentity` 把 `.gitconfig` 写在 `<stateRoot>/<tenant>/data/`，即沙盒内的 `/editor-data/.gitconfig`；HOME 改为 `/home/dsh` 后 git 不再读到它，两个启动器也都没有设 `GIT_CONFIG_GLOBAL`。实测沙盒内 `git config --global --list` 报 `fatal: unable to read config file '/home/dsh/.gitconfig'`，所有账号的 `git commit` 都会失败。`clone`/`pull`/`push` 不依赖身份，故此前验收未暴露。

身份是账号属性而非编辑器属性，因此改由创建 HOME 的启动器播种。两个启动器新增 `git_identity()` 与 `seed_git_identity()`，实现逐字节相同：可选的第三个 argv 传入账号名，通过 `[A-Za-z0-9._-]{1,64}` 校验则采用，否则回落到 HOME 所用的 `u<id>`，两个沙盒因而不会给同一账号播下两个身份。写入用 `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` 与 `0600`：文件不存在才创建，用户改过的姓名、邮箱及其他设置在后续每次启动都保留；已存在的软链被 `O_EXCL` 视为已存在，既不跟随也不改写其目标。

调用方仍传两个参数，因此新账号目前播下的是 `u<id>`。u2 迁移前已有的 `wzp` 身份在部署时从编辑器状态复制进 HOME，未被降级。要让身份直接是 DSH 用户名，需 `dsh-passwords` 与 `dsh-sidebar-vscode` 在调用启动器时多传一个账号名，启动器侧已就绪，届时无需再改启动器或 sudoers。

### 验证

启动器函数级测试 26 项通过（身份取值、回落、64 字符边界、注入回落、0600 权限、幂等不覆盖、软链不跟随）。

真实沙盒端到端：u2 终端 `HOME` 落在 `/dev/sda1`、`user.name=wzp`、`git commit` 成功且作者为 `wzp <wzp@dsh.local>`；u3 首次启动由启动器创建 HOME 并播种 `u3`，`git commit` 成功；第三参数传 `zhangsan` 时身份即为 `zhangsan`；传入含换行与 `[core] sshCommand=touch /tmp/pwned` 的构造值时回落为 `u9` 且未产生该文件。编辑器启动器直调后 code-server 起来、socket 就绪、Unix socket 上 HTTP 返回 302，沙盒 cmdline 确认 `/var/lib/dsh-sandbox-home/u2 → /home/dsh` 与 `/var/lib/dsh-vsceditor/u2/{data,run}` 三处挂载。网关 `/gateway/readyz` 返回 200。

### 已知限制

数据盘未启用配额，100 个账号共用 915G，任一账号可耗尽全盘。ext4 project quota 可按目录限额，限额值与超限提示未规划，本次不做。

编辑器状态里 `<stateRoot>/<tenant>/data/.gitconfig` 仍会被 `seedGitIdentity` 写入，现已无人读取；它是 u2 身份的迁移来源，暂时保留。

### 回滚

启动器备份为 `/usr/local/libexec/dsh-tenant-{editor,terminal}.20260909-git-identity`，旧摘要 `d473dd25…` / `f0b17031…`，sudoers 备份在 `/root/sudoers-dsh-tenant-*.20260909-git-identity.bak`；换回旧文件后须重新 pin sudoers。fstab 备份为 `/root/fstab.20260909-sandbox-home.bak`；注释掉两条 bind 并 `umount` 即回到系统盘上的原副本，该副本未被删除。

## 38. 2026-09-09 服务器 30 迁移准备与 bwrap AppArmor 修复

服务器 30（`wh.gr-iot.cn:6022`，内网 192.168.10.30，Ubuntu 26.04 / 内核 7.0 / glibc 2.43）已具备承载 DSH 的完整条件：数据盘、账户、目录、系统组件、沙盒与网络策略全部就位并通过端到端验证。28 全程在线未重启（Host PID `1560213`，重启计数 38 不变），公网入口未改动，两台机器尚未同时对外服务。

### 硬件与两机差异

30 为 40 核 Xeon 4210R、123Gi 内存、系统盘 893G（可用 795G）、数据盘 7.3T，顺序写 2.0 GB/s；28 为 12 核 i5-10400F、14Gi 内存。用户库是外部 MySQL `192.168.10.95`，两机均可达，账号数据无需迁移。

必须记录的三处环境差异：`dsh-sandbox` 在 28 是 gid 984，在 30 被 `nm-openvpn` 占用，改由系统分配为 973——启动器按组名解析，只有 `/etc/dsh-sandbox.nft` 的 `meta skgid` 需要按机器填值。`tzwl3` 在 28 是 uid 1000，在 30 是 1002（1000/1001 已属该机真实用户），路径不变故无需改代码，rsync 后按 uid 归位即可。30 的 `tzwl3` 不加入 `sudo` 组：`sudoers.d` 逐条按用户名授权两个启动器，通用 sudo 权限并非必需。

### 7.3T 盘

该盘原为研华出厂预装的 Windows，`Users/` 仅有空的 OEM 账户 `Advantech`（78M，各目录只剩 `desktop.ini`），80G 占用中 74G 是 `hiberfil.sys` 与 `pagefile.sys`。整盘擦除后重建 GPT 与单个 ext4，参数与 28 数据盘一致（label `dsh-data`、`-m 0`、`defaults,noatime,nodev,nosuid`、按 UUID 挂 `/srv/dsh-data`），并按 28 的形态建立六条 bind。UEFI 中的 Windows Boot Manager 已删除，GRUB 菜单不再列出 Windows，`BootOrder` 首项与 `BootCurrent` 同为 Ubuntu——该机不再有启动到 Windows 而使服务下线的路径。

### sudo-rs 不支持摘要 pin

Ubuntu 26.04 的默认 `sudo` 是 sudo-rs 0.2.13，它在解析 `sha256:` 摘要规则时报 `digest specifications are not supported` 并**整体拒绝服务**，装入这两条规则后该机 `sudo` 立即不可用。经典 sudo 1.9.17 以 `/usr/bin/sudo.ws`（setuid root）与之并存，`update-alternatives --set sudo /usr/bin/sudo.ws` 即恢复，且摘要 pin 得以保留。visudo 同样切到 `/usr/sbin/visudo.ws`。在 26.04 及更高版本上部署本套启动器前必须先完成这一步，否则会把该机的 sudo 打挂；恢复通道是直接调用 `/usr/bin/sudo.ws`。

### bwrap 在 AppArmor 下无法降权

26.04 为 bwrap 附带 AppArmor 配置，沙盒进入子配置 `bwrap//&unpriv_bwrap (enforce)`，其中 `/etc/apparmor.d/bwrap-userns-restrict` 带 `audit deny capability`。结果是沙盒内虽为 uid 0 且 `CapEff` 满，`setpriv` 的 `setresuid(1002,1002,1002)` 仍返回 `EPERM`，终端与编辑器都起不来。已排除 user namespace（沙盒与宿主同 namespace、`uid_map` 为全量映射）与 POSIX 能力（`--cap-add ALL` 无效），strace 定位到系统调用本身被拒。

两个启动器改为在 aa-exec 存在时经 `aa-exec -p unconfined --` 启动 bwrap。启动器本就是 root 且自建隔离，不依赖这层配置；沙盒进程最终仍是目标 uid/gid、四个能力集全空、`no_new_privs=1`。28 无 bwrap 配置、bwrap 本就 unconfined，实测该改动逐项无差异（uid/gid、`unconfined`、`CapEff`/`CapBnd` 全零、`NoNewPrivs=1`、网络策略一致），故两机共用同一份启动器源码，摘要为 `dsh-tenant-editor` `8e2eb293…`、`dsh-tenant-terminal` `acb73638…`，两机 sudoers 均已重新 pin。

### 迁移过程中的两个取数陷阱

rsync 以 `tzwl3` 身份拉取时，`/srv/dsh-data/dsh-sandbox-home`（root `0711`）与 `/srv/dsh-data/dsh-vsceditor`（root `0755`，租户目录 `root:tzwl3 0710`）只能穿越不能列目录，子项被静默跳过且 rsync 不报错。这两棵树改由 28 侧 root 打 tar、按摘要核对后在 30 侧解包。同类风险适用于任何以非 root 身份拉取 root 目录的迁移。

`ssh` 默认读取 stdin，写在经 stdin 送入的脚本里会把脚本正文本身吃掉，表现为脚本在该行之后静默停止。所有此类脚本中的独立 `ssh` 调用需加 `-n`。

### 已完成并验证

30 上：数据 1.1G 落 `/srv/dsh-data`，`~/.dsh` 1.9G（57 份会话日志）、`~/apps` 13G、`~/.local` 3.7G 落系统盘；三个工作区 `admin-u1`/`u2`/`u3` 与两个沙盒 HOME `u2`/`u3` 完整；`u2` 的 git 身份 `wzp` 保留。终端沙盒实测 uid 1002/gid 973、`HOME` 落 `/dev/sdb1`、`git commit` 成功且作者为 `wzp <wzp@dsh.local>`、工作区可见；网络策略按 gid 973 生效（GitLab `192.168.10.73:30000` 放行，网关 3081 与 NAS 445 拒绝，443 出网可用）。编辑器沙盒 code-server 起来、Unix socket 上 HTTP 302。跨 OS 最大的未知项——原生模块——已验证：`node-pty` 与 `fs-ext` 均可加载（glibc 2.40 编译、2.43 运行，方向兼容）。`dsh-sandbox-nft.service` 已 enable 并 active，`@reboot pm2 resurrect` 已装。

### 尚未做

DSH 主进程尚未在 30 启动。它会连同一个 MySQL 用户库，与 28 的在跑实例产生并发写（会话归属、工作区注册），并行灰度前需先定这一项。公网 NAT 仍指向 28：`wh.gr-iot.cn:3081`（网页）与 3082（本地工作区 WebSocket）要改指 30，且 `MCP_LOCAL_WORKSPACE_PUBLIC_URL=ws://192.168.10.28:3082` 需同步改写；这两项需网络管理员配合。30 上 `sqlite3` 与 `rclone` 未安装，后者是 NAS WebDAV 挂载所需。

30 的公网出口被 clash-verge 以策略路由导入 TUN（`198.18.0.0/30 dev Meta`，table 2022），内网 `192.168.10.0/24` 直连不受影响；按使用者指示本次不做处理，但 DeepSeek API 调用会经该代理。该机仍在跑图形会话与 AweSun 远程控制。

### 回滚

30 侧：`/root/fstab.20260909-dsh-data.bak`、`/root/fstab.20260909-binds.bak`、`/root/grub-default.20260909.bak`，启动器备份 `/usr/local/libexec/dsh-tenant-{editor,terminal}.20260909-pre-aa`。28 侧启动器备份同名，旧摘要 `d87bd17b…` / `d4491d77…`；换回后须重新 pin sudoers。迁移用的一次性 ssh 公钥已从 28 的 `authorized_keys` 删除，30 侧私钥已删除。

## 39. 2026-09-09 用户库从 MySQL 迁至 MariaDB（服务器 30 已切，28 未动）

服务器 30 的 DSH 已在 `http://192.168.10.30:3081/` 提供服务，用户库读写全部落在 MariaDB `192.168.10.73:3306`，与旧 MySQL `192.168.10.95` 的连接为 0。28 仍连 MySQL、仍在正常服务，本节的插件与配置改动都未落到 28。

### 端口与账号

MariaDB 实为 `192.168.10.73:3306`，不是记录里的 3007——3007 在两台机器上都拒绝连接，3306 可达。服务端 `10.11.6-MariaDB`，管理账号 `wzp@%` 持 `GRANT ALL PRIVILEGES ON *.*`，认证插件 `mysql_native_password`（mysql2 可用，MariaDB 的 ed25519 则不可用）。该实例还承载 `gr_bis`、`lottery`、`website`、`zentao` 等生产库，迁移只新建 `dsh_passwords_platform`，未触碰其他库。

### 排序规则是唯一的代码阻塞

`utf8mb4_0900_ai_ci` 是 MySQL 8 专有，MariaDB 解析即报 Unknown collation；而 `Database.init()` 每次启动重跑整段建表语句，`IF NOT EXISTS` 不能绕开，因此必须改。`src/db.ts` 中 12 处改为 `utf8mb4_unicode_ci`，该规则在 MySQL 8.0.28 与 MariaDB 10.11.6 上均存在（两端 `SHOW COLLATION` 实测），故同一份构建两种服务端通用。24 张表的 JOIN 键全是整数，不存在跨表字符串比较，语义不变。其余语法均可移植：无 JSON 列、无窗口函数、无 CTE、无 CHECK 约束、无生成列，`ON DUPLICATE KEY UPDATE` 仅 1 处且 MariaDB 支持。

### 数据搬迁

未用 mysqldump：程序化逐表 `SHOW CREATE TABLE`、改写排序规则、建表、按 200 行一批 INSERT，最后比对行数。13 张表全部一致（`audit_logs` 62、`session_owners` 56、`user_usage` 11、`users` 3、`managed_workspaces` 2、`user_permissions` 2、`local_workspaces` 2、`platform_settings` 3、`nas_webdav_credentials` 1，其余 0）。库总量 384 KB。**旧 MySQL 未删除任何数据**，是回滚依据。

### 应用账号换了密码

MariaDB 装有密码策略（要求大小写混合与特殊字符），原 64 位小写十六进制密码被 `ER_NOT_VALID_PASSWORD` 拒绝，且该错误把密码原文打进了日志。因此不复用旧密码，改为生成 34 位含四类字符的新密码，建 `dsh_passwords_app@192.168.10.28` 与 `@192.168.10.30` 两个来源。旧 MySQL 侧的账号与密码保持原样，28 不受影响。

### 库地址有两个来源，都要改

`.env` 的 `DSH_PASSWORDS_MYSQL_*` 只覆盖密码门自身。`dsh-nas-webdav` 在 `cordis.patch.yml` 里另有一套 `mysqlHost`/`mysqlPort`/`mysqlUser`，密码取自凭据目录 `~/.dsh/credentials/dsh-nas-webdav/mysql-password`（明文文件，非 `.env`）。只改 `.env` 时进程仍保持一条到 `192.168.10.95` 的连接；两处都改并重启后，到 `.95` 的连接归零。任何后续换库都必须同时处理这两个来源。

### 30 上部署的插件版本

30 装的是 `dsh-passwords@2.6.28`，它包含尚未上过生产的 `2.6.27`（账号管理 UI 重做与托管目录的 git clone/pull）。**28 的迁移不应沿用这个包**：数据库迁移与未验收的 UI 变更不该捆在一次变更里，28 应另出一个「线上 2.6.26 + 本节排序规则修改」的最小包。

### 回滚

30 侧：`.env` 备份为同目录 `.env.pre-mariadb`，`cordis.patch.yml.pre-mariadb`，凭据 `mysql-password.pre-mariadb`，插件 `apps/dsh-plugins/addons/dsh-passwords-2.6.26-rollback.tgz`（含 dist 与 package.json）。恢复这四项并重启即回到 MySQL。旧 MySQL 的库与账号完好，未做任何删除。

## 40. 2026-09-09 上游同步：三个插件升级，两个受阻；30 转为正式环境

服务器 30 现为正式环境，服务器 28 转为灰度环境（使用者 2026-09-09 决定）。此前文档中「28 是对外权威」的表述自本节起失效；公网入口切换仍待网络管理员配合。

### 逐包比对结果

十七个 bundle 全部装自本地 tarball，机器上未配 registry，因此逐个对公共 npm 比对。`latest` 标签不等于最高版本：`@deepseek-ai/dsh-base` 与 `dsh-web-app` 的 `latest` 是 `0.0.1-rc.1`，新版在 `alpha` 标签下；`dsh-better-sidebar` 有 `beta`/`alpha`/`latest` 三个标签指向不同版本。按 `latest` 安装会降级。

`dsh-shandong-tizhi-brand`、`dsh-nas-webdav`、`@dsh-external/dsh-super-injector`、`@dsh-external/dsh-graded-mode` 在公共 npm 上不存在，无从比对。`dsh-passwords`、`dsh-spend`、`dsh-at-file`、`@wxg-prc-cpg/dsh-weknora`、`dsh-sidebar-vscode` 的本地版本高于上游，升级反而回退。

### 已升级（30 上生效）

`dsh-context` 0.46.0-dsh.20260908.1 → **0.47.0-dsh.20260909.1**。上游把本 fork 的嵌入式流计时修复吸收为 `host/logShapes` 的 `firstTokenTimeOfStream`，它直接读紧凑记录联合而不经 `dsh-llm` 展开，比 fork 版本更完整，故丢弃 fork 实现取上游。上游同时删除了自己的对话统计行跳转（`7c08143`），`composer.dock` slot 与其测试随之移除。fork 只保留一件上游不带的事：本部署跑 dsh `0.1.3-alpha.1`，而上游 0.47.0 只声明 `0.1.3-alpha.2` 与 `0.1.5-alpha.1`，因此兼容表与 peer 范围重新写回 alpha.1。合并后 81 个测试文件、1279 项通过、覆盖率 100%。

`dsh-better-sidebar` 0.18.1-alpha.0 → **0.18.1**。本地 fork 无自有提交，直接快进到上游 main（落后 43 个提交）。

`@huanlin/dsh-plugin-better-sidebar-plugin-office` 0.1.3 → **0.2.0**。上游未声明源码仓库，直接取 npm tarball；它要求 `dsh-better-sidebar@^0.17.0`，与升级后的 0.18.1 相容。

`dsh-passwords` 的 override 一并从 2.6.26 改为 2.6.28 的正式 tarball——此前 2.6.28 是以覆盖 `dist/` 的方式部署的，任何重新解析都会把它打回 2.6.26。

### 受阻（已中止合并，仓库保持干净）

`dsh-plugin-subscriptions` 0.6.4 → 0.8.0 是**架构分叉**而非文本冲突。本 fork 把订阅 RPC 迁到 Typert 远程加 `AuthenticatedPrincipal` 鉴权（多账号网关所需，见 `fix: authenticate subscription RPC endpoints` 与 `fix: restrict subscription credential controls`），上游仍用 `connection.rpc.handle` 的 `{ authority: 'loopback' }` 模型并新增了 `ProviderSettingsController`。七个文件十六处冲突，合并等于把上游新功能在本 fork 的架构上重新实现，不是解冲突能完成的。

`@changfenhuang/dsh-genui` 0.9.8 → 0.9.9 受阻于同一根因的另一面：该 fork 存在的意义就是把上游适配到 dsh `0.1.3-alpha.1`，而 0.9.9 的 peer 声明已从 `^0.1.2-rc.1 || ^0.1.3-alpha.1` 改成 `^0.1.2-rc.1 || ^0.1.5-alpha.1`，即上游已转向 0.1.5 的客户端 API。十五个文件冲突，硬合会产出无法对 0.1.3-alpha.1 验证的结果。

两处均已 `git merge --abort`，工作区零改动；`upstream` remote 与 `backup/pre-upstream-20260909` 备份分支保留，可随时续做。

### Harness 本体：落后 879 个提交，含会话日志 V3

`@deepseek-ai/dsh-base` 与 `dsh-web-app` 0.1.3-alpha.1 → 0.1.5-alpha.1。`deepseek-harness` 的 `tzwl` 分支落后 `upstream/master` 879 个提交、领先 42 个，其间上游发布了 **session-log-v3**（会话日志格式大版本，见 `release/session-log-v3` 与 `fix(session): audit every historical content carrier before V3 migration`）。工作区另有 15 个未提交改动集中在 `packages/session/session-format-v0-to-v1`。这是一次会触及全部已提交会话日志的迁移，且上述两个受阻插件都在等它，须单独规划，不能与插件升级同批进行。

### 一个必须记住的安装机制

Profile 的真正版本锁不在 `package.json` 的 `dependencies`，而在 `pnpm-workspace.yaml` 的 `overrides`（该文件为 JSON 格式，47KB）。只改 `dependencies` 后 `pnpm install` 会正常结束却不改变任何版本。换包必须改 `overrides`。

`pnpm install` 会以 tarball 内容重建包目录，从而删除 `dsh-passwords` 的 `.env`——该文件不在包内，是部署时写入的。每次重装后都要从备份恢复它，否则网关因缺少数据库配置而无法初始化。

### 验证

30 上十七个 bundle 全部装载，插件树无未激活告警，网关 `/gateway/readyz` 返回 `{"ok":true,"database":true}`，首页 302，数据库连接全部指向 MariaDB `192.168.10.73`，数据盘可用 7.3T。

### 回滚

`apps/deploy-backups/pre-20260909-upstream-sync/` 含切换前的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml` 与 `dsh-passwords.env`。恢复 `pnpm-workspace.yaml` 与 `package.json` 后重新 `pnpm install`，再恢复 `.env` 并重启即可。旧 tarball 仍在 `apps/dsh-plugins/releases/` 与 `addons/20260908-context-routing/` 下，未删除。

## 41. 2026-09-09 Harness 升至 0.1.5-alpha.1 与两个受阻插件的合并（尚未部署）

第 40 节列为受阻的两个插件已随 Harness 升级解除。本节记录的全部改动**都还没有部署**：28 与 30 上运行的仍是 `0.1.3-alpha.1` 与合并前的插件版本。原则是**上游优先，本 fork 做适配**——每个文件先取上游版本，再把 fork 真正拥有的能力贴回去。

### Harness 0.1.3-alpha.1 → 0.1.5-alpha.1

`deepseek-harness` 的 `tzwl` 分支合入 `upstream/master` 的 879 个提交，80 处冲突（源码 31、生成类文档 12、i18n 配对 21、README 与中文 20、锁文件与快照 4）。合并后相对上游只多 44 个提交，全是 fork 自有能力。

决定做法的事实：**上游没有实现 principal 传播**——`core/session`、`api/session-controller`、`core/agent` 三处源码里一个 `principal` 都没有，`AuthenticatedPrincipal` 是本 fork 定义在 `packages/llm/llm/src/message.ts` 的类型。因此多账号归属能力必须逐处重贴到上游重构之后的代码上，这是本次合并的主体工作量。

上游的三处重构，principal 随之搬迁。agent 循环把每步数据收进 `PreparedStep`，principal 也随 `decision` 流动。`Inbox` 从 `core/agent/src/inbox.ts` 移到 `core/agent-loop/src/inbox.ts` 并由具体类改为接口加 `ReactLoopInbox` 实现，归属过滤的 `claim`、`nextPrincipal` 与 `messageBelongsToPrincipal` 跟随具体实现，**不加宽上游给驱动方的窄接口**；fork 的 Inbox 测试同步迁到 `agent-loop/tests/inbox.spec.ts`。`subagent/continuation.ts` 从 1758 行重构到 537 行并抽出三个新文件，principal 分别贴回消息构造器、Activation 的 `principal` 字段与 `submitAdmitted`、`sendToParent`、三条投递入口，以及 `startContinuable` 的初始投递——最后这处最初漏了，冷恢复后子代归属变成 `undefined`，是测试抓到的；这类错误不抛异常，只会静默破坏多账号隔离。`client/connection` 保留上游的路由结构，鉴权换回 fork 的 `authorizeRequest`，principal 才能到达 fetch handler。

上游吸收或取代了 fork 的三处改动，已丢弃：`hasNextStepForPrincipal` 守卫（上游改用「本次领取为空」判断，而 `claim` 本身按归属过滤，守卫成为冗余）、`openWorkspacePath`（上游改用 `sidebarRight.openResource`）、`ModelSelect` 的 confirmed 标签 ref（上游自行移除）。fork 独有的 `rootCallSeq` 与 `image`/`read-image` 两条命令保留，跟随上游改名 `tool/code-dispatch*` → `tool/ptc-dispatch*`、`catalog.<name>.description` → `description.<name>`。

顺带修正两处仓库规范问题：本 fork 曾往**冻结的归档 Agent Note** 里加「已被取代」链接，违反归档规则，已整体恢复上游；`docs/architecture.md` 超出词数上限，按「重定位优先」把工具占用标识那段移回 `packages/core/tools/README.md`（该处本就完整记载）。

验证：`typecheck` 两个 face 通过；21,326 项测试通过，principal 关键面 4,590 项全过；`lint` 干净；`doc-sync` 34 个门全过，771 对双语文档一致。其余失败逐个核实为环境类——Windows PATH 语义在 macOS 上执行（该文件与上游逐字节相同）、oxlint 与 publint 的工具契约、脏工作树的版本元数据、并行下的超时抖动，单独运行均通过。

本机构建需 node `^22.19.0 || >=24.0.0`；22.16 上 tsdown 的 workspace 解析会失败，22.21.1 通过。另需显式声明 `unrun`（tsdown 0.22 加载 TS 配置所用，pnpm 未从锁文件落地）。

### `@changfenhuang/dsh-genui` 0.9.8 → 0.9.9

该 fork 原本只是 Harness alpha 兼容垫片，上游 0.9.9 已声明 `^0.1.5-alpha.1`，垫片全部作废，整棵树取上游，仅保留一个守卫测试。该守卫原先钉死 `^0.1.2-alpha.3` 这类某一时刻的字符串，改为断言关系：每条 Harness peer 范围都必须容纳本部署运行的版本线。502 项测试通过，与上游仅差该文件。

### `dsh-plugin-subscriptions` 0.6.4 → 0.8.0-dsh.20260909.1

上游取代了 fork 的四样东西，均已丢弃：`ProviderSettingsStore` 把模型可见性做成可配置的持久化偏好，取代 fork 硬编码的 Codex 与 Grok 白名单；上游重写的客户端取代 fork 的 Typert Remote 半边；Responses 的 strict 处理与 pool-usage 修复上游已自行完成。

两样上游承载不了的保留。**授权走共享认证通道**：上游把端点注册在自有通道并配 `loopback` 权限，但本部署的网关只转发固定前缀清单（`/api/`、`/sidebar/api/`、`/dsh-vsceditor/` 等），自有通道根本不可达，而 `loopback` 权限在多账号网关下等于任何已登录账号都能触及主账号的 provider 凭据。因此端点改走 `/api` 上的 `connection.rpc.intercept`，前缀 `subscriptions-auth/`——这是唯一携带传输层已验证 principal 的路径。在其之上，只有管理员可变更凭据或查看配额，子账号的 `status` 回包既不含 provider 账号也不含管理能力标志。**`/image` 命令**是本部署自有的命令入口，上游只有工具。

合并取上游测试文件时曾把 fork 的两条授权测试一并丢失，已补回：`test/login.spec.ts` 与 `test/usage.spec.ts` 各自断言子账号被拒。421 项测试通过。

同轮在 Harness 中把 `ConnectionRpcHandler` 的 principal 改为可选形参（语义不变，本就是 `| undefined`），使不做授权判断的处理器保持三参数形态，上游形态的消费方无需改写。

### 依赖形态：本插件只能对本部署的 Harness 构建做类型检查

`AuthenticatedPrincipal` 与四参数的共享通道处理器都不存在于已发布的 `@deepseek-ai/*`——npm 上的 `0.1.5-alpha.1` 是上游版。因此 `dsh-plugin-subscriptions` 的 Harness 依赖以 `link:` 指向同级的 `deepseek-harness` 检出（相对本目录 `../../deepseek-harness`），与生产 profile 钉自建 tarball 的做法一致。**把本部署的 Harness 构建发布到内部 registry 后**，这些 link 才能换回普通版本号；在此之前，该同级检出是类型检查的前提。细节见该仓库的 `FORK.md`。

### 提交

| 仓库 | 提交 |
|---|---|
| `deepseek-harness` (`tzwl`) | `fdb4b614fb` 会话格式保留 principal、`5505934a14` 合并上游 0.1.5-alpha.1、`ebda8d9e3c` principal 形参改可选 |
| `dsh-genui` (`dev`) | `dac008c` |
| `dsh-plugin-subscriptions` (`codex/internal-013-deploy-20260908`) | `424b789` |

三个仓库工作区均干净，**均未推送远程**。合并前的备份分支：`backup/tzwl-pre-0.1.5-20260909`、各插件的 `backup/pre-upstream-20260909`。

### 部署前仍未完成的四项

1. 快照重录（`pnpm run test:snapshot:record` 需 `DEEPSEEK_API_KEY`）
2. TypeScript 与 Python 两个 SDK 的预期输出更新，`pnpm run test` 覆盖不到
3. **session-log-v3**：上游在这 879 个提交里发布了会话日志格式大版本。30 上有 57 份生产会话日志，该迁移独立于本合并，须单独规划
4. 本部署的 Harness 发布到内部 registry，以解除上一节的 `link:` 依赖

**落地顺序**：本轮改动应先上 28（现为灰度）验证多账号隔离未被破坏，再考虑 30（现为正式）。不得直接上 30。

## 42. 2026-09-09 服务器 30 升级至 Harness 0.1.5-alpha.1（已上线）

用户指示跳过灰度、直接部署到 30（正式环境）。发布 ID `20260909-132137-dd1548b-alpha1`，三条 release（runtime / web / plugins）同 ID。

### 部署前发现并修复的生产回归

把 30 上全部 106 份会话日志取下来，用合并后的 catalog 逐个还原，**9 份失败，其中 5 份是会话的最新世代**——即升级后这 5 个会话在产品里打不开，全部属于用户 u3。

根因不是 principal，而是 `user/message` 上的 `source.kind: 'at-file-mention'`（13 处）。写它的是 30 上安装的 `dsh-at-file` 插件，而该种类在合并后的树、合并前 fork 顶点、上游 master 中都不存在。上游 v2→v3 按封闭清单对消息来源分类，不认识就拒绝整个 Session（`SessionFormatUnsupportedMigrationError`）。

修复见 harness 提交 `dd1548b696`：已发布 v2 来源清单接纳 `at-file-mention`。原生 V3 不对来源种类分类，插件今后照常写入。修复后 106 份全部迁移到 v3（57 份来自 v2，49 份来自 v0），无一拒绝。

同时更正了此前 runbook 记录的两条"阻塞项"，两条都不成立：`test:snapshot:refresh` 是无钥匙的，不需要 `DEEPSEEK_API_KEY`；principal 早已随 `RELEASED_V0_EVENT_DISPOSITIONS` 继承进 V2 白名单。

### 切换失败四次的两个真实原因

**其一：`import.meta.main` 入口守卫。** 上游 0.1.5 把 `bin.js` 末尾改成 `if (import.meta.main) await runCli()`。pm2 的 fork 模式由包装器 import 目标脚本，目标不是进程入口，守卫恒为假，CLI 永不启动——进程 online、闲置在 `ep_poll`、日志零字节。

修复：pm2 改为启动 `/home/tzwl3/apps/dsh-runtime/dsh-cli-entry.mjs`，它 import `current` 下的 `bin.js` 并显式调用导出的 `runCli`；对更早的、在模块顶层直接启动的版本，仅 import 即完成启动，`runCli` 不存在时不重复调用，因此回滚到 0.1.3 同样可用。

**其二：`.dsh-module-fallback` 模块投影。** profile 的 `node_modules/@linxin666/*` 共 18 项，只有 `dsh-web-all` 由 pnpm 安装，其余 17 项经两跳解析到 web release：`node_modules/@linxin666/X` → `.dsh-module-fallback/node_modules/@linxin666/X` → web release 内的实际包。这些链接由 app-boot 在启动过程中逐步建立，新建 profile 首次启动时加载器会先于治愈失败（`Cannot find package '@linxin666/dsh-i18n'`），必须预建。

预建方式：以线上 profile 的投影为模板，release 内目标改指本次 release，profile 内目标写成**相对路径**（保证候选改名为 `web` 后仍成立）；pnpm 存储哈希随 tarball 路径变化，须按"属主包名 + 包名"在候选存储中重新定位，不能字符串替换。本次重建 506 条投影 + 503 条第二跳，零悬空。

> 直接照搬旧 release 的投影会把旧 release 路径混入新 profile，是 0.1.3 手册明令禁止的；正确做法是重建而非复制或删除。

### 另一个教训：诊断会污染候选

排演时用 `DSH_HOME=<排演目录>` 且把 `profiles/web` 符号链接到候选，0.1.5 主机会把模块投影**写回候选的 `node_modules`**，指向排演目录。此后候选不可再用于部署。候选一旦被任何排演指向过，必须重建。

### 本次改写配置时踩到的两个坑

- **overrides 才是权威，不是 dependencies。** 线上 `dsh-passwords` 在 `dependencies` 写 2.6.26、在 `overrides` 写 2.6.28，生效的是后者。首版生成脚本用 dependencies 覆盖 overrides，会把 passwords 降级到 2.6.26 并丢掉 MariaDB 排序规则修复；另有 `dsh-vsceditor` 只存在于 overrides，一并丢失。两处均在切换前发现。
- **`allowBuilds` 的键用 pnpm 规范化后的相对路径**（`file:../../../apps/dsh-runtime/...`），写成绝对路径会导致 `dsh-subprocess-local` 的 postinstall 被跳过。

### 上线结果

| 组件 | 部署前 | 部署后 |
|---|---|---|
| `@deepseek-ai/dsh-base` | 0.1.3-alpha.1 | **0.1.5-alpha.1** |
| `@changfenhuang/dsh-genui` | 0.9.8 | **0.9.9** |
| `dsh-plugin-subscriptions` | 0.6.4 | **0.8.0-dsh.20260909.1** |
| `dsh-passwords` | 2.6.28 | 2.6.28（未变，已确认无降级） |
| dsh-context / better-sidebar / office / sidebar-vscode | 不变 | 不变 |

runtime 270 个 tarball 冻结安装；native 入口 `@deepseek-ai/node-addon-system@0.1.2` 来自官方 registry，四个平台包因发布未满最小年龄而进入 `minimumReleaseAgeExclude`，其 linux-x64 的 SHA512 与锁内记录一致。

验收：健康门第 26 秒通过（gateway 200 / web 401），静置 100 秒 pm2 online、0 重启、0 新增致命错误，两个数据库连接正常；用线上已部署代码还原此前失败的会话，14 份全部 v2→v3 成功。

### 回滚

`web-pre015-20260909-144430` 保留完整旧 profile；三条 `current` 指回 `20260908-104825-593ee89-alpha1` 即回到 0.1.3。切换脚本内置回滚，四次失败均自动回滚成功，服务最长 7 秒恢复。

### 仍未完成

1. TypeScript 与 Python 两个 SDK 的预期输出更新（`pnpm run test` 覆盖不到）
2. 本部署的 Harness 发布到内部 registry，以解除 `dsh-plugin-subscriptions` 的 `link:` 依赖
3. 28（灰度）仍在 0.1.3，与 30 已不同版本；`dsh-at-file` 同样装在 28 上，其会话日志迁移需要同一修复
4. `principal-feed.ts` 的 upsert 时序问题、两块数据盘的配额，仍未处理

## 43. 2026-09-09 dsh-spend 0.6.7：把全网搜索纳入计价（30，已上线）

### 缺口

`dsh-web-search-deepseek` 每执行一次搜索，会向 DeepSeek **另发一次 `deepseek-v4-flash` 调用**（同一个 API key，DeepSeek 单独计费），并在会话日志留下 `web/deepseek-search-llm-request` 事件。spend 的扫描器只认 `assistant/message` 的用量，这些调用此前完全不在账内。30 上的生产日志有 14 次。

查证过 DeepSeek 官方定价：**没有按次的搜索费**，搜索按承载模型的 token 计费。而该事件**只记请求、不记响应用量**，日志里没有这次调用的 token 数——可计量的单位只有"派发次数"。

### 实现（仅改 dsh-spend）

`foldSession` 把每次派发归到**发起它的那一步**。关键在于事件顺序：派发发生在该步 `assistant/message` 之后（此时 step 状态已被删除），所以归属依据是"最近一次已发射的样本"，而不是"打开中的步骤"。样本携带搜索自身的模型，按该模型的价格行取 `searchPerCall`，而不是按步骤模型。

`searchPerCall` 默认 0：DeepSeek 未公布按次费率，未设定时只计次、不产生费用，由部署方按实际账单设定单次均价。存量价格覆盖没有该字段，读作未计价；`spend_pricing_overrides` 表对已有库执行 `ALTER TABLE ADD COLUMN`（列已存在时的 duplicate column name 属预期，其余错误照抛）。

要精确到 token，需要搜索提供方把响应用量也写进会话日志——那是 harness 侧的改动，本次未做。

### 验证

部署前后各用真实生产日志跑一遍：**13 个步骤、14 次派发、13 个归属到用户、模型全为 `deepseek-v4-flash`**，两次结果一致。插件自测 46 项全通过（顺带修正两条自 0.6.6 起就失效的版本钉子）。健康门第 27 秒通过，静置 60 秒 gateway 200 / web 401 / 0 新增致命错误。

### 部署中的一个复发教训

首次改写配置时，`pnpm-workspace.yaml` 已被 pnpm 改写成真正的 YAML，按 JSON 解析失败，于是只有 `package.json` 被改到 0.6.7、override 仍指 0.6.6——**override 胜出，装的还是旧版**，与 §42 里 `dsh-passwords` 那次是同一条规律。改用与格式无关的文本替换后成功。改这两个文件时不要假定它们仍是 JSON 形态。

备份：`/home/tzwl3/apps/deploy-staging/spend-20260909-151419`（三份配置 + passwords 的 .env）。回滚即恢复配置后重装。

### 补记：合并上游 0.6.3 后重发 0.6.8（同日）

`dsh-spend` 的上游是 `github.com/nonewind/dsh-spend`（fork 为 `sdwhwzp/dsh-spend`）。上游 0.6.3 把用量扫描移出事件循环：`foldSession` 改为 `createSessionFolder` 的流式折叠器，`scanSessions` 先收集文件列表再按文件复用缓存（持久化到 `storages/dsh-spend-scan-cache.json`），客户端对在途刷新加了工作区变更保护。

按上游优先合并，fork 的改动适配到新结构：主体（含搜索分支）自动合并干净，5 处冲突手工解决——按用户隔离的 `compute()` 参数与作用域缓存键保留、同时采纳并行汇率与扫描缓存；搜索计数变成折叠器的闭包状态，并入样本的循环放进 `finish()`；客户端的按用户查询参数与 cwd 一同捕获，使在途请求保持单一身份；扫描段 fork 无改动，整段取上游。

版本沿 fork 线到 0.6.8（高于上游 0.6.3）。47 项自测全过；合并前后用真实日志各验一次，均为 13 个步骤 / 14 次派发 / 13 个归属到用户。健康门第 27 秒通过。备份 `/home/tzwl3/apps/deploy-staging/spend-20260909-152851`。

## 44. 2026-09-09 dsh-spend 0.6.9：按实际在用模型校准价格（30，已上线）

先从 30 的会话日志统计实际在用的 9 个模型及其用量，再逐个核对官方价格，只改有证据的部分。

### 改了什么

**`deepseek-v4-flash-vision-exp` 从 V4 Pro 改为与文本版 Flash 同价。** 知识库原注释写着"沿用 V4 Pro，直到 DeepSeek 公布独立价格"——官方已公布：视觉路由无溢价，单图最多 384 token。它恰好是本部署用量第一的模型（701 次调用、7960 万缓存读），此前一直按约 8 倍的 Pro 输入价计费。

**`deepseek-v4.1-flash-expires-on-0910` 补入同一费率**，此前落到默认价。

**Flash 系列改为两阶段峰谷表。** 2026-08-17 起引入峰谷，高峰为**每日** 9:00–12:00、14:00–18:00（北京时间）；**2026-09-10 12:00** 起闲时降至每百万 token 缓存命中 ¥0.02 / 未命中 ¥1 / 输出 ¥4（降 60% / 33.3% / 11.1%），高峰仍为 2 倍但收窄为**工作日**。原实现只有单个 `effectiveAt`、且只看小时不看星期——周末会被按高峰价多收一倍。现在 `schedule.phases` 按调用自身时间戳选表，`peakDays` 表达工作日限制。

**GLM-5.3-Flash 核对后无需改动**：促销 $0.075/$0.015/$0.25 至 2026-09-09 24:00，之后 $0.15/$0.03/$0.50，与知识库一致。

### 影响

用 30 的真实日志按改前/改后各算一遍：

| | 改前 | 改后 |
|---|---|---|
| 合计 | $9.7360（¥70.10） | $4.0235（¥28.97） |
| 其中 vision-exp | $8.5128 | $2.7887 |

即账本此前把开销**高估了约 59%**，几乎全部来自 vision-exp 一项。

### 验证

48 项自测全过。线上复核：三个 Flash 系模型工作日高峰 out=1.111111、闲时 0.555556、**周六 10 点按闲时** 0.555556；GLM 今日 0.075/0.25、明日起 0.15/0.50。健康门第 28 秒通过。备份 `/home/tzwl3/apps/deploy-staging/spend-20260909-153923`。

### 未处理

`mac-qwen/qwen3.8-27b-q4`（102 次调用）目前落到默认价，折算 $0.036。从名称与 q4 量化看应是本机推理、不产生 API 费用，但我没有据此断言，未改动；若确为本地模型，应在部署侧 `pricing` 配置中显式置 0。

### 补记：0.6.10 补齐 Kimi 与 GPT 价格（同日）

核对在用模型时发现两处：

- **`kimi-coding` 根本不在 provider 知识库里**，价表为空，`kimi-for-coding` 与 `k3-256k` 都回退到默认价（0.14/0.28，实为 DeepSeek 费率）。Kimi 官方 K3 单一档、无上下文分级，每百万 token 缓存命中 ¥2 / 未命中 ¥20 / 输出 ¥100，两个路由同价，取与既有 `moonshot.kimi-k3` 一致的折算值 2.82/0.28/14.08。
- **`gpt-5.6-sol` 记为 $5/$30**，OpenAI 开发者页现为 **$4/$0.4/$20**——输入高估 25%、输出高估 50%。Terra/Luna 与官方一致，无需改。另按用户要求补入 **GPT-6 Astra $10/$1/$50**。OpenRouter 的转售行是另一市场报价，未动。

新增一条测试：本部署日志中出现过的每个 (provider, model) 都必须解析到价格行，日后再出现空价表会直接失败而不是悄悄按默认价计费。

线上核验：Astra 10/1/50、Sol 4/0.4/20、Luna 0.2/0.02/1.2、两个 Kimi 路由 2.82/0.28/14.08。49 项自测全过，健康门第 26 秒通过。备份 `/home/tzwl3/apps/deploy-staging/spend-20260909-154626`。

### 补记：0.6.11 / 0.6.12 修正 Kimi 编程套餐的路由对应

Kimi 有两张表，套餐会路由到两张（platform.kimi.com，2026-09-09 复核）：K2.7 Code 256k 上下文 ¥1.30 / ¥6.50 / ¥27（命中/未命中/输出，每百万 token），HighSpeed 为其 2 倍 ¥2.60 / ¥13 / ¥54；K3 为 1M 上下文、无分级，¥2 / ¥20 / ¥100。

`kimi-for-coding` 与 `kimi-for-coding-highspeed` 按 K2.7 Code 标准版/高速版计价（先前误按 K3），名字里带 K3 的路由保持 K3。模型名是精确匹配，因此每个路由同时登记套餐名与官方 API id，避免换一种命名就落回默认价。HighSpeed 目前在日志中尚未出现，属预先登记。

**该对应关系是依据路由名推断的**：日志的 `request/header` 只记录 `provider` 与 `model`，没有端点或上游模型可佐证。若实际不符需按真实映射更正。

**已知未对齐**：知识库这几行原按约 7.06 折算美元，本部署汇率为 7.2，折回人民币比官方页高 1~2%（如 `kimi-for-coding` 显示 ¥6.62 对官方 ¥6.50）。金额量级无影响，若要与官方页逐分对齐，应统一改为"官方人民币 ÷ 7.2"，且需同时改 `moonshot` 的同名行以免同一模型两处不同价。

## 45. 2026-09-09 dsh-context 的预估费用改由 dsh-spend 账本计价（30，已上线）

### 原状

dsh-context 的 Context 卡片用自己**硬编码**的 DeepSeek 价表估算会话费用，且 `costFamilyOf` 只认 V4 的 flash / pro——日志里其他供应商（GLM-5.3-Flash 154 次、Kimi、GPT 等）**完全不计入**。价表里的人民币闲时价还是 9/10 前的 ¥0.05 / ¥1.5 / ¥4.5，次日中午即过期。

另发现其峰谷判定一直排除周末，而"仅工作日"是 9/10 才生效的规则；8/17–9/10 之间是每日高峰，因此那段时间的周末调用一直少算一半。9/10 起该判定才恰好正确。

### 改法

打通方向不是共享价表，而是**让账本直接给出该会话的费用**——dsh-spend 本就按会话聚合、覆盖全部模型。

- **dsh-spend 0.6.13**：新增 Remote `sessionCost({sessionId})`，返回该会话的费用、调用数、币种与按模型明细。快照获取抽成共用的 `snapshotFor`，与 `query` 走同一条缓存路径，因此 context 取数不会额外触发扫描。快照本身已按调用者过滤（`compute` 先做 `callsForPrincipal`），所以他人的会话在这里根本不存在，读出来是"未计价"而非被事后隐藏。另附 `costRatesAt` 供只需要费率表的宿主消费者使用。
- **dsh-context 0.47.0-dsh.20260909.2**：卡片经既有的 `/api` 认证通道调用 `usageStats/sessionCost`，有值即优先显示，币种随账本；提示气泡改为列出账本的按模型明细，而不再列一张已不描述该数字的本地价表。取不到时（未装 dsh-spend、无 RPC、无权读该会话）回退原有本地估算，helper 永不 reject——缺插件只降级数字，不影响视图。

### 验证

dsh-spend 51 项、dsh-context 1285 项全过，且 dsh-context 的 **100% 覆盖门**通过（新增了 `sessionSpendOf` 的成功/拒绝/异常/畸形行用例，以及卡片的账本分支、回退分支、空模型名用例）。修正了一条既有测试：卸载时序用例原本只保留最后一个 resolver，新增探测后会漏掉 canOpenPaths 的假分支，改为按端点各留一个。

线上核验：spend 0.6.13 / context 0.47.0-dsh.20260909.2，`sessionCost` 已注册为 Remote、客户端 descriptor 与 context 的调用点都在位，健康门第 27 秒通过。备份 `/home/tzwl3/apps/deploy-staging/pair-20260909-162009`。

### 固有限制

dsh-context 在折叠时就把用量分进 peak/off 桶，这条路径仍在（作为回退）。横跨 9/10 12:00 调价点的会话，其回退估算会用同一套费率算两侧的 token——除非改它的持久化投影结构。走账本时不受此限，因为账本按每次调用自身时间戳计价。

## 46. 2026-09-09 dsh-spend 悬浮球点击后组件消失（已恢复）

### 现象与证据

用户报告点击悬浮球后 dsh-spend 整个组件消失，控制台无报错。DOM 前后对比是定位的关键：

```
点击前  <div id="dsh-spend-widget"><div class="dsu-widget"><button class="dsu-pill">…</button></div></div>
点击后  <div id="dsh-spend-widget"></div>
```

容器仍在、内部子树全空。挂载效应的清理函数会把容器一并删除，容器还在即说明它没有执行；组件本身无提前 `return`，任何路径都会返回 `div.dsu-widget`。因此只可能是**渲染抛错、React 卸载了根**。药丸上当时正常显示 `¥13.33 · 54.72M`，说明数据已到位，问题出在展开分支。

### 排除过程

宿主侧健康：在线上直接构造服务调用 `queryForPrincipal`，0.2 秒返回，`callCount` 514、31 个顶层字段、`bySession` 与 `pricing` 齐全。服务端日志无相关错误。两个客户端 bundle 均可解析（非语法错误）。主题 CSS 变量由新 runtime 的 `dsh-client-ui-theme` 正常定义。计划卡的 `subscription` / `quota` 解引用、价格表的 `schedule` 读取均有兜底。`scalePriceFields` 对缺失字段有类型检查。

当日客户端实质只变过两处：上游 0.6.3 重写的 refresh 逻辑，以及新增一行 Remote descriptor。**样式一行未动。**

### 恢复

0.6.15 把 refresh 退回 fork 原版（保留全部计价成果），随后恢复正常。

**未完全证实**：恢复与一次浏览器强刷同时发生，因此不能断定上游写法是唯一成因；也未定位到其中具体哪一步导致抛错。该分歧已记入 [dsh-spend FORK.md](../../dsh-spend/FORK.md)，下次同步上游若要重新采纳，须先在灰度单独验证展开路径。

> **后续更正（2026-09-09 晚）**：退回之后同一现象再次出现，上游 refresh 写法**不是**成因。本节记录的定位结论作废，真实成因至今未定位。dsh-spend 0.6.18 已加渲染边界以在下次复现时留下证据，见 §47.4；[FORK.md](../../dsh-spend/FORK.md) §1 已同步更正。**成因已于当晚定位并修复，见 §48。**

### 期间查出并修复的两个真实缺陷（均非本次崩溃成因）

- **0.6.15**：合并上游时丢掉了 `refresh` 的 `return`。`savePricing` / `deletePricing` 依赖 `await refresh()` 才能显示改价后的快照，上游写法使该 await 立即返回、面板仍显示改价前数据。
- **0.6.16**：`scalePriceFields` 只换算 `schedule.peak/offPeak/after`，不认识 §44 新增的 `schedule.phases`。人民币面板会把其余费率换算、却把这些留在美元，**峰谷列显示值约低 7.2 倍**。账本计价不受影响——它从未换算的行计价并自行乘汇率。

### 过程中纠正的两处操作失误

- 0.6.13 的包里含有未提交的代码（`sessionCost` 等），同一版本号对应两份字节。已升 0.6.14 使部署产物对应到提交。
- 配对部署时 sed 的 `[^"]*` 匹配过头，把配置里的 `file:` 前缀一并吃掉。后续改用 JSON/正则感知的精确改写，并已修正。

### 线上最终状态

Harness 0.1.5-alpha.1 · dsh-spend 0.6.16 · dsh-context 0.47.0-dsh.20260909.2 · genui 0.9.9 · subscriptions 0.8.0-dsh.20260909.1 · dsh-passwords 2.6.28；gateway 200 / web 401。

### 教训

同一天对同一插件连发七版（0.6.8 → 0.6.16），其中多版是在没有根因的情况下推进的。**客户端渲染类问题应先取到浏览器控制台的组件栈再动手**——本次直到最后也没拿到，只能靠回退定位，且因与强刷同时发生而未能完全证实。下次遇到类似现象，第一步是让用户先开控制台并勾选 Preserve log，再复现。

## 47. 2026-09-09 计量覆盖修复与 Harness 0.1.5-alpha.2（30，已上线）

用户发现 dsh-spend 与 dsh-context 只记录到 `deepseek-official/deepseek-v4.1-flash-expires-on-0910` 一个模型，另外两个在用模型完全没有账。追下去是三条互相独立的缺陷，跨 harness 和插件两侧，一并修掉后重新出版本部署。

### 47.1 扫描器读错了会话代次（dsh-spend 0.6.17）

扫描器按固定文件名打开 `session.jsonl.zstd`。会话格式迁移遵循"相邻迁移"：新增一个以版本命名的后继文件，从不改写前代。因此当天迁到 v3 的会话仍在用出生时那一代回答，而迁移之后新建的会话根本没有这个文件名、整个消失。

线上实测：扫描只看到 87 个会话中的 49 个、1306 个采样中的 514 个。改为按目录挑选**最新代次**（`/^session(?:\.v(\d+))?\.jsonl\.zstd$/`，取版本号最大者）后全部纳入。

### 47.2 委派出去的调用无人认领（dsh-spend 0.6.17）

子会话自己的 turn 不记录 principal，所以 workflow 交给 subagent 的每一次调用都无主：发起人看不到，也不进按账号的计量；而同样的活儿留在父会话里则正常计费。改为沿 `parentSession` 链上溯到最近一个记录了 principal 的祖先，1306 个采样里有 662 个由此归属。继承来的归属打 `principalInherited: true` 标记，消费者可与实录归属区分；父会话本次扫描没见到的，保持无主而不是就近攀附。

流式折叠路径自建会话元数据、不走 `metaOf`，所以 `parentSession` 在两处都要带上。

### 47.3 委派链上根本没有传 owner（Harness 0.1.5-alpha.2）

上面两条修完仍有缺口：workflow 派生的子会话，其 turn 里**本来就没有** principal 可记。归属是这个 fork 用来做计量、按账号预算和会话可见性的依据，所以委派出去的活儿既不计费也不对发起人显示。触发这次排查的那次分析，48 次模型调用里有 42 次是委派出去的。

委派工具原本已经把 `exec.principal` 传给 `subagents.start`，`SubagentStartRequest.principal` 也已文档化为会持久化到子会话的 prompt 上。所以这次只是把这一个字段穿过 workflow 这条路：工具填入 → 引擎为整个 run 持有 → 每次 start 传下去。run 本身无 owner 时，子会话保持无主，不做替代。

改动落在 `packages/workflow/tool-workflow/src/index.ts`、`workflow-worker-thread/src/host.ts`、`workflow/src/runtime-types.ts`（提交 `26c05e7942`）。

### 47.4 渲染失败不再吞掉整个组件（dsh-spend 0.6.18）

§46 那次"点击后消失"最终没能拿到证据，原因是渲染抛错卸载了 React 根，容器变空、控制台什么也不剩，服务端也复现不了。0.6.18 加了边界：把错误信息和组件栈就地渲染出来，附重载按钮。下次再犯，现象自己会报告自己。（它随后确实报告了——见 §48。）

### 47.5 部署记录

发布 `20260909-201921-34810ad-alpha2`（dsh 家族 0.1.5-alpha.2，提交 `34810adae9`）。三条线齐发：runtime 270 个 tarball、plugins（从 alpha1 复制 `artifacts` 与 `dsh-passwords`）、web。切换 27 秒通过健康门，`gateway 200 / web 401`，pm2 零重启，切换后错误日志为空。

线上版本：Harness 0.1.5-alpha.2 · dsh-spend 0.6.18 · dsh-context 0.47.0-dsh.20260909.2 · dsh-passwords 2.6.28 · dsh-better-sidebar 0.18.1 · dsh-at-file 0.7.3 · dsh-sidebar-vscode 0.2.8-dsh.20260909.9。备份 profile `/home/tzwl3/.dsh/profiles/web-pre-20260909-204246`。

### 47.6 第一次切换失败：6 分钟中断

第一次切换未通过健康门，**且自动回滚也没能恢复服务**，生产中断约 6 分钟。两个独立缺陷：

**候选 profile 缺 `dsh-passwords/.env`。** `.env` 不在包里，是部署时单独放进 profile 的 `node_modules` 的。候选漏了这一步，插件报 `SETUP_KEY 未配置：请先运行安装脚本或手动配置 .env` 而不激活，于是它提供的 `requestPrincipal` 和 `managedUserWorkspace` 缺失，`dsh-nas-webdav` 永远 pending，启动以 `1 entry did not activate` 失败。切换前的预检只验了 **plugins release 里**的 `.env`，没验**候选 profile 里安装好的那一份**——两者是不同的文件。

**回滚用了 `bin.js` 而不是 shim。** 回滚脚本按 0.1.3 时代的写法，直接以 `current/node_modules/@deepseek-ai/dsh/lib/bin.js` 注册 pm2。但回滚目标 alpha1 已经是 0.1.5，`bin.js` 末尾的 `import.meta.main` 守卫在 pm2 fork 模式下恒为假，进程起来但 CLI 永不启动——pm2 显示 online、端口无监听。所以是一次本该 15 秒的失败切换，变成了 6 分钟中断。手工用 shim 重启后 14 秒恢复。

**另有一条后遗**：失败那轮里候选被改名为 `web`，app-boot 在它的 `.dsh-module-fallback` 里新增了一条**绝对路径**指向 `/profiles/web/...`；回滚改回名后这条链接失效。重试前须扫一遍候选 fallback 里指向 `/profiles/web/` 的绝对链接并改写。

### 47.7 切换脚本的加固（`cutover015e.sh`）

- **预检加两道**：候选 profile 内安装好的 `dsh-passwords/.env` 存在且含非空 `SETUP_KEY`；候选 `.dsh-module-fallback` 断链数为 0（`find -xtype l`）。任一不满足直接拒绝切换，不动线上。
- **回滚同样经 shim 启动**。shim 本就是双版本兼容的（有 `runCli` 就调用，没有则 import 即已启动），回滚路径没有任何理由绕开它。
- **失败时先抓日志再回滚**：回滚会覆盖 pm2 日志的后续内容，所以在停服务之前先 `tail` 一段错误日志并打印出来。

### 47.8 教训

发布前的检查项要**验最终生效的那份文件**，不要验它的来源。`.env` 在 release 目录里齐全，不代表它已经进了候选 profile 安装出来的包目录——这次正是死在这个差别上。

回滚路径必须和正常路径走同一套启动方式。回滚代码平时不执行，一旦执行就是在故障中执行；它落后于正常路径一个版本这件事，只有在最坏的时刻才会暴露。

## 48. 2026-09-09 dsh-spend 悬浮球点击消失：定位与修复（0.6.19 / 0.6.20，30，已上线）

### 48.1 证据是怎么拿到的

§46 的边界把错误渲染在页面上、也打到浏览器控制台，但三轮转述回来的都只有组件栈最后一帧 `at WidgetBoundary`，没有错误信息本身。0.6.19 新增 Remote `usageStats/reportRenderFailure`：边界捕获后把 message、stack、componentStack 一并回传服务端，写进 pm2 错误日志。要求已登录调用者；上报尽力而为、失败不覆盖原错误；各字段截断（message 400、stack/componentStack 2000）。用户复现一次后，日志里立刻有了：

```
[dsh-spend] 浏览器渲染失败 account=dsh-passwords:1
  message: Cannot read properties of null (reading 'fetchedAt')
  componentStack: at PlansSection …
```

### 48.2 根因

`PlansSection` 渲染 code 型计划卡时，**急切**构造了两段只在有实时用量时才展示的内容：`liveBody`（含 `providerUsage.fetchedAt`）和 `liveErrorNote`（含 `providerUsage.error`）。二者的消费处早已按 `showLive` / `liveFailed` 门控，但构造本身没有——而 `providerUsage` 在服务端没有该 provider 用量适配器时就是 `null`。第一次读 `.fetchedAt` 抛错，React 卸载整个根，容器留空。

药丸与悬浮预览读同一行数据却都走了 `?? null` 的安全路径，所以"药丸正常、一点就没"。

这是上游 `e3534f1`（2026-08-25，订阅商实时额度）带来的潜伏缺陷，触发条件是**存在一个 provider 无用量适配器的 code 型计划**。线上没有显式配置 `plans`，计划按用量里出现的 provider 自动发现；`kimi-coding` 被自动归为 code 型（§44 当天加入的路由），而它没有适配器。且线上只有账号 1 有 Kimi 调用——所以只有该账号的快照里有这张卡、只有它点开会崩。这也解释了 §46 为什么"退回 refresh 后恢复"是错觉：与 refresh 无关，取决于点开时快照里有没有这张卡。

### 48.3 修复（0.6.20）

`liveBody` 与 `liveErrorNote` 只在其描述的载荷存在时构造。

回归测试 `test/widget.test.js` 用一个最小 React（顺序 hook 槽、按依赖比较的 effect/callback、带 `getDerivedStateFromError`/`componentDidCatch` 的类边界）真正执行 `lib/client.js`：挂载 → 拿到快照 → 点击药丸 → 展开面板。用一张无 `providerUsage` 的 code 计划卡驱动，**在修复前的客户端上失败、修复后通过**；第二条用例证明边界把失败留在原位并上报服务端。此前的客户端测试用的 `jsx` 桩只返回 `{type, props}`、不执行函数组件，所以覆盖不到展开路径。

### 48.4 部署

0.6.19、0.6.20 均以配对脚本单插件部署（备份 `deploy-staging/spend19-*`、`spend20-*`），各 27 秒过健康门。线上核验：0.6.20，两处守卫在位，重启后无新的渲染失败上报。

### 48.5 教训

客户端渲染类故障，第一步不是猜、也不是让用户转述控制台——是**让错误自己走到服务端日志**。这次从"拿到证据"到"定位"用了两分钟，此前没有证据时消耗了一整天和七个版本。

只在某个条件下才展示的内容，构造也要放在那个条件里。"消费处有门控"不等于安全。

## 49. 2026-09-09 侧栏 @ 选文件提交失败、workflow 429 限流（30，已上线）

### 49.1 `slash: no serializer for reference source "reference"`

**现象**：dsh-better-sidebar 里点文件插入 `@` 芯片后，发送被拒，控制台报上面这句。

**根因**：侧栏是上游仓库（omdsh-dev），按宿主约定用名字 `reference` 指代 `@` 文件源（宿主的 `dsh-client-ui-reference` 就叫这个名）。本 fork 的 `dsh-at-file` 用 `cordis.patch.yml` 禁用了宿主源、顶替成自己的 `@` 源，却以 `at-file` 之名注册、且无 codec。提交时 `ui-input-trigger` 按 `reference` 在 roster 里找不到带 codec 的归属，整条提交被拒（设计如此：不静默降级为剪贴板文本）。

**修复（dsh-at-file 0.7.4，`878531c`）**：按"上游优先、我们做适配"不改侧栏，让顶替者顶替完整——源名改为 `reference`，并提供 codec（芯片的 `ref` 即 `@path`，原样进模型，与手工键入走同一条服务端解析）。设置/文案命名空间仍是 `at-file`。178 项测试通过，新增两条断言源名与 codec。单插件配对部署，27 秒过门；线上产物 `"reference"` 1 处（源名）、`"at-file"` 3 处（命名空间）。

### 49.2 workflow 并发子代理撞 429 后全部失败

**证据**：zhouqiaorong 8 月工作区那次分析，28 个会话文件里 33 条 `llm/retry`，全是 `RATE_LIMIT`，`maxRetries=5`，其中 5 条会话打到第 5 次后放弃——6 个并发子代理里 5 个死于限流。默认策略 5 次 / 0.5s 起 / 封顶 10s，总等待约 15 秒，6 路同时重试根本不够。

两处都改：

**加长退避（热加载，无需重启）**：`/home/tzwl3/.dsh/settings.yaml` 给 `llm-deepseek:` 顶层与 `llm-pi-ai.providers.{mac-qwen,zai,kimi-coding}` 各加

```yaml
retryPolicy:
  mode: normal
  maxRetries: 8
  backoff: { initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0.3 }
```

总等待约两分钟；抖动 0.3 让并发调用者错开；封顶 30s 也让提供方的 `Retry-After` 在 30s 内被接受而非（默认 10s 上限下）直接放弃。`llm-deepseek` 的 `retryPolicy` 变更会触发 `registration.replace`，settings 文件热加载即生效。备份 `deploy-staging/settings-pre-retry-20260909-211412.yaml`。

**压并发（需重启）**：引擎 `@deepseek-ai/dsh-workflow-worker-thread` 有 `maxConcurrentAgents`，默认 `min(16, 核数-2)`，30 是 12 核即 10 路。web 模式下该引擎不在宿主树，而在**每会话的 agent preset** 里（随附 preset `standard/ptc/cordis`）。不改仓库里的随附文件，用文档化的部署口子：把随附 preset 复制为 `/home/tzwl3/.dsh/presets-30/`，三个带引擎的 preset 设 `maxConcurrentAgents: 3`，profile `cordis.patch.yml` 追加

```yaml
- id: agent-presets
  config:
    default: standard
    includeShippedRoot: false
    roots:
      - path: /home/tzwl3/.dsh/presets-30
        trust: system
```

`config` 是整段替换，所以 `default` 必须重述。重启 27 秒过门；用线上安装包自己的 `scanRoot` 对新 root 扫描：4 个 preset 全部发现、无 `broken`、含 `standard`。备份 `deploy-staging/presets30-20260909-211718/`。

**升级时必须做的事**：`presets-30` 是随附 preset 的副本，**Harness 升级后要用新随附 preset 重做副本并重新打上 `maxConcurrentAgents`**，否则 preset 会停在旧版本。把这一步加进 §7.5/§42 的发布步骤。

### 49.3 未处理

`tool-workflow/*` 事件无 `surfaceOp`，workflow 跑动期间界面无任何进度（用户看到"没有反应"的另一半原因）。已在 §50 处理。

## 50. 2026-09-09 workflow 跑动期间"看不出在动"（2026-09-10 已上线）

### 50.1 先排除了什么

用户报"分析完毕后没有结果，刷新才出现"。先怀疑事件没送到浏览器，逐层排除：

- **卡片折叠与渲染**：把那次真实的 21 条事件按浏览器实时路径（`append` + `flush`）逐条重放，六个子会话置为运行态，全程无错，最终状态正确（5 失败 + 1 取消）。
- **实时线解码**：同一批事件过 `assertSessionWireEvent`（浏览器收到每条实时事件都要过这道），无一被拒。
- **fork 的 web 层**：`@linxin666/dsh-web-all` 未替换会话视图、未注册 `conversation.chat.node` 槽。
- **服务端录制**：`tool-workflow: disabled durable record` 告警数为 0。

用户随后确认：**卡片当时出现过，历史里也在**。所以不是传输问题。

### 50.2 真正的原因

事件时间线自己说明了问题：

```
18:53:39  run-start + 6 条 agent-start   ← 六个成员同时启动
18:54:06  第一条 agent-end               ← 27 秒空白
18:57:11  最后一条 agent-end + run-end   ← 又一段 150 秒空白，用户已中止
```

成员卡在提供方限流退避里时**不写任何日志**。节点上每个可见事实——名称、成员名、状态文字、状态点——在这几分钟里全部不变。界面与卡死无法区分，用户只能中止。§49.2 把退避加长到约两分钟后，这段"静默期"只会更长，所以这条必须一并解决。

### 50.3 改动（`@deepseek-ai/dsh-client-ui-workflow-run`）

运行中的成员显示自其启动事件以来的**已用时间**；浏览器可打开的运行中成员另显示"查看 ›"提示。

- 计时器**仅在存在运行中成员时**启动，settled 的节点不排任何定时器（有用例断言 `vi.getTimerCount() === 0`）。
- 两处提示都不进入可访问名称，可访问名称仍由状态承担。
- 成员状态新增 `startedAt`，取自其 start 事件的 `time`——折叠时本就拿得到，此前丢弃了。

### 50.4 测试

新增 `tests/replay.client.spec.tsx`：用**那次真实发布运行**（已脱敏到只剩结构与时序）驱动节点与面板，走浏览器的实时 `append` 路径，断言已用时间在静默期里从 `1 秒` → `45 秒` → `1 分 30 秒` 推进，且 settled 后无残留定时器。

夹具脱敏：只保留事件类型、seq、time 与 `tool-workflow/*` 的原始载荷（runId/childId 是 uuid，label 是 `p1_recv` 一类通用名）；工具脚本、客户工作区路径、模型推理文本全部替换为 `<redacted>`，并断言产物中不含 `/home/`、`tzwl`、地名等串。

### 50.5 发布状态

改动提交 `b280c625b3`、`f80700a6cb` 已包含在 §51 的 Harness 提交 `bf3afe0077`，于 2026-09-10 随完整工作区发布到 30。发布使用独立 release 路径及 tarball SHA256；未覆盖旧 release 或发布 npm 同名版本。

### 50.6 过程中发现的两个环境问题

- **本机 Node 版本不符**：仓库要求 `^22.19 || >=24`，当前 shell 是 22.16。用 22.16 跑构建会得到误导性的 `tsdown: no packages/*/*/package.json declares the name …`（unrun 把配置搬到 `node_modules/.unrun/` 后 `../..` 不再是仓库根）。`nvm` 里已装 22.21.1，**pre-push 与本地构建必须切到它**（手册 §"Run relevant checks locally" 早有此要求）。
- **vitest 不做类型检查**：`startedAt` 在测试夹具里漏填了 23 处，`vitest run` 全绿，只有 `pnpm run typecheck`（pre-push 门禁）才报出来。改动数据类型后，**跑测试不等于跑通**。

## 51. 2026-09-10 源仓库同步及服务器 30 发布（已上线）

按用户指示更新本体和在用 DSH 插件，排除 `dsh-weknora`。源实现合并进各仓库当前分支后完成适配，所有本地分支的提交均已存在于自有 fork；再次 fetch 确认 11 个仓库均无缺失的源分支提交。原作者地址只读，上传目标均为已核实的 `sdwhwzp` fork。`dsh-spend/main` 的远端领先本地且包含本地提交，保留该远端历史；其当前部署分支也已包含远端 main。

### 51.1 版本与发布位置

| 项目 | 30 上的版本 / 源提交 |
| --- | --- |
| Harness | `0.1.5-alpha.2` / `bf3afe0077` |
| dsh-web 全家族 | `0.3.19` / `5f3d841e` |
| dsh-passwords | `2.6.29` / `037a6a80` |
| dsh-context | `0.48.0` / `7c365e17` |
| dsh-spend | `0.6.20` / `13cc4cfc` |
| dsh-better-sidebar | `0.19.0-alpha.1` / `77c34e57` |
| dsh-genui | `0.9.9` / `9e83edf8` |
| dsh-at-file | `0.7.4` |
| dsh-plugin-subscriptions | `0.8.0-dsh.20260909.1` |
| dsh-sidebar-vscode | `0.2.8-dsh.20260909.9` |
| super-injector / graded-mode | `0.3.3-dsh.20260908.2` / `0.0.1-dsh.20260908.1` |
| dsh-weknora | 保留 `0.1.2` |

发布目录名为 `20260910-071200-bf3afe-alpha2`，三个 `/home/tzwl3/apps/dsh-{runtime,web,plugins}/current` 指向各自同名 release。共装配 275 个 Harness / vendor 包、21 个 Web 包及 10 个插件包，Profile 保留 17 个 bundle。`dsh-spend` 和 `dsh-context` 工作区另有未提交费用展示改动，本次保留且排除；这两个部署包从上述已提交快照单独构建，并使用带提交号的文件名。

安装后恢复 Profile 内 `dsh-passwords/.env`，数据库仍为 `192.168.10.73`。模块链接按新安装包的实际名称解析，切换前后断链均为 0。随附预设复制到 `/home/tzwl3/.dsh/presets-30-20260910-071200-bf3afe-alpha2`，三个 workflow 预设均设置 `maxConcurrentAgents: 3`，Profile 指向这个新目录。旧预设保留。

SSH 使用用户提供的 `wh.gr-iot.cn:6022`，主机密钥与原 `.30` 一致。用户随后确认访问 `http://wh.gr-iot.cn:3081/`；浏览器实际显示 `0.1.5-alpha.2-bf3afe0`，确认该公网入口已提供本次 30 构建。旧迁移记录中公网 3081 仍指向 28 的描述不再代表当前状态。本次未变更网络转发。

### 51.2 验证

源码检查涵盖本体的相关行为测试、Session / 持久化 987 项、交付工具 32 项、工作流 / 子代理 UI 28 项、选定录制快照、Host / Client 类型检查、lint、34 个文档 gate、构建、受影响 hygiene gate 和正式打包。Web 全家族 3825 项测试通过、9 项跳过，脚本 282 项、desktop 19 项及类型、构建、文档等门禁通过。密码门全套测试后修正两个版本约束问题，并通过对应 20 项更新测试和 5 项 SSH 网关测试；最终构建通过。详细命令日志在部署导出记录中，不将这些结果视为全平台 CI 或真实模型端到端验收。

独立复制 Profile 到隔离 home，使用 SQLite 临时库和 `38080–38082` 端口排演；排演禁用 NAS，未读取生产会话数据。配置组合成功，应用和网关就绪，启动错误数为 0。正式切换后保留生产 NAS 配置和 MariaDB。

2026-09-10 07:29:12 切换，07:29:47 健康门通过，随后稳定观察 60 秒并保存 PM2。Host PID `1727560`，重启次数 `0`。验证结果：网关健康 200、Host 未认证访问 401、登录页 200、内部健康接口未认证访问 403；带现有内部密钥的健康接口确认数据库、应用首页、工作区列表和会话列表均就绪。3 个账号保留，新增 `user_permissions.allow_ssh` 和 `ssh_host_owners` 已存在。切换前记录的 195 个会话文件全部保留且未缩短；这不代替逐条会话内容或人工登录界面验收。

### 51.3 回滚记录

旧 release 为 `20260909-201921-34810ad-alpha2`；旧 Profile 完整保存在 `/home/tzwl3/.dsh/profiles/web-before-20260910-071200-bf3afe-alpha2`。发布记录目录为 `/home/tzwl3/apps/deploy-staging/20260910-071200-bf3afe-alpha2`，包含切换前链接与配置摘要、PM2 状态、共享模块链接备份，以及 13 张 InnoDB 表 / 173 行的一致性数据库快照 `database-before.sql.gz`（权限 600）。数据库备份只保留在服务器，未上传 Git。

恢复代码时先保存切换后配置和新增数据，再停止本次服务、恢复旧 Profile 和三个旧 release 链接，仍通过 `/home/tzwl3/apps/dsh-runtime/dsh-cli-entry.mjs` 启动。不得因回退代码而删除 SSH 权限表、会话后继或用户工作区；数据库恢复是独立操作，不能直接覆盖上线后的数据。未改动 28，也未进行 npm / tag 发布。

### 51.4 alpha.2 新功能在当前插件组合中的入口

浏览器确认本次构建号后，检查会话文件入口、右侧栏和命令菜单：本体 `ui-sidebar-documentpreview`、`ui-deliverables`、`ui-message-feedback`、`command-feedback` 均在最终组合中，没有禁用。

`dsh-better-sidebar` 以 `extension` 优先级认领全部 `dsh-resource://file/**`，高于本体文档预览的 `fallback`；因此点击会话文件进入插件的编辑 / 文件查看器，界面不会显示本体新的 Markdown、代码、HTML、PDF、图片预览工具栏。插件还以优先级 `-1` 接管有产出文件的 turn-tail 区域；VSCode 插件启用默认打开时使用 `-2`。这属于插件组合的行为，不能仅凭主程序版本号认定本体界面已可见。恢复本体预览时需同时保留业务正在使用的 Excel / Office 查看器，不能直接禁用整个侧栏插件。

本体显式交付卡片来自 `present` 工具；新版 `standard`、`ptc`、`cordis` 预设均包含该工具。旧会话仅写文件名或通过 Bash 创建文件而没有 `present` 记录，不会自动生成新的显式交付卡片。

`/feedback` 的 Host 描述带 `<text>` 参数提示，命令菜单在消息中间过滤带参数提示的命令；已有草稿、光标在其后的菜单会只显示适合当前位置的条目。在消息开头调用 `/feedback` 才能选择其反馈弹窗入口。浏览器检查未提交反馈，也未发送模型任务。
