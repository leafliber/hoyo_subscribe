// 附录 A.5 启动等式校验（CONTRACTS_BASELINE.md §11；邮件部分按 ADR-0003 纯日额度模型改写）。
//
// 合同要点：
// - `pnpm params:verify` 与 Worker 启动路径都执行本文件的等式；任一不成立**拒绝启动/非零退出**，
//   并**指明是哪一条**（AGENTS.md 第 2 节硬规则 2；ENGINEERING.md §4）。
// - 邮件等式为纯日额度模型：月度等式（MAIL_TOTAL_MONTH 等）已废止，不得实现（AGENTS.md 禁止清单）。
// - 每条等式携带 breakSample（使该条失败的最小参数覆盖），用于反向验证测试：人为破坏每一条，
//   校验必须准确指出该条——只测"全部成立时通过"没有意义。
// - MAIL_DIGEST_WINDOW 的"只提前不推迟"是方向性语义条款，无法用参数数值表达，
//   单列为 SEMANTIC_INVARIANTS，由调度实现（P4-02）以测试保证。

import type { ParamValues } from "./registry";
import { PARAMS } from "./registry";

/**
 * 数值参数宽化为 number 的快照类型：等式校验与反向验证测试需要注入"人为破坏值"，
 * as const 的字面量类型（如 260）会拒绝 259。非数值参数保持原类型。
 */
export type WritableParamValues = {
  readonly [K in keyof ParamValues]: ParamValues[K] extends number ? number : ParamValues[K];
};

/** 一条启动等式的定义。 */
export interface EquationDefinition {
  /** 稳定标识（kebab-case），失败消息与测试据此指明是哪一条。 */
  readonly id: string;
  /** 所属分组（邮件 / 认证 / 会话 / 其余）。 */
  readonly group: string;
  /** 合同原文（CONTRACTS_BASELINE.md §11 行文）。 */
  readonly contract: string;
  /** 用实际值渲染出的公式（失败消息直接展示）。 */
  readonly render: (v: WritableParamValues) => string;
  /** 等式判断。 */
  readonly check: (v: WritableParamValues) => boolean;
  /** 使本条失败的最小参数覆盖（反向验证用；不得影响"该条确实失败"这一事实）。 */
  readonly breakSample: Partial<WritableParamValues>;
}

/** 单条等式的校验结果。 */
export interface EquationResult {
  readonly id: string;
  readonly group: string;
  readonly contract: string;
  readonly formula: string;
  readonly ok: boolean;
}

const eq = (
  id: string,
  group: string,
  contract: string,
  render: (v: WritableParamValues) => string,
  check: (v: WritableParamValues) => boolean,
  breakSample: Partial<WritableParamValues>,
): EquationDefinition => ({
  id,
  group,
  contract,
  render,
  check,
  breakSample,
});

/** 发生项有效期的最大值：提前提醒 / 新事件 / 取消与重要更正 / 晚发现四类候选中最大者。 */
const maxOccurrenceTtl = (v: WritableParamValues): number =>
  Math.max(v.REMINDER_GRACE, v.NEW_EVENT_TTL, v.CHANGE_TTL, v.LATE_NOTICE_TTL);

