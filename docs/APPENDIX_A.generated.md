<!-- 生成物：由 packages/contracts/src/params/registry.ts 经 `pnpm params:docs` 生成，请勿手改。 -->
<!-- 文档与运行参数同源是 P1-03 的交付物；与本文冲突时以注册表代码为准并重新生成。 -->

# 附录 A：唯一参数基线（生成版）

> 本文件是主方案附录 A 的**生成视图**：参数值、单位、含义、状态全部来自
> `packages/contracts/src/params/registry.ts`。合同原文见
> `docs/HOYO_OFFICIAL_EVENT_SUBSCRIPTION_PLAN_v2.1.md` 附录 A；邮件部分按
> **ADR-0003（纯日额度模型）** 落地，主方案附录 A.4/A.5 中与之冲突的行以 ADR-0003 为准。

## ADR-0003 修订说明

以下月度参数已废止，**不在本注册表**（AGENTS.md 第 3 节禁止清单，出现即判不合格）：MAIL_TOTAL_MONTH、MAIL_EXISTING_AUTH_MONTH、MAIL_SIGNUP_AUTH_MONTH、MAIL_BASE_MONTH、MAIL_URGENT_MONTH；
envelope 公式、carry、E=1 兜底、认证软线 S、月末半日片段同此。邮件预算为纯日额度模型：
每个 UTC 日独立重置、池间不互借、不跨日结转；唯一平台硬约束是 `PLATFORM_MAIL_DAY_LIMIT`（实测）。

`DEFAULT_*` 与 `CHANGE_DEFAULTS` 只是**界面预选建议**（主方案 §4.4）：新账号以 `uninitialized` 建立，
服务端不得把预选写入订阅行，用户首次保存才产生正式配置。

P0 待定项（`MODEL_MAX_INPUT`、`MODEL_MAX_BILLED_OUTPUT`）未填写前，依赖模型自动调用的能力默认关闭
（开关 `AI_BILLING_PROFILE_CONFIGURED` 由实测值推导，不得用假设值翻转）。

### A.1 产品、来源与后台

