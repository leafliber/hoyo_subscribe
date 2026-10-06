# ADR-0025：实现可选 Web Push——独立 VAPID 秘密、登记推送服务、两步可见激活与按日外发预算

- **状态**：已接受（所有者 2026-10-06 要求实施："帮我将当前没有实现的web推送的功能完成，包括文档和代码"）。代码已在工作区完成，待验收与所有者部署；**生产开放仍由所有者决定**（见"待确认"）。
- **日期**：2026-10-06
- **提出者**：所有者（实施要求）；执行者（下列实现决定）
- **需要所有者批准**：是。实施已获批准；新增部署秘密 `PUSH_VAPID_PRIVATE_JWK` 的注入、`push_enabled` 的开启与 P6-03 的 E3 取证由所有者执行。没有新增收费产品、供应商或附录 A 参数。
- **与已有决定的关系**：
  - BUILD_PLAN 2026-10-06 记载"P6 三张卡与 F5 一张可选 Push 不做"。本 ADR 按所有者新的要求改为实施 P6-01、P6-02 的代码，F5-01 的网页，以及 P6-03 的取证清单（真实客户端取证仍需所有者）。
  - 不改变任何禁止清单条目；不触碰邮件预算模型（ADR-0003）。

## 背景

主方案 §7.8 规定了 Push 的合同：用户主动授权当前浏览器后，由会话/CSRF 校验创建归属账号的 pending 绑定，验证精确 HTTPS 推送服务域名、端点与加密密钥，再发可见激活通知；Service Worker 用狭窄 receipt token 与随机 challenge 确认后 active。同 endpoint 同 owner 幂等、不同 owner 冲突不抢占；测试、激活、重试计入 Push 预算；接口不得成为任意 Webhook/SSRF 入口；404/410 停用端点，401/403 先查 VAPID/配置、不批量删除用户，临时错误退避。前端 §9.3 规定了"在当前浏览器开启通知"的交互；D3 §2.8 规定只给事实。

合同没有写死的部分（VAPID 密钥怎么保管、哪些主机算推送服务、激活通知何时发、预算怎么记账、哪些通知走 Push、401/403 时具体做什么）需要在实现时决定。本 ADR 把这些决定写清楚。

## 受影响的合同

| 文档 | 章节 | 现有规定 | 本 ADR |
| --- | --- | --- | --- |
| 主方案 | §7.8 | 验证精确 HTTPS 推送服务域名 | 登记表：`fcm.googleapis.com`、`updates.push.services.mozilla.com`、`web.push.apple.com` 精确主机；WNS 只接受"一个 DNS 标签 + `notify.windows.com`"。端点必须是规范化后逐字不变的 https URL，无用户信息、端口、片段，有路径；外发前对解密出的端点再校验一次；不跟随重定向 |
| 主方案 | §7.8 | 创建 pending 绑定后发可见激活通知 | 两步：`POST` 登记并只交付一次 receipt token；页面把 token 存进本机后，`PATCH {action:"activate"}` 才发激活通知（否则激活通知可能先于 token 到达 Service Worker，回执无从发出）。同一轮激活最多 `PUSH_ACTIVATION_ATTEMPTS` 次、`PUSH_ACTIVATION_TTL` 内有效，本轮发出的挑战都可确认 |
| 主方案 | §7.8、§9.4 | 激活期限、服务租期、宽限期 | 状态 `pending / active / paused / gone`。暂停原因 `user / safety / lease_expired / restore`。**暂停后恢复必须重新验证接收**（开启新一轮激活）。`gone` 只来自推送服务明确 404/410 |
| 主方案 | §7.8、§9.1 | 测试、激活、重试计入 Push 预算 | 按 UTC 日计数（`capacity_state` 的 `push:send:<日>`、`push:test:<日>`、`push:new:<日>`）。每次外发调用（含重试与结果不明）计一次。取消/撤回、重要更正、晚发现为关键外发，可用到 `PUSH_SEND_DAY`；其余（常规提醒、新活动、激活、测试）以 `PUSH_SEND_DAY − PUSH_CRITICAL_RESERVED_DAY` 为限 |
| 主方案 | §7.8 | 401/403 先查 VAPID/配置，不批量删除用户 | 自动关闭运行开关 `push_enabled`（写系统审计 `control_disable`，原因 `incident_containment`），不删除、不改动任何绑定；业务消息转退避等待，维护者核对 VAPID 配置后在运行开关页重新打开 |
| 主方案 | §7.8 | 临时错误退避 | 408/429/5xx：`WATCHDOG_INTERVAL × 2^(n−1)`，推送服务给出更长的 Retry-After 时取其较大者；到期（`expires_at`）后不再试。超时与异常为结果不明，不盲目重发；Service Worker 的处理回执可以把它确认为已接受 |
| 主方案 | §7.1 | Push 目标为 binding_id | 业务通知与邮件共用同一兴趣匹配（`matchesSubscriptionInterest`）；Push 不分席位/常规两层，订阅里选了的规则与变更通知都推送。通道生效时间 = 绑定的 `activated_at`，须不晚于发生项 `due_at` |
| 主方案 | §8.1 第 10 组、第 12 组 | push_bindings；deliveries/outbox | 迁移 0029：push_bindings 增加激活、测试、暂停事实列；新增 `push_messages`（"实际哪一条推送"，与邮件的 MailOutbox 对应）；`users.push_revocation_version` 与触发器 `trg_push_revoke` |
| 主方案 | §8.3、§10.2 | VAPID 用途隔离、分开保管 | VAPID 私钥是独立部署秘密 `PUSH_VAPID_PRIVATE_JWK`（JWK，P-256），**不从 `CRYPTO_MASTER_SECRET` 派生**：订阅与公钥绑定，根秘密轮换不能让全部订阅失效。Keyring 的 `vapid` 派生槽保持预留不用。VAPID `sub` 取 `SITE_ORIGIN` |
| 主方案 | §10.1 | 独立开关覆盖 Push | 公开能力 `push` = `push_enabled` ∧ `outbound_enabled` ∧ 部署配置齐备 ∧ 非只读（原实现恒含一个 unknown） |
| 前端 v1.0 | §9.3、§10.1、§10.2 | 本浏览器通知；账号页 Push 分组；退出并暂停 | 订阅页"浏览器通知"卡片；账号页"浏览器通知"分区列出本账号全部浏览器；"退出并暂停本浏览器通知"先暂停（用当前会话）再退出，逐项报告 |
| D3 | §2.8、§2.10 | Push 只给事实；账号摘要 Push 为 unknown | `GET /api/v2/me/push-bindings` 视图（`PushChannelViewSchema`）；账号摘要的 Push 一行给按状态计数 |

