# 2026-09-08 本次改动清单（Harness 0.1.3-alpha.1 升级，进行中）

> 记录本轮“检查全部源仓库更新 → 升级 Harness 到 0.1.3-alpha.1 → 各插件适配 → 本机验证”任务中已产生的改动。上一轮记录见 `docs/2026-09-04-changes-overview.md`。
>
> **状态：本机候选安装核验完成，发布门禁尚未全部通过，未部署到 28 服务器。** 上次验收记录为 runtime `0.1.2-rc.1` + dsh-web-all `0.3.14` + dsh-passwords `2.6.19`；补充登录信息后已核实三条 current 路径与该基线一致，已取得安全发布清单及复用制品，尚未修改服务器。

## 1. 各仓库当前状态

| 仓库 | 分支 | 状态 | 说明 |
|---|---|---|---|
| deepseek-harness | `tzwl` | 已提交 `593ee89aa6`、**未推送** | 文档 33 项与 lint 通过；最终全量 9 项失败，原预算聚焦 9 项通过（§10.6） |
| macproject/dsh-web | `master` | 已推送 `cec0cde4` | 含合并 `0a01f09c`；另有未应用的 alpha.1 修复候选，隔离 typecheck/build 与 3634 项测试通过（§10.5） |
| macproject/dsh-passwords | `feature/principal-budget-webdav` | 修复 `388f80b` 已提交、**未推送** | 空白会话修复已验证（§10.3）；另有未提交发布依赖候选（§10.7） |
| macproject/dsh-plugin-subscriptions | `dev` | 修复 `a9a030b` 已提交、**未推送** | 实时目录和 0.1.3 API 适配已验证（§10.2）；另有未提交发布依赖候选（§10.7） |
| macproject/dsh-at-file | `dev` | 无待合上游；有未提交发布依赖候选 | 见 §10.7 |
| macproject/dsh-spend | `feature/principal-budget-webdav` | 无待合上游；有未提交发布依赖候选 | 见 §10.7 |
| macproject/nas | `main` | 无待合上游；有未提交发布依赖候选 | 见 §10.7 |
| dsh-shandong-tizhi-brand | `main` | 无待合上游 | — |
| macproject/dsh-weknora | `main` | 按既往决定跳过 | 腾讯上游 2916 提交 |

续跑时直接查询远端确认：`sdwhwzp/dsh-web` 的 `master` 当时已是 `5e65a315`，线上 task-board 修复已经推送；本地 `origin/master` 停在旧值。随后已将 51 个上游提交、合并提交和一项末尾空行清理提交推送，远端与本地 `master` 均为 `cec0cde4`。

## 2. deepseek-harness：合并 upstream 0.1.3-alpha.1

`tzwl` 合并 `upstream/master` 的 229 个提交（`0.1.2-rc.1` → `0.1.3-alpha.1`），备份分支 `backup/tzwl-before-013` = `bf8d4921d9`。

上游本次的主线改动：packed chunk row 被**紧凑 Assistant stream** 取代——`assistant/message` 内嵌它据以 settle 的 provider stream，Client-only 的 `assistant/live-chunk` 承载瞬态帧，具名 settlement delta 负责让瞬态行退场；`ConnectionFetchHandler` 新增流式请求体的 `requestBodyMode` 座位；`/` 菜单的模糊排序抽成 ui-primitives 的 `rankByName`；命令输入描述符的 `images` 更名为 `attachments`。

### 2.1 44 处冲突的解法

| 位置 | 上游改动 | fork 保留 |
|---|---|---|
| `core/agent-loop/src/agent.ts` | 整段移入 `try`，改用 `live.settle` | `principal` 透传 + `messageBelongsToPrincipal` 收件箱排序 |
| `client/connection/src/rpc-host.ts` | `requestBodyMode`、拦截器改单例 | principal 鉴权链、多拦截器 Set、按请求构造 `rpcFetchHandler` |
| `client/ui-commands/src/client/service.ts` | 模糊排序抽到 `rankByName` | `HOST_DESCRIPTION_KEYS` |
| `session-query/session-log-export` | `requestBody: 'buffered'` | `fetch(request, principal)` |
| `api/session-controller/src/commands.ts` | 文件回执准入 | principal 随 `UserMessage` 落库 |
| 7 组双语文档 | 紧凑 Assistant stream 术语 | principal / lifecycle 事实 |
| 生成物（slot/api catalog、config/persistence catalog、module-graph） | — | 冲突后统一重新生成 |

`packages/core/agent-loop/src/agent.ts` 的冲突下半段为空，是因为上游把整段重构后移入 `try`；HEAD 侧那段是重构前的旧副本，删除旧副本并把 `principal` 移植进新块。

双语配对哈希用 `verify-translation-pairing --write` 重录。

### 2.2 测试：14 个失败已全部处理

| 失败 | 根因 | 处置 |
|---|---|---|
| subagent × 3（interrupt） | fork 的 `beb70ef671` 把 `interruptByParent` 改成 async 做 principal 授权，未更新测试。async 函数不可能同步抛错 —— **fork 既有失败** | 测试改 `await … .rejects` |
| subagent × 1（deliverPrompt） | fork 加了第 7 个参数 `principal`，断言未跟上 —— **fork 既有失败** | 断言补 `undefined` |
| subagent × 1（catalog abort） | `requireReadableParent` 在 `try` 外，已 abort 的 signal 抛裸 `AbortError`，逃出 `gateway/cancelled` 映射 | 授权移入 `try`，`RemoteError` 原样透传 |
| session-projections × 1 | 上游给 `test-remote.ts` 加了“缺失就补 attachments 桩”，使“无 attachment 组合”的前提失效（上游那边靠 inject 尚未生效的时序侥幸通过；fork 的授权 `await` 让出那一拍，注册得以完成） | 给 `createSessionTestRemote` 增加 `omitAttachments` 选项，用例显式声明 |
| ui-tool × 2（同一调用渲染两行） | 上游夹具的 `tool/result` 不带 `sourceEventSeqs`，而真实 `tool-calls.ts:302` 是带的；fork 的 lifecycle 关联依赖它，call 与 result 落到不同 Context | 修正夹具 `toolSessionEvents`，复现真实引用 |
| ui-tool / ui-chat × 3（openWorkspacePath） | fork 加了 `sessionId` 做可见性授权，三处断言未跟上 —— **fork 既有失败** | 断言补 `sessionId` |
| ui-tool × 1（图片画廊） | fork 的 `renderMessageImages` 已被上游 `tool.call.images` slot 取代（经 attachment 插件填充、带会话授权加载器，`ToolRow` 对根/子调用统一走它，上游自带覆盖） | 删除验证旧路径的 fork 测试 |
| ui-model-selection × 1 | fork 写了“连接重置保留已确认标签”的测试，但实现从未落地（`src` 三方完全相同）—— **fork 既有失败** | 补上实现：用 ref 记住最后一次确认的标签与推理等级，重置窗口内不闪回“加载中” |
| session-log-export × 1 | fork 把 lineage 追踪提前到授权阶段用 `request.signal`，archive 内部用派生的 `producerSignal`；测试断言“同一对象” | 断言改为“一次取消贯穿 root/lineage/descendant 三处读取” |

