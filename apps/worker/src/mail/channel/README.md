# P4-05 邮件通道

依据：主方案 §4.6、§7.5、§8.2、§9.4–9.5，前端 §9.2，D3 §1.1–1.3 / §2.7。

## API 与确认

`GET /api/v2/me/email-channel` 返回 `server_time`、`channel_revision`、两层开关、当前绑定下每层开启同意的版本/时间与最后事件、已保存订阅、脱敏地址及地址版本、租期/最近续租时间/原因、精确名额余量、精确地址抑制、业务发送状态和启用前说明。读取失败的容量/抑制/服务事实显式为 `unknown`。响应 `no-store`，不返回动作表、完整邮箱、凭证或地址 HMAC。

`PUT` 是两个可选开关的更新；未提供的层保留原状态，关闭席位同时关闭常规层。开启请求携带 GET 所见的 `expected_revision`、`email_version`、`subscription_revision`。每个从关闭变为开启的层还必须分别提交 `seat_consent_version` / `routine_consent_version`，值取 `EMAIL_CONSENT_VERSION`；版本代表明确确认 GET 中的地址、已保存内容、发送机会、租期、预算说明。没有任意收件地址参数；未知字段由外壳拒绝。首次启用前调用 P2-05 保存确认判定，并在提交守卫中复查。

成功返回 `{ result: 'completed', state }`；同时申请两层而只有常规子名额满时返回 `{ result: 'partial', state, routine_error }`，席位已开、常规层未开。只申请常规层且满额则返回结构化 `capacity_reached`，既有席位保持。开启拒绝同时返回 `blocked_reason`，与 contracts 的 `emailChannelEnableAvailability` 使用同一个闭合原因。写入时授权仍由数据库核对，浏览器推导不是授权。

`enable` / `disable` 是只追加的同意事件。每次关后再开都有新的 `enable`；重复关闭无写入。只有 `enable` 参与 P4-01 的当前绑定/当前层生效时间计算。两层不写进订阅配置。无规则但有变更通知的订阅可以开启席位。

## 条件提交和安全暂停

容量、会话及 epoch（含恢复登录受限会话）、地址版本、订阅版本、抑制与普通修改日额都放在同一事务的条件守卫。恢复码可选，不是开启前置（ADR-0026）。子名额在该事务内计算；不采用 COUNT 后无条件写入。事务最后的单条审计 INSERT 可写零、一或两条，避免零行打断 `changes()` 链。SQL 失败整批回滚；条件未命中不给成功响应。过期席位仍计入容量，不能仅因租期到期自动释放。

恢复路由 `pauseHooks` 以及账号生命周期 `hooks` 均在 Worker 入口接入。紧急停用、恢复登录、换邮箱、删除账号同批关闭两层。挂钩先幂等铺设关闭行，避免“读取时通道不存在、提交前首次启用”的竞态；关闭事件和关闭开关仍受外层事务守卫控制。换邮箱后旧同意留在旧绑定，新绑定从零同意开始。紧急停用不消费恢复码。

## 后续接线与保留规则

- `renewEmailSeat(db, userId, now)` 是 P5-02 后台扫描的有界单用户续租原语。取 users 三种真实活动水位的最大值，截止时间由活动时刻加 `MAIL_SEAT_LEASE` 推导，CAS 核对活动与通道版本。发送、投递反馈、GET 和仍能登录都不是活动。这个原语不依赖网页访问，不释放沉睡席位，也不替 P5-02 实施回收。GET 的 `lease.background_processing = 'unknown'` 表示调度尚未接线；不能宣传为已经运行。（2026-10-06 现状：P5-02 起每次 Cron 维护逐页调用本原语；但 `view.ts` 仍把 `background_processing` 固定为 `'unknown'`，网页因此显示"后台续租状态未知"，这一字段待另行修正。）
- P4-06 接入退订能力后，向 `makeEmailChannelRoutes` 提供 `sendingAvailable`（需同时覆盖业务发送配置、现有发送开关与业务退订可用性），默认 `false` 如实表示当前业务发送链未开放。（现状：Worker 入口已提供，等于发信可用 ∧ `business_mail_enabled` ∧ 退订可用。）预算事实复用 P4-04 的日账本与 contracts 判定；不发送测试信。
- P5-01 的能力开放开关尚未定义，本卡不另造 `system_state` 键。未来由该卡提供已审定的事实与写入守卫。（现状：开启席位、常规层分别受 `email_seats_open`、`email_routine_enabled` 约束，先预检，再在提交守卫里复查。）
- 同意/撤销历史按参数注册表 `CONSENT_AUDIT_AFTER_CLOSE` 的关闭后保留期交 P5-02 清理；本卡不删历史。账号删除仍沿用既有分页清理，额度消耗不退款。
- 不新增迁移。容量读取扫描当前 `email_channels`（每账号至多一行）；同意读取用既有 user/binding 索引按用户与当前绑定缩小范围，不扫描整个事件历史。请求绑定参数数与用户/历史数量无关。

本目录的集成测试使用合成身份、随机测试密钥与本地 D1；无真实邮件、平台调用或收费资源。