| 参数 | 值 | 单位 | 含义 | 状态与备注 |
| --- | --- | --- | --- | --- |
| SUPPORTED_SCOPE | {"games":["genshin","hsr","zzz"],"regions":["CN"]} | — | 仅开放验证通过的来源类别（genshin / hsr / zzz；CN）；不自动加入未来游戏 | 基线；取值引用 enums.ts（P1-02），单一运行时定义源 |
| SUBSCRIPTION_INIT_STATE | uninitialized | 枚举 | 新账号订阅行初值；首次合法保存后转 initialized 且不可退回 | 基线 |
| DEFAULT_SCOPE_GAMES | ["genshin","hsr","zzz"] | 游戏枚举数组 | 仅作界面预选（三款全选）；用户保存前不构成正式 scope | 界面预选；§4.4：服务端不得写入订阅行 |
| DEFAULT_CALENDAR_EVENT_TYPES | ["livestream","maintenance","limited_event","gacha"] | 事件类型数组 | 界面预选的基础可见事件类型 | 界面预选；§4.4：服务端不得写入订阅行 |
| DEFAULT_CALENDAR_NODE_TYPES | ["start","end","reward_deadline"] | 节点类型数组 | 界面预选的基础可见节点；phase_unlock 默认不选（噪音较高） | 界面预选；§4.4：服务端不得写入订阅行 |
| DEFAULT_RULE_IDS | ["livestream_start_1h","maintenance_start_1h","limited_end_1d","gacha_end_1d"] | rule_id 数组 | 提醒推荐值，用户确认后生效；规则可以为空 | 界面预选；rule_id 定义源在 rules.ts（A.6），此处不复制 |
| CALENDAR_ALARMS_DEFAULT | true | 布尔 | 首次启用展示关联节点及兼容提示；不代表外部客户端已授予提醒能力 | 基线 |
| CHANGE_DEFAULTS | {"new_event":false,"important_change":true,"cancelled_or_retracted":true,"late_discovery":true} | 四开关对象 | 变更通知界面预选：new_event=false，其余三开；邮件/Push 通道本身默认关闭 | 界面预选；键形状引用 SubscriptionConfig.notifications（subscription.ts） |
| SOURCE_POLL | 1,800 | 秒 | 常规轮询间隔，服从来源实际限制 | 基线 |
| SOURCE_HOT_POLL | 600 | 秒 | 前瞻/更新前后的热点轮询 | 基线 |
| SOURCE_RECHECK_WINDOW | 7 | 天 | 近期公告正文复查范围 | 基线 |
| SOURCE_RECHECK_INTERVAL | 21,600 | 秒 | 复查间隔；活跃关联公告继续受限跟踪 | 基线 |
| SOURCE_LIMIT_PROFILE | {"status":"measured-by-p0-02","registryFile":"fixtures/sources/registry.draft.json","perSourceField":"sources[].limit_profile_measured"} | 按来源结构 | 页数、正文大小、请求超时、重定向和批量上限 | 实测引用；P0-02 实测，见 fixtures/sources/registry.draft.json 的 limit_profile_measured |
| DISCOVERY_TARGET | 1,800 | 秒 | 自官方发布时间计的发现目标（不是 SLA） | 基线 |
| PUBLICATION_TARGET | 2,700 | 秒 | 自官方发布时间计的发布目标（不是 SLA） | 基线 |
| WATCHDOG_INTERVAL | 600 | 秒 | 修复两个固定执行器 | 基线 |
| MATCH_PAGE | 20 | 候选/页 | 到期展开的匹配分页 | 基线 |
| SEND_CONCURRENCY | 2 | 并发 | 外发并发，实测后调整 | 基线 |
| EXECUTOR_BATCH_WALL_LIMIT | 120 | 秒 | 执行器到限保存进度，不常驻等待 | 基线 |
| CONFIG_MAX_BYTES | 4,096 | 字节（KiB 原文） | 正式订阅配置上限（4 KiB） | 基线 |
| API_BODY_MAX_BYTES | 8,192 | 字节（KiB 原文） | 普通账号/Push 请求体上限（8 KiB）；认证另用小字段 Schema | 基线 |
| USER_MUTATIONS_DAY | 30 | 次/日 | 每账号业务修改上限；不限制终止路径（§9.5） | 基线 |
| GLOBAL_MUTATIONS_DAY | 3,000 | 次/日 | 全站业务修改上限；同样不限制终止路径 | 基线 |

### A.2 认证与账号