**14 个里有 6 个是 fork 既有失败**（改了行为没改测试），说明本仓库测试此前不是全绿状态。

### 2.3 全量测试的三轮结果与逐项归因

本节保留另一项任务的历史结果与当时判断。其“资源敏感、非代码问题”归因不等于本任务已证明所有失败原因；固定合并提交上的最终全量仍有 9 项失败，应以 §10.6 的命令、最终断言及聚焦复跑结果作为当前验证状态。

修完 §2.2 的 14 项后，全量 `pnpm run test` 又跑了三轮，失败数 21 → 13 → 7 且集合各不相同。逐个单独复跑后归因如下：

**真实失败（1 个，已修）**

`packages/spill/spill-local/tests/spill-local.spec.ts` 的 “keeps a file exactly at the boundary”。该包与上游**逐字节一致**，fork 未碰过；失败源于测试自身的浮点往返缺陷：

```ts
const cutoffMs = Date.now() - 30 * DAY_MS
utimesSync(boundary, cutoffMs / 1000, cutoffMs / 1000)   // utimes 收秒
```

实测本机 `cutoffMs = 1786235817961` 写入后读回 `mtimeMs = 1786235817960.999`，差 −0.000977 ms，于是 `stats.mtimeMs >= cutoffMs` 为假，边界文件被当作 strictly-older 删除。成败取决于 `Date.now()` 当刻的值能否被 ms→s→ms 精确往返，属于随时间随机失败。

修法：把 cutoff 对齐到整秒，使往返精确，用例回到检验比较逻辑本身而非时钟取值。

**资源敏感、非代码问题（其余全部）**

| 用例 | 单独复跑结果 |
|---|---|
| `scripts/oxlint-contract.spec.ts` | 13/13 通过（23.4s） |
| `packages/experimental/code-runtime-python/` | 282/285 通过；余 1 项 60s 超时，该包与上游逐字节一致 |
| `packages/boot/app-boot/tests/hmr-config.spec.ts` | 6/6 通过 |
| `packages/client/ui-primitives/tests/code-block.client.spec.tsx` | 15/15 通过 |
| agent-team、subagent/continuation、session-snapshot、acp、doc-site、lefthook、built-bundle 等 | 单独复跑均通过 |

这些都是跑真实子进程（oxlint 可执行文件、Python 解释器、构建产物导入）的重型用例，本机并发下互相争 CPU 即超时。实证：oxlint 与 code-runtime-python **单独各自全绿**，两者同跑则 oxlint 5 项全数超时失败。

修完 spill 后的第四轮全量为 10 个失败，`spill-local` 已不再出现，其余全部集中在同一批重型用例；本轮新出现的 `client-build-environment.client.spec.ts`（8/8）、`typert/generator/tests/tools-catalog.spec.ts`（1/1）、`code-runtime-python/tests/protocol.spec.ts`（25/25）单独复跑同样全绿。

按 `AGENTS.md` 的分工，穷尽覆盖与平台矩阵归 CI；本机据此判定合并本身健康，已提交为 `593ee89aa6`。

Agent Note 已写：`.agents/notes/implemented/architecture/2026-09-05-principal-authorization-across-013-upstream.md`（中英双语 + i18n 配对）。

## 3. dsh-web：合并上游 v0.3.17

51 个提交，10 处冲突（其中 2 处是构建产物），已全部解决并提交 `0a01f09c`。

- `package.json` — 保留 fork 的 `--workspace-concurrency=1`，加入上游 `test:desktop`
- `dsh-remote-web-ui` — 保留 fork 的“无桌面页脚入口”定制与 0.4.0 版本线；采纳上游“`startMobileAdapt` 移入 `apply` 并在 dispose 回退”
- `dsh-pet/src/index.ts` — 采纳上游的 settings 双路径注册（`installSection` / `register`），但**去掉 `syncRoutes()`**：fork 要求路由全生命周期注册，某账号隐藏宠物时另一账号仍须能调用 API
- `dsh-pet/src/client/index.test.tsx` — 删除上游新增的 `settingsScope` 版监听测试。fork 的客户端设置源已换成 `PetAccountSettingsScope`（按账号隔离、走 HTTP），该测试在 fork 架构下是死路径；fork 自有两条账号级覆盖
- `dsh-web-settings/src/allowlist.ts` — 保留 fork 的 market 映射，合入上游新增的 usage / doctor / liangshen / session-archive
- `dsh-web-settings/tests/allowlist.spec.ts` — 删除 fork 那两条与上游 #1176/#1370 互斥的断言。查明 `resolveNamespaceEntry`（单值）**无生产调用点**，生产走复数版 `resolveNamespaceEntries`（两个 market 命名空间都返回）再按实际注册过滤，fork 的 `dsh-web-ui-market` 照常放行，故采纳上游顺序以减少长期分歧
- `dsh-web-all/aggregate.yml` — 采纳上游 tombstones，避免老 profile 残留条目触发 `ERR_PACKAGE_PATH_NOT_EXPORTED`

