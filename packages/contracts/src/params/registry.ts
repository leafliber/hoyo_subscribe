// 参数注册表——唯一参数基线（主方案附录 A 全表；任务卡 P1-03）。
//
// 合同要点（AGENTS.md 第 2 节硬规则 2；主方案附录 A 引言；ENGINEERING.md §4）：
// - 所有阈值、TTL、配额、提前量只来自本文件；正文、模块、前端、文案不得出现第二份字面常量。
// - 参数名与附录 A 完全一致的全大写原名，不缩写、不改名；消费方不得另起别名。
// - 邮件预算按 ADR-0003（纯日额度模型）实现：月度参数（MAIL_*_MONTH）与 envelope/carry
//   机制已废止，**不得出现在本注册表**（AGENTS.md 第 3 节禁止清单）。
// - 值统一使用基础单位（秒 / 字节 / 次 / 封 / 天），PARAM_META.unit 记录附录原文单位与换算。
// - `DEFAULT_*` 只是界面预选建议（主方案 §4.4）：新账号以 uninitialized 建立，服务端不得
//   把预选写入订阅行。类型上以 UiPresetSuggestion 标记。
// - P0 待定项未填写前，依赖它们的能力默认关闭（见 AI_BILLING_PROFILE_CONFIGURED）。
//
// A.6 提醒规则注册表不在此复制：唯一定义源是 ../rules.ts 的 REMINDER_RULES（P1-02 交付）。
// SUPPORTED_SCOPE 的取值也不复制：引用 ../enums.ts（P1-02 交付，单一运行时定义源）。

import type { EventType, NodeType } from "../enums";
import { SUPPORTED_SCOPE_GAMES, SUPPORTED_SCOPE_REGIONS } from "../enums";
import type { RuleId } from "../rules";
import type { SubscriptionConfig } from "../subscription";

/** 界面预选建议标记（主方案 §4.4、附录 A.1）：DEFAULT_* 不是服务端默认值。 */
export type UiPresetSuggestion<T> = T & {
  readonly __uiPresetSuggestion: "ui-preset-only";
};

const asUiPreset = <T>(value: T): UiPresetSuggestion<T> => value as UiPresetSuggestion<T>;

// ---------------------------------------------------------------------------
// A.1 产品、来源与后台（主方案 §2、§3、§6、§7、§9.5、§10）
// ---------------------------------------------------------------------------

/** 仅开放验证通过的来源类别；创建时保存具体选择，不自动加入未来游戏。附录 A.1；§3.3。取值引用 enums.ts，不在此复制第二份。 */
export const SUPPORTED_SCOPE = {
  games: SUPPORTED_SCOPE_GAMES,
  regions: SUPPORTED_SCOPE_REGIONS,
} as const;

/** 新账号订阅行初值；首次合法保存后转 initialized 且不可退回。附录 A.1；§4.4。 */
export const SUBSCRIPTION_INIT_STATE = "uninitialized" as const;

/** 仅作界面预选；用户保存前不构成正式 scope。附录 A.1；§4.4。引用 SUPPORTED_SCOPE_GAMES。 */
export const DEFAULT_SCOPE_GAMES = asUiPreset(SUPPORTED_SCOPE_GAMES);

/** 界面预选的基础可见事件类型。附录 A.1。 */
export const DEFAULT_CALENDAR_EVENT_TYPES = asUiPreset([
  "livestream",
  "maintenance",
  "limited_event",
  "gacha",
] as const satisfies readonly EventType[]);

/** 界面预选的基础可见节点；phase_unlock 默认不选，噪音较高。附录 A.1。 */
export const DEFAULT_CALENDAR_NODE_TYPES = asUiPreset([
  "start",
  "end",
  "reward_deadline",
] as const satisfies readonly NodeType[]);

/** 提醒推荐值，用户确认后生效；规则可以为空。附录 A.1；§5.3。rule_id 定义源在 ../rules.ts。 */
export const DEFAULT_RULE_IDS = asUiPreset([
  "livestream_start_1h",
  "maintenance_start_1h",
  "limited_end_1d",
  "gacha_end_1d",
] as const satisfies readonly RuleId[]);

/** 首次启用展示关联节点及兼容提示；不代表外部客户端已授予提醒能力。附录 A.1；§6。 */
export const CALENDAR_ALARMS_DEFAULT = true as const;

/** 变更通知四开关的界面预选（新事件默认关，取消/更正/晚发现默认开）；邮件/Push 通道本身默认关闭。附录 A.1；§5.1、§5.3。键形状引用 SubscriptionConfig["notifications"]（不含 rule_ids）。 */
export const CHANGE_DEFAULTS = asUiPreset({
  new_event: false,
  important_change: true,
  cancelled_or_retracted: true,
  late_discovery: true,
} as const satisfies Record<
  Exclude<keyof SubscriptionConfig["notifications"], "rule_ids">,
  boolean
>);

/** 常规轮询间隔，服从来源实际限制。附录 A.1；§3.1。 */
export const SOURCE_POLL = 1800 as const;

/** 前瞻/更新前后的热点轮询，仍服从来源实际限制。附录 A.1；§3.1。 */
export const SOURCE_HOT_POLL = 600 as const;

/** 近期公告正文复查范围。附录 A.1；§3.2。 */
export const SOURCE_RECHECK_WINDOW = 7 as const;

/** 复查间隔；活跃关联公告继续受限跟踪。附录 A.1；§3.2。 */
export const SOURCE_RECHECK_INTERVAL = 21600 as const;

/** 页数、正文大小、请求超时、重定向和批量上限——按来源实测。附录 A.1。实测值已由 P0-02 填入 fixtures/sources/registry.draft.json（sources[].limit_profile_measured），本注册表只登记引用，不另写一份。 */
export const SOURCE_LIMIT_PROFILE = {
  status: "measured-by-p0-02",
  registryFile: "fixtures/sources/registry.draft.json",
  perSourceField: "sources[].limit_profile_measured",
} as const;

/** 消费方读取 fixtures 来源注册项时 limit_profile_measured 的结构（类型契约，不是第二份值）。 */
export interface SourceLimitProfile {
  pages: number | string;
  batch_upper_bound_items: number | string;
  max_observed_content_bytes?: number;
  request_timeout_recommend_ms: number;
  redirects_observed: number;
  [key: string]: unknown;
}

/** 自官方发布时间计的发现目标，不是 SLA。附录 A.1；§3.1。 */
export const DISCOVERY_TARGET = 1800 as const;

/** 自官方发布时间计的发布目标，不是 SLA。附录 A.1；§3.1。 */
export const PUBLICATION_TARGET = 2700 as const;

/** 修复两个固定执行器。附录 A.1；§10.2。 */
export const WATCHDOG_INTERVAL = 600 as const;

/** 到期展开的匹配分页（候选/页）。附录 A.1；§7.2。 */
export const MATCH_PAGE = 20 as const;

/** 外发并发，实测后调整。附录 A.1。 */
export const SEND_CONCURRENCY = 2 as const;

/** 到限保存进度，不常驻等待。附录 A.1；§10.2。 */
export const EXECUTOR_BATCH_WALL_LIMIT = 120 as const;

/** 正式订阅配置上限。附录 A.1；§5.1。 */
export const CONFIG_MAX_BYTES = 4096 as const;

/** 普通账号/Push 请求体上限；认证另用小字段 Schema。附录 A.1；§8.2。 */
export const API_BODY_MAX_BYTES = 8192 as const;

/** 每账号业务修改上限；不限制 §9.5 的终止路径。附录 A.1；§9.5。 */
export const USER_MUTATIONS_DAY = 30 as const;

/** 全站业务修改上限；同样不限制终止路径。附录 A.1；§9.5。 */
export const GLOBAL_MUTATIONS_DAY = 3000 as const;

// ---------------------------------------------------------------------------
// A.2 认证与账号（主方案 §4.3—§4.6、§9.3）
// ---------------------------------------------------------------------------

