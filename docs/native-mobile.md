# Native Android and iOS accounts

The `dsh-mobile` native clients use the existing HTTPS mobile login, refresh and logout endpoints. Enable `MCP_MOBILE_AUTH_ENABLED=true` on the HTTPS gateway, then choose **账号登录 / Account login** in the app and enter the gateway origin, username and password. The server certificate must be trusted by the device. An HTTP upstream behind this gateway remains supported; a TLS-terminating reverse proxy in front of an HTTP-only account gateway does not enable mobile authentication.

Each login response includes `mobileGateway.gatewayId`, `gatewayName` and `path`. The account-specific ID is stable across device sessions and distinct for different accounts. The client resolves the returned path against the same authenticated origin. It stores the refresh cookie in Keychain on iOS or an Android Keystore-encrypted no-backup store, never the password or short-lived bearer. Reconnecting renews the bearer and verifies the server and account identity. The host switcher selects isolated preferences, session projections and attachment caches. Removing an account revokes its device session before deleting its local credential; an unavailable server leaves the profile present and reports the failure.

`/api/mobile.v1/<gatewayId>` accepts only HTTPS mobile bearer connections using `dsh-mobile-v1`; browser cookies and browser-origin upgrades are rejected. Each connection re-enters the account gateway's HTTP Remote routes and Remote mux with its bearer. The gateway supplies signed upstream principals, checks workspace and session access, filters baselines and live projections, applies account policies and disconnects revoked devices. Its loopback carrier pins the listening gateway's certificate. No host-wide Mobile Gateway plugin or separate public port is needed for account mode.

The native bridge supports Session V4 history, assistant streaming, images, commands, session presets, permissions, tasks, goals, queue operations, rename and archive. Raw host directory browsing, file-download sessions, global default-model changes and scheduling are not exposed by this bridge. Use the account web UI for those operations where the account has permission. Existing device pairing remains a separate client mode.

Host authorization for a single cold conversation reads its stored header and any required parent headers individually. A batch authorization, such as the Session list, shares one corpus read when any requested Session is cold; an all-live batch does not read persistence. Headers and access decisions are rechecked on each authorization call, so deletion, directory changes and revoked grants take effect on later reads.

The account bridge requests title-only Session list hints for native clients. The Host still applies account authorization and returns the same Session summaries; conversation subscriptions continue to carry complete history and projections.

Native subscriptions initially load the latest four messages to bound the opening payload and Markdown layout on the phone. Set `MCP_MOBILE_INITIAL_HISTORY_MESSAGES` to an integer from 1 to 100 to change that window. Older-page requests retain the client's page size; `hasMore`, the durable cursor, projections and the atomic assistant-stream baseline remain unchanged. Scroll upward to read earlier messages.

When opening a conversation, its model, preset, permission, context, statistics, task and goal reads wait until the first message snapshot is sent. This prevents those controls from repeatedly loading the same cold Session log. Other Sessions remain independent; cancellation or a failed opening releases pending reads, and a closed socket discards them. Every later read still passes account authorization. Models, permissions, context, statistics, tasks and goals use the authorized projection endpoint; overlapping reads for one Session share one request per connection, with no cache after completion.

The protocol adapter is pinned to `Clarklevis1995/dsh-plugin-mobile-gateway` commit `d805c567d106cc9bd19e5c429fe7c689f3be9645`. Only its codec and authorized Remote adapter are loaded; its Cordis plugin is not activated. `src/mobile-wire-event.ts` retains the MIT notice for the upstream event projection. Upgrade this dependency together with the native clients and the bridge's account-isolation tests.

## Validation

Run `npm run build` and `node --import tsx --test test/principal-access.test.ts test/mobile-account-opening.test.ts test/mobile-session-controls.test.ts test/mobile-auth.test.ts test/gateway-tenant-remote-mux.test.ts test/gateway-remote-mux.test.ts`. The native regression covers distinct account IDs, filtered state baselines and deltas, own-session snapshots, rejection of another account's session, raw-directory denial, refresh identity and live logout. The Remote mux tests cover web cookies and mobile bearers. A real local Harness smoke also exercises native queries, empty-session creation, history, commands, subscription, rename and archive without calling a model.

## 原生 Android 与 iOS 账号

在自身提供 HTTPS 的网关上启用 `MCP_MOBILE_AUTH_ENABLED=true`，手机 App 选择“账号登录”，输入账号网关的 HTTPS 地址、用户名和密码。账号模式复用原生聊天界面，无需另装全局 Mobile Gateway 插件或开放新端口。网关证书必须得到手机信任。

同一服务器的不同账号分别保存凭据、偏好、会话缓存和附件。密码不落盘，短期 access token 只保留在内存；长期 refresh cookie 存入 iOS Keychain 或 Android Keystore 加密存储。切换账号使用主机列表，断线重连自动续期并核对账号身份。删除账号先向服务器撤销设备会话；撤销失败会保留资料并提示错误。

所有请求和订阅仍经过现有网关的账号权限检查、签名 principal、工作区和会话访问检查、状态过滤及设备撤销。桥接不开放宿主机原始目录浏览、文件下载、全局默认模型修改和定时任务管理；有权限时可使用现有账号网页操作。原来的设备扫码配对模式独立保留。

Host 对单个未激活对话的授权逐个读取目标会话头及所需父会话头。会话列表等批量授权遇到未激活会话时共用一次目录读取；全部会话已激活时不读取存储。每次授权重新读取会话头并校验访问权限，删除会话、修改目录或撤销授权会影响后续读取。

账号桥接为原生客户端请求仅含标题提示的会话列表。Host 仍执行账号鉴权并返回相同的会话摘要；对话订阅继续传输完整历史和投影。

原生订阅首次读取最近 4 条消息，限制首屏数据量和 Markdown 排版的工作量。可用 `MCP_MOBILE_INITIAL_HISTORY_MESSAGES` 设置 1 到 100 的整数。更早的页面仍使用客户端的分页大小，`hasMore`、持久游标、投影和原子的生成流基线保持原语义；向上滑动继续读取更早的消息。

打开会话时，模型、预设、权限、上下文、统计、任务和目标的读取会等待首份消息快照发出，避免同时重复加载同一份冷会话日志。其他会话的读取不受影响；取消订阅或首次读取失败会放行等待的读取，连接关闭则丢弃这些读取。后续每次读取仍执行账号授权。模型、权限、上下文、统计、任务与目标通过授权状态接口读取；同一连接内同时进行的同一会话读取合并一次，完成后不保留结果缓存。

The native permission picker reads `permissionPresets/catalog` and the authorized Session projection. It does not request the administrator-only settings schema.

原生权限选项只读取预设目录和有访问权限的会话投影，不调用仅供管理员使用的全局设置描述接口。

Native history, pagination, and live subscriptions resolve subagent Session addresses from the Host roster, including the durable parent id. Every resolved read still passes the account gateway policy; a client-supplied parent cannot override the recorded relationship.

原生历史读取、翻页与实时订阅会根据 Host 会话目录补齐子代理会话的持久父会话地址。补齐后的请求仍经过账号网关授权，客户端传入的父会话不能覆盖已记录的父子关系。
### Message receipts

Account connections advertise `message-receipts`. A native message may include a UUID `requestId`; admission preserves it in the Host prompt source and returns it in `sent`. The later `user/message` carries the same value as `event.raw.rpcId`. Without a client nonce, the gateway generates one. Clients can keep a submitted preview visible until the corresponding durable event arrives, without matching message text, adding a fake history event, or retrying the prompt. An acknowledgement confirms admission, not model completion. Existing account authorization and adapter admission serialization still apply.