**原合并验证**：`pnpm -r build`、`pnpm -r test`、`typecheck`、`aggregate:check`、`community:check`、`runtime-deps:check`、`i18n:check`、`skin-hooks:check`、`docs:check` 全部通过。当时安装的是 rc.1 SDK，alpha.1 的追加验证与兼容修复见 §10.5。

## 4. dsh-plugin-subscriptions：Codex 改用实时模型目录

### 4.1 问题

模型选择器只显示 3 个 ChatGPT 模型。根因是 `src/providers/codex.ts` 里的**硬编码 id 白名单**：

```ts
const CODEX_PICKER_MODEL_IDS = new Set(CODEX_PICKER_MODELS.map(m => m.id))  // 只有 gpt-5.6-sol/terra/luna
function pickerModels(models) { return models.filter(m => CODEX_PICKER_MODEL_IDS.has(m.id)) }
```

`fetchCodexModels` 中 `if (!CODEX_PICKER_MODEL_IDS.has(entry.slug)) continue` 把后端返回的其余模型直接丢弃。README 宣称的 “live model catalogs” 对 Codex 并不成立。将来 OpenAI 发布新模型，不改这份列表就不会显示。

用本机已存的 Codex 登录（pro 计划）实测 `chatgpt.com/backend-api/codex/models`，后端返回 8 个模型，**当前没有 GPT-6**，最新为 gpt-5.6 系列。被白名单挡掉的是 `gpt-5.5`、`gpt-5.4-mini`、`gpt-5.3-codex-spark`、`gpt-reserve`、`codex-auto-review`。

### 4.2 改法

改为由**后端目录自己决定**，白名单退化为离线兜底：

- 删除 `CODEX_PICKER_MODEL_IDS` 与 `pickerModels()`，4 处调用点直接使用原数组
- `fetchCodexModels` 去掉 id 过滤，保留原有的 `visibility` 过滤（codex-rs `ModelVisibility`：只有 `list` 进选择器，`hide`/`none` 丢弃）
- 新增 `meetsClientVersion()`：跳过 `minimal_client_version` 高于本插件 `CODEX_CLIENT_VERSION` 的条目，避免列出选得到却调用即失败的模型
- 新增 `entryModalities()`：按后端 `input_modalities` 上报模态。**这是放开白名单的必要配套**——`gpt-5.3-codex-spark` 只支持 `["text"]`，而原代码硬编码“每个 gpt-5.x 都接受图片输入”，放开后会错误宣称它收图片
- `CODEX_PICKER_MODELS` 保留为 discovery 关闭或目录读取失败时的兜底，注释改为说明其兜底性质
- `discovered(model)` 去掉白名单短路，否则白名单外的模型拿不到推理等级与 fast tier 元数据

用真实目录验证后，选择器从 3 个变为 **6 个**（按 priority 排序）：gpt-5.6-sol / terra / luna / gpt-5.5 / gpt-5.4-mini / gpt-5.3-codex-spark；`gpt-reserve` 与 `codex-auto-review` 按 `visibility: hide` 正确丢弃；`gpt-5.3-codex-spark` 正确识别为纯文本、上下文 128k。

### 4.3 顺带的 0.1.3 适配

该插件通过 workspace link 直接编译本机 harness 源码，因此 0.1.3 的 `CommandInputDescriptor.images` → `attachments` 重命名使它编译失败。`src/image-commands.ts` 两处 `input: { …, images: true }` 改为 `attachments: true`（`invocation.attachments` 早已是新名，属半适配状态）。

续跑后的完整 `npm test` 与 Host/Client 构建已通过，见 §10.2。

### 4.4 Grok 侧：同构白名单，但不能照搬这个改法

`src/providers/grok.ts` 有结构相同的白名单（`GROK_PICKER_MODELS` = grok-4.6 / grok-4.5、`GROK_PICKER_MODEL_IDS`、`pickerModels()`），`fetchGrokModels` 第 565 行同样丢弃白名单外的条目。本轮**未改动**，原因是两处实质差异：

1. **后端目录不提供可见性依据。** Codex 的 `chatgpt.com/backend-api/codex/models` 每条返回 `visibility`、`priority`、`supported_reasoning_levels`、`input_modalities`、`minimal_client_version` 等完整元数据，去掉 id 白名单后由 `visibility` 接管即可。Grok 走的是 `api.x.ai/v1/models`，响应只有 `{ id }`——没有任何字段能区分“订阅可用”与“仅 API key 可用”。推理等级要另外拉 Grok CLI 目录（`fetchGrokCliCatalog`）才拿得到，且该请求失败时只能退回上一次已知值。
2. **白名单同时是拒绝闸门。** `assertPickerModel()` 在选择模型（770 行）与发起请求（801 行）两处硬拒绝白名单外的模型，而 Codex 侧没有任何等价拒绝逻辑——这也是 Codex 改动面干净的原因。

也就是说，x.ai 的 `/v1/models` 很可能返回订阅（X Premium）并不能调用的模型，此处的白名单更像是一道必要保护，而非单纯的过时列表。若要同样改成实时，需要先查明订阅可调用模型的判定依据，不能直接删过滤。

本机 Grok 登录的 token 已于 2026-08-27 过期，本轮未实测其后端返回内容。

### 4.5 待确认

- Grok 是否按 §4.4 的前提另行调研后改造。
- Codex 改动的完整 `npm test` 已在续跑中完成并提交，结果见 §10.2。

### 4.6 一次需要说明的操作

为查明后端实际暴露哪些模型，用 `~/.dsh/plugins/subscriptions/auth.json` 中的 refresh token 换取过 access token（存档中的 token 已于 09-01 过期）。OpenAI 做了 refresh token 轮换，但复验确认**存档中的旧 token 仍然有效**，插件登录未受影响；未改写 `auth.json`，插件下次自行刷新时会正常保存新 token。若日后订阅登录失效，在 设置 → Subscriptions 重新登录即可。