// 附录 A.5 / CONTRACTS_BASELINE.md §11 全部数值等式。行序与 §11 一致。
export const PARAM_EQUATIONS: readonly EquationDefinition[] = [
  // —— 邮件：纯日额度模型（ADR-0003）——
  eq(
    "mail-total-day-sum",
    "邮件（纯日额度）",
    "MAIL_TOTAL_DAY = MAIL_AUTH_DAY + MAIL_BASE_DAY + MAIL_URGENT_DAY",
    (v) =>
      `MAIL_TOTAL_DAY(${v.MAIL_TOTAL_DAY}) = MAIL_AUTH_DAY(${v.MAIL_AUTH_DAY}) + MAIL_BASE_DAY(${v.MAIL_BASE_DAY}) + MAIL_URGENT_DAY(${v.MAIL_URGENT_DAY}) → ${v.MAIL_TOTAL_DAY} = ${v.MAIL_AUTH_DAY + v.MAIL_BASE_DAY + v.MAIL_URGENT_DAY}`,
    (v) => v.MAIL_TOTAL_DAY === v.MAIL_AUTH_DAY + v.MAIL_BASE_DAY + v.MAIL_URGENT_DAY,
    { MAIL_TOTAL_DAY: 259 },
  ),
  eq(
    "mail-total-day-within-platform-limit",
    "邮件（纯日额度）",
    "MAIL_TOTAL_DAY <= PLATFORM_MAIL_DAY_LIMIT（平台实测日上限）",
    (v) =>
      `MAIL_TOTAL_DAY(${v.MAIL_TOTAL_DAY}) <= PLATFORM_MAIL_DAY_LIMIT(${v.PLATFORM_MAIL_DAY_LIMIT})`,
    (v) => v.MAIL_TOTAL_DAY <= v.PLATFORM_MAIL_DAY_LIMIT,
    { PLATFORM_MAIL_DAY_LIMIT: 259 },
  ),
  eq(
    "mail-signup-auth-day-subset",
    "邮件（纯日额度）",
    "MAIL_SIGNUP_AUTH_DAY <= MAIL_AUTH_DAY",
    (v) => `MAIL_SIGNUP_AUTH_DAY(${v.MAIL_SIGNUP_AUTH_DAY}) <= MAIL_AUTH_DAY(${v.MAIL_AUTH_DAY})`,
    (v) => v.MAIL_SIGNUP_AUTH_DAY <= v.MAIL_AUTH_DAY,
    { MAIL_SIGNUP_AUTH_DAY: 91 },
  ),
  eq(
    "mail-auth-floor-below-day",
    "邮件（纯日额度）",
    "MAIL_AUTH_FLOOR < MAIL_AUTH_DAY（floor 必须真正触得到）",
    (v) => `MAIL_AUTH_FLOOR(${v.MAIL_AUTH_FLOOR}) < MAIL_AUTH_DAY(${v.MAIL_AUTH_DAY})`,
    (v) => v.MAIL_AUTH_FLOOR < v.MAIL_AUTH_DAY,
    { MAIL_AUTH_FLOOR: 90 },
  ),
  eq(
    "mail-urgent-floor-below-day",
    "邮件（纯日额度）",
    "MAIL_URGENT_FLOOR < MAIL_URGENT_DAY（floor 必须真正触得到）",
    (v) => `MAIL_URGENT_FLOOR(${v.MAIL_URGENT_FLOOR}) < MAIL_URGENT_DAY(${v.MAIL_URGENT_DAY})`,
    (v) => v.MAIL_URGENT_FLOOR < v.MAIL_URGENT_DAY,
    { MAIL_URGENT_FLOOR: 120 },
  ),
  eq(
    "mail-routine-seats-within-seats",
    "邮件（池容量对得起承诺的名额）",
    "MAIL_ROUTINE_SEATS_MAX <= MAIL_SEATS_MAX",
    (v) =>
      `MAIL_ROUTINE_SEATS_MAX(${v.MAIL_ROUTINE_SEATS_MAX}) <= MAIL_SEATS_MAX(${v.MAIL_SEATS_MAX})`,
    (v) => v.MAIL_ROUTINE_SEATS_MAX <= v.MAIL_SEATS_MAX,
    { MAIL_ROUTINE_SEATS_MAX: 101 },
  ),
  eq(
    "mail-base-day-covers-routine-seats",
    "邮件（池容量对得起承诺的名额）",
    "MAIL_BASE_DAY >= MAIL_ROUTINE_SEATS_MAX × MAIL_USER_BASE_DAY（1.25x 重试余量：50 对 40）",
    (v) =>
      `MAIL_BASE_DAY(${v.MAIL_BASE_DAY}) >= MAIL_ROUTINE_SEATS_MAX(${v.MAIL_ROUTINE_SEATS_MAX}) × MAIL_USER_BASE_DAY(${v.MAIL_USER_BASE_DAY}) = ${v.MAIL_ROUTINE_SEATS_MAX * v.MAIL_USER_BASE_DAY}`,
    (v) => v.MAIL_BASE_DAY >= v.MAIL_ROUTINE_SEATS_MAX * v.MAIL_USER_BASE_DAY,
    // 注意：MAIL_BASE_DAY 50→49 不会破坏本条（49 >= 40 仍成立），只会连带破坏总和等式；
    // 1.25x 余量下本条的单点破坏场景是名额越过日池（41 仍不够，需 51）或日池跌破名额（39）。
    { MAIL_ROUTINE_SEATS_MAX: 51 },
  ),
  eq(
    "mail-urgent-day-covers-seats-plus-floor",
    "邮件（池容量对得起承诺的名额）",
    "MAIL_URGENT_DAY >= MAIL_SEATS_MAX + MAIL_URGENT_FLOOR（一次官方取消当天覆盖全部席位，且之后仍触得到 floor）",
    (v) =>
      `MAIL_URGENT_DAY(${v.MAIL_URGENT_DAY}) >= MAIL_SEATS_MAX(${v.MAIL_SEATS_MAX}) + MAIL_URGENT_FLOOR(${v.MAIL_URGENT_FLOOR}) = ${v.MAIL_SEATS_MAX + v.MAIL_URGENT_FLOOR}`,
    (v) => v.MAIL_URGENT_DAY >= v.MAIL_SEATS_MAX + v.MAIL_URGENT_FLOOR,
    { MAIL_URGENT_DAY: 119 },
  ),
  // —— 认证时序：下限本身即安全，不依赖实现另行加算 ——
  eq(
    "preauth-min-ttl-safe",
    "认证时序",
    "PREAUTH_MIN_TTL >= OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN",
    (v) =>
      `PREAUTH_MIN_TTL(${v.PREAUTH_MIN_TTL}) >= OTP_TTL(${v.OTP_TTL}) + AUTH_COMPLETION_TTL(${v.AUTH_COMPLETION_TTL}) + PREAUTH_MARGIN(${v.PREAUTH_MARGIN}) = ${v.OTP_TTL + v.AUTH_COMPLETION_TTL + v.PREAUTH_MARGIN}`,
    (v) => v.PREAUTH_MIN_TTL >= v.OTP_TTL + v.AUTH_COMPLETION_TTL + v.PREAUTH_MARGIN,
    { PREAUTH_MIN_TTL: 1319 },
  ),
  eq(
    "otp-cookie-covers-late-challenge",
    "认证时序",
    "OTP 绑定 Cookie 截止 >= 最晚挑战截止 + AUTH_COMPLETION_TTL + PREAUTH_MARGIN",
    (v) =>
      `OTP绑定Cookie截止(PREAUTH_MIN_TTL=${v.PREAUTH_MIN_TTL}) >= 最晚挑战截止(OTP_TTL=${v.OTP_TTL}) + AUTH_COMPLETION_TTL(${v.AUTH_COMPLETION_TTL}) + PREAUTH_MARGIN(${v.PREAUTH_MARGIN}) = ${v.OTP_TTL + v.AUTH_COMPLETION_TTL + v.PREAUTH_MARGIN}`,
    (v) => v.PREAUTH_MIN_TTL >= v.OTP_TTL + v.AUTH_COMPLETION_TTL + v.PREAUTH_MARGIN,
    { OTP_TTL: 601 },
  ),
  // —— 会话时序：抖动下界仍须显著大于不活跃期限 ——
  eq(
    "session-absolute-lower-above-idle",
    "会话时序",
    "SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER > SESSION_IDLE_TTL",
    (v) =>
      `SESSION_ABSOLUTE_TTL(${v.SESSION_ABSOLUTE_TTL}) - SESSION_ABSOLUTE_JITTER(${v.SESSION_ABSOLUTE_JITTER}) = ${v.SESSION_ABSOLUTE_TTL - v.SESSION_ABSOLUTE_JITTER} > SESSION_IDLE_TTL(${v.SESSION_IDLE_TTL})`,
    (v) => v.SESSION_ABSOLUTE_TTL - v.SESSION_ABSOLUTE_JITTER > v.SESSION_IDLE_TTL,
    { SESSION_ABSOLUTE_JITTER: 8_000_000 },
  ),
  eq(
    "session-idle-above-renew-interval",
    "会话时序",
    "SESSION_IDLE_TTL > SESSION_RENEW_INTERVAL",
    (v) =>
      `SESSION_IDLE_TTL(${v.SESSION_IDLE_TTL}) > SESSION_RENEW_INTERVAL(${v.SESSION_RENEW_INTERVAL})`,
    (v) => v.SESSION_IDLE_TTL > v.SESSION_RENEW_INTERVAL,
    { SESSION_RENEW_INTERVAL: 8_000_000 },
  ),
  eq(
    "session-idle-above-expiry-notice",
    "会话时序",
    "SESSION_IDLE_TTL > SESSION_EXPIRY_NOTICE",
    (v) =>
      `SESSION_IDLE_TTL(${v.SESSION_IDLE_TTL}) > SESSION_EXPIRY_NOTICE(${v.SESSION_EXPIRY_NOTICE})`,
    (v) => v.SESSION_IDLE_TTL > v.SESSION_EXPIRY_NOTICE,
    { SESSION_EXPIRY_NOTICE: 8_000_000 },
  ),
  // —— 其余 ——
  eq(
    "delivery-dedupe-above-occurrence-ttls",
    "其余",
    "DELIVERY_DEDUPE_TTL > 业务发生项最大有效期 + 最大重试余量",
    (v) =>
      `DELIVERY_DEDUPE_TTL(${v.DELIVERY_DEDUPE_TTL}) > max(REMINDER_GRACE ${v.REMINDER_GRACE}, NEW_EVENT_TTL ${v.NEW_EVENT_TTL}, CHANGE_TTL ${v.CHANGE_TTL}, LATE_NOTICE_TTL ${v.LATE_NOTICE_TTL}) = ${maxOccurrenceTtl(v)}（重试余量由调度实现再行加算，参数层以最大有效期为下界）`,
    (v) => v.DELIVERY_DEDUPE_TTL > maxOccurrenceTtl(v),
    { DELIVERY_DEDUPE_TTL: 86_400 },
  ),
  eq(
    "feed-shrink-guard-ratio-open-interval",
    "其余",
    "0 < FEED_SHRINK_GUARD_RATIO < 1",
    (v) => `0 < FEED_SHRINK_GUARD_RATIO(${v.FEED_SHRINK_GUARD_RATIO}) < 1`,
    (v) => v.FEED_SHRINK_GUARD_RATIO > 0 && v.FEED_SHRINK_GUARD_RATIO < 1,
    { FEED_SHRINK_GUARD_RATIO: 1 },
  ),
  // —— 预留包含于对应总量；pending <= total ——
  eq(
    "mail-auth-reserved-within-pending",
    "预留与容量包含",
    "MAIL_AUTH_RESERVED_PENDING <= MAIL_PENDING_MAX（认证预留包含在未完成总量内）",
    (v) =>
      `MAIL_AUTH_RESERVED_PENDING(${v.MAIL_AUTH_RESERVED_PENDING}) <= MAIL_PENDING_MAX(${v.MAIL_PENDING_MAX})`,
    (v) => v.MAIL_AUTH_RESERVED_PENDING <= v.MAIL_PENDING_MAX,
    { MAIL_AUTH_RESERVED_PENDING: 501 },
  ),
  eq(
    "mail-pending-within-record",
    "预留与容量包含",
    "MAIL_PENDING_MAX <= MAIL_RECORD_MAX（未完成量包含在元数据容量内）",
    (v) => `MAIL_PENDING_MAX(${v.MAIL_PENDING_MAX}) <= MAIL_RECORD_MAX(${v.MAIL_RECORD_MAX})`,
    (v) => v.MAIL_PENDING_MAX <= v.MAIL_RECORD_MAX,
    { MAIL_RECORD_MAX: 499 },
  ),
  eq(
    "mail-unmatched-within-feedback",
    "预留与容量包含",
    "MAIL_UNMATCHED_MAX <= MAIL_FEEDBACK_MAX（未关联反馈保留包含在反馈容量内）",
    (v) =>
      `MAIL_UNMATCHED_MAX(${v.MAIL_UNMATCHED_MAX}) <= MAIL_FEEDBACK_MAX(${v.MAIL_FEEDBACK_MAX})`,
    (v) => v.MAIL_UNMATCHED_MAX <= v.MAIL_FEEDBACK_MAX,
    { MAIL_UNMATCHED_MAX: 20_001 },
  ),
  eq(
    "delivery-pending-within-record",
    "预留与容量包含",
    "DELIVERY_PENDING_MAX <= DELIVERY_RECORD_MAX（未完成任务包含在记录容量内）",
    (v) =>
      `DELIVERY_PENDING_MAX(${v.DELIVERY_PENDING_MAX}) <= DELIVERY_RECORD_MAX(${v.DELIVERY_RECORD_MAX})`,
    (v) => v.DELIVERY_PENDING_MAX <= v.DELIVERY_RECORD_MAX,
    { DELIVERY_PENDING_MAX: 50_001 },
  ),
  eq(
    "push-active-within-total",
    "预留与容量包含",
    "PUSH_ACTIVE_MAX <= PUSH_TOTAL_MAX",
    (v) => `PUSH_ACTIVE_MAX(${v.PUSH_ACTIVE_MAX}) <= PUSH_TOTAL_MAX(${v.PUSH_TOTAL_MAX})`,
    (v) => v.PUSH_ACTIVE_MAX <= v.PUSH_TOTAL_MAX,
    { PUSH_TOTAL_MAX: 499 },
  ),
  eq(
    "push-pending-within-total",
    "预留与容量包含",
    "PUSH_PENDING_MAX <= PUSH_TOTAL_MAX",
    (v) => `PUSH_PENDING_MAX(${v.PUSH_PENDING_MAX}) <= PUSH_TOTAL_MAX(${v.PUSH_TOTAL_MAX})`,
    (v) => v.PUSH_PENDING_MAX <= v.PUSH_TOTAL_MAX,
    { PUSH_PENDING_MAX: 551 },
  ),
  eq(
    "push-critical-reserved-within-send-day",
    "预留与容量包含",
    "PUSH_CRITICAL_RESERVED_DAY <= PUSH_SEND_DAY（关键预留包含在外发总预算内）",
    (v) =>
      `PUSH_CRITICAL_RESERVED_DAY(${v.PUSH_CRITICAL_RESERVED_DAY}) <= PUSH_SEND_DAY(${v.PUSH_SEND_DAY})`,
    (v) => v.PUSH_CRITICAL_RESERVED_DAY <= v.PUSH_SEND_DAY,
    { PUSH_CRITICAL_RESERVED_DAY: 5001 },
  ),
  eq(
    "push-test-day-within-send-day",
    "预留与容量包含",
    "PUSH_TEST_DAY <= PUSH_SEND_DAY（测试日量仍计入总发送）",
    (v) => `PUSH_TEST_DAY(${v.PUSH_TEST_DAY}) <= PUSH_SEND_DAY(${v.PUSH_SEND_DAY})`,
    (v) => v.PUSH_TEST_DAY <= v.PUSH_SEND_DAY,
    { PUSH_TEST_DAY: 5001 },
  ),
  // —— 价格 / usage 单位一致 ——
  eq(
    "ai-soft-below-hard",
    "usage 单位一致",
    "AI_SOFT_DAY < AI_HARD_DAY（同为 Neurons/日，软线严于硬线）",
    (v) => `AI_SOFT_DAY(${v.AI_SOFT_DAY}) < AI_HARD_DAY(${v.AI_HARD_DAY})`,
    (v) => v.AI_SOFT_DAY < v.AI_HARD_DAY,
    { AI_SOFT_DAY: 8000 },
  ),
];

