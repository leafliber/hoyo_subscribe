// 三个日池与预算占用语义（任务卡 P1-07，验收 ID A-P1-BUDGET）——纯函数，L1 可测。
//
// 合同依据：
// - 主方案 §9.1：`settled + reserved + uncertain` 均占可用预算；四池划分（既有账号
//   认证/安全、新注册认证、基础业务、紧急业务）；重发与明确失败后的新调用同样纳入
//   各自用途预算。
// - ADR-0003 + CONTRACTS_BASELINE.md §7：纯日额度模型。每个 UTC 日独立重置、池间不互借、
//   不跨日结转；envelope / carry / E=1 兜底 / 认证软线 S / 月末半日片段 / MAIL_*_MONTH
//   已废止（AGENTS.md 第 3 节禁止清单，出现即判不合格）。
// - 应用账本不是绝对账单封顶：平台按其真实接受时间计费（§9.2 末段）。
//   PLATFORM_MAIL_DAY_LIMIT 只经 params:verify 校验容量关系，不进运行时守卫。
//
// 「池间不互借」在本模块是结构性质：每个池的当日剩余只由自己的日额度与自己的占用
// 计算，认证总池 = existing_auth + new_registration 两行合计（新注册子额度含于其中），
// 与基础池、紧急池之间不存在任何共享或借用项。
//
// 参数策略（AGENTS.md 硬规则 2）：全部额度只来自 ../params/registry，本文件零字面常量。

import {
  MAIL_AUTH_DAY,
  MAIL_BASE_DAY,
  MAIL_SIGNUP_AUTH_DAY,
  MAIL_URGENT_DAY,
} from "../params/registry";

/** 预算周期口径：migrations/0013 usage_periods.period_kind 当前唯一取值（ADR-0003 定为 UTC 日）。 */
export const BUDGET_PERIOD_KIND = "utc_day" as const;

/**
 * 四个邮件池（主方案 §9.1；与 migrations/0013 usage_periods.pool 的 CHECK 值一一对应）。
 * existing_auth 与 new_registration 共享认证日池 MAIL_AUTH_DAY（新注册只占子额度
 * MAIL_SIGNUP_AUTH_DAY）；base_business、urgent_business 各自独立。
 */
export const MAIL_POOLS = [
  "existing_auth",
  "new_registration",
  "base_business",
  "urgent_business",
] as const;

export type MailPool = (typeof MAIL_POOLS)[number];

/** 认证日池覆盖的两行：合计受 MAIL_AUTH_DAY 约束（池间不互借——不含基础/紧急份额）。 */
export const AUTH_MAIL_POOLS = ["existing_auth", "new_registration"] as const;

/** 单个池/用户的当日占用三元组（§9.1：三者合计均占当日额度）。 */
export interface MailPoolOccupancy {
  reserved: number;
  settled: number;
  uncertain: number;
}

export const EMPTY_OCCUPANCY: MailPoolOccupancy = { reserved: 0, settled: 0, uncertain: 0 };

/** 占用合计 = settled + reserved + uncertain（§9.1 唯一口径）。 */
export function occupancyTotal(occupancy: MailPoolOccupancy): number {
  return occupancy.reserved + occupancy.settled + occupancy.uncertain;
}

/** 当日剩余 = 日额度 − 占用合计，下限 0（守卫已保证不超卖；负值只可能来自外部注入）。 */
export function dayRemaining(dayLimit: number, occupancy: MailPoolOccupancy): number {
  return Math.max(0, dayLimit - occupancyTotal(occupancy));
}

/** 认证日池总量上限（existing_auth + new_registration 合计的约束值）。 */
export function authDayTotalLimit(): number {
  return MAIL_AUTH_DAY;
}

/** 池行自身的日额度：new_registration 行的额度即新注册子额度 MAIL_SIGNUP_AUTH_DAY。 */
export function poolDayLimit(pool: MailPool): number {
  switch (pool) {
    case "existing_auth":
      return MAIL_AUTH_DAY;
    case "new_registration":
      return MAIL_SIGNUP_AUTH_DAY;
    case "base_business":
      return MAIL_BASE_DAY;
    case "urgent_business":
      return MAIL_URGENT_DAY;
  }
}

/** 账本快照：worker 读 usage_periods 后组装；user 行是每用户基础/紧急日机会计数（§9.1）。 */
export interface MailDayLedgerSnapshot {
  periodKey: string;
  pools: Record<MailPool, MailPoolOccupancy>;
  userBase?: MailPoolOccupancy;
  userUrgent?: MailPoolOccupancy;
}

/** 认证日池占用 = 两行相加（结构上不含任何基础/紧急份额）。 */
export function authTotalOccupancy(pools: MailDayLedgerSnapshot["pools"]): MailPoolOccupancy {
  return {
    reserved: pools.existing_auth.reserved + pools.new_registration.reserved,
    settled: pools.existing_auth.settled + pools.new_registration.settled,
    uncertain: pools.existing_auth.uncertain + pools.new_registration.uncertain,
  };
}

/**
 * floor 触发判定：剩余**恰好等于** floor 即视为触发（`remaining <= floor`）。
 * 口径推导：§7.2 公式「剩余 < floor」按发送时点判定——批准这一封后剩余将跌破 floor 时，
 * 降级立即生效，等价于发送前 `remaining <= floor`。ADR-0003「一次全量取消（100 席位）
 * 后当天还剩 20，恰好落到 floor 上自动收紧」与任务卡 ★ 用例钉死等号属于触发侧；
 * 两个 floor（MAIL_URGENT_FLOOR / MAIL_AUTH_FLOOR）在 §7.2 中公式对称，取同一口径。
 */
export function floorIsEngaged(remaining: number, floorLimit: number): boolean {
  return remaining <= floorLimit;
}

/**
 * 「未外发」的 outbox 状态集合（§9.2 跨界条款）：从未调用过供应商。leased 只是持有
 * 租约仍属未外发；calling_provider 起视为已调用；unknown 是不确定——按已调用处理，不释放。
 * 与 migrations/0012 mail_outbox.status 的取值对应；完整状态机属 P4-03，这里只固化
 * 跨日判定所需的这一子集。
 */
export const OUTBOX_UNSENT_STATUSES = ["pending", "leased"] as const;

/**
 * mail_outbox.period_key 的「尚未绑定预算日」占位值（该列 NOT NULL，migrations/0012）。
 * outbox 行创建时先落此值；账本预占成功后由本账本改写为真实 UTC 日键（迁移注释：
 * period_key 取值由 P1-07 账本写入）。再次预占同一行会因占位值已不在而条件未命中，
 * 天然防止一行 outbox 双份预算。
 */
export const OUTBOX_UNRESERVED_PERIOD_KEY = "" as const;

/**
 * UTC 日分桶（账本 period_key 派生）：key 为 'YYYY-MM-DD'，startMs 含端、endMsExclusive
 * 不含端。P1-02 决定 ExactTime 与 DateOnly 之间不提供转换函数（类型层面不可互转）；
 * 本函数是预算域的周期分桶，不是通用时间转换，因此定义在此而非 time.ts。
 */
export function utcDayPeriod(ms: number): {
  key: string;
  startMs: number;
  endMsExclusive: number;
} {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const startMs = Date.UTC(year, month, day);
  // Date.UTC 对超界分量自动进位，月末/年末（含闰年）无需分支。
  const endMsExclusive = Date.UTC(year, month, day + 1);
  const key = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(
    day,
  ).padStart(2, "0")}`;
  return { key, startMs, endMsExclusive };
}
