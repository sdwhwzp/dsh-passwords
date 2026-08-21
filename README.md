# dsh-passwords

[English](README_en.md) | 简体中文

`dsh-passwords` 是 DeepSeek Harness（dsh）的认证和访问控制层，提供登录、账号管理、工作区与会话授权、沙盒限制以及用量控制。

支持两种部署方式：

- 已有 dsh 环境：使用 npm 安装插件。
- 没有 dsh 环境：使用 Docker 镜像，镜像内包含 dsh `0.1.0-rc.8` 和 dsh-passwords。

纯本机使用 dsh 时不需要安装本项目。

## 功能

### 远程访问

- 登录页和首次配置页
- Cookie 会话默认保持 12 小时
- npm 部署支持自动 HTTPS、证书申请和续期
- 登录界面跟随 dsh 的主题和语言设置
- 登录后可以远程使用 dsh 设置
- dsh 升级后可以从设置页重新加载远程设置补丁

### 账号管理

- 第一个创建的账号是主用户，之后创建的账号是子用户
- 主用户可以创建、删除和管理子用户
- 用户可以修改自己的用户名和密码，主用户可以管理所有账号
- 改密和改名后，相关旧会话立即失效
- 登录成功、登录失败和管理操作写入审计日志

### 权限与配额

主用户可以为每个子用户配置：

- 工作区和活动会话访问权限
- 会话与消息可见范围
- 每小时 token 上限
- 每日使用时长上限
- 沙盒级别
- 上传和 git 下载权限
- 账号封禁状态

子用户只能访问已授权的工作区和会话。子用户消息默认发送给主用户，广播消息由主用户显式启用。

### 协作

设置页和 dsh 界面提供账号间的聊天与留言功能，支持议题、拉取请求、讨论、公告和问题等标签。每个账号都可以单独隐藏聊天入口。

## 快速开始

### 前置条件

根据部署方式准备环境：

- npm 部署：Node.js 22.5+、npm，以及已经安装并能正常运行的 dsh。
- Docker 部署：Docker Engine 或 Docker Desktop，以及一个可用的 DeepSeek API key。宿主机不需要安装 Node.js 或 dsh。
- 生产环境：一个自己的域名，或 `<公网IP>.sslip.io`。如果使用 nginx 或 Caddy 反向代理，需要让公网 80/443 到达反代服务。

### npm 安装

适用于已经安装 dsh 的宿主机：

```bash
npm install -g dsh-passwords
dsh-passwords install
```

安装器会检查 dsh、pnpm 和预构建产物，生成配置，注册 `dsh-passwords` 到 dsh web profile，并应用远程设置补丁。npm 包已经包含 `dist/`，正常安装不需要本地编译。

查看版本或手动启动网关：

```bash
dsh-passwords --version
dsh-passwords serve-gateway
```

正常使用时，安装完成后启动 dsh web 即可。

### Docker 安装

Docker 镜像名为 `skywalker237234/dsh-passwords`，省略标签时默认使用 `latest`。先创建 `.env`：

```env
DEEPSEEK_API_KEY=your-deepseek-api-key
```

启动容器：

```bash
docker run -d \
  --name dsh-passwords \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:3088:3088 \
  -v dsh-home:/data/dsh \
  -v dsh-passwords-state:/data/dsh-passwords \
  skywalker237234/dsh-passwords
```

容器内的 dsh web 服务监听 `3080`，密码门监听 `3088`。宿主机只暴露 `127.0.0.1:3088`，公网访问应由 nginx 或 Caddy 终结 TLS 后反代到该地址。

持久化目录说明：

- `dsh-home` 保存 dsh profile、依赖和插件配置。
- `dsh-passwords-state` 保存 `.env`、SQLite 数据库、证书和初始化状态。

不要删除这两个卷，否则会丢失 dsh 配置、账号、数据库或密钥。

### 首次配置

Docker 部署读取一次性配置密钥：

```bash
docker exec dsh-passwords cat /data/dsh-passwords/setup-key.txt
```

npm 部署的密钥位于安装目录的 `setup-key.txt`。打开反代后的 HTTPS 地址，输入 `SETUP_KEY` 创建主用户。初始化成功后，`setup-key.txt` 会自动删除。

## 反向代理