| 参数 | 值 | 单位 | 含义 | 状态与备注 |
| --- | --- | --- | --- | --- |
| SECRET_BITS | 256 | 位 | Session、Feed、恢复秘密等随机强度；验证码另算 | 基线 |
| ACCOUNT_MAX_STORED | 500 | 账号 | 账号存量上限 | 基线 |
| REGISTRATIONS_DAY | 10 | 次/日 | 每 UTC 日完成注册上限；另受发信、预占和开放状态限制 | 基线 |
| OTP_DIGITS | 8 | 位 | 均匀随机生成的验证码位数 | 基线 |
| OTP_TTL | 600 | 秒 | 验证码有效期；重发不延长最初总期限 | 基线 |
| OTP_ATTEMPTS | 5 | 次/挑战 | 每挑战尝试上限；重发不重置累计错误次数 | 基线 |
| OTP_COOLDOWN | 60 | 秒 | 同规范邮箱发送间隔 | 基线 |
| EMAIL_AUTH_INTENTS_DAY | 5 | 次/日 | 同规范邮箱的登录、重发及重新验证合计 | 基线 |
| EMAIL_VERIFY_ATTEMPTS_HOUR | 20 | 次/小时 | 邮箱级额外防猜测边界 | 基线 |
| AUTH_CHALLENGES_MAX | 1,000 | 个 | 全站短期挑战上限 | 基线 |
| AUTH_CHALLENGES_PER_EMAIL | 3 | 个 | 同规范邮箱同时有效挑战数 | 基线 |
| PREAUTH_MIN_TTL | 1,320 | 秒 | 预认证会话下限；已按 A.5 等式取 OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN | 基线 |
| PREAUTH_MARGIN | 120 | 秒 | 预认证 Cookie 的额外余量 | 基线 |
| AUTH_COMPLETION_TTL | 600 | 秒 | 完成回执最大期限；激活即清除密文 | 基线 |
| SESSION_PENDING_TTL | 600 | 秒 | pending 会话超时清理，不占 active 名额 | 基线 |
| SESSION_PENDING_PER_USER | 2 | 个 | 同账号同时有效 pending 会话数 | 基线 |
| SESSION_ABSOLUTE_TTL | 15,552,000 | 秒（原文 180 天） | 绝对到期不被续期突破 | 基线 |
| SESSION_ABSOLUTE_JITTER | 1,728,000 | 秒（原文 ±20 天） | 创建时抽取并固定写入的抖动幅度，摊平集中到期 | 基线 |
| SESSION_IDLE_TTL | 7,776,000 | 秒（原文 90 天） | 不活跃到期；只用外部日历的用户由此决定重新认证频率（§9.3） | 基线 |
| SESSION_RENEW_INTERVAL | 604,800 | 秒（原文 7 天） | 每会话续期最小间隔；只由真实前台操作触发（§4.5） | 基线 |
| SESSION_EXPIRY_NOTICE | 1,209,600 | 秒（原文 14 天） | 到期前网页提示窗口 | 基线 |
| SESSION_ACTIVE_MAX | 5 | 个 | 同账号 active 会话上限；满额由用户选择撤销 | 基线 |
| SESSION_LABEL_SOURCE | {"source":"user-provided","fallback":"creation-time+coarse-platform"} | 策略 | 会话标签来源：用户自填，缺省为创建时间 + 粗粒度平台；仅作显示，IP/UA 指纹不参与鉴权 | 策略 |
| RECENT_AUTH_TTL | 600 | 秒 | 限定 Session、用途和目标的近期认证有效期，单次消费 | 基线 |
| RECOVERY_CODE_COUNT | 1 | 个 | 当前恢复码个数；恢复登录消费后立即交付新码；紧急停用不消费 | 基线 |
| RECOVERY_ATTEMPTS_HOUR | 10 | 次/小时 | 按 recovery_id 与来源分别计的尝试上限（针对枚举与刷量） | 基线 |
| RECOVERY_ATTEMPTS_DAY | 30 | 次/日 | 同上的每日上限；超出返回统一的稍后重试 | 基线 |
| ACCOUNT_IDLE_DAYS | 180 | 天 | 无有效活动才进入回收；不以无网页登录单独判定 | 基线 |
| ACCOUNT_GRACE_DAYS | 30 | 天 | 回收宽限；宽限期内仍可凭原账号证明恢复 | 基线 |
| FEED_ACTIVITY_WRITE_INTERVAL | 1 | 天 | 活动水位合并写入间隔；随授权查询同事务完成 | 基线 |
| RECLAIM_TELEMETRY_STALE_HOURS | 48 | 小时 | 活动水位失真超此值即全局暂停账号与席位回收（§6.6） | 基线 |
| ADMIN_SESSION_TTL | 43,200 | 秒（原文 12 小时） | 独立管理员权限域的会话期限 | 基线 |

### A.3 日历、通知有效期与模型

