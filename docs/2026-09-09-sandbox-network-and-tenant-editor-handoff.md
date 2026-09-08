# 2026-09-09 编辑器界面、沙盒联网与多账号编辑器交接总结

编辑器主题现在跟随 DSH，菜单栏、活动栏与状态栏已隐去；宿主机装了 git，终端和编辑器沙盒可以访问内网 GitLab 与公网 HTTPS，因此每个人可以用自己的 git 账号拉取、修改和上传代码。多账号版 `dsh-sidebar-vscode`（整页编辑器 + 右侧会话框的布局）已完成主机半的隔离改造，客户端与部署尚未完成。

## 文档入口

- 本文：本轮功能总览、设计取舍、上传记录、验收与未完成项。
- [变更概览第 16–18 节](2026-09-08-changes-overview.md#16-2026-09-08-编辑器界面融合)：三次改动的摘要与索引。
- [部署手册第 33–35 节](server-28-deployment-runbook.md#33-2026-09-08-编辑器界面融合部署)：包摘要、切换过程、验收矩阵、回滚资料。
- [上一轮交接](2026-09-08-plugin-integration-handoff.md)：Context、Routing Suite、终端、任务看板与编辑器首次上线。

## 用户要求

- 编辑器要和 DSH 界面融为一体，切换 DSH 主题时编辑器跟随；隐藏 code-server 自带的菜单栏、活动栏、状态栏与未接入模型的 Chat 入口。
- 每个人在自己账号的终端里用自己的 git 账号 `clone` / `pull` / `push`，各账号的 git 身份分开。
- 换用 `dsh-sidebar-vscode` 取得「整页编辑器 + 右侧 DSH 会话框」的布局。
- 方案要简单；不要为已经公开的入口和本就人人可达的局域网构筑多余的基础设施。

## 已完成

| 项目 | 结果与入口 |
|---|---|
| 编辑器主题接管 | DSH 明暗决定 `workbench.colorTheme`，DSH token 写入 `workbench.colorCustomizations`；代码区与语法高亮一并跟随，切换主题即时生效 |
| chrome 精简 | 菜单栏、活动栏、状态栏经 VS Code 自身设置隐藏，工作台栅格自行收起；自带 Chat 入口隐去 |
| 账号 git 身份 | 首次打开编辑器在该账号编辑器 HOME 写入 `.gitconfig`，已存在则不改写 |
| 宿主机 git | `git 2.45.2`，位于 `/usr`，两个沙盒只读绑定 `/usr`，无需修改启动器 |
| 沙盒联网 | 共享宿主网络命名空间 + `dsh-sandbox` 组 + nftables 按组过滤出站 |
| 多账号编辑器（主机半） | `dsh-sidebar-vscode` fork 加 `tenant` 模式：停用无鉴权代理，spool 按账号寻址 |

线上版本：`dsh-vsceditor@0.5.4-dsh.20260908.1`、`dsh-passwords@2.6.24`、code-server `4.133.0`、Harness `0.1.3-alpha.1-593ee89`，Host PID `1482230`，Profile 16 个 bundle，`pm2 save` 已执行。本轮共三次切换（v5、v6、v7），每次都经隔离 home 的真实 `dsh --profile web` 装配预检与 30 秒健康门。

## 设计取舍与被否决的方案

**主题**：v5 曾用「往同源 iframe 注入 CSS 覆盖 `--vscode-*`」，只影响外壳，代码区与语法高亮仍由 code-server 主题决定，DSH 切暗色时出现明暗分区。核查发现 `/etc/dsh-vsceditor.json` 的 `account` 就是 DSH 运行账号，启动器创建的租户状态目录本就归该账号所有，因此改为直接写 code-server 用户设置，v6 起 CSS 注入路径整体删除。

**沙盒网络**：初版是每沙盒一个 netns + veth + 网桥，默认全断按需开洞。两件事推翻了它——宿主 `ufw` 处于 active 且 FORWARD 默认 DROP（nftables 下任一表 DROP 即丢包），`net.ipv4.ip_forward` 为 `0`。要走通需开全局转发并给网桥加一条笼统 `ufw route allow`，而它保护的登录网关**本就发布在公网**、局域网**本就对每台办公电脑可达**。改为共享网络命名空间 + 按组过滤：`ip_forward` 仍为 `0`，ufw 未改动。

pasta 方案实测否决：Ubuntu 24.10 的 2024-08 版 pasta 默认把宿主 loopback 映射进命名空间，`--no-map-gw` 无效，该版本没有关闭开关。为原型安装的 `passt` 已 purge。

**编辑器插件**：`dsh-sidebar-vscode` 直接替换会拆掉隔离——它的 README 自述内置反代面向单上游、全局共享，且「能访问该端口的客户端即可使用被代理的工作台」；`src/` 中没有任何 principal 或会话校验。改为在 fork 中补隔离，并复用现有的已鉴权代理，不引入 `serve-web`。

## dev 分支上传记录

| 仓库 | 分支与提交 | 内容 |
|---|---|---|
| [dsh-vsceditor](https://github.com/sdwhwzp/dsh-vsceditor/tree/dev) | `9b078fa` → **`e0f6d3f`**（已推送） | 设置接管、账号 git 身份、启动器联网改造、导出 `tenant-access` |
| [dsh-passwords](https://github.com/sdwhwzp/dsh-passwords/tree/dev) | `82e4d1d` → **`ddd4766`**（已推送） | 终端启动器联网改造、部署记录第 33–35 节 |
| dsh-sidebar-vscode | `4596d55` → **`47fe753`**（**仅本地**） | fork 的 `tenant` 模式主机半；半成品，未推送 |

## 验证结果

- 沙盒可达性矩阵（以 `setpriv --regid 984` 实测）：内网 GitLab `192.168.10.73:30000`、`github.com:443`、DNS 通；DSH API、登录网关（回环 / LAN / 公网三条路径）、宿主 SSH、GitLab 那台的 22/80/443、NAS、内网网关、GitLab 公网路径、`github.com:22`、tailnet 全断。同一矩阵以 gid 1000 运行时宿主自身不受影响。
- 经真实终端启动器的端到端测试：`gid=984(dsh-sandbox)`、`git version 2.45.2`、CA 包存在、登录网关与 NAS 被拦；沙盒内 `git ls-remote https://github.com/git/git HEAD` 返回真实 SHA，DNS、TLS、CA 与 git 全链路可用。
- 以线上安装的 `lib/tenant-settings.cjs` 对临时状态根实跑一次写入：不在白名单的 `editor.background` 被丢弃，三个 chrome 键按配置写入，`.gitconfig` 正确落盘，临时目录已删除。
- `dsh-vsceditor` 自测 12 项通过；`dsh-sidebar-vscode` fork 自测 `467 → 472` 全绿，新增 5 项针对账号隔离，其中一项锁住「两账号 folder 相同而 spool 必须分开」。
- v7 的包内 `scripts/tenant-editor-launcher.py` 摘要与线上 root 启动器一致（`4952114cad339346…`）。

这些检查不替代浏览器验收，也不证明多账号编辑器可用——它的客户端与部署尚未完成。

## 2026-09-09 后续：编辑器接管与两处既有缺陷

编辑器 UI 已换成 `dsh-sidebar-vscode` 的侧栏标签页，`dsh-vsceditor` 退出 Profile、运行时并入前者，root 启动器内容与摘要全程未变。线上 `dsh-sidebar-vscode@0.2.8-dsh.20260909.9`、`dsh-passwords@2.6.26`、`dsh-better-sidebar@0.18.1-alpha.0`。

使用者已确认可用：侧栏标签页加载工作台、编辑器选中代码右键送出引用 chip、沙盒内 `git clone`/`pull`、工作区创建与显示、Git 图谱分支。

同轮定位并修复了一处与本次改动无关的既有缺陷：一条自 2026-09-01 起无法读取归属的子代理会话每轮吃满归属扫描的 15 秒预算，使扫描永远 `partial`，其 30 秒窗口内所有读取都拿不完整快照——新建工作区因而要刷新才可见。`2.6.26` 让「已尝试且确定读不了」的行不再重试也不再判定整轮不完整。另一处已定位未修：`principal-feed.ts` 的 `upsert` 帧因 `workspaceRegistry.list()` 快照尚无新 id 而被丢弃。

三个部署坑与两处自引入回归的完整记录见[部署手册第 36 节](server-28-deployment-runbook.md#36-2026-09-09-侧栏编辑器接管dsh-vsceditor-退役与两处既有缺陷修复)。

## 未完成项

**浏览器视觉验收未执行**，三次切换的 `accepted-v*.json` 均记为 `healthy-pending-visual-acceptance`。本轮没有签发临时令牌，没有写入任何账号的真实编辑器设置或工作区文件。

**终端的 git 身份未自动写入**。编辑器 HOME 是每账号独立的 `/editor-data`，由 `dsh-vsceditor` seed；终端 HOME 是账号的工作区根目录，属密码门范围，目前未实现。各账号首次在终端提交前需自行执行 `git config --global user.name` 与 `user.email`——这样还能填自己真实的 GitLab 邮箱，比自动写入的内部域更合适。

**多账号编辑器剩余五项**：客户端 iframe 改指向 `/dsh-vsceditor/ide/<sessionId>/` 并在每次 open-channel 调用带上 `sessionId`；启动器注入 `DSH_SIDEBAR_VSCODE_SPOOL=/editor-data/dsh-sidebar-vscode`；VS Code 扩展按租户安装且扩展侧读同一环境变量；`dsh-better-sidebar`（已装 `0.18.0`，未列入 bundles）挂载；部署与沙盒内实测。

## 已知限制与恢复资料

出站策略是「默认通、按规则拦」而非「默认断、按需放」，规则错漏即是缺口；规则集存档于 `deploy-artifacts/20260908-vsceditor/records/dsh-sandbox.nft`。放行公网 443 意味着沙盒可访问任意 HTTPS 站点，`npm install`、`pip install` 与在线扩展市场随之可用，数据也可经 HTTPS 外发，这是明确接受的取舍。沙盒之间不再有网络命名空间隔离，可互访对方在高位端口监听的本地服务。所有沙盒仍以同一 uid 1000 运行，隔离依靠挂载命名空间，联网后一次逃逸的价值上升。

内网 GitLab 为 HTTP，git over HTTP 的 PAT 明文传输，仅限局域网内；公网路径已被规则拦掉。GitLab 通常不接受账号密码做 git over HTTP，需建 Personal Access Token；用账号密码配 `credential.helper store` 会同时明文落盘并明文过网，不应采用。账号把 `settings.json` 手工改成非 JSON 后主题停止跟随，DSH 报错但不覆盖。

账号 git 身份是便利设置而非审计手段：git 允许从命令行或环境指定作者。

回滚资料：Profile 备份 `apps/deploy-backups/pre-20260908-vsceditor-v5|v6|v7`；启动器旧文件 `/usr/local/libexec/*.20260908-v2`，旧 sudoers `/root/sudoers-*.20260908-v2.bak`（恢复前经 `visudo -c` 校验）。`systemctl disable --now dsh-sandbox-nft.service` 删除出站策略表。回滚插件不会卸载 git、不会删除已写入账号的 `settings.json` 与 `.gitconfig`，也不会撤销 nftables 单元。不得删除工作区、会话日志或任务账本，不得重跑已完成的切换脚本。本机私有证据位于 `deploy-artifacts/20260908-vsceditor/{records,scripts}/`。