## 决策

### 1. 推送服务与端点

- 登记表在 contracts `PUSH_SERVICE_HOSTS`，校验函数 `checkPushEndpoint` 由 Worker 与网页共用。新增服务须先改登记表并经 ADR。
- p256dh 必须是 65 字节未压缩点且 WebCrypto 能导入（在 P-256 曲线上），auth 必须是 16 字节。
- 外发：`POST` 端点，`Content-Encoding: aes128gcm`（RFC 8291，每条消息一次性 ECDH 密钥与 salt），`TTL` 到消息自身失效为止，关键外发 `Urgency: high`，VAPID ES256 JWT `exp` 为 1 小时。超时取执行器墙钟上限 `EXECUTOR_BATCH_WALL_LIMIT`。不读响应正文。

### 2. 绑定、receipt 与激活

- 所有者管理：`GET/POST /api/v2/me/push-bindings`，`PATCH/DELETE /api/v2/me/push-bindings/{id}`，`POST …/{id}/test`、`…/{id}/renew`。要求 active、非恢复受限会话与绑定会话的 CSRF。
- receipt 窄能力：`POST /api/v2/push-bindings/{id}/activate`（receipt token + 挑战）、`…/{id}/processed`（receipt token + 消息 ID）。不读 Cookie、不做 CSRF（没有可被跨站借用的环境凭据），同源 Origin 校验照常；凭证不符、挑战不符、期限已过一律同一个 404，响应体只有结果码。
- receipt token：服务器生成 `SECRET_BITS` 随机串，只在登记响应里出现一次，库里只存 SHA-256；页面存进 IndexedDB 与 Service Worker 共用。同 endpoint 同 owner 再登记只轮换 token（幂等，绑定身份不变）。
- 激活挑战：每发一次生成新挑战，库里只存哈希列表（至多 `PUSH_ACTIVATION_ATTEMPTS` 个）；激活、暂停、过期即清空。同一绑定两次激活通知之间至少间隔 `PUSH_TEST_COOLDOWN`（与测试通知同属用户触发的可见通知）。
- 本人上限 `PUSH_USER_MAX` 计本人全部绑定（含失效与过期 pending，删除或替换即释放）；全站 `PUSH_TOTAL_MAX` 计 active + paused + 未过期 pending；`PUSH_PENDING_MAX` 计未过期 pending；`PUSH_ACTIVE_MAX` 在回执激活时核对；`PUSH_NEW_DAY` 按 UTC 日计新建。同一浏览器的失效或激活过期的旧绑定，在同一事务内被新登记替换，不额外占名额。
- 登记、恢复、续期计入普通修改日额（§9.5"设备管理"）；暂停与删除是终止路径，不受日额、能力开关、订阅状态阻断。

