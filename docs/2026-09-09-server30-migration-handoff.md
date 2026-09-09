# 2026-09-09 服务器 30 迁移与 MariaDB 切换交接总结

服务器 30 已能独立提供 DSH 服务，入口 `http://192.168.10.30:3081/`，用户库跑在 MariaDB。**自 2026-09-09 起 30 为正式环境、28 为灰度环境**（使用者决定）；公网 `wh.gr-iot.cn:3081` 仍指向 28，切换待网络管理员配合。两台机器现在共用同一份 root 启动器源码。

角色反转后，本文其余段落中「28 是对外权威」的表述按此更正：28 上的插件与配置今后先行验证，确认后再上 30。

## 文档入口

- 本文：当天全部改动的总览、验收快照、限制与待决事项。
- [变更概览第 19–21 节](2026-09-08-changes-overview.md)：三项改动的摘要与索引。
- [部署手册第 37–39 节](server-28-deployment-runbook.md)：路径、摘要、验证记录、回滚资料。

## 验收快照

| | 服务器 28（对外权威） | 服务器 30（新） |
|---|---|---|
| 系统 | Ubuntu 24.10 / 内核 6.11 | Ubuntu 26.04 / 内核 7.0 |
| 硬件 | 12 核 i5-10400F / 14Gi | 40 核 Xeon 4210R / 123Gi |
| 数据盘 | 916G（可用 915G） | 7.3T（可用 7.3T） |
| 系统盘 | 233G（可用 158G） | 879G（可用 789G） |
| 用户库 | MySQL 192.168.10.95 | **MariaDB 192.168.10.73:3306** |
| `dsh-passwords` | 2.6.26 | 2.6.28 |
| `dsh-sidebar-vscode` | 0.2.8-dsh.20260909.9 | 同 |
| `dsh-better-sidebar` | 0.18.1-alpha.0 | 同 |
| Profile bundle | 17 | 17 |
| `tzwl3` uid | 1000 | 1002 |
| `dsh-sandbox` gid | 984 | 973 |
| 启动器 editor | `8e2eb293…` | 同 |
| 启动器 terminal | `acb73638…` | 同 |
| sudo | 1.9.15p5 | 1.9.17p2（由 sudo-rs 切回经典） |
| Host PID | 1560213（重启计数 38，全天未变） | 1428744 |
| 网关 `/gateway/readyz` | 200 | 200 |

30 上有 3 个工作区（`admin-u1`/`u2`/`u3`）、57 份会话日志、两个沙盒 HOME（`u2`/`u3`），`dsh-sandbox-nft.service` 为 active/enabled 且规则匹配 `skgid 973`。这些是当日快照，后续部署前须重新核对。

## 用户要求

- 沙盒 HOME 与项目数据都要落在大容量盘上，不能压系统盘。
- 每个账号在自己的终端和编辑器里都要能用 git 提交。
- 把 DSH 迁到服务器 30，7.3T 的盘按 28 的形态格式化挂载，整盘清掉不保留 Windows。
- 用户库从 MySQL 迁到 MariaDB。
- 服务器 30 上 clash-verge 对公网出口的劫持本次不处理。

## 已完成的改动

| 项目 | 结果 |
|---|---|
| 沙盒 HOME 迁盘（28） | `/var/lib/dsh-sandbox-home` 与 `/var/lib/dsh-vsceditor` 以 bind 挂到 916G 数据盘；系统盘不再承担各账号的 node/JDK/包缓存 |
| git 身份修复（28+30） | 改由创建 HOME 的 root 启动器播种 `~/.gitconfig`；`O_EXCL` 保证用户改过的设置永不被覆盖 |
| bwrap AppArmor 修复（28+30） | 启动器经 `aa-exec -p unconfined` 起 bwrap，解决 Ubuntu 26.04 上 `setpriv` 无法降权 |
| 7.3T 盘（30） | 整盘擦除重建 GPT + 单个 ext4，参数与 28 数据盘一致；Windows 启动项已从 UEFI 删除 |
| 迁移准备（30） | `tzwl3` 账户、`dsh-sandbox` 组、六条 bind、4.7G 数据、code-server、启动器、sudoers、nftables、node/pnpm/pm2/rclone/sqlite3 |
| DSH 启动（30） | 补 MySQL 授权后网关起来；`http://192.168.10.30:3081/` 可访问 |
| MariaDB 迁移（30） | 13 张表逐表搬迁行数一致，应用账号换新密码，到旧 MySQL 的连接归零 |
| 停止按钮排查 | 结论是服务端无缺陷，见下 |

