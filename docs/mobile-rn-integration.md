# RN 手机端接入

状态：开发中，尚未部署。手机保持现有 RN 原生安装基线，通过 JS 热更新接入本账号网关。

## 源码同步

2026-09-11 将 upstream/main 6a414b7 合并到自有 dev，版本推进为 2.7.1-dsh.20260911.1。接受 rc.2 安装提示、兼容更新、登录 spinner、更新错误状态和单层 WebSocket 通配符；保留已验证的原生 principal/Host Cookie 接口、工作区/会话所有权、MySQL 存储、独立账号页、拆分的共享样式和自有 fork 的固定依赖。原版二进制补丁/旧会话 grant 路径不重引入；对应旧 fixture 不恢复。

## 移动认证

实现目标：独立 JSON 登录与续期、系统持久 Cookie、短期内存 bearer、设备会话撤销、HTTP/WS 同等账号权限。默认 30 天不活跃失效、90 天绝对上限；参数通过配置调整。真机 Cookie/冷启动/热更新验收在发布前完成。

同步验证：Node 22.21.1 下 npm run build 通过；启动、路径权限、更新、网关头部及账号卡片定向测试共 90 项通过。未执行线上部署或 Windows 安装验收。

## 移动认证契约

启用 `MCP_MOBILE_AUTH_ENABLED=true` 后提供 `/gateway/mobile/v1/bootstrap` 和 `/gateway/mobile/v1/auth/{challenge,login,refresh,logout}`。认证使用网关自身 HTTPS 监听，不信任外部自报的 `X-Forwarded-Proto`；由反向代理终止 TLS 的部署需另行设计可信代理边界。所有认证响应为不缓存的 JSON，登录/刷新直接 200，不经过网页 302。先 GET challenge，再将返回值放入 `X-Dsh-Csrf`，系统 Cookie 存储自动附带同一次 challenge Cookie。

`__Secure-dsh_mobile_refresh` 是 Host-only、Secure、HttpOnly 持久 Cookie，Path 限于移动认证目录；服务端 `mobile_sessions` 仅保存随机 secret 的 HMAC 摘要、用户凭据版本和毫秒级有效期。默认短令牌 15 分钟、闲置 30 天、单次登录最长 90 天，每账号最多 20 个设备；参数见 `.env.example`。正常使用通过刷新延长闲置期，绝对有效期不会延长。相同设备重新登录替换旧会话；禁用账号删除设备会话，之后解除禁用也不能恢复旧 Cookie。SQLite 和 MySQL 均增加独立表，不迁移或覆写原账号数据。

HTTP RPC 和 Remote WS 使用 `Authorization: Bearer dshm.…`，客户端另发 `X-Dsh-Mobile: 1`。移动 JWT 使用独立派生密钥、用途 audience、serverId issuer 和设备 sid；每次校验服务端会话及 credential_version，不进入网页登录缓存。显式无效移动身份不会退回网页登录，移动令牌也不能放进旧网页 Cookie 使用。混入另一个有效网页账号 Cookie 时拒绝请求。网关转发时剥离手机 bearer/认证头，向 Harness 注入既有签名 principal；普通用户的会话、目录和 Remote 流继续经过既有隔离逻辑。

退出删除设备行并关闭该设备所有活动连接；不同设备保持登录。WebSocket 每秒复查移动会话，跨网关进程的撤销/账号变化也会结束旧连接。客户端访问令牌仅在内存中，Cookie 不由业务 JS 读取或序列化。系统 Cookie 存储不等同 Keychain/Keystore；同一主机的 Cookie 不按端口隔离，因此手机恢复许可额外绑定完整 origin、serverId、物联网用户及梯智用户 ID。客户端仅在存在匹配的正向恢复许可时刷新，离线退出记录待撤销来源并清除许可。

## 本地验证与发布门槛

新增 `test/mobile-auth.test.ts` 使用本地 HTTPS、专用测试证书、临时 SQLite 和受控时钟覆盖持久化/过期/撤销/隔离；测试证书只用于回环测试。服务端构建及已有 Remote/权限测试同时检查网页登录兼容。当前主机没有 MySQL 服务，MySQL 分支采用既有同步 SQL 适配和用户行锁，真实 MySQL 迁移/并发验证仍待候选环境执行。

当前代码未部署到 30，也未发布手机热更新。正式发布前必须以实际 Harness 描述符检查 session/list 的 `_request`、其余会话方法的 `request`、`$events/result` 的 clientId/eventId/outcome，并在既有 iPhone/Android 安装包验证强停、冷启动、重启、续期和 OTA。暂停移动能力时保留表及业务数据；需要彻底撤销旧登录时清除设备会话，不能仅临时关开开关后声称会话已撤销。

普通账号 Remote mux 回归复用同一组断言分别运行网页登录 Cookie 和移动 Bearer，共 12 项，覆盖文件越权、会话撤权、跨租户/Host 全局事件过滤、未知协议和逻辑流生命周期。移动认证独立测试 9 项通过。iPhone 已确认正式包 1.0.23 / build 1，对应 Pushy 93452，实际 Cookie 持久化仍待候选服务和单机更新；线上移动 bootstrap 当前 404。