Docker 部署默认由 nginx 或 Caddy 处理 80/443，网关只监听宿主机回环地址：

```text
HTTPS 443 -> nginx/Caddy -> http://127.0.0.1:3088 -> http://127.0.0.1:3080
```

nginx 配置至少需要支持 WebSocket、SSE 和长连接：

```nginx
location / {
    proxy_pass http://127.0.0.1:3088;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

同时在 nginx 或 Caddy 中配置 HTTP 到 HTTPS 的跳转，并在系统防火墙和云安全组中放行 80、443。不要把 Docker 管理端口、dsh RPC 或网关管理端口暴露到公网。

## 自动 HTTPS

npm 部署默认由网关管理 HTTPS：

- 自动探测公网 IP，并为 `<IP>.sslip.io` 申请 Let's Encrypt 证书。
- 证书有效期为 90 天，到期前自动续期。
- 使用自有域名时，在 `.env` 中设置 `MCP_GATEWAY_DOMAIN`，并将域名解析到服务器。
- 首次签发失败时不会自动降级为明文 HTTP。

Docker 部署使用 nginx 或 Caddy 终结 TLS，容器内保持 HTTP 模式，不要同时启用两套 HTTPS 终结逻辑。

| 错误码 | 含义 | 处理方式 |
|---|---|---|
| `30` | 证书签发失败 | 检查 80/443、防火墙、安全组、DNS 和 Let's Encrypt 连通性 |
| `31` | 无法确定公网 IP 或域名 | 配置 `MCP_GATEWAY_DOMAIN`，或改用反向代理 |
| `32` | 端口被占用 | 释放端口或修改 `MCP_GATEWAY_PORT` |

`sslip.io` 用于让证书域名与访问地址匹配。直接使用裸 IP 访问 HTTPS 可能出现主机名不匹配，应使用 `<公网IP>.sslip.io` 或自有域名。

## HTTP 模式

HTTP 只适用于明确接受明文传输风险的内网环境：

```bash
node scripts/start-http.mjs 8080
```

公网部署不要使用 HTTP。明文模式下密码和会话 Cookie 可能被网络中间人读取。

## 设置页

登录 dsh 后打开 **设置 → 插件**，可以使用 `dsh-passwords` 卡片：

| 功能 | 权限 | 说明 |
|---|---|---|
| 远程设置与补丁重载 | 所有登录用户 | dsh 升级后重新应用设置补丁 |
| 修改密码 | 本人；主用户可管理所有人 | 修改后旧会话失效 |
| 修改用户名 | 本人；主用户可管理所有人 | 修改后使用新用户名登录 |
| 子用户管理 | 主用户 | 创建和删除子用户 |
| 子用户权限 | 主用户 | 配置工作区、会话、配额、沙盒、上传、git 下载和封禁 |
| 聊天与留言 | 所有登录用户 | 支持标签和账号级显示开关 |

密码至少 12 位，并同时包含大写字母、小写字母、数字和符号。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SETUP_KEY` | 安装器生成 | 首次创建主用户的密钥；初始化成功后自动轮换 |
| `MCP_JWT_SECRET` | 首次配置前由 `SETUP_KEY` 派生 | 会话签名密钥；手动更换会使现有会话失效 |
| `MCP_INTERNAL_SECRET` | 首次配置时生成 | 内部请求认证密钥 |
| `MCP_DB_ENC_KEY` | 安装器生成 | SQLite 敏感字段加密密钥，不能更换 |
| `MCP_DB_PATH` | `./data/platform.db` | SQLite 数据库路径 |
| `MCP_GATEWAY_HOST` | `0.0.0.0` | 网关监听地址 |
| `MCP_GATEWAY_PORT` | `8080` | 网关监听端口 |
| `MCP_GATEWAY_UPSTREAM` | `http://127.0.0.1:3080` | dsh web 上游地址 |
| `MCP_GATEWAY_DOMAIN` | 空 | 自有域名；npm 自动 HTTPS 使用此域名 |
| `MCP_GATEWAY_AUTO_TLS` | 开启 | Docker 反代模式设为 `0` |
| `MCP_GATEWAY_REDIRECT_PORT` | `80` | ACME 验证和 HTTP 跳转端口 |
| `MCP_GATEWAY_PUBLIC_HOST` | 空 | 固定公网主机名，防止 Host 头反射 |
| `MCP_DSH_ROOT` | 自动探测 | dsh 安装目录 |
| `MCP_DSH_RESTART_SERVICE` | `dsh-web` | 补丁重载后的 systemd 服务名；留空表示不自动重启 |
| `DSH_PASSWORDS_ENV_FILE` | 空 | 指定 `.env` 文件路径 |