## 验证结果

**沙盒（两台机器）**：终端内 uid/gid、`HOME` 落数据盘、`git commit` 成功且作者为账号名、工作区可见；网络策略按各自 gid 生效（内网 GitLab 放行，网关 3081 与 NAS 445 拒绝，443 出网可用）。编辑器 code-server 起来且 Unix socket 上 HTTP 302。

**git 身份**：启动器函数级测试 26 项通过，覆盖取值、回落、64 字符边界、注入回落、`0600` 权限、幂等不覆盖、软链不跟随。真实沙盒中 `u2` 保留 `wzp`、`u3` 首启自动播种、传入构造值时回落且未产生副作用文件。

**跨 OS**：`node-pty` 与 `fs-ext` 原生模块在 30 上可加载（glibc 2.40 编译、2.43 运行）。

**MariaDB**：`dsh-passwords` 407 项测试 394 通过 0 失败。13 张表行数逐项一致（`audit_logs` 62、`session_owners` 56、`user_usage` 11、`users` 3 等）。切换后 30 到 `192.168.10.73` 有 3 条连接、到 `192.168.10.95` 为 0。

这些检查不替代 Harness 全量测试，也不构成对 `2.6.27` 账号管理 UI 的验收。

## 停止按钮：服务端没有缺陷

会话 `session-88e8fc29` 中三次到达服务端的停止，从最后一个流帧到轮次结算分别是 44ms、18ms、12ms，流在此前一直保持约 130 帧/秒的密度，说明取消信号一到就掐断了连接。三次被停的消息 `text` 均为 0 字，内容全是 `reasoning` 块（898/1987/1185 字）。使用的 `deepseek-v4-flash-vision-exp` 正常一步要吐 3000–7600 字思考、耗时 9–20 秒才开始写回答，因此点击前后有大量思考文字在滚动，观感即"没停"。

同一日志中唯一没有实时结算的一轮，`turn/end` 为 `{"kind":"interrupted"}`——该值只由崩溃恢复补写，对应的是当天的生产重启，不是停止按钮。

尚未取得的数字是点击到服务端收到之间的延迟。若浏览器 Network 面板中该 cancel 请求的 TTFB 确为 2400ms，则那 2.4 秒内模型确实在继续生成，那部分才可优化。

## 三个必须记住的环境差异

**sudo-rs 不支持摘要 pin。** Ubuntu 26.04 默认的 sudo 是 sudo-rs 0.2.13，遇到 `sha256:` 规则报 `digest specifications are not supported` 并**整体拒绝服务**，装入规则即让该机 sudo 不可用。经典 sudo 以 `/usr/bin/sudo.ws`（setuid root）并存，`update-alternatives --set sudo /usr/bin/sudo.ws` 恢复且保留摘要 pin。在 26.04 及更高版本部署本套启动器前必须先做这一步；恢复通道是直接调用 `/usr/bin/sudo.ws`。

**AppArmor 让 bwrap 内无法降权。** 26.04 把沙盒关进 `bwrap//&unpriv_bwrap (enforce)`，`/etc/apparmor.d/bwrap-userns-restrict` 带 `audit deny capability`，导致沙盒内 uid 0 且 `CapEff` 满的情况下 `setresuid` 仍返回 EPERM。已排除 user namespace 与 POSIX 能力，strace 定位到系统调用本身被拒。启动器改为经 `aa-exec -p unconfined` 起 bwrap，沙盒进程最终仍是目标 uid/gid、四个能力集全空、`no_new_privs=1`；28 上实测该改动逐项无差异。