| 参数 | 值 | 单位 | 含义 | 状态与备注 |
| --- | --- | --- | --- | --- |
| FEED_PAST_DAYS | 30 | 天 | 完整基础窗口过去端 | 基线 |
| FEED_FUTURE_DAYS | 180 | 天 | 完整基础窗口未来端；共享更正允许受限越界 | 基线 |
| FEED_BASE_NODE_MAX | 1,000 | 节点 | 基础可见 + 提醒关联节点上限 | 基线 |
| FEED_PATCH_NODE_MAX | 1,000 | 条目 | 更正层条目上限；合并去重后仍受响应字节限制 | 基线 |
| FEED_RESPONSE_MAX_BYTES | 2,097,152 | 字节（原文 2 MiB） | 超限报错，不静默截断 | 基线 |
| FEED_SHRINK_GUARD_RATIO | 0.4 | 比例 | 缩水守卫触发比例（§6.5）；须在开区间 (0,1) | 基线 |
| FEED_SHRINK_GUARD_MIN | 5 | 条 | 低于此条目数的小日历不触发守卫 | 基线 |
| CAL_PATCH_MIN_DAYS | 90 | 天 | 更正保留下限，仅用于公共更正层 | 基线 |
| CAL_PATCH_TAIL_DAYS | 30 | 天 | 覆盖旧节点最晚时间之后的保留尾巴 | 基线 |
| CAL_PATCH_GLOBAL_MAX | 10,000 | 条 | 公共更正记录保护值；接近上限告警并暂停非关键扩大 | 基线 |
| PUBLIC_CACHE_FRESH | 300 | 秒 | 公共快照新鲜窗口 | 基线 |
| FEED_MAX_STALE | 86,400 | 秒（原文 24 小时） | 私人 Feed 只用当前完整发布代次，不回退旧代次 | 基线 |
| REMINDER_GRACE | 300 | 秒 | 正常提前提醒有效期，且不超过节点时刻 | 基线 |
| NEW_EVENT_TTL | 21,600 | 秒 | 新事件公布有效期 | 基线 |
| CHANGE_TTL | 86,400 | 秒 | 取消及重要更正有效期 | 基线 |
| LATE_NOTICE_TTL | 900 | 秒 | 晚发现尝试窗口 | 基线 |
| LATE_POST_START_WINDOW | 7,200 | 秒 | 开始后允许补报范围；截止已过不补临近通知 | 基线 |
| AI_SOFT_DAY | 6,000 | Neurons/日 | 模型日预算软线：优先前瞻/维护/截止/关键更正，停低价值回填 | 基线；套餐包含量未证实（platform-facts.md）；P0-03 须反向校验 |
| AI_HARD_DAY | 8,000 | Neurons/日 | 模型日预算硬线；所有 profile 共用账本，含失败和重试 | 基线；不得编造套餐包含量让校验通过；启用看 AI_BILLING_PROFILE_CONFIGURED |
| MODEL_MAX_INPUT | 未填写（P0 待定） | token | 输入保护值——未填写 | P0 待定；P0-03 按真实部署填写；未填写前模型自动调用默认关闭 |
| MODEL_MAX_BILLED_OUTPUT | 未填写（P0 待定） | token | 完整计费输出上界——未填写 | P0 待定；无法确定完整计费输出上界时，不开放自动调用 |
| MODEL_STRUCT_REPAIR | 1 | 次 | 结构修复额外调用；先预占费用，用尽进入审核 | 基线 |
| MODEL_NETWORK_RETRIES | 2 | 次 | 网络重试额外调用；同样先预占并计量 | 基线 |
| EXTRACTION_EVAL_MIN | 120 | 篇 | 三游戏均覆盖的评估样本量；合成样本须明确标注 | 基线 |
| KEY_EVENT_RECALL | 0.95 | 比例（原文 ≥95%） | 关键事件召回门槛 | 基线 |
| AUTO_PUBLISH_TIME_ERRORS | 0 | 个 | 自动发布保留集已知时间错误为 0（有限样本门槛） | 基线 |

### A.4 邮件与 Push（按 ADR-0003 纯日额度模型）