/** Session、Feed、恢复秘密等随机强度（位）；验证码另按 OTP_DIGITS。附录 A.2；§4.1。 */
export const SECRET_BITS = 256 as const;

/** 账号存量上限。附录 A.2。 */
export const ACCOUNT_MAX_STORED = 500 as const;

/** 每 UTC 日完成注册上限；另受发信、预占和开放状态限制。附录 A.2；§4.2。 */
export const REGISTRATIONS_DAY = 10 as const;

/** 均匀随机生成的验证码位数。附录 A.2；§4.3。 */
export const OTP_DIGITS = 8 as const;

/** 验证码有效期；重发不延长最初总期限。附录 A.2；§4.3。 */
export const OTP_TTL = 600 as const;

/** 每挑战尝试上限；重发不重置累计错误次数。附录 A.2；§4.3。 */
export const OTP_ATTEMPTS = 5 as const;

/** 同规范邮箱发送间隔。附录 A.2；§4.3。 */
export const OTP_COOLDOWN = 60 as const;

/** 同规范邮箱的登录、重发及重新验证合计（次/日）。附录 A.2；§4.3。 */
export const EMAIL_AUTH_INTENTS_DAY = 5 as const;

/** 邮箱级额外防猜测边界（次/小时）。附录 A.2；§4.3。 */
export const EMAIL_VERIFY_ATTEMPTS_HOUR = 20 as const;

/** 全站短期挑战上限。附录 A.2；§4.3。 */
export const AUTH_CHALLENGES_MAX = 1000 as const;

/** 同规范邮箱同时有效挑战数。附录 A.2；§4.3。 */
export const AUTH_CHALLENGES_PER_EMAIL = 3 as const;

/** 预认证会话下限，已按 A.5 等式取 OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN，使下限本身即安全；实际期限还须覆盖更晚创建的挑战。附录 A.2；§4.3、附录 A.5。 */
export const PREAUTH_MIN_TTL = 1320 as const;

/** 预认证 Cookie 的额外余量。附录 A.2；§4.3。 */
export const PREAUTH_MARGIN = 120 as const;

/** 完成回执最大期限；激活即清除密文。附录 A.2；§4.3。 */
export const AUTH_COMPLETION_TTL = 600 as const;

/** pending 会话超时清理，不占 active 名额。附录 A.2；§4.5。 */
export const SESSION_PENDING_TTL = 600 as const;

/** 同账号同时有效 pending 会话数；有效恢复可先释放本人旧 pending。附录 A.2；§4.5。 */
export const SESSION_PENDING_PER_USER = 2 as const;

/** 绝对到期不被续期突破（附录原值 180 天）。附录 A.2；§4.5。 */
export const SESSION_ABSOLUTE_TTL = 15_552_000 as const;

/** 绝对期限抖动幅度（附录原值 ±20 天）：创建时抽取并固定写入，摊平上线期集中注册造成的集中到期洪峰。附录 A.2；§4.5。 */
export const SESSION_ABSOLUTE_JITTER = 1_728_000 as const;

/** 不活跃到期（附录原值 90 天）；只用外部日历的用户由此项决定重新认证频率（§9.3）。附录 A.2；§4.5。 */
export const SESSION_IDLE_TTL = 7_776_000 as const;

/** 每会话续期最小间隔（附录原值 7 天）；只由 §4.5 定义的真实前台操作触发。附录 A.2；§4.5。 */
export const SESSION_RENEW_INTERVAL = 604_800 as const;

/** 到期前网页提示窗口（附录原值 14 天）。附录 A.2；§4.5。 */
export const SESSION_EXPIRY_NOTICE = 1_209_600 as const;

/** 同账号 active 会话上限；满额由用户选择撤销，不自动踢最早会话。附录 A.2；§4.5。 */
export const SESSION_ACTIVE_MAX = 5 as const;

/** 会话标签来源策略：用户自填，缺省为创建时间 + 粗粒度平台；仅作显示，IP/UA 指纹不参与鉴权。附录 A.2；§4.5。 */
export const SESSION_LABEL_SOURCE = {
  source: "user-provided",
  fallback: "creation-time+coarse-platform",
} as const;

/** 限定 Session、用途和目标的近期认证有效期，单次消费。附录 A.2；§4.5。 */
export const RECENT_AUTH_TTL = 600 as const;

/** 当前恢复码个数；无日常自动过期；恢复登录消费后立即交付新码并强制保存确认；紧急停用不消费。附录 A.2；§4.6。 */
export const RECOVERY_CODE_COUNT = 1 as const;

/** 按 recovery_id 与来源分别计的每小时尝试上限；针对枚举与刷量，不是猜中概率。附录 A.2；§4.6。 */
export const RECOVERY_ATTEMPTS_HOUR = 10 as const;

/** 同上的每日尝试上限；超出返回统一的稍后重试。附录 A.2；§4.6。 */
export const RECOVERY_ATTEMPTS_DAY = 30 as const;

/** 无有效活动才进入回收的 idle 天数；不以无网页登录单独判定。附录 A.2；§9.4。 */
export const ACCOUNT_IDLE_DAYS = 180 as const;

/** 回收宽限天数；宽限期内仍可凭原账号证明恢复。附录 A.2；§9.4。 */
export const ACCOUNT_GRACE_DAYS = 30 as const;

/** 活动水位合并写入间隔（天）；随授权查询同事务完成。附录 A.2；§6.6、§9.4。 */
export const FEED_ACTIVITY_WRITE_INTERVAL = 1 as const;

/** 活动水位写入失败或过期超过此值（小时），全局暂停账号与席位回收。附录 A.2；§6.6、§9.4。 */
export const RECLAIM_TELEMETRY_STALE_HOURS = 48 as const;

/** 独立管理员权限域的会话期限（附录原值 12 小时）。附录 A.2；§4.5。 */
export const ADMIN_SESSION_TTL = 43_200 as const;

// ---------------------------------------------------------------------------
// A.3 日历、通知有效期与模型（主方案 §6、§7、§10.1）
// ---------------------------------------------------------------------------

/** 完整基础窗口过去端（天）。附录 A.3；§6.2。 */
export const FEED_PAST_DAYS = 30 as const;

/** 完整基础窗口未来端（天）；共享更正允许受限越界。附录 A.3；§6.2。 */
export const FEED_FUTURE_DAYS = 180 as const;

/** 基础可见 + 提醒关联节点上限。附录 A.3；§6.2。 */
export const FEED_BASE_NODE_MAX = 1000 as const;

/** 更正层条目上限；合并去重后仍受响应字节限制。附录 A.3；§6.3。 */
export const FEED_PATCH_NODE_MAX = 1000 as const;

/** 个人 Feed 响应字节上限；超限报错，不静默截断（附录原值 2 MiB）。附录 A.3；§6.6。 */
export const FEED_RESPONSE_MAX_BYTES = 2_097_152 as const;

/** 条目数较上次成功输出下降超过此比例、且无 view_revision / 公共代次变化可解释时，拒绝返回并告警（§6.5）。附录 A.3。 */
export const FEED_SHRINK_GUARD_RATIO = 0.4 as const;

/** 低于此条目数的小日历不触发缩水守卫，避免正常波动误报。附录 A.3；§6.5。 */
export const FEED_SHRINK_GUARD_MIN = 5 as const;

/** 更正保留下限（天），仅用于公共更正层。附录 A.3；§6.3。 */
export const CAL_PATCH_MIN_DAYS = 90 as const;

/** 覆盖旧节点最晚时间之后的保留尾巴（天）。附录 A.3；§6.3。 */
export const CAL_PATCH_TAIL_DAYS = 30 as const;

/** 公共更正记录保护值；接近上限告警并暂停非关键扩大。附录 A.3；§6.3。 */
export const CAL_PATCH_GLOBAL_MAX = 10_000 as const;

/** 公共快照新鲜窗口。附录 A.3；§6.4。 */
export const PUBLIC_CACHE_FRESH = 300 as const;