/** §11 中无法以参数数值表达的语义条款：由对应实现阶段的测试保证，本校验不假装覆盖。 */
export interface SemanticInvariant {
  readonly id: string;
  readonly contract: string;
  readonly enforcedBy: string;
}

export const SEMANTIC_INVARIANTS: readonly SemanticInvariant[] = [
  {
    id: "mail-digest-window-forward-only",
    contract:
      "MAIL_DIGEST_WINDOW 只用于提前发送；合并后任一条的实际发送时间不得晚于其自身 expires_at（附录 A.5 / §11）",
    enforcedBy: "P4-02 调度实现（合并只能提前，不得推迟任何一条）",
  },
];

/** 校验给定参数快照的全部等式，返回逐条结果（不抛错）。 */
export function checkParamEquations(values: WritableParamValues = PARAMS): EquationResult[] {
  return PARAM_EQUATIONS.map((e) => ({
    id: e.id,
    group: e.group,
    contract: e.contract,
    formula: e.render(values),
    ok: e.check(values),
  }));
}

/** 等式不成立时抛出，消息逐条指明是哪一条。 */
export class ParamEquationError extends Error {
  constructor(readonly failed: EquationResult[]) {
    super(
      `参数等式校验失败：${failed.length} 条不成立（附录 A.5 / CONTRACTS_BASELINE.md §11）\n${failed
        .map((f) => `  ✗ [${f.id}]（${f.group}）${f.contract}\n    ${f.formula}`)
        .join("\n")}`,
    );
    this.name = "ParamEquationError";
  }
}

/**
 * 启动等式校验：全部成立时返回逐条结果；任一不成立抛 ParamEquationError（消息指明每一条）。
 * `pnpm params:verify` 与 Worker 启动路径共用本函数。
 */
export function verifyParams(values: WritableParamValues = PARAMS): EquationResult[] {
  const results = checkParamEquations(values);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    throw new ParamEquationError(failed);
  }
  return results;
}