| 参数 | 值 | 单位 | 含义 | 状态与备注 |
| --- | --- | --- | --- | --- |
| MAIL_SEATS_MAX | 100 | 席 | 邮件席位：取消/撤回、重要更正、晚发现 | ADR-0003 修订；附录原值 50；ADR-0003 变更 100 |
| MAIL_ROUTINE_SEATS_MAX | 40 | 席 | 席位子名额：额外开启常规提前提醒邮件（默认关闭，§7.5） | ADR-0003 修订；附录原值 20；ADR-0003 修订一变更 40 |
| MAIL_SEAT_LEASE | 90 | 天 | 服务租期；有账号活动信号即自动续租（§9.4） | 基线 |
| PLATFORM_MAIL_DAY_LIMIT | 1,000 | 封/日 | 平台侧邮件日发送上限 | 平台实测；实测值：GET /accounts/{id}/email/sending/limits（platform-facts.md，2026-09-22）；随平台变动须重跑 params:verify |
| MAIL_AUTH_DAY | 90 | 封/日 | 认证日硬上限（含新注册子集）；持续消耗由 MAIL_AUTH_FLOOR 降级约束 | 基线 |
| MAIL_SIGNUP_AUTH_DAY | 10 | 封/日 | 新注册是认证日池的子集；剩余不足先停注册 | 基线 |
| MAIL_BASE_DAY | 50 | 封/日 | 基础日池：常规提前提醒与新事件公布 | ADR-0003 修订；附录原值 25；ADR-0003 修订一变更 50（保留 1.25x 重试余量） |
| MAIL_URGENT_DAY | 120 | 封/日 | 紧急日池：取消/撤回、重要更正、晚发现；须覆盖一次全量取消 + floor | ADR-0003 修订；附录原值 60；ADR-0003 变更 120 |
| MAIL_TOTAL_DAY | 260 | 封/日 | 全用途日上限 = 认证 + 基础 + 紧急，且服从 PLATFORM_MAIL_DAY_LIMIT | ADR-0003 修订；附录原值 175；ADR-0003 变更 260 |
| MAIL_AUTH_FLOOR | 20 | 封（当日剩余口径） | 认证池底线：当日剩余跌破后只接受既有账号首次登录，暂停新注册发信与全部重发 | ADR-0003 修订；附录原值 200/月；ADR-0003 口径改 20/日 |
| MAIL_URGENT_FLOOR | 20 | 封（当日剩余口径） | 紧急池底线：当日剩余跌破后收紧为只发取消/撤回 | ADR-0003 修订；附录原值 150/月；ADR-0003 口径改 20/日 |
| MAIL_USER_BASE_DAY | 1 | 封/日 | 每账号基础发送机会；同批次多条候选合并为一封（§7.3） | 基线 |
| MAIL_USER_URGENT_DAY | 2 | 封/日 | 每账号紧急发送机会；非保证额度 | 基线 |
| MAIL_DIGEST_WINDOW | 600 | 秒 | 同用户同优先级候选的合并前瞻窗口；只允许提前发送，不允许推迟任何一条 | 基线；方向性语义条款，见 verify.ts SEMANTIC_INVARIANTS |
| MAIL_PENDING_MAX | 500 | 条 | 未完成 MailOutbox 上限 | 基线 |
| MAIL_AUTH_RESERVED_PENDING | 200 | 槽 | 认证槽包含在 MAIL_PENDING_MAX 内；业务不得占用预留部分 | 基线 |
| MAIL_RECORD_MAX | 10,000 | 条 | 短期发送元数据容量，不保存完整正文 | 基线 |
| MAIL_FEEDBACK_MAX | 20,000 | 条 | 反馈记录容量 | 基线 |
| MAIL_UNMATCHED_MAX | 1,000 | 条 | 未关联反馈的有限保留 | 基线 |
| FEEDBACK_BATCH | 10 | 条 | Queue 小批消费 | 基线 |
| FEEDBACK_MAX_RETRIES | 8 | 次 | 重试后进入 DLQ | 基线 |
| PUSH_USER_MAX | 5 | 个 | 每账号 Push 绑定上限 | 基线 |
| PUSH_ACTIVE_MAX | 500 | 个 | 全站 active 上限 | 基线 |
| PUSH_TOTAL_MAX | 550 | 个 | 全站总量上限（含 active） | 基线 |
| PUSH_PENDING_MAX | 50 | 个 | 全站 pending 上限 | 基线 |
| PUSH_NEW_DAY | 50 | 个/日 | 每日新绑定上限 | 基线 |
| PUSH_SEND_DAY | 5,000 | 次/日 | 每日外发上限，含业务、激活、测试、重试 | 基线 |
| PUSH_CRITICAL_RESERVED_DAY | 500 | 次/日 | 关键预留，包含在外发总预算内 | 基线 |
| PUSH_ACTIVATION_TTL | 600 | 秒 | 可见激活期限 | 基线 |
| PUSH_ACTIVATION_ATTEMPTS | 3 | 次 | 有效接收证明后才 active | 基线 |
| PUSH_TEST_COOLDOWN | 60 | 秒 | 同绑定测试冷却 | 基线 |
| PUSH_TEST_DAY | 200 | 次/日 | 全站测试日量，仍计入总发送 | 基线 |
| PUSH_LEASE | 180 | 天 | 服务租约，不是浏览器协议有效期 | 基线 |
| PUSH_STALE_GRACE | 30 | 天 | 失效宽限 | 基线 |
| PUSH_RECEIPT_WRITE_INTERVAL | 1 | 天 | 合并真实业务确认的写入间隔；激活独立处理 | 基线 |