/** 私人 Feed 只用当前完整发布代次，不回退旧代次（附录原值 24 小时）。附录 A.3；§6.6。 */
export const FEED_MAX_STALE = 86_400 as const;

/** 正常提前提醒有效期，且不超过节点时刻。附录 A.3；§7.2。 */
export const REMINDER_GRACE = 300 as const;

/** 新事件公布有效期。附录 A.3；§7.2。 */
export const NEW_EVENT_TTL = 21_600 as const;

/** 取消及重要更正有效期。附录 A.3；§7.2。 */
export const CHANGE_TTL = 86_400 as const;

/** 晚发现尝试窗口。附录 A.3；§7.2。 */
export const LATE_NOTICE_TTL = 900 as const;

/** 开始后允许补报范围；截止已过不补临近通知。附录 A.3；§7.2。 */
export const LATE_POST_START_WINDOW = 7200 as const;

/** 模型日预算软线（Neurons）：优先前瞻/维护/截止/关键更正，停低价值回填。附录 A.3；§10.1。注意：套餐 Neuron 包含量未证实（docs/evidence/p0/platform-facts.md），启用前须 P0-03 反向校验。 */
export const AI_SOFT_DAY = 6000 as const;

/** 模型日预算硬线（Neurons）；所有模型 profile 共用账本，含失败和重试。附录 A.3；§10.1。同上：不得用编造的包含量让校验通过。 */
export const AI_HARD_DAY = 8000 as const;

/** 输入保护值——**未填写**（P0-03 按真实部署填写）。附录 A.3。未填写前依赖模型自动调用的能力默认关闭。 */
export const MODEL_MAX_INPUT = null as null;

/** 完整计费输出上界——**未填写**（P0-03 按真实部署填写）；无法确定完整计费输出上界时，不开放自动调用。附录 A.3。 */
export const MODEL_MAX_BILLED_OUTPUT = null as null;

/** 结构修复的额外调用次数；先预占费用，用尽进入审核。附录 A.3；§7.6。 */
export const MODEL_STRUCT_REPAIR = 1 as const;

/** 网络重试的额外调用次数；同样先预占并计量。附录 A.3；§7.6。 */
export const MODEL_NETWORK_RETRIES = 2 as const;

/** 三游戏均覆盖的评估样本篇数；合成样本须明确标注，不充作官方样本。附录 A.3；§7.6。 */
export const EXTRACTION_EVAL_MIN = 120 as const;

/** 关键事件召回门槛（附录原值 ≥95%）。附录 A.3；§7.6。 */
export const KEY_EVENT_RECALL = 0.95 as const;

/** 自动发布的保留集已知时间错误数（附录原值：保留集已知错误为 0）；有限样本门槛，不是生产零错误保证。附录 A.3；§7.6。 */
export const AUTO_PUBLISH_TIME_ERRORS = 0 as const;

/**
 * 模型自动调用能力总开关：MODEL_MAX_INPUT 与 MODEL_MAX_BILLED_OUTPUT 均取得实测值前为 false。
 * 依据：账户 entitlements 112 条中无任何 workers_ai.* 条目（docs/evidence/p0/platform-facts.md，
 * 2026-09-22）——Workers AI 可用性与 Neuron 包含量均未证实。**不得用假设值冒充实测值翻转本开关。**
 */
export const AI_BILLING_PROFILE_CONFIGURED =
  MODEL_MAX_INPUT !== null && MODEL_MAX_BILLED_OUTPUT !== null;

// ---------------------------------------------------------------------------
// A.4 邮件与 Push（主方案 §9.1—§9.5；**邮件值按 ADR-0003 纯日额度模型**）
// ---------------------------------------------------------------------------

/** 邮件席位（取消/撤回、重要更正、晚发现）。附录 A.4 原值 50；**ADR-0003 变更为 100**（所有者决定，平台侧 1,000/日容得下）。 */
export const MAIL_SEATS_MAX = 100 as const;

/** 席位的子名额：额外开启常规提前提醒邮件（默认关闭，§7.5）。附录 A.4 原值 20；**ADR-0003 修订一变更为 40**。 */
export const MAIL_ROUTINE_SEATS_MAX = 40 as const;

/** 服务租期（天）；有任何账号活动信号即自动续租，不要求专门回网页点一次。附录 A.4；§9.4。 */
export const MAIL_SEAT_LEASE = 90 as const;

/** 平台侧邮件日发送上限（封/日）——**实测值**，来源 `GET /accounts/{id}/email/sending/limits`（docs/evidence/p0/platform-facts.md，2026-09-22）。随平台变动须重跑 `pnpm params:verify`。ADR-0003 新增。 */
export const PLATFORM_MAIL_DAY_LIMIT = 1000 as const;

/** 认证日硬上限（封）：既有账号登录 + 新注册子集；只防突发，持续消耗由 MAIL_AUTH_FLOOR 降级约束。附录 A.4；§9.2（ADR-0003 口径）。 */
export const MAIL_AUTH_DAY = 90 as const;

/** 新注册验证、重发及相应测试（封/日），是认证日池的子集；剩余不足先停注册。附录 A.4；§9.2。 */
export const MAIL_SIGNUP_AUTH_DAY = 10 as const;

/** 基础日池（封）：常规提前提醒与新事件公布。附录 A.4 原值 25；**ADR-0003 修订一变更为 50**（随子名额抬高，保留 1.25x 重试余量）。 */
export const MAIL_BASE_DAY = 50 as const;

/** 紧急日池（封）：取消/撤回、重要更正、晚发现；不做平滑，须覆盖一次全量取消 + floor。附录 A.4 原值 60；**ADR-0003 变更为 120**。 */
export const MAIL_URGENT_DAY = 120 as const;

/** 全用途日上限（封）：= MAIL_AUTH_DAY + MAIL_BASE_DAY + MAIL_URGENT_DAY，且服从 PLATFORM_MAIL_DAY_LIMIT。附录 A.4 原值 175；**ADR-0003 变更为 260**。 */
export const MAIL_TOTAL_DAY = 260 as const;

/** 认证日池底线储备（封）：**当日剩余**跌破后只接受既有账号首次登录、暂停新注册发信与全部重发。附录 A.4 原值 200/月；**ADR-0003 口径改为 20/日**。 */
export const MAIL_AUTH_FLOOR = 20 as const;

/** 紧急日池底线（封）：**当日剩余**跌破后收紧为只发取消/撤回。附录 A.4 原值 150/月；**ADR-0003 口径改为 20/日**。 */
export const MAIL_URGENT_FLOOR = 20 as const;

/** 每账号基础发送机会（封/日）；同批次多条候选按 §7.3 合并为一封。附录 A.4。 */
export const MAIL_USER_BASE_DAY = 1 as const;

/** 每账号紧急发送机会（封/日）；非保证额度。附录 A.4。 */
export const MAIL_USER_URGENT_DAY = 2 as const;

/** 同用户同优先级候选的合并前瞻窗口（秒）；**只允许提前发送，不允许推迟任何一条**（语义条款见 verify.ts）。附录 A.4；§7.3。 */
export const MAIL_DIGEST_WINDOW = 600 as const;

/** 未完成 MailOutbox 上限。附录 A.4；§9.2。 */
export const MAIL_PENDING_MAX = 500 as const;

/** 认证槽包含在 MAIL_PENDING_MAX 总量内；业务不得占用预留部分。附录 A.4；§9.2。 */
export const MAIL_AUTH_RESERVED_PENDING = 200 as const;

/** 短期发送元数据容量，不保存完整正文。附录 A.4；§8.1。 */
export const MAIL_RECORD_MAX = 10_000 as const;

/** 反馈记录容量。附录 A.4；§7.4。 */
export const MAIL_FEEDBACK_MAX = 20_000 as const;

/** 未关联反馈的有限保留。附录 A.4；§7.4。 */
export const MAIL_UNMATCHED_MAX = 1000 as const;

/** Queue 小批消费条数。附录 A.4；§7.4。 */
export const FEEDBACK_BATCH = 10 as const;