## 5. dsh-passwords：上游 7 提交暂不全量合并

上游 `slywalker2006/dsh-passwords` 领先 7 个提交，最新为 `590b2ca release: v2.6.11 DSH 0.1.2 and 0.1.3 compatibility`。

试合后**中止**：33 个冲突，`src/gateway.ts` 双方各改 5876 / 1628 行，`test/gateway-proxy-headers.test.ts` 双方各改 2200 行左右——两条线几乎独立演化。上游这 7 个提交里，`v2.6.8 alpha.5`、`v2.6.10 rc.1` 兼容本 fork 已各自实现过，重复但实现不同，硬合风险极高。

逐条核对 `590b2ca` 的 0.1.3 适配，只有两项与本 fork 相关：

1. **apiproxy 白名单补丁**——上游删除（0.1.3 已无该包）。本 fork **已经清理过**，无需处理。
2. **可分配工作区的空白会话过滤**——上游明确移除，其 JSDoc 写明“`session.create()` 之后会话本来就是空白的；能否分配只由注册表成员资格、归档状态与持久化存在决定”。本 fork 的 `src/plugin.ts:1124/1133` **仍在**用 `isDisplayableDshSession` / `isDisplayableDshSurface` 过滤，且外层 `catch` 会把异常吞成空列表——与此前“选择不了工作区”的故障同源。

续跑已定向移植第 2 项并补回归测试（§10.3），未全量合并这 7 个提交。空白会话在管理员分配清单中可选，账号可见性仍受原有权限约束；改动尚未上线。

本轮已完成的是：把仓库里未提交的 **BotHub Bridge**（`src/bot-bridge.ts` + 测试 + `BOTHUB.md`，已接入 `plugin.ts`）落盘为 `0a71ac8`，避免合并时丢失。落盘前验证：`npm run build` 通过，`npm test` 385 项全过。

## 6. 环境问题：磁盘

数据卷 228Gi 已用约 200Gi，任务中一度**完全写满**，导致 dsh-web 构建与测试日志写入失败；当时任务也把大面积测试超时归因于该环境问题。此前已执行 `pnpm store prune` 释放 3.09 GB。此后系统又回收了空间（具体来源未核实），本轮续跑再次测得可用约 **29Gi**，未再观察到磁盘写满；这不能证明 §10.6 的测试超时原因。

以下可回收大件**未动**，待确认：

| 路径 | 大小 | 性质 |
|---|---|---|
| `~/Library/Developer/Xcode/iOS DeviceSupport` | 5.6G | 真机调试符号缓存，删后重连设备会重新下载 |
| `~/java_error_in_idea.hprof` | 1.5G | 2026-07-02 的 IDEA 崩溃转储 |
| `~/Library/Caches/com.tencent.xinWeChat` | 1.8G | 微信缓存（聊天记录不受影响，本地图片/文件需重新下载） |
| `~/Library/Caches/com.openai.codex` | 1.4G | Codex 缓存 |
| `~/projects.backup-20260718` | 10G | 用户项目备份，不建议动 |

## 7. 待确认事项汇总

空白会话定向修复与 dsh-web 补推已完成；Grok 扩展和额外磁盘清理未执行。

### 7.1 dsh-passwords 的空白会话过滤（§5）

已采用定向修复：`session.create()` 后尚无内容的会话可以进入管理员分配清单，未命名时显示会话 ID；仍检查工作区登记、归档、目录和会话存在性。普通账号权限没有放宽。实现与验证见 §10.3。

### 7.2 dsh-web 后续合并补推

已通过明确的个人 fork URL 推送 `master`，远端从 `5e65a315` 前进到 `cec0cde4`，未修改任何 remote URL。原“65 个未推送”的判断来自过期的本地 remote-tracking ref；本轮实际推送 53 个提交，包含末尾空行清理。见 §10.5。

### 7.3 Grok 是否同样改为实时目录

见 §4.4。前提是先查明“订阅可调用”的判定依据，不能直接删过滤。

### 7.4 磁盘清理

见 §6。当前已回收到 29Gi，短期不再紧迫；表中大件是否清理由使用者决定。

## 8. 下一步

1. Harness 合并已提交为 `593ee89aa6`；该提交的完整文档门禁和 lint 通过，最终全量测试结果另记 §10.6，不能以早期单独复跑结果代替。
2. 完成 dsh-web 的 alpha.1 SDK 兼容修复与隔离验证（§10.5），再完成五个业务插件的发布声明、锁文件和安装入口对齐（§10.7）。
3. 28 安全清单与固定第三方制品已取得（§10.8）；限定本机的完整 Profile 安装及冻结重装已通过（§10.10），下一步应完成 Linux 整套 Host 验收与部署备份，不可直接套用开发机注册脚本。
4. 本机验证和安装布局核验完成后，再按部署手册切换 runtime、dsh-web、dsh-plugins 三条发布线及 Profile 绝对依赖路径。Grok 扩展和额外磁盘清理不在本轮升级必需项内。

## 9. 回退依据

| 对象 | 回退点 |
|---|---|
| deepseek-harness | 分支 `backup/tzwl-before-013` = `bf8d4921d9`（合并前状态）；合并提交为 `593ee89aa6` |
| dsh-web | 合并提交 `0a01f09c` 的第一父提交 `5e65a315` |
| dsh-passwords | `0a71ac8` 之前为 `2.6.19` 线上同源状态 |
| dsh-plugin-subscriptions | `a9a030b` 的第一父提交；保留本次提交，可另行 revert |
| 28 服务器 | 本轮未改动；已核实 current 与上次 rc.1 基线一致，安全清单见候选目录 `server-28/` |

## 10. 续跑记录

### 10.1 独占验证尚未取得