Docker 镜像会自动设置 Docker 运行所需的内部路径和端口。除 `DEEPSEEK_API_KEY`、公网主机名或反代场景外，通常不需要额外环境变量。

## 常用命令

宿主机 npm 部署：

```bash
dsh-passwords audit --limit 20
dsh-passwords patch status
dsh-passwords patch
dsh-passwords serve-gateway --port 9000
```

Docker 部署：

```bash
docker ps --filter name=dsh-passwords
docker logs dsh-passwords --tail 100
docker restart dsh-passwords
docker exec dsh-passwords cat /data/dsh-passwords/setup-key.txt
```

## 常见问题

- **登录页仍显示首次配置**：数据库中没有主用户，按页面提示重新输入 `SETUP_KEY`。
- **忘记主用户密码**：停止服务并备份数据库与 `.env` 后清空用户表，再重新进行首次配置。不要直接删除持久化卷。
- **Docker 容器启动后无法访问**：先检查 `docker logs dsh-passwords`，再检查 `127.0.0.1:3088`、nginx/Caddy 配置以及 80/443 防火墙规则。
- **反代后页面加载不完整或聊天断开**：确认反代已启用 HTTP/1.1、WebSocket、SSE，并关闭响应缓冲。
- **dsh 报 `duplicate loader entry id`**：不要用 `dsh plugin add` 重排整个 profile。重新运行 `dsh-passwords install`，让注册脚本只追加 dsh-passwords 条目。
- **npm 安装 dsh 时出现 `allow-scripts` 或 `node-pty` 错误**：这是 dsh 依赖的原生构建限制，不是 dsh-passwords 的依赖。按 dsh 的安装说明放行对应脚本后重新安装。
- **设置页异常**：在设置卡片中执行补丁重载；如果仍然异常，运行 `dsh-passwords patch` 后重启 dsh web。
- **想修改 `MCP_DB_ENC_KEY`**：不要修改。该密钥一旦用于数据库，替换后历史数据无法解密，备份数据库时必须同时备份 `.env`。

## 安全与隐私

密码只以 bcrypt 哈希保存。用户名、IP 和审计详情中的敏感字段使用数据库密钥加密。密钥保存在 `.env` 或 Docker 持久化卷中，请限制文件访问权限。

- 连续登录失败会触发按账号和 IP 的退避与节流。
- 登出、改密和改名会吊销相关会话。
- 子用户不能访问未授权的工作区和会话。
- dsh-ssh、skin-center、modlens、dsh-uploads 等运维端点按账号权限隔离；新子用户默认禁用 git 下载。
- 网关对慢连接、并发连接和路径归一化进行防护。
- 不要提交 `.env`、数据库文件、DeepSeek API key、Docker 凭据或 `setup-key.txt`。

## 语言

- 登录页和首次配置页跟随 dsh 语言或浏览器语言，也可以在页面中切换中文和 English。
- 设置页卡片跟随 dsh 的语言设置。
- CLI 根据 `LANG`、`LC_ALL` 或 `LC_MESSAGES` 环境变量选择语言。

## 版本兼容

当前发布版本为 `dsh-passwords 2.6.0`，目标 dsh 版本为 `0.1.0-rc.8`。客户端槽位注册包含 keyed slot 所需的 `options.key`，可兼容 dsh `0.1.0-rc.6` 及更高版本，但建议使用 rc.8 以保持依赖和 profile 布局一致。

npm 包包含预构建的 `dist/`、TypeScript 源码、安装与注册脚本、Docker 文件、`cordis.yml`、README 和许可证。Docker 镜像使用与 npm `2.6.0` 一致的 `src/`、`dist/` 和 `scripts/`。

## License

本项目采用 GPLv3，详见 [LICENSE](LICENSE)。

本项目是 dsh 的独立扩展，与 DeepSeek 没有隶属关系。dsh 本身按其项目许可证授权。
