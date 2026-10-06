# P6 可选 Web Push（Worker 侧）

依据：主方案 §7.1、§7.3、§7.4、§7.8、§8.1–§8.3、§9.1、§9.4–§9.6、§10.1–§10.2，附录 A.4；D3 §1.2、§2.8；ADR-0025。
共享规则只在 `packages/contracts/src/push.ts`（端点登记表、状态与视图、推导置灰、预算与期限换算、响应分类）。

## 文件

| 文件 | 职责 |
| --- | --- |
| `config.ts` | 部署配置：`PUSH_VAPID_PRIVATE_JWK`（独立秘密）+ `SITE_ORIGIN`（VAPID sub）+ 三个根秘密；缺一即未配置 |
| `crypto.ts` | RFC 8291 aes128gcm 加密（附录 A 向量测试）、RFC 8292 VAPID ES256、SHA-256 |
| `client.ts` | 一次 HTTP 外发：外发前再校验端点、不跟随重定向、有超时、不读正文 |
| `outbound.ts` | 载荷构造（激活 / 测试 / 业务）、加密外发、结果落库；401/403 自动关闭 `push_enabled` |
| `store.ts` | 行 → 视图投影、容量与日额余量、端点与密钥的受控密文 |
| `service.ts` | 本人管理：读取、登记（同 owner 幂等 / 替换失效旧绑定）、暂停、重发/恢复激活、测试、续期、删除 |
| `receipts.ts` | receipt 窄能力：`activate`（token + 本轮挑战）与 `processed`（token + 消息 ID，合并写入） |
| `routes.ts` | 外壳路由（user 域 + capability 域） |
| `hooks.ts` | 安全暂停（紧急停用、恢复登录）与删除账号：推进 `users.push_revocation_version`，触发器暂停全部绑定 |
| `delivery.ts` | 业务通知：补建展开待办、按冻结上界分页建 Delivery 与外发记录、有预算的外发、维护、alarm |
| `environment.ts` | DeliveryDO 的依赖（字段密钥、配置、fetch） |

## 状态机

```text
POST 登记 ──► pending（activation_deadline = 现在 + PUSH_ACTIVATION_TTL，attempts = 0）
               │ PATCH activate：发可见激活通知（attempts + 1，冷却 PUSH_TEST_COOLDOWN，至多 PUSH_ACTIVATION_ATTEMPTS 次）
               │ Service Worker：receipt token + 本轮任一挑战 ──► active（租期 PUSH_LEASE）
               │ 激活截止已过 ──► 回收删除；同一端点再登记在同一事务内替换
active ──► paused（user：用户暂停；safety：紧急停用/恢复登录/删除账号；lease_expired：租期到期）
paused ──► PATCH activate ──► pending（新一轮激活，必须重新验证接收）
任意（推送服务 404/410）──► gone ──► 删除或 PUSH_STALE_GRACE 后回收
paused / gone 超过 PUSH_STALE_GRACE ──► 回收删除
```

## 预算与外发

- 计数在 `capacity_state`：`push:send:<UTC 日>`（全部外发尝试）、`push:test:<日>`、`push:new:<日>`，键含日期，不跨日结转。
- 关键（取消/撤回、重要更正、晚发现）可用到 `PUSH_SEND_DAY`；其他以 `PUSH_SEND_DAY − PUSH_CRITICAL_RESERVED_DAY` 为限。
- 激活与测试在请求内同步外发一次；业务通知只由 DeliveryDO 外发（每轮至多 `SEND_CONCURRENCY` 页展开、`MATCH_PAGE` 条外发，受墙钟约束），失败只退避 Push 单元（`delivery:push-backoff`）。
- 结果：2xx 已接受（不是客户端显示）；404/410 → gone；401/403 → 关 `push_enabled`、写系统审计、不动绑定；408/429/5xx → 退避；超时/异常 → unknown，不重发；Service Worker 的处理回执可把 unknown 确认为已接受。
- 不发心跳：只有激活、测试、业务三种可见通知。

## 不做的事

- 不按 endpoint 认领或删除他人绑定；不接受请求体里的 user_id。
- 不把 receipt token、挑战、端点或密钥写进 URL、日志或视图（日志白名单与禁止字段规则覆盖 endpoint、p256dh、vapid）。
- 不缓存页面、不做后台同步（Service Worker 见 `apps/web/public/sw.js`）。

本目录测试使用合成订阅、合成 VAPID 密钥与推送服务替身；无真实推送服务、网络或收费资源。