/** 反馈重试次数上限；重试后进入 DLQ。附录 A.4；§7.4。 */
export const FEEDBACK_MAX_RETRIES = 8 as const;

/** 每账号 Push 绑定上限。附录 A.4；§7.7。 */
export const PUSH_USER_MAX = 5 as const;

/** 全站 active Push 上限。附录 A.4；§7.7。 */
export const PUSH_ACTIVE_MAX = 500 as const;

/** 全站 Push 总量上限（含 active）。附录 A.4；§7.7。 */
export const PUSH_TOTAL_MAX = 550 as const;

/** 全站 pending Push 上限。附录 A.4；§7.7。 */
export const PUSH_PENDING_MAX = 50 as const;

/** 每日新绑定上限。附录 A.4；§7.7。 */
export const PUSH_NEW_DAY = 50 as const;

/** 每日外发上限，含业务、激活、测试、重试。附录 A.4；§7.7。 */
export const PUSH_SEND_DAY = 5000 as const;

/** 关键预留，包含在 PUSH_SEND_DAY 总预算内。附录 A.4；§7.7。 */
export const PUSH_CRITICAL_RESERVED_DAY = 500 as const;

/** 可见激活期限。附录 A.4；§7.7。 */
export const PUSH_ACTIVATION_TTL = 600 as const;

/** 激活尝试次数；有效接收证明后才 active。附录 A.4；§7.7。 */
export const PUSH_ACTIVATION_ATTEMPTS = 3 as const;

/** 同绑定测试冷却。附录 A.4；§7.7。 */
export const PUSH_TEST_COOLDOWN = 60 as const;

/** 全站测试日量，仍计入总发送。附录 A.4；§7.7。 */
export const PUSH_TEST_DAY = 200 as const;

/** 服务租约（天），不是浏览器协议有效期。附录 A.4；§7.7。 */
export const PUSH_LEASE = 180 as const;

/** 失效宽限（天）。附录 A.4；§7.7。 */
export const PUSH_STALE_GRACE = 30 as const;

/** 合并真实业务确认的写入间隔（天）；激活独立处理。附录 A.4；§7.7。 */
export const PUSH_RECEIPT_WRITE_INTERVAL = 1 as const;

// ---------------------------------------------------------------------------
// A.5 保留与配置依赖（主方案 §7.4、§8.1、§10.3）
// ---------------------------------------------------------------------------

/** 未完成 Delivery 上限；不通过删除未完成任务腾容量。附录 A.5；§7.2。 */
export const DELIVERY_PENDING_MAX = 5000 as const;

/** Delivery 记录容量；同样不靠删除腾容量。附录 A.5；§7.4。 */
export const DELIVERY_RECORD_MAX = 50_000 as const;

/** 发生项去重保留（附录原值 7 天）：大于发生项/重试有效期；发生项结束后不得重新展开。附录 A.5；§7.2。 */
export const DELIVERY_DEDUPE_TTL = 604_800 as const;

/** 发送元数据保留（附录原值 30 天）；OTP/完成回执密文按短期生命周期即时清除，不套用此期限。附录 A.5；§4.3。 */
export const MAIL_METADATA_TTL = 2_592_000 as const;

/** 反馈记录保留（附录原值 30 天）；到期汇总，未决事件保持有限异常记录。附录 A.5。 */
export const MAIL_FEEDBACK_TTL = 2_592_000 as const;

/** 过期认证清理最迟时间（附录原值 24 小时）；过期即不能授权。附录 A.5；§4.3。 */
export const EXPIRED_AUTH_CLEANUP = 86_400 as const;

/** 过期会话元数据脱敏审计后清除 token_hash 的期限（附录原值 7 天）。附录 A.5；§4.5。 */
export const EXPIRED_SESSION_METADATA = 604_800 as const;

/** 限速窗口容量；满额采用粗粒度拒绝，不继续生成无限键。附录 A.5；§9.5。 */
export const RATE_WINDOWS_MAX = 10_000 as const;

/** 窗口结束后的清理延迟（附录原值 24 小时）。附录 A.5；§9.5。 */
export const RATE_WINDOWS_CLEANUP_DELAY = 86_400 as const;

/** 未被引用文章保留（附录原值 30 天）；正式证据引用优先。附录 A.5；§3.2。 */
export const UNUSED_ARTICLE_TTL = 2_592_000 as const;

/** 未被引用版本保留（附录原值 90 天）；同上。附录 A.5。 */
export const UNREFERENCED_VERSION_TTL = 7_776_000 as const;

/** 事件证据保留（附录原值 365 天）；活跃、争议和未到期公共更正可延长。附录 A.5；§3.2。 */
export const EVENT_EVIDENCE_TTL = 31_536_000 as const;

/** 通道同意关闭后的最小脱敏记录保留（附录原值 180 天）；平台抑制另按其规则，不自动到期解封。附录 A.5；§4.7。 */
export const CONSENT_AUDIT_AFTER_CLOSE = 15_552_000 as const;

/** 独立加密备份间隔（附录原值 7 天）。附录 A.5；§10.3。 */
export const BACKUP_INTERVAL = 604_800 as const;

/** 备份份数；密钥另存，完成恢复演练。附录 A.5；§10.3。 */
export const BACKUP_COPIES = 4 as const;

// ---------------------------------------------------------------------------
// 聚合快照与元数据
// ---------------------------------------------------------------------------