使用 Node `22.21.1` 执行 `pnpm run test`，日志为 `/tmp/dsh-013-harness-test-20260908.log`。运行期间发现另一项任务同时执行 `npm exec vitest run packages/experimental/code-runtime-python/tests/runtime.spec.ts scripts/oxlint-contract.spec.ts`，并出现不属于本次执行的新 `spill-local.spec.ts` 改动。本轮已主动中断，退出码为 130；这不是通过的测试结果，也不能作为独占复跑证据。已保留另一任务的进程和修改。

中断前记录到 subagent-acp 三项 5 秒超时，以及 oxlint-contract 五项失败；没有取得最终断言汇总，暂不据此判断代码原因。

### 10.2 订阅插件已验证并提交

提交 `a9a030b6ae06b9042c79533fe3681c5c10c1942a`（`fix(codex): discover subscription models from the live catalog`）。除原有目录改动，还补齐 `resolveOwnModel` 的输入模态传播，避免纯文本模型在实际选择后仍被宣称支持图片；补充目录、版本、配置和缓存回归，并更新 README 双语。

Node `22.21.1` 下 `npm test` 为 378 项：372 通过、6 跳过、0 失败；`npm run build` 通过，包含 Host 和 Client 类型检查。既有登录测试会探测 macOS Keychain，本次因已有登录凭据而跳过 6 项文件存储测试；没有输出或修改凭据，也没有调用真实 token/API 接口。日志为 `/tmp/dsh-013-subscriptions-test.log` 和 `/tmp/dsh-013-subscriptions-build.log`。提交尚未推送。

### 10.3 空白会话分配已验证并提交

提交 `388f80b`（`fix(workspaces): allow assigning registered blank sessions`）。工作区清单保留 live 和可读取的持久化空白会话，过滤已归档、已删除及目录不存在的记录；只有明确的 `SESSION_QUERY_SESSION_NOT_FOUND` 才按会话已删除处理。服务缺失或存储失败返回 HTTP 502 / `WORKSPACE_UNAVAILABLE`，设置卡显示错误并支持刷新恢复，避免把失败伪装成空清单。管理员鉴权保持在清单读取之前。

Node `22.21.1` 下 `npm test` 为 392 项：379 通过、13 项既有跳过、0 失败；`npm run build` 通过，包含 Host/Client 类型检查和客户端 bundle。日志为 `/tmp/dsh-013-passwords-test.log` 和 `/tmp/dsh-013-passwords-build.log`。提交尚未推送，28 服务器未改动。

### 10.4 Harness 复核补修

本次复核发现上轮 §2.2 中两个修复仍有遗漏，并补充了授权取消和版本一致性检查：

- 模型重载时不仅保留 aria/title，也保留按钮上可见的推理等级文字。
- 通用工具图片不能由 `read_image` 专属图库完全替代。新增 `tool.call.result-images` 插槽，复用附件插件的会话授权加载器，恢复根调用、嵌套调用及缺少完整卡片元数据的历史图片；有效 `read_image` 卡保持折叠展示且不重复渲染。
- `subagent.prompt` 的父会话授权被取消时也返回 `gateway/cancelled`，并保留已映射的拒绝错误。
- `@deepseek-ai/dsh-principal-access` 从遗漏的 `0.1.2-rc.1` 对齐到 `0.1.3-alpha.1`；静态检查 259 个非 vendor 的 DSH manifest（含根目录和实验包）后无版本不一致，其中正式发布 family 为 249 个包。内部引用使用 `workspace:` / `link:`，无需修改锁文件。

Node `22.21.1` 下，`control.spec.ts` 23 项通过；模型按钮、工具图片、附件、会话投影及导出等 21 个测试文件的 381 项通过；`pnpm run build:lib:client` 通过；构建后的 `image-display.expected.e2e.ts` 4 项通过。日志分别为 `/tmp/dsh-013-control-test.log`、`/tmp/dsh-013-focused-test.log`、`/tmp/dsh-013-client-build.log`、`/tmp/dsh-013-image-display.log`。

`pnpm run test:docs` 首次为 14 个检查通过、1 个配对检查失败。随后核对并修复了 5 对历史合并文档：补中文 principal-access 配置项、持久化 principal/调用引用字段和来源行号，纠正 subagent note 与源码不符的引用菜单描述；限定这 5 对的配对检查通过。

完整 `doc-sync` 期间，Host 编译报 `TS6053`：`scripts/staged-lint-probe-6f516ca8-978e-4d52-ba5d-abe08544a4c2.ts` 被 `scripts/**/*.ts` 纳入程序后已不存在。进程检查确认另一项任务在同一仓库执行 `vitest.mjs run` 全量测试。为停止争用，本任务主动中断自己的 `doc-sync`（退出 130）；中断前 doc graphs 通过，其余检查不能宣称通过。日志为 `/tmp/dsh-013-doc-sync.log`。随后对本任务涉及的 20 个改动文件执行不加载 TypeScript project 的 staged lint 配置，退出 0，日志为 `/tmp/dsh-013-staged-lint.log`。

另一项任务随后把以上改动及其 spill-local 修复一并提交为 `593ee89aa6`，工作区恢复干净。本任务未终止其进程。§2.3 是另一任务的测试记录，§10.1 和本节是本任务实际执行结果，两者不能混作同一次独占验证。

确认其他测试/构建进程结束后，在固定提交 `593ee89aa6` 上重新执行 `DSH_GATE_CONCURRENCY=2 pnpm run doc-sync`：33 项全部通过，耗时 179 秒；随后 `pnpm run lint:contracts-ready` 通过。后者复用文档门禁已生成的 Host 构建，不重复构建。日志为 `/tmp/dsh-013-doc-sync-final.log` 和 `/tmp/dsh-013-lint-final.log`；本次未再出现 TS6053。

### 10.5 dsh-web 补推与 alpha.1 追加验证

本轮按既有合并门禁记录补跑 `pnpm test:scripts`（251 项全部通过）与 `pnpm docs:check`（通过）。`git diff --check` 发现上游四个文件带多余末尾空行；机械清理并同步对应双语 hash，提交 `cec0cde4`，未改变测试或产品行为。