### 3. 业务外发

- 发生项起步（邮件冻结受众 order 上界）后，为它补建 `occurrence:{id}:push` 待办，按同一上界 keyset 分页；每页 Delivery（channel=push，target=binding_id）、`push_messages` 与游标同一条件提交。去重族与邮件同一规范串。
- DeliveryDO 的同一串行 tick 里，Push 是独立单元（失败只退避 Push 自身，键 `delivery:push-backoff`）。外发前即时复核：Delivery 仍待发、发生项未改期未过期、绑定仍 active 且租期有效且在 due_at 前激活、账号与兴趣仍匹配。
- 预算在领取外发的同一条件提交里记账；当日用尽时非关键消息推到下一 UTC 日（仍受自身有效期约束），过期则以 `push_budget_exhausted` 跳过。外发顺序按优先级、创建时间、随机 ID，不按注册顺序。
- 邮件调度只取 `channel='email'` 的 Delivery（原有几处查询未区分通道，邮件分类器会把 Push Delivery 标成 skipped，本次一并修正）。

### 4. 租期、活动水位与回收

- 激活即续期到 `PUSH_LEASE`；真实处理回执按 `PUSH_RECEIPT_WRITE_INTERVAL` 合并写入（续租 + `users.last_push_processed_at`，同一事务）；测试与续期按钮是账号操作续期。
- 回收（P5-02 维护）：租期到期 → paused（`lease_expired`）；暂停或失效超过 `PUSH_STALE_GRACE` → 删除；pending 过激活截止 → 删除；结束的 `push_messages` 与 Delivery 同一期限清理。**修正**：原代码把 `PUSH_STALE_GRACE`（单位天）按秒换算，宽限会只有 30 秒；改由 contracts 的 `pushStaleCleanupBefore` 换算。
- 处理回执的水位写入失败时，与 Feed 水位相同地记 `activity_write_failures`（指标 `push_processed_merge`）并持久暂停回收。

### 5. 安全暂停与生命周期

- 紧急停用、恢复登录（P2-05 安全暂停挂接点）与删除账号（P2-07）在同一账号事务里推进 `users.push_revocation_version`，触发器把该账号全部 pending/active 绑定转为 paused（`safety`）并清空挑战。紧急停用仍不消费恢复码。换邮箱不影响 Push（绑定归属账号）。撤销会话不撤销 Push（前端 §10.1）。
- 删除账号的分页清理删除绑定（端点与密钥密文随之清除）；导出不含任何 Push 秘密。
- 灾难恢复（P5-03 工具）：Push 端点与密钥按受控密文校验；恢复后全部绑定暂停（`restore`），receipt 撤销，须重新登记与验证。

### 6. 网页

- `/sw.js`：只显示可见通知、报回执、处理点击（只打开站内路径）；不缓存、不拦截请求、不做后台同步或心跳。
- 订阅页卡片只在能力开放、或本人已有绑定时出现；点击前不申请权限、不登记、不发通知；权限与绑定状态分开显示；只有合法回执后才显示"本浏览器接收验证通过"；权限被拒只说明去设置调整；绑定属于其他账号时解释冲突，用户可明确选择"为当前账号重新创建本浏览器的通知订阅"（退订后重新订阅得到新端点，不认领或删除他人绑定）。
- 新增 `manifest.webmanifest`：iPhone/iPad 只有添加到主屏幕的网页应用能接收推送。

## 价值

- 用户多一个能主动弹出提醒的可选通道，且接收能力经过可见激活与回执真正验证，而不是"平台接受即算成功"。
- 关键通知（取消、更正、晚发现）有预留额度，不会被常规提醒挤掉。
- VAPID 配置错误时自动止损（停发、不删用户），维护者核对后恢复。

## 成本

- 迁移 0029（只增列、增表、增索引与触发器；push_bindings 此前无写入路径，无数据迁移）。
- 每条 Push 外发一次 D1 条件写与一次推送服务请求；Workers 外发请求不另计费。`PUSH_SEND_DAY` = 5,000/日封顶。
- 不新增收费产品、供应商或附录 A 参数。