/** 全部参数的聚合快照（名字即附录原名）。等式校验与文档导出以此为值来源。 */
export const PARAMS = {
  // A.1
  SUPPORTED_SCOPE,
  SUBSCRIPTION_INIT_STATE,
  DEFAULT_SCOPE_GAMES,
  DEFAULT_CALENDAR_EVENT_TYPES,
  DEFAULT_CALENDAR_NODE_TYPES,
  DEFAULT_RULE_IDS,
  CALENDAR_ALARMS_DEFAULT,
  CHANGE_DEFAULTS,
  SOURCE_POLL,
  SOURCE_HOT_POLL,
  SOURCE_RECHECK_WINDOW,
  SOURCE_RECHECK_INTERVAL,
  SOURCE_LIMIT_PROFILE,
  DISCOVERY_TARGET,
  PUBLICATION_TARGET,
  WATCHDOG_INTERVAL,
  MATCH_PAGE,
  SEND_CONCURRENCY,
  EXECUTOR_BATCH_WALL_LIMIT,
  CONFIG_MAX_BYTES,
  API_BODY_MAX_BYTES,
  USER_MUTATIONS_DAY,
  GLOBAL_MUTATIONS_DAY,
  // A.2
  SECRET_BITS,
  ACCOUNT_MAX_STORED,
  REGISTRATIONS_DAY,
  OTP_DIGITS,
  OTP_TTL,
  OTP_ATTEMPTS,
  OTP_COOLDOWN,
  EMAIL_AUTH_INTENTS_DAY,
  EMAIL_VERIFY_ATTEMPTS_HOUR,
  AUTH_CHALLENGES_MAX,
  AUTH_CHALLENGES_PER_EMAIL,
  PREAUTH_MIN_TTL,
  PREAUTH_MARGIN,
  AUTH_COMPLETION_TTL,
  SESSION_PENDING_TTL,
  SESSION_PENDING_PER_USER,
  SESSION_ABSOLUTE_TTL,
  SESSION_ABSOLUTE_JITTER,
  SESSION_IDLE_TTL,
  SESSION_RENEW_INTERVAL,
  SESSION_EXPIRY_NOTICE,
  SESSION_ACTIVE_MAX,
  SESSION_LABEL_SOURCE,
  RECENT_AUTH_TTL,
  RECOVERY_CODE_COUNT,
  RECOVERY_ATTEMPTS_HOUR,
  RECOVERY_ATTEMPTS_DAY,
  ACCOUNT_IDLE_DAYS,
  ACCOUNT_GRACE_DAYS,
  FEED_ACTIVITY_WRITE_INTERVAL,
  RECLAIM_TELEMETRY_STALE_HOURS,
  ADMIN_SESSION_TTL,
  // A.3
  FEED_PAST_DAYS,
  FEED_FUTURE_DAYS,
  FEED_BASE_NODE_MAX,
  FEED_PATCH_NODE_MAX,
  FEED_RESPONSE_MAX_BYTES,
  FEED_SHRINK_GUARD_RATIO,
  FEED_SHRINK_GUARD_MIN,
  CAL_PATCH_MIN_DAYS,
  CAL_PATCH_TAIL_DAYS,
  CAL_PATCH_GLOBAL_MAX,
  PUBLIC_CACHE_FRESH,
  FEED_MAX_STALE,
  REMINDER_GRACE,
  NEW_EVENT_TTL,
  CHANGE_TTL,
  LATE_NOTICE_TTL,
  LATE_POST_START_WINDOW,
  AI_SOFT_DAY,
  AI_HARD_DAY,
  MODEL_MAX_INPUT,
  MODEL_MAX_BILLED_OUTPUT,
  MODEL_STRUCT_REPAIR,
  MODEL_NETWORK_RETRIES,
  EXTRACTION_EVAL_MIN,
  KEY_EVENT_RECALL,
  AUTO_PUBLISH_TIME_ERRORS,
  // A.4（ADR-0003 纯日额度模型；月度参数已废止，不得出现）
  MAIL_SEATS_MAX,
  MAIL_ROUTINE_SEATS_MAX,
  MAIL_SEAT_LEASE,
  PLATFORM_MAIL_DAY_LIMIT,
  MAIL_AUTH_DAY,
  MAIL_SIGNUP_AUTH_DAY,
  MAIL_BASE_DAY,
  MAIL_URGENT_DAY,
  MAIL_TOTAL_DAY,
  MAIL_AUTH_FLOOR,
  MAIL_URGENT_FLOOR,
  MAIL_USER_BASE_DAY,
  MAIL_USER_URGENT_DAY,
  MAIL_DIGEST_WINDOW,
  MAIL_PENDING_MAX,
  MAIL_AUTH_RESERVED_PENDING,
  MAIL_RECORD_MAX,
  MAIL_FEEDBACK_MAX,
  MAIL_UNMATCHED_MAX,
  FEEDBACK_BATCH,
  FEEDBACK_MAX_RETRIES,
  PUSH_USER_MAX,
  PUSH_ACTIVE_MAX,
  PUSH_TOTAL_MAX,
  PUSH_PENDING_MAX,
  PUSH_NEW_DAY,
  PUSH_SEND_DAY,
  PUSH_CRITICAL_RESERVED_DAY,
  PUSH_ACTIVATION_TTL,
  PUSH_ACTIVATION_ATTEMPTS,
  PUSH_TEST_COOLDOWN,
  PUSH_TEST_DAY,
  PUSH_LEASE,
  PUSH_STALE_GRACE,
  PUSH_RECEIPT_WRITE_INTERVAL,
  // A.5
  DELIVERY_PENDING_MAX,
  DELIVERY_RECORD_MAX,
  DELIVERY_DEDUPE_TTL,
  MAIL_METADATA_TTL,
  MAIL_FEEDBACK_TTL,
  EXPIRED_AUTH_CLEANUP,
  EXPIRED_SESSION_METADATA,
  RATE_WINDOWS_MAX,
  RATE_WINDOWS_CLEANUP_DELAY,
  UNUSED_ARTICLE_TTL,
  UNREFERENCED_VERSION_TTL,
  EVENT_EVIDENCE_TTL,
  CONSENT_AUDIT_AFTER_CLOSE,
  BACKUP_INTERVAL,
  BACKUP_COPIES,
} as const;

/** 等式校验与测试注入用的参数值快照类型。 */
export type ParamValues = typeof PARAMS;

/** 参数状态：基线值 / ADR-0003 修订 / 平台实测 / 引用实测文件 / P0 待定 / 界面预选 / 策略描述。 */
export type ParamStatus =
  | "baseline"
  | "adr-0003"
  | "measured"
  | "measured-ref"
  | "pending-p0"
  | "ui-preset"
  | "strategy";

/** 单条参数的机器可读元数据（文档表格导出用；与 PARAMS 键一一对应，由测试保证）。 */
export interface ParamMeta {
  readonly section: "A.1" | "A.2" | "A.3" | "A.4" | "A.5";
  readonly unit: string;
  readonly description: string;
  readonly status: ParamStatus;
  readonly note?: string;
}