执行 `git push git@github.com:sdwhwzp/dsh-web.git master:master` 后，`git ls-remote` 与本地 `HEAD` 均为 `cec0cde4ca890c94e5d803690fbd4b747b5e2a43`，工作区干净。日志为 `/tmp/dsh-013-web-scripts.log` 和 `/tmp/dsh-013-web-docs.log`。本机没有 `gh` 命令，本轮未核对 GitHub Actions 状态；推送不代表部署，本任务未切换 28 发布。

后续发布盘点发现，dsh-web 当前安装的 `@deepseek-ai/dsh-api-session-controller` 实际为 `0.1.2-rc.1`，根目录与直接子包共 208 项 DSH 开发依赖声明仍为 `^0.1.2-rc.1`。这些声明不是运行时 peers，但此前 Web 构建和测试不能据此当作 alpha.1 SDK 兼容性证据；正在从 `cec0cde4` 建立不带凭据和 node_modules 的隔离源码副本，以同批 runtime tgz 的显式 overrides 补做验证，真实 dsh-web 仓库保持不变。

隔离安装确认 259 个根依赖包与 2563 个 DSH/vendor 引用均匹配本批制品后，alpha.1 类型检查发现实际兼容性错误：`dsh-pet/src/event-projection.ts` 仍投影已移除的持久化 `assistant/chunk`，测试也构造旧事件。新 `assistant/live-chunk` 仅属于 Client 投影；Host 必须改订阅 `agent/assistant-stream` 并保留文本/推理增量的宠物状态。已在隔离副本迁移到 Host 流式事件，保留思考/书写增量；start/end 帧不发放奖励，奖励仍由持久化 turn/end 去重处理。监听随全局启停注册和释放，账号级视图保持 idle、无跨账号会话摘要。不能将已推送 `cec0cde4` 直接当作包含该修复的 alpha.1 Web 制品。

隔离副本的 Pet 服务测试 47 项通过；全工作区 typecheck（20 个子项目）和 build 通过；随后 `pnpm -r --workspace-concurrency=2 test` 为 3634 通过、1 跳过、0 失败，其中 Pet 全包 478 项通过。使用原测试预算，未调用真实模型 API，也未运行 Electron 或线上 Host smoke。日志、SDK 来源审计和可应用源码补丁保存于候选目录 `dsh-web-validation/`；真实 dsh-web 仓库仍未应用该迁移。Pet 与聚合包最低 Harness 版本、直接 `dsh-agent` 开发依赖、README 双语和 Agent Note 已单独补成候选 patch；文档配对和 aggregate 检查通过。三个独立 patch（Pet 源码、task-board 测试、发布声明/文档）可共同应用到 `cec0cde4`。正式新版本、统一 SDK 发布锁和 CI/release 的 rc.1 smoke 固定项尚未完成，不能当作已发布修复。

全 Web 测试日志还暴露一个既有 task-board 测试问题：对旧 `modelId` 字段的断言位于生产 catch 内，抛出 AssertionError 仍被吞掉并显示用例通过。alpha.1 的选择请求字段是 `model`、响应字段是 `selected`，生产实现正确；已将测试断言移到调用完成后对捕获请求检查，单文件 15 项通过；单独保存测试修复补丁，防止后续生产 catch 掩盖断言失败。

### 10.6 固定提交上的全量测试

确认没有其他任务并跑测试或构建后，使用 Node `22.21.1` 在 `593ee89aa6` 上执行 `pnpm run test`，日志为 `/tmp/dsh-013-harness-test-final.log`。结果为 1066 个文件通过、6 个失败、9 个跳过；18196 项通过、9 项失败、118 项跳过，耗时 653.60 秒，退出码 1。

| 失败 | 最终错误 |
|---|---|
| oxlint-contract 的最终诊断输出；code-block 的懒加载语法；webworker-packer 的插件清单；Inspector 两项 Worker 回滚 | 5 项外层测试超过默认 5 秒 |
| app-boot HMR 的刷新失败广播 | 外层测试超过 20 秒 |
| Python 日志/返回值峰值测试 | 预期 `output-limit`，实际为运行时 `timeout`（20 秒） |
| Python 两项 600 万元素宽度测试 | 实际返回 `wall-clock ceiling reached (60000ms)`，不能归入 Vitest 默认 5 秒超时 |

随后仅选择这六个文件中的九项失败用例，使用 `pnpm exec vitest run <六个文件> -t <九项用例名称>`，保留原配置、预算和断言：9 项全部通过，293 项因名称筛选未执行，耗时 58.80 秒。日志为 `/tmp/dsh-013-failed-cases.log`。没有扩大全局/用例超时、降低断言或修改这些测试；本轮聚焦通过说明失败在该次运行未复现，不能把完整 `pnpm run test` 改记为通过，也不能据此证明并发稳定性。Harness 合并尚未推送。

追加只读审计已保存为候选目录 `validation-logs/harness-flake-review.md`。Inspector 两例的 5 秒外层预算小于所启动 Worker 的合法预算，且存在先申请空闲端口再关闭重绑、断言失败后缺少 finally 清理的问题；这些静态缺陷不等于已证明本次超时根因。Python 的大数据用于 Linux 地址空间限制下的内存回归，macOS 不提供同一限制；缩小数据必须先用 Linux 负对照证明仍会击中原缺陷，不能仅为消除超时减少样本。其余失败仍缺少具体阶段耗时证据。本次没有修改六个测试文件、扩大预算或新增 skip。

### 10.7 发布依赖对齐

五个业务插件本机直接声明的 DSH 依赖均已软链到 Harness `0.1.3-alpha.1`，但发布 manifest 仍为 `0.1.2-rc.1`。本地 semver `7.8.5` 验证 `satisfies('0.1.3-alpha.1', '^0.1.2-rc.1')` 为 false，本机构建成功不能代替制品安装核验。

按前次升级惯例整体切换目标线，保留各仓库已有的精确/caret 写法；候选版本为 subscriptions `0.6.4`、passwords `2.6.20`、at-file `0.7.3`、spend `0.6.6`、NAS `0.2.6`。同时更新 README、at-file 插件 manifest、passwords 安装器/Docker 默认版本和版本准入测试，共 20 个文件。品牌插件没有 DSH 依赖，无需改版。上述为未提交的候选 diff；隔离生成锁阶段未改真实锁或 node_modules，后续 at-file 构建的自动依赖同步另记下文。

