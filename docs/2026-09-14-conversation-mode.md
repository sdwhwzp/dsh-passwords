# 开发模式与纯会话模式

## 使用

左侧“开发模式／纯会话”切换入口保留现有开发体验。Harness 0.1.6-alpha.2 起主视图的会话选择归 ui-workspace（`uiWorkspace.openSession`），Session Controller 不再提供 `open`/`clear`，也没有公开的“未选择会话”状态：切回开发模式时打开最近的开发会话，账号没有开发会话时在纯会话目录里新建一个。纯会话直接进入输入框，展示本账号聊天记录和“新建纯会话”；未提问的空会话会复用。切回开发模式后，工作区、终端、文件与编辑器入口恢复。已有开发会话不会被改成纯会话，纯会话也不能原地升级为开发会话。

纯会话继续使用 Harness 的 Session、模型选择、流式订阅、历史存储和账号额度限制。WeKnora 已配置时可以列出知识库、检索、读取文档及问答。API Key 的知识库权限由 WeKnora 决定；共用同一个 Key 不代表知识库内容自动按 dsh 账号隔离。

## 实现决策

Harness 输入框要求 Session 关联 Workspace，因此服务器自动关联登录账号自己的托管目录，用户不需要创建或选择工作区。工具使用该账号目录，并遵守与开发模式相同的账号权限和沙盒设置。

`dshPasswords/createConversation` 从登录 principal 解析目录，生成 Session ID，并在发布 Session 前保存归属和 `conversation_mode:<sessionId>=chat` 设置。创建中断仍保留归属与显示模式，便于恢复已部分保存的会话。`dshPasswords/conversations` 只返回当前账号拥有的纯会话 ID。创建成功的响应先通过原生 `sessions.create({ sessionId, cwd })` 幂等接入客户端，再选择会话；正在进行的旧列表请求不能作为新会话已可选择的依据。

`agent/created` 恢复显示模式，并让分支继承父会话模式。纯会话不设置工具白名单、不安装额外执行守卫，也不修改工具展示方式；已安装的 GenUI 校验、渲染、文件、Shell 和子代理等工具按账号权限可用。网关、租户 shell 和服务管理继续执行原有账号认证、目录限制与管理员检查。

模式只决定界面与聊天提示，不作为服务端授权依据。GenUI 使用 `dsh-ui` 代码围栏，渲染失败时可调用 `validate_dsh_ui` 诊断修复；网格列数使用 `cols`，卡片正文使用 `items`。聊天界面保留工具生成的面板；工作区导航等开发入口仍由开发模式展示。

## 验证与维护

`test/conversation-mode.test.ts` 覆盖创建前归属、创建失败、历史恢复、分支继承、全部工具可见和账号工具守卫保留。`test/conversation-mode-client.test.ts` 覆盖模式切换、空会话复用与订阅清理。`test/gateway-proxy-headers.test.ts` 覆盖纯会话工具相关请求的账号归属与沙盒限制。

网页使用现有 slot 及局部样式隐藏开发入口，不修改 Harness 主仓库。升级 Harness UI 后需要复核侧栏、会话标题栏和输入框布局。发布验收应包括实时回复、刷新恢复、两账号隔离、知识库调用和切回开发模式。

## 2026-09-14 部署验收

版本 `2.7.1-dsh.20260914.2` 已部署到 [线上入口](https://gr.gr-iot.cn:3081/)，运行代码提交为 `e6b4b511a2ac50594aa90ceb103a9c951797e749`，已推送到 `dev`。

构建、20 项相关测试和 49 项网关测试通过；工具组装过滤调整后，5 项模式测试再次通过。本地浏览器验证自动显示回复、刷新恢复、切回开发模式和 shell 强制调用拒绝；WeKnora 真实工具调用返回 3 个知识库。两个测试账号的纯会话列表互相隔离，越权读取历史返回 403。

生产健康入口返回 200，未登录 Host 返回 401，新纯会话查询接口返回 200。165 个已有会话保留；331 个依赖中仅更新 dsh-passwords，330 个保持原版本；原有 32 行配置保留，另加 WeKnora 配置。地址和 Key 仅保存在服务器受限配置中，不进入 Git。

制品 SHA-256 为 `9272cfc11124a5c6206084443e1f64217b8f47aeb12a64c9e52c5647d3d6b6fc`。回滚 profile：`/home/tzwl3/.dsh/profiles/web-before-20260914-conversation-mode`；服务器审计：`/home/tzwl3/apps/deploy-staging/20260914-conversation-mode`。本地专用测试进程、临时 profile、数据库、凭据、日志、缓存与压缩包均已清理，源代码、共享依赖和服务器回滚资料保留。

## 2026-09-14 新建会话选择修复

版本 `2.7.1-dsh.20260914.3` 已上线，代码提交 `f41192b03a6b3e6194cb296d3f1e3de21fbcad24` 已推送到 `dev`。自定义创建成功后，客户端使用原生幂等接入接口登记同一个 ID 和服务端解析的账号目录，再打开会话，避免列表尚未包含新 ID 时出现 `sessions.select: unknown session`。

54 项相关测试、构建通过；旧实现会触发新增的回归断言。线上确认报错会话存在，原生接入返回同一 ID。167 个会话保留，健康入口 200，未登录 Host 401，连续稳定检查通过；331 个依赖中仅更新 dsh-passwords，33 行配置及 WeKnora 凭据保持原样。

首次切换因 90 秒总就绪时限不足以容纳启动和完整稳定检查而自动回滚；第二次将部署脚本启动预算设为 180 秒，保留全部健康及回滚条件后通过。制品 SHA-256：`a3e5ac232f9dbb251a8ce1c36ddd42a06e6ec397bd7748f42907f59b4c484117`；审计目录 `/home/tzwl3/apps/deploy-staging/20260914-conversation-selection-fix-retry`；回滚 profile `/home/tzwl3/.dsh/profiles/web-before-20260914-conversation-selection-fix-retry`。本次本地临时压缩包、脚本和日志已清理，服务器审计及回滚资料保留。

## 2026-09-14 纯会话全部工具

版本 `2.7.1-dsh.20260914.4` 已上线，代码提交 `9ca4416fb9f59e6ba4a6cee4ae51d77bad901f82` 已推送到 `dev`。纯会话按账号原有权限使用全部已安装工具，恢复 GenUI 校验与渲染、租户 Shell、服务工具和子代理；聊天界面允许工具面板显示，提示词明确 `dsh-ui` 围栏及卡片字段格式。已有纯会话恢复时同样生效；已保存的错误 JSON 回答需要重新生成。

65 项相关测试和构建通过，覆盖实际工具注册、账号守卫、目录限制、网关归属和沙盒拒绝；GenUI 解析器确认错误卡片字段可被诊断，修正后的 `cols`/`items` 规格可解析。线上 167 个会话保留，健康入口 200、未登录 Host 401，连续稳定检查通过；330 个其他依赖和 33 行配置保持不变。

制品 SHA-256：`d54954fe837bf9bd2e6c94e1adebdc432a5b2d9dc437a44ca5422a2794853ac9`；服务器审计 `/home/tzwl3/apps/deploy-staging/20260914-chat-tools`；回滚 profile `/home/tzwl3/.dsh/profiles/web-before-20260914-chat-tools`。本地临时包、测试日志与脚本已清理，源代码、共享依赖及服务器回滚资料保留。