### A.5 保留与配置依赖

| 参数 | 值 | 单位 | 含义 | 状态与备注 |
| --- | --- | --- | --- | --- |
| DELIVERY_PENDING_MAX | 5,000 | 条 | 未完成 Delivery 上限；不通过删除未完成任务腾容量 | 基线 |
| DELIVERY_RECORD_MAX | 50,000 | 条 | Delivery 记录容量；同样不靠删除腾容量 | 基线 |
| DELIVERY_DEDUPE_TTL | 604,800 | 秒（原文 7 天） | 大于发生项/重试有效期；发生项结束后不得重新展开 | 基线 |
| MAIL_METADATA_TTL | 2,592,000 | 秒（原文 30 天） | 发送元数据保留；OTP/回执密文按短期生命周期即时清除，不套用此期限 | 基线 |
| MAIL_FEEDBACK_TTL | 2,592,000 | 秒（原文 30 天） | 反馈记录保留；到期汇总，未决事件保持有限异常记录 | 基线 |
| EXPIRED_AUTH_CLEANUP | 86,400 | 秒（原文 24 小时） | 过期即不能授权；此值仅为清理最迟时间 | 基线 |
| EXPIRED_SESSION_METADATA | 604,800 | 秒（原文 7 天） | 脱敏审计后清除 token_hash | 基线 |
| RATE_WINDOWS_MAX | 10,000 | 键 | 限速窗口容量；满额采用粗粒度拒绝 | 基线 |
| RATE_WINDOWS_CLEANUP_DELAY | 86,400 | 秒（原文 24 小时） | 窗口结束后的清理延迟 | 基线 |
| UNUSED_ARTICLE_TTL | 2,592,000 | 秒（原文 30 天） | 未被引用文章保留；正式证据引用优先 | 基线 |
| UNREFERENCED_VERSION_TTL | 7,776,000 | 秒（原文 90 天） | 未被引用版本保留 | 基线 |
| EVENT_EVIDENCE_TTL | 31,536,000 | 秒（原文 365 天） | 事件证据保留；活跃、争议和未到期公共更正可延长 | 基线 |
| CONSENT_AUDIT_AFTER_CLOSE | 15,552,000 | 秒（原文 180 天） | 通道同意关闭后的最小脱敏记录；平台抑制不自动到期解封 | 基线 |
| BACKUP_INTERVAL | 604,800 | 秒（原文 7 天） | 独立加密备份间隔 | 基线 |
| BACKUP_COPIES | 4 | 份 | 备份份数；密钥另存，完成恢复演练 | 基线 |

## A.6 固定提醒规则注册表

> 本表由 `packages/contracts/src/rules.ts` 的 `REMINDER_RULES`（P1-02 交付）生成，参数注册表不复制第二份。

| rule_id | 事件类型 | 节点 | 提前量（秒） | 用户文案 |
| --- | --- | --- | --- | --- |
| livestream_start_1h | livestream | start | 3,600 | 前瞻开始前 1 小时 |
| maintenance_start_1h | maintenance | start | 3,600 | 维护开始前 1 小时 |
| limited_start_1h | limited_event | start | 3,600 | 限时活动开始前 1 小时 |
| limited_end_1d | limited_event | end | 86,400 | 限时活动结束前 1 天 |
| gacha_start_1h | gacha | start | 3,600 | 卡池开始前 1 小时 |
| gacha_end_1d | gacha | end | 86,400 | 卡池结束前 1 天 |
| phase_unlock_1h | limited_event | phase_unlock | 3,600 | 活动阶段解锁前 1 小时 |
| reward_deadline_1d | limited_event | reward_deadline | 86,400 | 奖励领取截止前 1 天 |