/** 附录 A.6 提醒规则注册表不复制进本表：唯一定义源在 ../rules.ts（REMINDER_RULES）。 */
export const PARAM_META: Readonly<Record<keyof ParamValues, ParamMeta>> = {
  // A.1
  SUPPORTED_SCOPE: {
    section: "A.1",
    unit: "—",
    description: "仅开放验证通过的来源类别（genshin / hsr / zzz；CN）；不自动加入未来游戏",
    status: "baseline",
    note: "取值引用 enums.ts（P1-02），单一运行时定义源",
  },
  SUBSCRIPTION_INIT_STATE: {
    section: "A.1",
    unit: "枚举",
    description: "新账号订阅行初值；首次合法保存后转 initialized 且不可退回",
    status: "baseline",
  },
  DEFAULT_SCOPE_GAMES: {
    section: "A.1",
    unit: "游戏枚举数组",
    description: "仅作界面预选（三款全选）；用户保存前不构成正式 scope",
    status: "ui-preset",
    note: "§4.4：服务端不得写入订阅行",
  },
  DEFAULT_CALENDAR_EVENT_TYPES: {
    section: "A.1",
    unit: "事件类型数组",
    description: "界面预选的基础可见事件类型",
    status: "ui-preset",
    note: "§4.4：服务端不得写入订阅行",
  },
  DEFAULT_CALENDAR_NODE_TYPES: {
    section: "A.1",
    unit: "节点类型数组",
    description: "界面预选的基础可见节点；phase_unlock 默认不选（噪音较高）",
    status: "ui-preset",
    note: "§4.4：服务端不得写入订阅行",
  },
  DEFAULT_RULE_IDS: {
    section: "A.1",
    unit: "rule_id 数组",
    description: "提醒推荐值，用户确认后生效；规则可以为空",
    status: "ui-preset",
    note: "rule_id 定义源在 rules.ts（A.6），此处不复制",
  },
  CALENDAR_ALARMS_DEFAULT: {
    section: "A.1",
    unit: "布尔",
    description: "首次启用展示关联节点及兼容提示；不代表外部客户端已授予提醒能力",
    status: "baseline",
  },
  CHANGE_DEFAULTS: {
    section: "A.1",
    unit: "四开关对象",
    description: "变更通知界面预选：new_event=false，其余三开；邮件/Push 通道本身默认关闭",
    status: "ui-preset",
    note: "键形状引用 SubscriptionConfig.notifications（subscription.ts）",
  },
  SOURCE_POLL: {
    section: "A.1",
    unit: "秒",
    description: "常规轮询间隔，服从来源实际限制",
    status: "baseline",
  },
  SOURCE_HOT_POLL: {
    section: "A.1",
    unit: "秒",
    description: "前瞻/更新前后的热点轮询",
    status: "baseline",
  },
  SOURCE_RECHECK_WINDOW: {
    section: "A.1",
    unit: "天",
    description: "近期公告正文复查范围",
    status: "baseline",
  },
  SOURCE_RECHECK_INTERVAL: {
    section: "A.1",
    unit: "秒",
    description: "复查间隔；活跃关联公告继续受限跟踪",
    status: "baseline",
  },
  SOURCE_LIMIT_PROFILE: {
    section: "A.1",
    unit: "按来源结构",
    description: "页数、正文大小、请求超时、重定向和批量上限",
    status: "measured-ref",
    note: "P0-02 实测，见 fixtures/sources/registry.draft.json 的 limit_profile_measured",
  },
  DISCOVERY_TARGET: {
    section: "A.1",
    unit: "秒",
    description: "自官方发布时间计的发现目标（不是 SLA）",
    status: "baseline",
  },
  PUBLICATION_TARGET: {
    section: "A.1",
    unit: "秒",
    description: "自官方发布时间计的发布目标（不是 SLA）",
    status: "baseline",
  },
  WATCHDOG_INTERVAL: {
    section: "A.1",
    unit: "秒",
    description: "修复两个固定执行器",
    status: "baseline",
  },
  MATCH_PAGE: {
    section: "A.1",
    unit: "候选/页",
    description: "到期展开的匹配分页",
    status: "baseline",
  },
  SEND_CONCURRENCY: {
    section: "A.1",
    unit: "并发",
    description: "外发并发，实测后调整",
    status: "baseline",
  },
  EXECUTOR_BATCH_WALL_LIMIT: {
    section: "A.1",
    unit: "秒",
    description: "执行器到限保存进度，不常驻等待",
    status: "baseline",
  },
  CONFIG_MAX_BYTES: {
    section: "A.1",
    unit: "字节（KiB 原文）",
    description: "正式订阅配置上限（4 KiB）",
    status: "baseline",
  },
  API_BODY_MAX_BYTES: {
    section: "A.1",
    unit: "字节（KiB 原文）",
    description: "普通账号/Push 请求体上限（8 KiB）；认证另用小字段 Schema",
    status: "baseline",
  },
  USER_MUTATIONS_DAY: {
    section: "A.1",
    unit: "次/日",
    description: "每账号业务修改上限；不限制终止路径（§9.5）",
    status: "baseline",
  },
  GLOBAL_MUTATIONS_DAY: {
    section: "A.1",
    unit: "次/日",
    description: "全站业务修改上限；同样不限制终止路径",
    status: "baseline",
  },
  // A.2
  SECRET_BITS: {
    section: "A.2",
    unit: "位",
    description: "Session、Feed、恢复秘密等随机强度；验证码另算",
    status: "baseline",
  },
  ACCOUNT_MAX_STORED: {
    section: "A.2",
    unit: "账号",
    description: "账号存量上限",
    status: "baseline",
  },
  REGISTRATIONS_DAY: {
    section: "A.2",
    unit: "次/日",
    description: "每 UTC 日完成注册上限；另受发信、预占和开放状态限制",
    status: "baseline",
  },
  OTP_DIGITS: {
    section: "A.2",
    unit: "位",
    description: "均匀随机生成的验证码位数",
    status: "baseline",
  },
  OTP_TTL: {
    section: "A.2",
    unit: "秒",
    description: "验证码有效期；重发不延长最初总期限",
    status: "baseline",
  },
  OTP_ATTEMPTS: {
    section: "A.2",
    unit: "次/挑战",
    description: "每挑战尝试上限；重发不重置累计错误次数",
    status: "baseline",
  },
  OTP_COOLDOWN: {
    section: "A.2",
    unit: "秒",
    description: "同规范邮箱发送间隔",
    status: "baseline",
  },
  EMAIL_AUTH_INTENTS_DAY: {
    section: "A.2",
    unit: "次/日",
    description: "同规范邮箱的登录、重发及重新验证合计",
    status: "baseline",
  },
  EMAIL_VERIFY_ATTEMPTS_HOUR: {
    section: "A.2",
    unit: "次/小时",
    description: "邮箱级额外防猜测边界",
    status: "baseline",
  },
  AUTH_CHALLENGES_MAX: {
    section: "A.2",
    unit: "个",
    description: "全站短期挑战上限",
    status: "baseline",
  },
  AUTH_CHALLENGES_PER_EMAIL: {
    section: "A.2",
    unit: "个",
    description: "同规范邮箱同时有效挑战数",
    status: "baseline",
  },
  PREAUTH_MIN_TTL: {
    section: "A.2",
    unit: "秒",
    description: "预认证会话下限；已按 A.5 等式取 OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN",
    status: "baseline",
  },
  PREAUTH_MARGIN: {
    section: "A.2",
    unit: "秒",
    description: "预认证 Cookie 的额外余量",
    status: "baseline",
  },
  AUTH_COMPLETION_TTL: {
    section: "A.2",
    unit: "秒",
    description: "完成回执最大期限；激活即清除密文",
    status: "baseline",
  },
  SESSION_PENDING_TTL: {
    section: "A.2",
    unit: "秒",
    description: "pending 会话超时清理，不占 active 名额",
    status: "baseline",
  },
  SESSION_PENDING_PER_USER: {
    section: "A.2",
    unit: "个",
    description: "同账号同时有效 pending 会话数",
    status: "baseline",
  },
  SESSION_ABSOLUTE_TTL: {
    section: "A.2",
    unit: "秒（原文 180 天）",
    description: "绝对到期不被续期突破",
    status: "baseline",
  },
  SESSION_ABSOLUTE_JITTER: {
    section: "A.2",
    unit: "秒（原文 ±20 天）",
    description: "创建时抽取并固定写入的抖动幅度，摊平集中到期",
    status: "baseline",
  },
  SESSION_IDLE_TTL: {
    section: "A.2",
    unit: "秒（原文 90 天）",
    description: "不活跃到期；只用外部日历的用户由此决定重新认证频率（§9.3）",
    status: "baseline",
  },
  SESSION_RENEW_INTERVAL: {
    section: "A.2",
    unit: "秒（原文 7 天）",
    description: "每会话续期最小间隔；只由真实前台操作触发（§4.5）",
    status: "baseline",
  },
  SESSION_EXPIRY_NOTICE: {
    section: "A.2",
    unit: "秒（原文 14 天）",
    description: "到期前网页提示窗口",
    status: "baseline",
  },
  SESSION_ACTIVE_MAX: {
    section: "A.2",
    unit: "个",
    description: "同账号 active 会话上限；满额由用户选择撤销",
    status: "baseline",
  },
  SESSION_LABEL_SOURCE: {
    section: "A.2",
    unit: "策略",
    description:
      "会话标签来源：用户自填，缺省为创建时间 + 粗粒度平台；仅作显示，IP/UA 指纹不参与鉴权",
    status: "strategy",
  },
  RECENT_AUTH_TTL: {
    section: "A.2",
    unit: "秒",
    description: "限定 Session、用途和目标的近期认证有效期，单次消费",
    status: "baseline",
  },
  RECOVERY_CODE_COUNT: {
    section: "A.2",
    unit: "个",
    description: "当前恢复码个数；恢复登录消费后立即交付新码；紧急停用不消费",
    status: "baseline",
  },
  RECOVERY_ATTEMPTS_HOUR: {
    section: "A.2",
    unit: "次/小时",
    description: "按 recovery_id 与来源分别计的尝试上限（针对枚举与刷量）",
    status: "baseline",
  },
  RECOVERY_ATTEMPTS_DAY: {
    section: "A.2",
    unit: "次/日",
    description: "同上的每日上限；超出返回统一的稍后重试",
    status: "baseline",
  },
  ACCOUNT_IDLE_DAYS: {
    section: "A.2",
    unit: "天",
    description: "无有效活动才进入回收；不以无网页登录单独判定",
    status: "baseline",
  },
  ACCOUNT_GRACE_DAYS: {
    section: "A.2",
    unit: "天",
    description: "回收宽限；宽限期内仍可凭原账号证明恢复",
    status: "baseline",
  },
  FEED_ACTIVITY_WRITE_INTERVAL: {
    section: "A.2",
    unit: "天",
    description: "活动水位合并写入间隔；随授权查询同事务完成",
    status: "baseline",
  },
  RECLAIM_TELEMETRY_STALE_HOURS: {
    section: "A.2",
    unit: "小时",
    description: "活动水位失真超此值即全局暂停账号与席位回收（§6.6）",
    status: "baseline",
  },
  ADMIN_SESSION_TTL: {
    section: "A.2",
    unit: "秒（原文 12 小时）",
    description: "独立管理员权限域的会话期限",
    status: "baseline",
  },
  // A.3
  FEED_PAST_DAYS: {
    section: "A.3",
    unit: "天",
    description: "完整基础窗口过去端",
    status: "baseline",
  },
  FEED_FUTURE_DAYS: {
    section: "A.3",
    unit: "天",
    description: "完整基础窗口未来端；共享更正允许受限越界",
    status: "baseline",
  },
  FEED_BASE_NODE_MAX: {
    section: "A.3",
    unit: "节点",
    description: "基础可见 + 提醒关联节点上限",
    status: "baseline",
  },
  FEED_PATCH_NODE_MAX: {
    section: "A.3",
    unit: "条目",
    description: "更正层条目上限；合并去重后仍受响应字节限制",
    status: "baseline",
  },
  FEED_RESPONSE_MAX_BYTES: {
    section: "A.3",
    unit: "字节（原文 2 MiB）",
    description: "超限报错，不静默截断",
    status: "baseline",
  },
  FEED_SHRINK_GUARD_RATIO: {
    section: "A.3",
    unit: "比例",
    description: "缩水守卫触发比例（§6.5）；须在开区间 (0,1)",
    status: "baseline",
  },
  FEED_SHRINK_GUARD_MIN: {
    section: "A.3",
    unit: "条",
    description: "低于此条目数的小日历不触发守卫",
    status: "baseline",
  },
  CAL_PATCH_MIN_DAYS: {
    section: "A.3",
    unit: "天",
    description: "更正保留下限，仅用于公共更正层",
    status: "baseline",
  },
  CAL_PATCH_TAIL_DAYS: {
    section: "A.3",
    unit: "天",
    description: "覆盖旧节点最晚时间之后的保留尾巴",
    status: "baseline",
  },
  CAL_PATCH_GLOBAL_MAX: {
    section: "A.3",
    unit: "条",
    description: "公共更正记录保护值；接近上限告警并暂停非关键扩大",
    status: "baseline",
  },
  PUBLIC_CACHE_FRESH: {
    section: "A.3",
    unit: "秒",
    description: "公共快照新鲜窗口",
    status: "baseline",
  },
  FEED_MAX_STALE: {
    section: "A.3",
    unit: "秒（原文 24 小时）",
    description: "私人 Feed 只用当前完整发布代次，不回退旧代次",
    status: "baseline",
  },
  REMINDER_GRACE: {
    section: "A.3",
    unit: "秒",
    description: "正常提前提醒有效期，且不超过节点时刻",
    status: "baseline",
  },
  NEW_EVENT_TTL: {
    section: "A.3",
    unit: "秒",
    description: "新事件公布有效期",
    status: "baseline",
  },
  CHANGE_TTL: {
    section: "A.3",
    unit: "秒",
    description: "取消及重要更正有效期",
    status: "baseline",
  },
  LATE_NOTICE_TTL: {
    section: "A.3",
    unit: "秒",
    description: "晚发现尝试窗口",
    status: "baseline",
  },
  LATE_POST_START_WINDOW: {
    section: "A.3",
    unit: "秒",
    description: "开始后允许补报范围；截止已过不补临近通知",
    status: "baseline",
  },
  AI_SOFT_DAY: {
    section: "A.3",
    unit: "Neurons/日",
    description: "模型日预算软线：优先前瞻/维护/截止/关键更正，停低价值回填",
    status: "baseline",
    note: "套餐包含量未证实（platform-facts.md）；P0-03 须反向校验",
  },
  AI_HARD_DAY: {
    section: "A.3",
    unit: "Neurons/日",
    description: "模型日预算硬线；所有 profile 共用账本，含失败和重试",
    status: "baseline",
    note: "不得编造套餐包含量让校验通过；启用看 AI_BILLING_PROFILE_CONFIGURED",
  },
  MODEL_MAX_INPUT: {
    section: "A.3",
    unit: "token",
    description: "输入保护值——未填写",
    status: "pending-p0",
    note: "P0-03 按真实部署填写；未填写前模型自动调用默认关闭",
  },
  MODEL_MAX_BILLED_OUTPUT: {
    section: "A.3",
    unit: "token",
    description: "完整计费输出上界——未填写",
    status: "pending-p0",
    note: "无法确定完整计费输出上界时，不开放自动调用",
  },
  MODEL_STRUCT_REPAIR: {
    section: "A.3",
    unit: "次",
    description: "结构修复额外调用；先预占费用，用尽进入审核",
    status: "baseline",
  },
  MODEL_NETWORK_RETRIES: {
    section: "A.3",
    unit: "次",
    description: "网络重试额外调用；同样先预占并计量",
    status: "baseline",
  },
  EXTRACTION_EVAL_MIN: {
    section: "A.3",
    unit: "篇",
    description: "三游戏均覆盖的评估样本量；合成样本须明确标注",
    status: "baseline",
  },
  KEY_EVENT_RECALL: {
    section: "A.3",
    unit: "比例（原文 ≥95%）",
    description: "关键事件召回门槛",
    status: "baseline",
  },
  AUTO_PUBLISH_TIME_ERRORS: {
    section: "A.3",
    unit: "个",
    description: "自动发布保留集已知时间错误为 0（有限样本门槛）",
    status: "baseline",
  },
  // A.4
  MAIL_SEATS_MAX: {
    section: "A.4",
    unit: "席",
    description: "邮件席位：取消/撤回、重要更正、晚发现",
    status: "adr-0003",
    note: "附录原值 50；ADR-0003 变更 100",
  },
  MAIL_ROUTINE_SEATS_MAX: {
    section: "A.4",
    unit: "席",
    description: "席位子名额：额外开启常规提前提醒邮件（默认关闭，§7.5）",
    status: "adr-0003",
    note: "附录原值 20；ADR-0003 修订一变更 40",
  },
  MAIL_SEAT_LEASE: {
    section: "A.4",
    unit: "天",
    description: "服务租期；有账号活动信号即自动续租（§9.4）",
    status: "baseline",
  },
  PLATFORM_MAIL_DAY_LIMIT: {
    section: "A.4",
    unit: "封/日",
    description: "平台侧邮件日发送上限",
    status: "measured",
    note: "实测值：GET /accounts/{id}/email/sending/limits（platform-facts.md，2026-09-22）；随平台变动须重跑 params:verify",
  },
  MAIL_AUTH_DAY: {
    section: "A.4",
    unit: "封/日",
    description: "认证日硬上限（含新注册子集）；持续消耗由 MAIL_AUTH_FLOOR 降级约束",
    status: "baseline",
  },
  MAIL_SIGNUP_AUTH_DAY: {
    section: "A.4",
    unit: "封/日",
    description: "新注册是认证日池的子集；剩余不足先停注册",
    status: "baseline",
  },
  MAIL_BASE_DAY: {
    section: "A.4",
    unit: "封/日",
    description: "基础日池：常规提前提醒与新事件公布",
    status: "adr-0003",
    note: "附录原值 25；ADR-0003 修订一变更 50（保留 1.25x 重试余量）",
  },
  MAIL_URGENT_DAY: {
    section: "A.4",
    unit: "封/日",
    description: "紧急日池：取消/撤回、重要更正、晚发现；须覆盖一次全量取消 + floor",
    status: "adr-0003",
    note: "附录原值 60；ADR-0003 变更 120",
  },
  MAIL_TOTAL_DAY: {
    section: "A.4",
    unit: "封/日",
    description: "全用途日上限 = 认证 + 基础 + 紧急，且服从 PLATFORM_MAIL_DAY_LIMIT",
    status: "adr-0003",
    note: "附录原值 175；ADR-0003 变更 260",
  },
  MAIL_AUTH_FLOOR: {
    section: "A.4",
    unit: "封（当日剩余口径）",
    description: "认证池底线：当日剩余跌破后只接受既有账号首次登录，暂停新注册发信与全部重发",
    status: "adr-0003",
    note: "附录原值 200/月；ADR-0003 口径改 20/日",
  },
  MAIL_URGENT_FLOOR: {
    section: "A.4",
    unit: "封（当日剩余口径）",
    description: "紧急池底线：当日剩余跌破后收紧为只发取消/撤回",
    status: "adr-0003",
    note: "附录原值 150/月；ADR-0003 口径改 20/日",
  },
  MAIL_USER_BASE_DAY: {
    section: "A.4",
    unit: "封/日",
    description: "每账号基础发送机会；同批次多条候选合并为一封（§7.3）",
    status: "baseline",
  },
  MAIL_USER_URGENT_DAY: {
    section: "A.4",
    unit: "封/日",
    description: "每账号紧急发送机会；非保证额度",
    status: "baseline",
  },
  MAIL_DIGEST_WINDOW: {
    section: "A.4",
    unit: "秒",
    description: "同用户同优先级候选的合并前瞻窗口；只允许提前发送，不允许推迟任何一条",
    status: "baseline",
    note: "方向性语义条款，见 verify.ts SEMANTIC_INVARIANTS",
  },
  MAIL_PENDING_MAX: {
    section: "A.4",
    unit: "条",
    description: "未完成 MailOutbox 上限",
    status: "baseline",
  },
  MAIL_AUTH_RESERVED_PENDING: {
    section: "A.4",
    unit: "槽",
    description: "认证槽包含在 MAIL_PENDING_MAX 内；业务不得占用预留部分",
    status: "baseline",
  },
  MAIL_RECORD_MAX: {
    section: "A.4",
    unit: "条",
    description: "短期发送元数据容量，不保存完整正文",
    status: "baseline",
  },
  MAIL_FEEDBACK_MAX: {
    section: "A.4",
    unit: "条",
    description: "反馈记录容量",
    status: "baseline",
  },
  MAIL_UNMATCHED_MAX: {
    section: "A.4",
    unit: "条",
    description: "未关联反馈的有限保留",
    status: "baseline",
  },
  FEEDBACK_BATCH: { section: "A.4", unit: "条", description: "Queue 小批消费", status: "baseline" },
  FEEDBACK_MAX_RETRIES: {
    section: "A.4",
    unit: "次",
    description: "重试后进入 DLQ",
    status: "baseline",
  },
  PUSH_USER_MAX: {
    section: "A.4",
    unit: "个",
    description: "每账号 Push 绑定上限",
    status: "baseline",
  },
  PUSH_ACTIVE_MAX: {
    section: "A.4",
    unit: "个",
    description: "全站 active 上限",
    status: "baseline",
  },
  PUSH_TOTAL_MAX: {
    section: "A.4",
    unit: "个",
    description: "全站总量上限（含 active）",
    status: "baseline",
  },
  PUSH_PENDING_MAX: {
    section: "A.4",
    unit: "个",
    description: "全站 pending 上限",
    status: "baseline",
  },
  PUSH_NEW_DAY: {
    section: "A.4",
    unit: "个/日",
    description: "每日新绑定上限",
    status: "baseline",
  },
  PUSH_SEND_DAY: {
    section: "A.4",
    unit: "次/日",
    description: "每日外发上限，含业务、激活、测试、重试",
    status: "baseline",
  },
  PUSH_CRITICAL_RESERVED_DAY: {
    section: "A.4",
    unit: "次/日",
    description: "关键预留，包含在外发总预算内",
    status: "baseline",
  },
  PUSH_ACTIVATION_TTL: {
    section: "A.4",
    unit: "秒",
    description: "可见激活期限",
    status: "baseline",
  },
  PUSH_ACTIVATION_ATTEMPTS: {
    section: "A.4",
    unit: "次",
    description: "有效接收证明后才 active",
    status: "baseline",
  },
  PUSH_TEST_COOLDOWN: {
    section: "A.4",
    unit: "秒",
    description: "同绑定测试冷却",
    status: "baseline",
  },
  PUSH_TEST_DAY: {
    section: "A.4",
    unit: "次/日",
    description: "全站测试日量，仍计入总发送",
    status: "baseline",
  },
  PUSH_LEASE: {
    section: "A.4",
    unit: "天",
    description: "服务租约，不是浏览器协议有效期",
    status: "baseline",
  },
  PUSH_STALE_GRACE: { section: "A.4", unit: "天", description: "失效宽限", status: "baseline" },
  PUSH_RECEIPT_WRITE_INTERVAL: {
    section: "A.4",
    unit: "天",
    description: "合并真实业务确认的写入间隔；激活独立处理",
    status: "baseline",
  },
  // A.5
  DELIVERY_PENDING_MAX: {
    section: "A.5",
    unit: "条",
    description: "未完成 Delivery 上限；不通过删除未完成任务腾容量",
    status: "baseline",
  },
  DELIVERY_RECORD_MAX: {
    section: "A.5",
    unit: "条",
    description: "Delivery 记录容量；同样不靠删除腾容量",
    status: "baseline",
  },
  DELIVERY_DEDUPE_TTL: {
    section: "A.5",
    unit: "秒（原文 7 天）",
    description: "大于发生项/重试有效期；发生项结束后不得重新展开",
    status: "baseline",
  },
  MAIL_METADATA_TTL: {
    section: "A.5",
    unit: "秒（原文 30 天）",
    description: "发送元数据保留；OTP/回执密文按短期生命周期即时清除，不套用此期限",
    status: "baseline",
  },
  MAIL_FEEDBACK_TTL: {
    section: "A.5",
    unit: "秒（原文 30 天）",
    description: "反馈记录保留；到期汇总，未决事件保持有限异常记录",
    status: "baseline",
  },
  EXPIRED_AUTH_CLEANUP: {
    section: "A.5",
    unit: "秒（原文 24 小时）",
    description: "过期即不能授权；此值仅为清理最迟时间",
    status: "baseline",
  },
  EXPIRED_SESSION_METADATA: {
    section: "A.5",
    unit: "秒（原文 7 天）",
    description: "脱敏审计后清除 token_hash",
    status: "baseline",
  },
  RATE_WINDOWS_MAX: {
    section: "A.5",
    unit: "键",
    description: "限速窗口容量；满额采用粗粒度拒绝",
    status: "baseline",
  },
  RATE_WINDOWS_CLEANUP_DELAY: {
    section: "A.5",
    unit: "秒（原文 24 小时）",
    description: "窗口结束后的清理延迟",
    status: "baseline",
  },
  UNUSED_ARTICLE_TTL: {
    section: "A.5",
    unit: "秒（原文 30 天）",
    description: "未被引用文章保留；正式证据引用优先",
    status: "baseline",
  },
  UNREFERENCED_VERSION_TTL: {
    section: "A.5",
    unit: "秒（原文 90 天）",
    description: "未被引用版本保留",
    status: "baseline",
  },
  EVENT_EVIDENCE_TTL: {
    section: "A.5",
    unit: "秒（原文 365 天）",
    description: "事件证据保留；活跃、争议和未到期公共更正可延长",
    status: "baseline",
  },
  CONSENT_AUDIT_AFTER_CLOSE: {
    section: "A.5",
    unit: "秒（原文 180 天）",
    description: "通道同意关闭后的最小脱敏记录；平台抑制不自动到期解封",
    status: "baseline",
  },
  BACKUP_INTERVAL: {
    section: "A.5",
    unit: "秒（原文 7 天）",
    description: "独立加密备份间隔",
    status: "baseline",
  },
  BACKUP_COPIES: {
    section: "A.5",
    unit: "份",
    description: "备份份数；密钥另存，完成恢复演练",
    status: "baseline",
  },
};

/**
 * ADR-0003 已废止的月度邮件参数：**不得再出现在本注册表或任何消费方**（AGENTS.md 第 3 节
 * 禁止清单：envelope 公式、carry、E=1 兜底、认证软线 S、月末半日片段同此）。测试对
 * Object.keys(PARAMS) 做静态断言。
 */
export const RETIRED_MAIL_PARAMS: readonly string[] = [
  "MAIL_TOTAL_MONTH",
  "MAIL_EXISTING_AUTH_MONTH",
  "MAIL_SIGNUP_AUTH_MONTH",
  "MAIL_BASE_MONTH",
  "MAIL_URGENT_MONTH",
];