**库地址有两个来源。** `.env` 的 `DSH_PASSWORDS_MYSQL_*` 只覆盖密码门自身；`dsh-nas-webdav` 在 `cordis.patch.yml` 里另有一套 `mysqlHost`/`mysqlPort`/`mysqlUser`，密码取自凭据目录 `~/.dsh/credentials/dsh-nas-webdav/mysql-password`（明文文件）。只改 `.env` 时进程仍保持一条到旧库的连接。任何换库都必须同时处理两处。

## 迁移过程中的两个取数陷阱

rsync 以 `tzwl3` 身份拉取 root 拥有的 `0711`/`0710` 目录时只能穿越不能列目录，子项被静默跳过**且 rsync 不报错**；这两棵树改由源侧 root 打 tar、按摘要核对后解包。

`ssh` 默认读取 stdin，写在经 stdin 送入的脚本里会把脚本正文本身吃掉，表现为脚本在该行之后静默停止；此类脚本中的独立 `ssh` 调用需加 `-n`。

## 已知限制与待决事项

**28 尚未迁 MariaDB。** 28 仍连 MySQL `192.168.10.95`；作为灰度环境它可以先保持 MySQL，也可以迁到 MariaDB 的独立库以贴近正式环境，二者取舍未定。它不应沿用 30 上的 `2.6.28`：该版本裹了尚未上过生产的 `2.6.27`（账号管理 UI 重做与托管目录的 git clone/pull），数据库迁移不该与未验收的 UI 变更捆在一次变更里。28 应另出「线上 2.6.26 + 排序规则修改」的最小包，并走完整的候选 Profile 装配冒烟与切换流程。

**公网入口仍指向 28。** `wh.gr-iot.cn:3081`（网页）与 3082（本地工作区 WebSocket）要改指 30，需网络管理员配合；`MCP_LOCAL_WORKSPACE_PUBLIC_URL` 在 30 上已改为 `ws://192.168.10.30:3082`，属本机专属配置。

**两台机器共用同一批 sessionId。** 用户库已在两处分别指向 MariaDB 与 MySQL，但会话日志文件是各自一份。在 30 上产生的新会话与新消息，正式切换时会被从 28 重新同步覆盖。

**数据盘没有配额。** 100 个账号共用 7.3T（30）或 915G（28），任一账号可耗尽全盘。ext4 project quota 可按目录限额，限额值与超限提示未规划。

**30 的公网出口经 clash-verge 的 TUN。** 内网 `192.168.10.0/24` 直连不受影响，但 DeepSeek API 调用会经该代理；按要求本次不处理。该机仍在跑图形会话与 AweSun 远程控制。

**应用账号密码已轮换（仅 MariaDB 侧）。** MariaDB 的密码策略拒绝了原 64 位十六进制密码，且该错误把密码原文打进了日志，因此新建账号时换用了 34 位新密码。旧 MySQL 侧的账号与密码保持原样。

**会话日志仍在系统盘。** 两台机器的 `~/.dsh/sessions` 都未迁到数据盘，当前 14M 级别，增长慢。

## 恢复资料

30 侧：`/root/fstab.20260909-dsh-data.bak`、`/root/fstab.20260909-binds.bak`、`/root/grub-default.20260909.bak`；启动器备份 `/usr/local/libexec/dsh-tenant-{editor,terminal}.20260909-pre-aa`；MariaDB 回滚为 `.env.pre-mariadb`、`cordis.patch.yml.pre-mariadb`、`mysql-password.pre-mariadb`、`apps/dsh-plugins/addons/dsh-passwords-2.6.26-rollback.tgz`。

28 侧：启动器备份同名，旧摘要 `d87bd17b…`/`d4491d77…`，sudoers 备份在 `/root/sudoers-dsh-tenant-*.20260909-git-identity.bak`；换回旧文件后须重新 pin sudoers。fstab 备份 `/root/fstab.20260909-sandbox-home.bak`，注释掉两条 bind 并 `umount` 即回到系统盘上的原副本，该副本未删除。

旧 MySQL `192.168.10.95` 的库、表与账号完好，未做任何删除。迁移用的一次性 ssh 公钥已从 28 的 `authorized_keys` 删除，30 侧私钥已删除。

恢复前先保存后续新增的数据和配置，不得删除会话日志、工作区、个人任务账本或已提交的数据后继，不得直接重跑已完成的切换脚本。