在隔离临时目录使用 npm `--package-lock-only --ignore-scripts` 生成锁时，passwords 因官方 registry 缺少 `@deepseek-ai/dsh-api-session-controller@0.1.3-alpha.1` 返回 ETARGET。Spend 和 NAS 的 caret 范围分别解析出 44 和 25 个 `0.1.3-alpha.2` DSH 条目，均未回填，避免混入未经本轮验证的版本。没有使用 `--force`、`--legacy-peer-deps` 或伪造 resolution/integrity。仅确认了首个缺包，未声称其他 exact 依赖在 npm 可用。

随后直接执行 `npm view @deepseek-ai/dsh-api-session-controller@0.1.3-alpha.1 version --registry=https://registry.npmjs.org`，官方 registry 同样返回 E404 / `No match found for version 0.1.3-alpha.1`；不是仅凭镜像安装失败判断缺包。

候选 patch 已按仓库保存到 `/Users/wangzhipeng/macproject/deploy-artifacts/20260908-013-candidate/plugin-dependencies/`，并记录基线提交、涉及文件以及 patch/旧锁 SHA-256；排除了本改动总览。锁文件和插件制品安装核验仍未完成，不能直接将这些候选 diff 当作可发布版本。下一步需以同批 runtime tarball 和部署 Profile 的显式 overrides 核验实际安装布局。

追加本机检查：subscriptions、passwords、at-file、NAS 的已有 build 均通过；passwords 两项版本/peer 固定测试通过。Spend 没有 build 或 typecheck 脚本，执行已有 `npm test` 为 42 通过、1 失败；唯一失败是候选 package `0.6.6` 与旧 lock `0.6.5` 未同步，依赖锁仍待生成，该检查记为未通过。记录与日志位于候选目录 `plugin-dependencies/light-validation/`。

at-file 的 `pnpm run build` 被 pnpm `11.24.0` 默认 `verify-deps-before-run=install` 自动触发依赖重整，虽未显式运行 install，node_modules 仍发生了变化。构建前后全部已跟踪文件、锁和 gitstatus 均相同；当前 14 个预期直接 DSH peer 均链接本机 Harness `0.1.3-alpha.1`。未逐项记录同步前的链接，不能声称链接前后完全相同；另有一个不在 manifest 中的悬空 `dsh-client-runtime` 链接，来源未确认，未擅自删除。其他候选锁仍与基线一致，依赖候选均未提交。

### 10.8 28 部署准备与缺失输入

本轮发布 family 为 249 个 DSH 包，均为 `0.1.3-alpha.1`；比 rc.1 增加 client-file-upload、session-format、session-format-catalog、session-format-v0-to-v1、session-format-v1-to-v2。`vendor/` 与 `native/` 相对合并前提交无差异，可按实际名称与 SHA-256 复用旧制品。最终运行时包数应由 tgz 内 manifest 逐项对账，不能由旧总数推算。

部署手册 §26 要求复用 sidebar `0.18.1-alpha.0` 和 Office `0.1.3`，且 28 Profile 不含 dshmarket；通用 `scripts/profile-plugins.json` 却仍默认 sidebar `0.15.2`、Office `0.1.2` 并补入 dshmarket。`register-plugin.mjs` 还会改写本机 dsh-web 链接和触发构建，因此本轮不得直接用该脚本重建 28 Profile。应从 28 当前 Profile 副本更新已在用依赖的绝对路径，保留 bundles 和补丁配置。

本机未找到 rc.1 的完整发布清单及固定第三方 tgz 副本。使用 `BatchMode=yes`、`StrictHostKeyChecking=yes` 分别对 `tzwl3@192.168.10.28` 和 `tzwl3@100.64.0.5` 发起只读 SSH 检查，均被 `Permission denied (publickey,password)` 拒绝，未取得任何远端配置，也未修改服务器。使用者随后提供本地地址文档 `/Volumes/External/projects/voice/ai地址.md`，本任务通过该文档中的 28 登录信息成功连接；凭据仅在内存及匿名管道中传递，没有写入仓库、日志、环境变量或命令参数，也未连接文档中的 30。三条 current 与手册基线一致：runtime/plugins 为 `20260904-204003-bf8d4921d9-rc1`，Web 为 `20260905-083633-5e65a315-rc1`。已只读取得 runtime/Profile 依赖清单、旧制品名称与 SHA-256。安全记录保存在候选目录 `server-28/`；该目录没有原始口令、`.env`、账号数据或完整敏感配置。

实测 runtime 的 packageManager 为 pnpm `11.7.0`，Profile 为 `11.24.0`，后续安装验证分别使用对应版本。runtime 的 254 个直接依赖由 244 个 DSH、9 个 vendor 和 `dshmarket@1.38.1` 构成；Profile 的 11 个直接依赖和 12 个 bundles 均不引用 market，不能把已安装与启用混为一谈。Profile 当前使用 subscriptions `0.6.3`、passwords `2.6.19`、at-file `0.7.2`、Spend `0.6.5`、NAS `0.2.5`。

已取回 sidebar `0.18.1-alpha.0`、Office `0.1.3` 和旧 Cordis 的原始 tgz，并补取品牌 `1.0.3`、GenUI `0.9.8`、WeKnora `0.1.2` 的原包，均通过远端 SHA-256 对账；没有升级 WeKnora。其余 8 个 vendor tgz 与本机新候选字节相同；Cordis 的 32 个其他成员相同，唯一差异为 `package.json` 排版，JSON 内容相同。补取的三个包另存 `server-28/additional-artifacts/` 及独立哈希清单。

旧发布没有留存 Landlock tgz，但 runtime 实际装有 entry 和 linux-x64 `0.1.1`，锁中另有 linux-arm64 `0.1.1` 可选包；正式 registry SHA-512 已记录在 `native-lock.json`。本次没有重打这些已安装原生包，也没有在 macOS 冒称 Linux 功能通过。