## 附录 A.5 / CONTRACTS_BASELINE.md §11 启动等式（生成时的实际值）

| 等式 ID | 分组 | 合同 | 当前值 |
| --- | --- | --- | --- |
| mail-total-day-sum | 邮件（纯日额度） | MAIL_TOTAL_DAY = MAIL_AUTH_DAY + MAIL_BASE_DAY + MAIL_URGENT_DAY | MAIL_TOTAL_DAY(260) = MAIL_AUTH_DAY(90) + MAIL_BASE_DAY(50) + MAIL_URGENT_DAY(120) → 260 = 260 |
| mail-total-day-within-platform-limit | 邮件（纯日额度） | MAIL_TOTAL_DAY <= PLATFORM_MAIL_DAY_LIMIT（平台实测日上限） | MAIL_TOTAL_DAY(260) <= PLATFORM_MAIL_DAY_LIMIT(1000) |
| mail-signup-auth-day-subset | 邮件（纯日额度） | MAIL_SIGNUP_AUTH_DAY <= MAIL_AUTH_DAY | MAIL_SIGNUP_AUTH_DAY(10) <= MAIL_AUTH_DAY(90) |
| mail-auth-floor-below-day | 邮件（纯日额度） | MAIL_AUTH_FLOOR < MAIL_AUTH_DAY（floor 必须真正触得到） | MAIL_AUTH_FLOOR(20) < MAIL_AUTH_DAY(90) |
| mail-urgent-floor-below-day | 邮件（纯日额度） | MAIL_URGENT_FLOOR < MAIL_URGENT_DAY（floor 必须真正触得到） | MAIL_URGENT_FLOOR(20) < MAIL_URGENT_DAY(120) |
| mail-routine-seats-within-seats | 邮件（池容量对得起承诺的名额） | MAIL_ROUTINE_SEATS_MAX <= MAIL_SEATS_MAX | MAIL_ROUTINE_SEATS_MAX(40) <= MAIL_SEATS_MAX(100) |
| mail-base-day-covers-routine-seats | 邮件（池容量对得起承诺的名额） | MAIL_BASE_DAY >= MAIL_ROUTINE_SEATS_MAX × MAIL_USER_BASE_DAY（1.25x 重试余量：50 对 40） | MAIL_BASE_DAY(50) >= MAIL_ROUTINE_SEATS_MAX(40) × MAIL_USER_BASE_DAY(1) = 40 |
| mail-urgent-day-covers-seats-plus-floor | 邮件（池容量对得起承诺的名额） | MAIL_URGENT_DAY >= MAIL_SEATS_MAX + MAIL_URGENT_FLOOR（一次官方取消当天覆盖全部席位，且之后仍触得到 floor） | MAIL_URGENT_DAY(120) >= MAIL_SEATS_MAX(100) + MAIL_URGENT_FLOOR(20) = 120 |
| preauth-min-ttl-safe | 认证时序 | PREAUTH_MIN_TTL >= OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN | PREAUTH_MIN_TTL(1320) >= OTP_TTL(600) + AUTH_COMPLETION_TTL(600) + PREAUTH_MARGIN(120) = 1320 |
| otp-cookie-covers-late-challenge | 认证时序 | OTP 绑定 Cookie 截止 >= 最晚挑战截止 + AUTH_COMPLETION_TTL + PREAUTH_MARGIN | OTP绑定Cookie截止(PREAUTH_MIN_TTL=1320) >= 最晚挑战截止(OTP_TTL=600) + AUTH_COMPLETION_TTL(600) + PREAUTH_MARGIN(120) = 1320 |
| session-absolute-lower-above-idle | 会话时序 | SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER > SESSION_IDLE_TTL | SESSION_ABSOLUTE_TTL(15552000) - SESSION_ABSOLUTE_JITTER(1728000) = 13824000 > SESSION_IDLE_TTL(7776000) |
| session-idle-above-renew-interval | 会话时序 | SESSION_IDLE_TTL > SESSION_RENEW_INTERVAL | SESSION_IDLE_TTL(7776000) > SESSION_RENEW_INTERVAL(604800) |
| session-idle-above-expiry-notice | 会话时序 | SESSION_IDLE_TTL > SESSION_EXPIRY_NOTICE | SESSION_IDLE_TTL(7776000) > SESSION_EXPIRY_NOTICE(1209600) |
| delivery-dedupe-above-occurrence-ttls | 其余 | DELIVERY_DEDUPE_TTL > 业务发生项最大有效期 + 最大重试余量 | DELIVERY_DEDUPE_TTL(604800) > max(REMINDER_GRACE 300, NEW_EVENT_TTL 21600, CHANGE_TTL 86400, LATE_NOTICE_TTL 900) = 86400（重试余量由调度实现再行加算，参数层以最大有效期为下界） |
| feed-shrink-guard-ratio-open-interval | 其余 | 0 < FEED_SHRINK_GUARD_RATIO < 1 | 0 < FEED_SHRINK_GUARD_RATIO(0.4) < 1 |
| mail-auth-reserved-within-pending | 预留与容量包含 | MAIL_AUTH_RESERVED_PENDING <= MAIL_PENDING_MAX（认证预留包含在未完成总量内） | MAIL_AUTH_RESERVED_PENDING(200) <= MAIL_PENDING_MAX(500) |
| mail-pending-within-record | 预留与容量包含 | MAIL_PENDING_MAX <= MAIL_RECORD_MAX（未完成量包含在元数据容量内） | MAIL_PENDING_MAX(500) <= MAIL_RECORD_MAX(10000) |
| mail-unmatched-within-feedback | 预留与容量包含 | MAIL_UNMATCHED_MAX <= MAIL_FEEDBACK_MAX（未关联反馈保留包含在反馈容量内） | MAIL_UNMATCHED_MAX(1000) <= MAIL_FEEDBACK_MAX(20000) |
| delivery-pending-within-record | 预留与容量包含 | DELIVERY_PENDING_MAX <= DELIVERY_RECORD_MAX（未完成任务包含在记录容量内） | DELIVERY_PENDING_MAX(5000) <= DELIVERY_RECORD_MAX(50000) |
| push-active-within-total | 预留与容量包含 | PUSH_ACTIVE_MAX <= PUSH_TOTAL_MAX | PUSH_ACTIVE_MAX(500) <= PUSH_TOTAL_MAX(550) |
| push-pending-within-total | 预留与容量包含 | PUSH_PENDING_MAX <= PUSH_TOTAL_MAX | PUSH_PENDING_MAX(50) <= PUSH_TOTAL_MAX(550) |
| push-critical-reserved-within-send-day | 预留与容量包含 | PUSH_CRITICAL_RESERVED_DAY <= PUSH_SEND_DAY（关键预留包含在外发总预算内） | PUSH_CRITICAL_RESERVED_DAY(500) <= PUSH_SEND_DAY(5000) |
| push-test-day-within-send-day | 预留与容量包含 | PUSH_TEST_DAY <= PUSH_SEND_DAY（测试日量仍计入总发送） | PUSH_TEST_DAY(200) <= PUSH_SEND_DAY(5000) |
| ai-soft-below-hard | usage 单位一致 | AI_SOFT_DAY < AI_HARD_DAY（同为 Neurons/日，软线严于硬线） | AI_SOFT_DAY(6000) < AI_HARD_DAY(8000) |

### 语义条款（无法用参数数值校验，由实现阶段测试保证）

- **mail-digest-window-forward-only**：MAIL_DIGEST_WINDOW 只用于提前发送；合并后任一条的实际发送时间不得晚于其自身 expires_at（附录 A.5 / §11）——由P4-02 调度实现（合并只能提前，不得推迟任何一条）。

### 等式数量核对

数值等式 24 条、语义条款 1 条。
`pnpm params:verify` 与 Worker 启动路径逐条校验数值等式，任一不成立即拒绝并指明该条。