## 安全影响

- **新的写入口**：receipt 端点不需会话。授权是 256 位随机 token（只存哈希）+ 本轮随机挑战或消息 ID；它只能把本绑定转 active、记一次处理回执，不能读邮箱、改账号、改偏好或管理其他设备；不同原因一律 404，不泄露绑定是否存在。
- **SSRF**：外发目标只来自登记表内的推送服务主机，登记与外发前各校验一次，不跟随重定向，不读正文；无法借此请求任意 URL。
- **端点与密钥**：受控密文（AAD 绑定记录类型与绑定 ID），日志白名单与禁止字段规则已覆盖 endpoint、p256dh、vapid；端点与 token 不进 URL。Workers Logs 的调用日志只会看到绑定 ID（UUID，不授权）。
- **存在性**：端点已归属其他账号时返回冲突。能提交该端点的只有持有它的浏览器本身，不构成按邮箱的存在性泄露。
- **VAPID 私钥**：经 Wrangler secret 注入，Worker 内以不可导出的 CryptoKey 使用。按 §10.2「分开保管」，所有者生成时在仓库外的加密离线位置留一份（`generate-vapid.mjs --out`：权限 0600 新建，拒绝覆盖与仓库内路径），灾备恢复或重建 Worker 时用它重新注入同一把；仓库、备份包、对话里都没有它。

## 预算与容量影响

- 邮件四池（ADR-0003 的三个日池）不变。
- Push：`PUSH_SEND_DAY`、`PUSH_CRITICAL_RESERVED_DAY`、`PUSH_TEST_DAY`、`PUSH_NEW_DAY` 与各存量上限按附录 A.4 生效；A.5 已有的四条 Push 等式不变，无新增等式。

## 回退

- 关闭 `push_enabled` 即停止新的登记与一切 Push 外发（已在途的单条请求除外）；用户仍可暂停、删除绑定。
- 代码回退到本次改动之前（main `346fbbb`）：`push_enabled` 从未打开过（没有任何 Push 绑定或 Push 投递）时可直接回退，0029 的列、表与触发器留在库里，旧代码不读写（只增不删）。**打开过之后不要直接回退**：旧代码的邮件调度不区分渠道，会把未完成的 Push 投递当成待发邮件；旧回收把 `PUSH_STALE_GRACE` 按秒换算，暂停的绑定会在租期到期约 30 秒后被删；Service Worker 的回执会落到不存在的路由。此时先关 `push_enabled`，把未完成的 Push 投递收尾后再回退——目前没有后台入口，需要维护者出受控 SQL 并核对。已发出的推送无法撤回。
- VAPID 私钥一旦更换，全部现有订阅失效。**目前没有换钥流程**：前端重新开启会沿用浏览器里绑定旧公钥的订阅，服务端对旧绑定外发会收到 401/403 并自动关闭开关。所以不要轮换；离线副本保证丢失 Worker secret 时能注入同一把。确认泄露时先关 `push_enabled` 并保持关闭，补上换钥流程（前端发现公钥变化即重新订阅、旧公钥下的绑定一律置为失效）之后再换。

## 备选方案

- **VAPID 私钥从根秘密派生**：密钥随根秘密轮换而变，全部订阅随之失效；与 §10.2"分开保管"相悖。未采用。
- **登记请求内直接发激活通知**：激活通知可能先于 receipt token 落到本机到达 Service Worker，回执发不出，表现为"偶发激活失败"。未采用，改为两步。
- **客户端生成 receipt token**：可以消除上面的竞态，但重新登记失败时会覆盖本机有效凭证。未采用。
- **401/403 只记指标不停发**：配置错误时会持续烧预算、每条都失败。未采用。
- **Push 沿用邮件的席位/常规两层**：合同未要求，Push 名额（`PUSH_USER_MAX` 等）已有独立约束。未采用。

## 待确认（所有者）

1. 远端应用迁移 0029（先按备份手册备份）；生成 VAPID 密钥并在离线位置留一份，再注入 `PUSH_VAPID_PRIVATE_JWK`（见 DEPLOYMENT_PREREQUISITES §1）；然后部署。
2. 是否、何时在运行开关页打开 `push_enabled`。打开前建议先完成 P6-03 的取证。
3. P6-03：桌面、Android、iOS 主屏幕 Web App 与目标网络分别取证（`docs/evidence/p6/README.md`）。**中国大陆网络下 Chrome 等依赖 Google 推送服务（FCM）的浏览器可能无法接收**；未取证前不得对外承诺这些浏览器可用。