### 10.9 运行时候选制品与隔离安装

在干净提交 `593ee89aa6ec8496e26dd2f4d3fbaab76b41c65a` 上使用 Node `22.21.1` 完成 official 构建、DSH/vendor 打包与现成 native 入口打包，得到 249 个 DSH、9 个 vendor、1 个 native 入口，共 259 个 tgz。客户端记录为 `profile=official`、`commit=593ee89`、`version=0.1.3-alpha.1`，共 222 个客户端制品。`hygiene` 16 项通过；native 入口的离线验证通过。

制品保存在 `/Users/wangzhipeng/macproject/deploy-artifacts/20260908-013-candidate/runtime/`，`tarballs.json` 记录名称、版本、源码提交与 SHA-256，`SHA256SUMS` 可供逐项校验。Linux Landlock 的两个平台二进制不在本机，未构建或假冒该平台验证；后续应从旧发布取得并校验。

官方 `verify-packed-install` 的 npm 路径失败：Node `22.21.1` 自带 npm `10.9.4` 在 Arborist `loadPeerSet` 内访问空的 `parent.edgesOut`，未完成安装，也未执行 CLI 版本验证。日志为 `/tmp/dsh-013-verify-packed-install.log`，不能把它记为通过。

另按 28 的实际 pnpm 安装方式建立独立 `pnpm-consumer`：dependencies 与 overrides 均显式指定本批 259 个 tgz。使用 pnpm `11.7.0` 安装成功，耗时 2 分 44.7 秒；镜像下载一个第三方 macOS SDK 时的临时错误由 pnpm 自身重试恢复，未更换其版本。安装后的 `dsh --version` 为 `0.1.3-alpha.1`；259 个实际 `@deepseek-ai` 包实例均与本批制品相符，3528 个安装文件逐字节一致，锁内 tarball 来源及 SHA-512 均匹配，未混入 alpha.2。细节见 `runtime/pnpm-installation-audit.json`。这是 macOS 隔离安装和 CLI 版本证据，不代替 28 的 Profile、Linux 原生功能或完整服务启动验收。

### 10.10 插件部署候选的封装与验证

源码开发锁与线上 Profile 的 pnpm 锁用途不同。按部署手册 §7.5、§7.6 和 §26，可在本机用同批 runtime tgz、明确的 overrides 和 28 固定第三方制品生成独立部署候选锁；该验证不等于五个仓库的通用发布锁已完成。passwords 仍打包旧 `npm-shrinkwrap.json`，其安装器在依赖不完整时会运行 `npm ci`，这条安装恢复路径必须继续记为未验证，不能由 Profile 安装成功代替。

首次对 subscriptions 执行 `npm pack --dry-run --ignore-scripts --json` 时，本机 npm `10.9.4` 的 Pacote `prepareDir()` 仍运行了 `prepare`，触发 Host/Client 重建并成功结束。源码检查确认该方法未检查 `ignoreScripts`；输出混入构建日志使清单解析失败，后四个仓库未执行这条命令。subscriptions 的 gitstatus 没有新增已跟踪变化，该次 dry-run 未生成 tgz；重建了本机 lib 产物。随后直接使用 npm 自带的 Arborist / npm-packlist 读取五库清单，得到 230、88、36、22、13 个文件，无实际 `.env`、凭据存储或私钥文件名，passwords 的已声明 `.env.example` 和旧 shrinkwrap 均保留。清单及原始日志见候选目录 `plugin-pack-plan/`。随后按真实清单封装限定本机部署验证的 tgz，没有冒称官方 npm pack 成功。第一阶段用 pnpm `11.7.0` 安装 259 个 runtime 包与 5 个新插件，安装及冻结重装均通过；锁文件 SHA 不变，5 个插件的 Host 入口可导入（未 apply 服务），`dsh --version` 为 alpha.1，264 个安装实例的 3917 个文件与候选 tgz 一致。正式 registry 取得的两个 Linux 原生可选包也已按 28 锁内 SHA-512 核验。完整 Profile 的首个候选使用 pnpm `11.24.0` 安装成功，但原目录及空目录的冻结安装均以 236 失败：两个被 macOS 跳过的 Linux 可选依赖被链接到 `.tgz` 文件，读取其 `package.json` 时出现 `ENOTDIR`。静态检查定位到 pnpm 在判断 skipped 之前处理 `file:` 引用；该失败没有被删除或改记为通过。

修正候选只撤销两个新增的平台包 file overrides，保留 native entry 的 exact `0.1.1` 可选依赖及 28 原锁中的正式 registry SHA-512；其余 DSH、runtime 和第三方解析不变，没有删除可选包或更换 pnpm。修正后安装、原目录冻结重装及全新空目录冻结安装全部通过。规范候选为 `plugin-profile-validation/profile-registry-native-consumer/`，锁 SHA-256 为 `76c58ddbcced60fbe4edc514a4a3ed74bc7fdb1b440aa9e7388b297114cb4973`。

该候选共 270 个直接依赖，269 个安装归档实例的 4382 个文件与制品一致，实际 DSH 版本只有 alpha.1；全部 11 个业务/Web Host 入口可用原生 ESM 导入，12 个 bundles 及顺序与 28 一致。另核对链接 Web 副本的 483 项依赖声明、280 个预期实例和 4368 个文件，均匹配已验证的源码副本及同批 runtime 制品。第一次 Office 检查误用 CJS 条件解析 import-only 导出，已改用原生 ESM；原验证 helper 的失败日志仍保留。

最终记录见 `plugin-profile-validation/README.md`、`validation.json` 和 `commands.json`。以上是 macOS 的安装、依赖与入口导入验证，未启动 12 个 bundles 组成的完整 Host、未执行 Linux 原生功能，也未切换服务器。源码发布锁/版本、passwords 安装恢复路径、Web release smoke 和 §10.6 的全量测试失败仍分别保留，不因候选安装通过而自动消除。
