# Native Android and iOS accounts

The `dsh-mobile` native clients use the existing HTTPS mobile login, refresh and logout endpoints. Enable `MCP_MOBILE_AUTH_ENABLED=true` on the HTTPS gateway, then choose **账号登录 / Account login** in the app and enter the gateway origin, username and password. The server certificate must be trusted by the device. An HTTP upstream behind this gateway remains supported; a TLS-terminating reverse proxy in front of an HTTP-only account gateway does not enable mobile authentication.

Each login response includes `mobileGateway.gatewayId`, `gatewayName` and `path`. The account-specific ID is stable across device sessions and distinct for different accounts. The client resolves the returned path against the same authenticated origin. It stores the refresh cookie in Keychain on iOS or an Android Keystore-encrypted no-backup store, never the password or short-lived bearer. Reconnecting renews the bearer and verifies the server and account identity. The host switcher selects isolated preferences, session projections and attachment caches. Removing an account revokes its device session before deleting its local credential; an unavailable server leaves the profile present and reports the failure.

`/api/mobile.v1/<gatewayId>` accepts only HTTPS mobile bearer connections using `dsh-mobile-v1`; browser cookies and browser-origin upgrades are rejected. Each connection re-enters the account gateway's HTTP Remote routes and Remote mux with its bearer. The gateway supplies signed upstream principals, checks workspace and session access, filters baselines and live projections, applies account policies and disconnects revoked devices. Its loopback carrier pins the listening gateway's certificate. No host-wide Mobile Gateway plugin or separate public port is needed for account mode.

The native bridge supports Session V4 history, assistant streaming, images, commands, session presets, permissions, tasks, goals, queue operations, rename and archive. Raw host directory browsing, file-download sessions, global default-model changes and scheduling are not exposed by this bridge. Use the account web UI for those operations where the account has permission. Existing device pairing remains a separate client mode.

The protocol adapter is pinned to `Clarklevis1995/dsh-plugin-mobile-gateway` commit `d805c567d106cc9bd19e5c429fe7c689f3be9645`. Only its codec and authorized Remote adapter are loaded; its Cordis plugin is not activated. `src/mobile-wire-event.ts` retains the MIT notice for the upstream event projection. Upgrade this dependency together with the native clients and the bridge's account-isolation tests.

## Validation

Run `npm run build` and `node --import tsx --test test/mobile-auth.test.ts test/gateway-tenant-remote-mux.test.ts test/gateway-remote-mux.test.ts`. The native regression covers distinct account IDs, filtered state baselines and deltas, own-session snapshots, rejection of another account's session, raw-directory denial, refresh identity and live logout. The Remote mux tests cover web cookies and mobile bearers. A real local Harness smoke also exercises native queries, empty-session creation, history, commands, subscription, rename and archive without calling a model.

## 原生 Android 与 iOS 账号

在自身提供 HTTPS 的网关上启用 `MCP_MOBILE_AUTH_ENABLED=true`，手机 App 选择“账号登录”，输入账号网关的 HTTPS 地址、用户名和密码。账号模式复用原生聊天界面，无需另装全局 Mobile Gateway 插件或开放新端口。网关证书必须得到手机信任。

同一服务器的不同账号分别保存凭据、偏好、会话缓存和附件。密码不落盘，短期 access token 只保留在内存；长期 refresh cookie 存入 iOS Keychain 或 Android Keystore 加密存储。切换账号使用主机列表，断线重连自动续期并核对账号身份。删除账号先向服务器撤销设备会话；撤销失败会保留资料并提示错误。

所有请求和订阅仍经过现有网关的账号权限检查、签名 principal、工作区和会话访问检查、状态过滤及设备撤销。桥接不开放宿主机原始目录浏览、文件下载、全局默认模型修改和定时任务管理；有权限时可使用现有账号网页操作。原来的设备扫码配对模式独立保留。
