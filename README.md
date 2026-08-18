# dsh-passwords

[English](README_en.md) | 简体中文

给 DeepSeek Harness（dsh）加一层**服务器级网关**，把它从「本地单机工具」升级成能多人远程使用的**多租户平台**。

dsh 自带的网页界面没有登录、没有权限、没有用量控制——放到服务器上，任何拿到地址的人都能用，还会白白消耗你的模型额度。dsh-passwords 在 dsh 前面挡一层网关：没登录先看登录页；登录后按账号身份做**权限与配额控制**。安装只需一条命令，**无需任何额外配置**即可开箱即用。

> **一句话定位：dsh-passwords = 让 dsh 真正变成服务器产品的那一层。** 企业内部分发、API 中转站给客户开子账号、团队共享一台服务器，都是它的目标场景。纯本地单机用 dsh 不需要它；但只要访问地址不是 localhost，先装它。

🏅 已收录于 [Awesome DeepSeek Harness](https://github.com/0xsline/awesome-deepseek-harness) 生态索引（Infrastructure & Development）与 [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 插件精选列表（Development & Runtime）。

## 功能一览

### 1️⃣ 远程连接

- 登录页 + 首次配置页（第一次访问先设主账号，之后谁访问都先过登录页）
- 登录一次管 12 小时（Cookie 会话，关浏览器也不丢）
- **自动 HTTPS**：装完自动向 Let's Encrypt 申请浏览器信任的证书，零配置、自动续期；80 端口自动跳转 443
- 登录页自动跟着 dsh 的主题走（dsh 用深色它就深色）
- 远程浏览器可正常使用 dsh 的全部设置功能（dsh 默认只允许本机浏览器编辑设置，dsh-passwords 自动处理这件事；dsh 升级后若设置页出现异常，设置页卡片里有"重载补丁"一键修复）

### 2️⃣ 多用户

- 一个**主用户**（首次配置创建）+ 任意多个**子用户**，各自独立账号密码登录
- 所有账号管理都在 dsh 设置页的卡片里完成，不用 SSH：改密码、改用户名、创建/删除子用户
- 主用户可管理所有子用户；子用户只能改自己
- 改密后旧会话全部立即失效；每次登录/失败都有记录，一条命令就能查谁在什么时候登录过

### 3️⃣ 权限与配额

主用户可以在设置页给每个子用户单独配置：

- **工作区白名单**：子用户只能打开你指定的文件夹，看不到别的
- **每小时 token 上限**、**每日使用时长上限**：到量自动拒绝
- **沙盒权限**：只读 / 可写工作区 / 完全访问，三档可选；子用户的 AI 想越权提权时，网关直接把审批改成「拒绝」
- **上传 / git 下载开关**、**封禁子用户**

### 4️⃣ 协作

- 界面左下角的聊天按钮：主用户和子用户之间留言，可打标签（议题 / 拉取请求 / 讨论 / 公告 / 问题）

## 界面截图

| 登录页 · 浅色 | 登录页 · 深色 | 登录页 · English |
|:---:|:---:|:---:|
| <img src="docs/screenshots/white-login.png" width="360"> | <img src="docs/screenshots/black-login.png" width="360"> | <img src="docs/screenshots/white-login-en.png" width="360"> |

| dsh 主界面（登录后） | 聊天 / 留言 | 设置页卡片 · 账号管理 |
|:---:|:---:|:---:|
| <img src="docs/screenshots/main-ui.png" width="360"> | <img src="docs/screenshots/chat.png" width="360"> | <img src="docs/screenshots/card-front.png" width="360"> |

| | 设置页卡片 · 权限与配额 | |
|:---:|:---:|:---:|
| | <img src="docs/screenshots/card-back.png" width="360"> | |
## 快速开始

### 0. 前置条件（三样）

1. **Node.js 22.5+**：`node -v` 查看（Linux：`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`；Windows：nodejs.org 下载安装包）
2. **dsh 已装好**：`npm install -g @deepseek-ai/dsh`，并已能正常对话（dsh 自身的模型连接配置好即可；本插件不需要任何额外配置）
3. **git**：Linux 没装就 `apt-get install -y git`；Windows 去 git-scm.com 下载（pnpm 缺了脚本会自动装）

### 1. 安装（按平台）

```bash
# Linux / macOS —— 方式 A：直接下载安装
curl -fsSL https://raw.githubusercontent.com/slywalker2006/dsh-passwords/main/install.sh | bash

# Linux / macOS —— 方式 B：先 clone 再装
git clone https://github.com/slywalker2006/dsh-passwords
cd dsh-passwords
bash install.sh
```

**Windows**：下载仓库里的 `install.bat` 双击运行（或 clone 后运行）。它会自动把项目装到 `%USERPROFILE%\dsh-passwords` 并完成全部配置。Windows 上绑 80/443 **不需要管理员权限**；端口被占用时网关会以错误码 32 提示。

**npm 用户**：

```bash
npm install -g dsh-passwords
dsh-passwords install     # 生成随机 SETUP_KEY + 注册插件 + 应用补丁（等价一键安装）
```

（`dsh-passwords --version` 看版本；`dsh-passwords serve-gateway` 手动启动网关。）

脚本自动完成：装依赖 → 编译 → **生成随机 SETUP_KEY** → 注册为 dsh 插件 → 应用远程设置补丁。

装完屏幕最后会显示**首次配置密钥（SETUP_KEY）**，同时也写进了安装目录的 `setup-key.txt`。**首次配置成功后该文件会被自动删除**，`.env` 里的密钥也会自动固化成独立变量并轮换——你不需要手动处理。

### 2. 三步完成首次配置

1. 用平时的方式启动 dsh（dsh 的模型密钥已配好即可，直接运行 `dsh web`；密码门本身无需任何额外配置）——**密码门会被自动拉起，不需要任何额外启动命令**
2. 浏览器直接打开 `https://<服务器IP>.sslip.io`——第一次访问会**自动进入「首次配置」页**，输入 SETUP_KEY，创建主用户（不用手动输入 `/gateway/setup`）
3. 之后所有人访问 `https://<服务器IP>.sslip.io` 都会先过登录页

别忘了在防火墙**和云服务商安全组**里放行 **80 和 443** 端口（开不了 80 的机器见下面的「部署场景矩阵」）。

## 密码门跟着 dsh 走

不需要 systemd，不需要手动启动网关进程，不需要给 dsh 加任何启动参数：

```
dsh 启动 → 插件被加载 → 插件自动拉起密码门（日志就在 dsh 控制台里）
dsh 退出 → 密码门跟着停（不会留僵尸进程占端口）
```

- 高级用法：想单独托管网关进程？`node dist/cli.js serve-gateway` 手动跑，或自己配 systemd 也行。
- 临时禁止自动拉起（调试用）：启动 dsh 时加环境变量 `DSH_PASSWORDS_NO_AUTOSTART=1`。

## 自动 HTTPS（不用买证书、不用配置）

- 默认自动探测服务器公网 IP，用 `<IP>.sslip.io` 域名向 Let's Encrypt 签发 90 天证书；到期前 30 天自动续期（新证书热加载，无需重启），全程零操作
- 有自己域名：`.env` 加一行 `MCP_GATEWAY_DOMAIN=你的域名`，域名 A 记录指向服务器即可，证书自动改签域名版
- **签发失败会拒绝启动**（带错误码），绝不会悄悄降级成明文 HTTP；续期失败但旧证书还在有效期内时，继续用旧证书并在后台自动重试

| 错误码 | 含义 | 怎么办 |
|---|---|---|
| **30** | 证书签发失败 | 检查 80/443 是否放行（防火墙 + 云安全组都要开）、80 是否被占用、能否连通 Let's Encrypt |
| **31** | 拿不到公网 IP/域名 | 服务器没有公网 IP，或探测失败。有域名就设 `MCP_GATEWAY_DOMAIN`；纯内网用走 HTTP 模式 |
| **32** | 端口被占用 | 换端口（`.env` 的 `MCP_GATEWAY_PORT`）或释放被占端口 |

> 为什么地址里有个 `.sslip.io`？浏览器要求证书上的名字和网址一致，而 Let's Encrypt 不给纯 IP 签发证书，`<IP>.sslip.io` 是免费借名服务。直接输裸 IP 的 `https://` 仍会提示主机名不匹配，属正常现象——从 80 端口入口进会自动跳到正确地址。

## 部署场景矩阵（重点：80 端口）

自动 HTTPS 的证书验证（Let's Encrypt http-01）要求 **LE 直连你服务器公网 IP 的 80 端口**——安全组、系统防火墙、NAT 转发一层都不能少。开不了 80 也不用慌，对号入座：

| 场景 | 做法 | 用户看到的 | 需要放行 |
|---|---|---|---|
| ✅ 公网服务器，80/443 都能开 | 什么都不用做（默认） | HTTPS（自动证书） | 80 + 443 |
| ✅ 有自己的域名证书 | `.env` 填 `MCP_GATEWAY_TLS_CERT/KEY`，端口随便改 | HTTPS（你的证书） | 只有你的网关端口，80 完全不用 |
| ✅ 机器上已有 nginx/caddy 反代 | 反代在 80/443 用真实证书终结 TLS 并转发到密码门；`.env` 设 `MCP_GATEWAY_AUTO_TLS=0` + 高位端口，密码门只监听回环 | HTTPS（反代的证书） | 反代管 80/443，密码门零公网暴露 |
| ✅ 域名挂在 Cloudflare | CF 边缘终结 TLS 转发到源站任意端口（配置同反代思路） | HTTPS（CF 证书） | 源站只对 CF 开放 |
| ⚠ 无公网 IP / 纯内网 | `scripts/start-http.mjs` 或 `.env` 设 `AUTO_TLS=0` | HTTP 明文 | 任意端口 |
| ⚠ 只有裸 IP 且 80 开不了 | 只能 HTTP（协议限制：http-01 固定走 80，裸 IP 又没有 DNS 可验证） | HTTP 明文 | 任意端口 |

> 补充：http-01 验证只在**签发和续期**时访问 80 端口（每次几秒钟，约每 60 天一次）；`MCP_GATEWAY_REDIRECT_PORT` 默认就是 80，同时承担证书应答和 301 跳转两件事。

## HTTP 模式（明文，能不用就不用）

密码门默认**拒绝**以明文 HTTP 运行。确实只能内网用、且接受风险的话：

```bash
node scripts/start-http.mjs [端口]    # 默认 8080，会弹 y/N 确认
```

脚本会先显示明文风险警告，输入 `y` 才启动。明文 HTTP 下密码与会话 Cookie 可能被网络中间人嗅探——公网部署请优先使用自动 HTTPS（默认模式，无需配置，只有证书实在签不出来时才用 HTTP 模式）。

更彻底的做法：`.env` 里写 `MCP_GATEWAY_AUTO_TLS=0` 和 `MCP_GATEWAY_PORT=8080`，之后 dsh 启动时插件会直接以 HTTP 模式拉起密码门。

## 设置页里的密码门卡片

登录 dsh 后，打开 **设置 → 插件**，能看到"dsh-passwords · 密码门"卡片。里面可以：

| 功能 | 谁可用 | 说明 |
|---|---|---|
| **远程设置 + 重载补丁** | 所有登录用户 | 远程设置已应用（强制启用）；dsh 升级后若设置页出现异常，点"重载补丁"一键修复（自动重启网页服务并刷新页面，不用 SSH） |
| **修改密码** | 本人改自己；主用户可改任何人 | 改密后旧会话全部立即失效，需重新登录 |
| **修改用户名** | 本人改自己；主用户可改任何人 | 改名后需用新用户名重新登录 |
| **子用户管理** | 仅主用户 | 创建/删除子用户（子用户可用登录页进入，但没有管理权限） |
| **子用户权限** | 仅主用户 | 工作区白名单、每小时 token 上限、每日时长上限、沙盒级别、上传/git 下载开关、封禁 |
| **聊天 / 留言** | 所有登录用户 | 左下角聊天按钮，支持标签（议题/拉取请求/讨论/公告/问题） |

- **主用户** = 首次配置时创建的那个账号；之后添加的都是**子用户**。
- 密码要求与登录页一致：至少 12 位，且大写、小写、数字、符号各至少一位。

## 配置（.env 速查表）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SETUP_KEY` | 安装脚本自动生成 | 首次配置密钥；JWT 会话密钥也从它派生，**安装后别删** |
| `MCP_JWT_SECRET` | 空（从 SETUP_KEY 派生） | 会话签名密钥。生产环境建议独立设置（`openssl rand -hex 32`），SETUP_KEY 泄露时不连带会话伪造 |
| `MCP_DB_PATH` | `./data/platform.db` | 数据库文件（SQLite 自动建库，不需要 MySQL） |
| `MCP_DB_ENC_KEY` | 空 | 数据加密密钥。`openssl rand -hex 32` 生成。**设了就不能换，换钥匙旧数据全废** |
| `MCP_GATEWAY_HOST` | `0.0.0.0` | 网关监听地址 |
| `MCP_GATEWAY_PORT` | `443` | 网关端口 |
| `MCP_GATEWAY_UPSTREAM` | `http://127.0.0.1:3080` | dsh 网页地址（插件自动指向 dsh 实际端口，一般不用改） |
| `MCP_GATEWAY_REDIRECT_PORT` | `80` | 80 端口：ACME 证书验证 + 301 跳转 443 |
| `MCP_GATEWAY_DOMAIN` | 空 | 自己的域名；留空自动用 `<公网IP>.sslip.io` |
| `MCP_GATEWAY_AUTO_TLS` | 开 | 留空=自动；`0` 关闭（明文 HTTP，危险） |
| `MCP_GATEWAY_ACME_EMAIL` | 空 | 证书到期提醒邮箱（可选） |
| `MCP_GATEWAY_ACME_STAGING` | 关 | `1`=用 LE 测试环境签发（调试用，浏览器不信任） |
| `MCP_GATEWAY_TLS_CERT` / `MCP_GATEWAY_TLS_KEY` | 空 | 两个都填 = 用你自己的证书（优先于自动 HTTPS） |
| `MCP_GATEWAY_PUBLIC_HOST` | 空 | 跳转固定用的公网 IP/域名（防 Host 伪造反射） |
| `MCP_DSH_ROOT` | 自动探测 | dsh 安装目录（`@deepseek-ai/dsh` 所在处），探测不到时手动指定 |
| `MCP_DSH_RESTART_SERVICE` | `dsh-web` | 重载补丁后自动重启的 dsh systemd 服务名；显式留空不自动重启 |
| `DSH_PASSWORDS_ENV_FILE` | 空 | 手动指定 `.env` 路径（插件自动传，一般不用填） |

## 常用命令

```bash
node dist/cli.js audit --limit 20        # 看最近 20 条审计日志（自动解密）
node dist/cli.js patch status            # 看远程设置补丁状态
node dist/cli.js patch                   # 重载补丁（重新应用 + 重启 dsh-web）
node dist/cli.js serve-gateway --port 9000   # 手动启动网关并换端口
node scripts/start-http.mjs 8080         # 明文 HTTP 模式（危险，y/N 确认）
```

## 常见问题

- **登录页一直显示"首次配置"？** 说明用户表是空的（新库或数据库被清过）。按页面提示输入 `SETUP_KEY` 重新创建主用户即可。
- **忘记主用户密码？** 停服后跑 `node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/platform.db');db.exec('DELETE FROM users;')"`，重启后重新走首次配置。
- **dsh 控制台报错误码 30 / 31，密码门没起来？** 见上面「自动 HTTPS」的错误码表。修好后重启 dsh 会自动再拉起。
- **443 端口绑定失败（非 root 用户）？** Linux 上 1024 以下端口需要 root：用 root/sudo 启动 dsh，或把 `MCP_GATEWAY_PORT` 改成高位端口（如 8443）并自行做端口转发。
- **dsh 启动报 `duplicate loader entry id`？** 你在 profile 里用过 `dsh plugin add`。它会把 profile 里**所有**声明 `dsh.bundle` 的依赖全部加进 bundles 层，与已装的其它插件重复时 dsh 直接启动失败。卸载 dsh-passwords 后改用 `node scripts/register-plugin.mjs` 精确注册（只追加本插件一个条目）。
- **npm 装 dsh 报 allow-scripts / node-pty 错？** npm 新版会拦截安装脚本，先放行再重装：`npm config set allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs --location=user`，然后重新 `npm install -g @deepseek-ai/dsh`（本项目自身没这个问题，是 dsh 的依赖要跑原生构建）。
- **dsh 报 `crypto.randomUUID is not a function`？** 旧版网关没有 HTML 注入兼容层，更新代码后**强刷浏览器**（Ctrl+Shift+R）。
- **数据库文件被偷了要紧吗？** 不要紧。敏感字段全是密文或散列，没有 `.env` 里的密钥解不开；密码本身只有 bcrypt 哈希，本来就没有明文。
- **想换 `MCP_DB_ENC_KEY`？** 不行。这个密钥一旦启用就不能换，换了一切历史数据都解不开。备份数据库时必须连 `.env` 一起备份。
- **每次进去都卡在 "Loading plugins…"？** 这是 dsh 在加载它的 ~30 个插件脚本，而 dsh 对插件/静态资源返回的是 `no-cache`，浏览器每次都要全部重新下载。网关已对 `/assets/*` 和带 `rev=` 的 `/plugins/*` 强制一年期 immutable 缓存（文件名/rev 都是内容哈希，dsh 更新会自动换新地址）。升级后**第一次访问仍会完整下载一次，之后刷新秒进**；如果还慢，强刷一次浏览器（Ctrl+Shift+R）让新响应头生效。
- **访问有点慢？** 密码门每次请求只花约 1-2ms。先查 TLS 握手：`curl -s -o /dev/null -w "TCP:%{time_connect}s TLS:%{time_appconnect}s\n" https://你的地址/gateway/login`——TLS 那项正常是几十毫秒。TCP 快、TLS 也快但还是慢的话，就是你的网络到服务器的链路延迟，代码解决不了。

## 手动安装（想自己一步步来）

> Windows 用户建议直接用 `install.bat`；本节以 Linux 为例，步骤等价。

1. `git clone https://github.com/slywalker2006/dsh-passwords && cd dsh-passwords`
2. `npm install && npm run build`
3. `cp .env.example .env`，把 `SETUP_KEY` 改成随机串（`openssl rand -hex 24`）
4. 注册插件：`node scripts/register-plugin.mjs`（等价于把 `link:$(pwd)` 加进 `~/.dsh/profiles/web/package.json` 的 dependencies 和 `dsh.profile.bundles` 再 pnpm install。**不要用 `dsh plugin add`**，原因见常见问题）
5. 应用补丁：`node dist/cli.js patch`（找不到 dsh 目录就用 `MCP_DSH_ROOT=/path/to/@deepseek-ai/dsh` 指定）

之后同样：启动 dsh → 密码门自动拉起 → 打开 `https://<你的地址>` 完成首次配置。

## 安全与隐私

账号密码只存 bcrypt 哈希；用户名、IP、审计记录加密落盘；登录/失败全程审计；证书签发失败拒绝启动（不降级明文）。所有密钥都在你自己的 `.env` 和数据库里，源码公开不影响安全。

- **防暴力破解**：连续输错密码锁定，锁定时长随失败轮次退避（1 → 5 → 15 → 60 分钟封顶）；主用户不会被多 IP 轮换全局锁死（仅单 IP 锁定，防账号级 DoS）。
- **防密码喷洒（IP 级节流）**：同一 IP 在 15 分钟内累计 30 次登录失败 → 该 IP 全局节流 30 分钟（跨用户名累计，专门对付“单 IP 轮换多个用户名”的喷洒手法；节流期间不消耗 bcrypt，登录成功自动解除）。NAT/共享出口的大团队若误触发，等 30 分钟自动恢复，无需人工干预。
- **会话吊销**：登出即服务端吊销（该 token 立即失效）；改密/改名后所有旧会话失效。
- **子用户隔离（第三方插件面）**：dsh-ssh（SSH 主机/隧道）、skin-center、modlens、dsh-uploads 列表/删除等运维面端点仅主用户可用；上传/下载按 `allow_upload` / `allowGitDownload` 权限门控，**新子用户默认禁 git 下载**（含 dsh-uploads 下载等外带通道），主用户按需开启，子用户无法枚举或外带共享存储中的文件。
- **慢速连接防护**：显式请求超时（半开头部 20s 切断）+ 并发连接上限（网关 512 / 跳转端 256），抵御 slowloris 类慢连接耗尽。
- **路径归一化**：门卫从原始 URL 迭代解码（防双重编码）+ 压平斜杠 + WHATWG 归一化做前缀判定，`%2f..%2f` / `%252f..` 等 SPA 壳绕过变体全部拦截。
- **生产加固建议**：
  1. **首次配置成功后系统会自动删掉 `setup-key.txt`、把 JWT/内部/字段加密密钥固化成独立 `.env` 变量、并轮换 SETUP_KEY**——无需手动处理；如果你在已初始化的实例上部署（没走首次配置页），才需要手动删一次 `setup-key.txt`；
  2. 需要更强隔离时，可在 `.env` 里**显式设置独立的 `MCP_JWT_SECRET`**（`openssl rand -hex 32`）与 `MCP_DB_ENC_KEY`——首次配置后这些值已自动固化，手动设置只是换一把新的；
  3. 建议配 `MCP_DSH_RESTART_SERVICE` 指向正确的 systemd 服务名。

## 语言

界面为中英双语，跟随 dsh 的语言设置：

- **登录页 / 首次配置页**：跟随 dsh 的语言（设置 → 通用 → 语言），其次跟随浏览器语言；页面右上角有 中文/English 切换，点一下即持久生效。
- **设置页卡片**：跟随 dsh 的语言设置，切换语言即时生效。
- **命令行（CLI）**：跟随 `LANG` / `LC_ALL` 环境变量（`en` 开头即英文）。

## 更新日志

### 2026-08-18 — 兼容 DeepSeek Harness 最新版 keyed slot 变更

**问题**：dsh 最新版（0.1.0-rc.6+）将 `settings.plugin.item` 等 UI 槽位升级为 keyed slot（键控槽位），注册时必须提供 `options.key` 属性。旧版 dsh-passwords 的客户端注册代码缺少 `key` 字段，导致插件加载时报错：

```
Failed to load plugins dsh-passwords
failed to apply loader entry 007bd0cb (dsh-passwords):
keyed slot "settings.plugin.item" requires options.key
```

**修复**：在 `src/client/index.tsx` 的三处 `ctx.slots.register()` 调用中均添加了 `key` 属性：

| 槽位 | 注册 key |
|---|---|
| `settings.plugin.item` | `dsh-passwords` |
| `shell.overlay` | `dsh-passwords-chat` |
| `conversation.composer.dock` | `dsh-passwords-token` |

**操作**：更新代码后重新编译（`npm run build`）并重启 dsh 即可。

## License

[BSD 3-Clause](./LICENSE) © 2026 slywalker2006——自由使用、修改、分发，保留版权声明即可。

本项目是 dsh 的独立扩展，与 DeepSeek 无隶属关系。dsh 本身按它自己的许可证（MIT）授权。
