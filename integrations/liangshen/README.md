# 梁神模式拨杆

适用于已经提供 `liangshen` Agent 预设、并安装 `@linxin666/dsh-web-all` 的共享部署。将同目录 `cordis.patch.yml` 中的覆盖行合并到部署 profile 的用户补丁层；如已有同名行，先核对配置再更新，避免重复。

`web-ui-liangshen` 在全家桶中默认禁用，因此已有预设不代表拨杆前端已加载。此覆盖仅通过 `clientOnly: true` 将拨杆加入前端子插件清单，不重新同步已有预设文件。账号仍受网关预设白名单、会话归属及首次发送后禁止切换预设的限制；管理员动态插件运行器继续保持管理员专用。

验证普通账号的 `/api/dsh-web-all/rows` 包含 `@linxin666/dsh-liangshen`，在未开始的会话中可见拨杆，并核对切换后的预设。没有获准使用 `liangshen` 的账号不应显示拨杆。更新后需要重新加载页面。

## 2026-09-15 部署记录

30 服务器的 `web` profile 已加入此覆盖。切换前共 210 个会话、0 个运行中会话；原有 331 个依赖包及 30 行补丁保持不变，补丁增加为 31 行。更新后的完整补丁 SHA-256 为 `bf62c75d481a6de70d7022df18035560196f79e0da03d32183312549ebeb93af`。服务器 `/home/tzwl3/apps/deploy-staging/20260915-liangshen` 保存切换结果和私有回滚副本。

验证结果：`readyz` 返回 200，未认证 Host 请求返回 401，服务连续 22.81 秒健康；管理员与普通账号的子插件列表均包含 LiangShen，预设接口均返回 200 且包含 `liangshen`。普通账号启动入口仍排除管理员动态插件运行器。桌面端使用普通账号 `wzp` 刷新并新建空白会话后，已实际看到“普通模式”拨杆；验证未发送模型消息。

在 `dsh-web/packages/dsh-web-all` 使用 Node 22.21.1 执行 `node node_modules/vitest/vitest.mjs run tests/rows-ledger.spec.ts tests/client-children-mount.spec.ts`，2 个文件、21 项测试通过，覆盖仅客户端记录和按活动清单挂载子插件的行为。部署候选 YAML 另经解析确认只追加本覆盖行。
