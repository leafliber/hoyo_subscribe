// 邮件意图的当日判定与预占计划（任务卡 P1-07，验收 ID A-P1-BUDGET）——纯函数，L1 可测。
//
// 合同依据：CONTRACTS_BASELINE.md §7.1—§7.2、ADR-0003（纯日额度模型）；主方案 §9.1。
// 本文件是「什么意图在什么账本状态下可批准」的唯一判定源：Worker 账本守卫只消费
// planMailReservation 产出的阈值（同一语义的 SQL 化），不得另写一套判断
// （AGENTS.md 硬规则 3）。
//
// 恢复入口不依赖发信预算（§9.2 保留条款，认证降级期间用户取回控制权的唯一保障）：
// MailIntentKind 不存在恢复流程的取值——恢复/紧急停用不产生邮件意图，类型层面就
// 无法把恢复流程接到邮件预算判定上。

import {
  MAIL_AUTH_FLOOR,
  MAIL_URGENT_FLOOR,
  MAIL_USER_BASE_DAY,
  MAIL_USER_URGENT_DAY,
} from "../params/registry";
import {
  authDayTotalLimit,
  authTotalOccupancy,
  dayRemaining,
  floorIsEngaged,
  type MailDayLedgerSnapshot,
  type MailPool,
  occupancyTotal,
  poolDayLimit,
} from "./pools";

/**
 * 邮件发送意图（§9.1 四池用途 × §7.3 优先级阶梯的紧急三档）。
 * 认证邮件是最高优先级（§7.4），认证降级语义按附录 A.4 的子额度与 §7.2 的降级条款展开。
 */
export type MailIntentKind =
  | "signup_auth" // 新注册验证码（含其重发）——占新注册子额度
  | "existing_auth_first_login" // 既有账号的首次登录验证码（认证降级期间唯一放行的认证意图）
  | "auth_resend" // 既有账号验证码重发（认证降级期间全部暂停）
  | "base_routine_or_announce" // 常规提前提醒 / 新事件公布（基础池，无 floor）
  | "urgent_cancelled_or_retracted" // 紧急最高档（紧急 floor 收紧后唯一可发档）
  | "urgent_important_change"
  | "urgent_late_discovery";

/** 意图归属的池（守卫递增的 usage_periods 行）。 */
export function poolOfMailIntent(kind: MailIntentKind): MailPool {
  switch (kind) {
    case "signup_auth":
      return "new_registration";
    case "existing_auth_first_login":
    case "auth_resend":
      return "existing_auth";
    case "base_routine_or_announce":
      return "base_business";
    case "urgent_cancelled_or_retracted":
    case "urgent_important_change":
    case "urgent_late_discovery":
      return "urgent_business";
  }
}

export type MailIntentRejectionReason =
  | "urgent_day_exhausted" // 紧急池当日用尽：当日停发（§7.1）
  | "urgent_floor_degraded" // 紧急 floor 收紧：只发取消/撤回这一最高档（§7.2）
  | "auth_day_exhausted" // 认证池当日用尽
  | "auth_floor_degraded" // 认证降级：只放行既有账号首次登录（§7.2）
  | "signup_sub_quota_exhausted" // 新注册子额度用尽：先停注册（附录 A.4）
  | "base_day_exhausted" // 基础池当日用尽
  | "user_day_exhausted"; // 每用户日机会用尽（MAIL_USER_BASE_DAY / MAIL_USER_URGENT_DAY）

export type MailIntentDecision =
  | { decision: "approve"; pool: MailPool }
  | { decision: "reject"; reason: MailIntentRejectionReason };

/** 当日紧急池剩余跌破（含等于）MAIL_URGENT_FLOOR → 收紧为只发取消/撤回。 */
export function urgentFloorEngaged(snapshot: MailDayLedgerSnapshot): boolean {
  return floorIsEngaged(
    dayRemaining(poolDayLimit("urgent_business"), snapshot.pools.urgent_business),
    MAIL_URGENT_FLOOR,
  );
}

/** 当日认证池剩余跌破（含等于）MAIL_AUTH_FLOOR → 只接受既有账号首次登录。 */
export function authFloorEngaged(snapshot: MailDayLedgerSnapshot): boolean {
  return floorIsEngaged(
    dayRemaining(authDayTotalLimit(), authTotalOccupancy(snapshot.pools)),
    MAIL_AUTH_FLOOR,
  );
}

/** 新注册子额度（MAIL_SIGNUP_AUTH_DAY）是否已用尽——用尽先停注册发信（附录 A.4）。 */
export function signupSubQuotaExhausted(snapshot: MailDayLedgerSnapshot): boolean {
  return occupancyTotal(snapshot.pools.new_registration) >= poolDayLimit("new_registration");
}

/**
 * 当日判定：池间不互借（每池只看自己的剩余；认证池看 existing+new_registration 合计），
// 降级口径见 pools.ts floorIsEngaged（等号属于触发侧）。
 */
export function decideMailIntent(
  kind: MailIntentKind,
  snapshot: MailDayLedgerSnapshot,
): MailIntentDecision {
  switch (kind) {
    case "urgent_cancelled_or_retracted":
    case "urgent_important_change":
    case "urgent_late_discovery": {
      if (snapshot.userUrgent && occupancyTotal(snapshot.userUrgent) >= MAIL_USER_URGENT_DAY) {
        return { decision: "reject", reason: "user_day_exhausted" };
      }
      const urgentRemaining = dayRemaining(
        poolDayLimit("urgent_business"),
        snapshot.pools.urgent_business,
      );
      if (urgentRemaining <= 0) {
        return { decision: "reject", reason: "urgent_day_exhausted" };
      }
      if (kind !== "urgent_cancelled_or_retracted" && urgentFloorEngaged(snapshot)) {
        return { decision: "reject", reason: "urgent_floor_degraded" };
      }
      return { decision: "approve", pool: "urgent_business" };
    }
    case "base_routine_or_announce": {
      if (snapshot.userBase && occupancyTotal(snapshot.userBase) >= MAIL_USER_BASE_DAY) {
        return { decision: "reject", reason: "user_day_exhausted" };
      }
      if (dayRemaining(poolDayLimit("base_business"), snapshot.pools.base_business) <= 0) {
        return { decision: "reject", reason: "base_day_exhausted" };
      }
      return { decision: "approve", pool: "base_business" };
    }
    case "signup_auth": {
      const authRemaining = dayRemaining(authDayTotalLimit(), authTotalOccupancy(snapshot.pools));
      if (authRemaining <= 0) {
        return { decision: "reject", reason: "auth_day_exhausted" };
      }
      if (signupSubQuotaExhausted(snapshot)) {
        return { decision: "reject", reason: "signup_sub_quota_exhausted" };
      }
      if (authFloorEngaged(snapshot)) {
        return { decision: "reject", reason: "auth_floor_degraded" };
      }
      return { decision: "approve", pool: "new_registration" };
    }
    case "existing_auth_first_login": {
      // 认证降级不挡首次登录（§7.2）：认证池内剩余全部留给既有账号首次登录，
      // 直到当日额度真正用尽。
      if (dayRemaining(authDayTotalLimit(), authTotalOccupancy(snapshot.pools)) <= 0) {
        return { decision: "reject", reason: "auth_day_exhausted" };
      }
      return { decision: "approve", pool: "existing_auth" };
    }
    case "auth_resend": {
      const authRemaining = dayRemaining(authDayTotalLimit(), authTotalOccupancy(snapshot.pools));
      if (authRemaining <= 0) {
        return { decision: "reject", reason: "auth_day_exhausted" };
      }
      if (authFloorEngaged(snapshot)) {
        return { decision: "reject", reason: "auth_floor_degraded" };
      }
      return { decision: "approve", pool: "existing_auth" };
    }
  }
}

/**
 * 预占守卫阈值：decideMailIntent 判定的 SQL 化（同一语义的唯一来源）。
 * Worker 账本把这些数值绑进条件提交守卫的 WHERE 谓词，容量判定与预占写入是同一条
 * 语句（P1-05 纪律：禁止 COUNT 后无条件 INSERT）。
 * 等价性由 L1 测试逐边界钉死：decide 批准 ⟺ 快照满足 plan 的全部阈值。
 */
export interface MailReservationPlan {
  pool: MailPool;
  /** 守卫行自身的占用上限（new_registration = 子额度；基础/紧急 = 池日额度；认证行 = 认证日池总量）。 */
  rowOccupancyLimit: number;
  /** 认证意图额外需要：existing_auth + new_registration 合计占用上限（池间不互借）。 */
  authTotalLimit?: number;
  /** 业务发送的每用户日机会上限（无 user 维度的意图不设）。 */
  userDayLimit?: number;
}

export function planMailReservation(kind: MailIntentKind): MailReservationPlan {
  switch (kind) {
    case "signup_auth":
      // 认证降级期间暂停新注册发信（§7.2）；子额度用尽先停注册（附录 A.4）。
      return {
        pool: "new_registration",
        rowOccupancyLimit: poolDayLimit("new_registration"),
        authTotalLimit: authDayTotalLimit() - MAIL_AUTH_FLOOR,
      };
    case "existing_auth_first_login":
      // 首次登录不受认证降级约束，吃到认证日池真正用尽。
      return {
        pool: "existing_auth",
        rowOccupancyLimit: authDayTotalLimit(),
        authTotalLimit: authDayTotalLimit(),
      };
    case "auth_resend":
      return {
        pool: "existing_auth",
        rowOccupancyLimit: authDayTotalLimit(),
        authTotalLimit: authDayTotalLimit() - MAIL_AUTH_FLOOR,
      };
    case "base_routine_or_announce":
      return {
        pool: "base_business",
        rowOccupancyLimit: poolDayLimit("base_business"),
        userDayLimit: MAIL_USER_BASE_DAY,
      };
    case "urgent_cancelled_or_retracted":
      // 最高档不受 floor 收紧影响（收紧后唯一可发档）。
      return {
        pool: "urgent_business",
        rowOccupancyLimit: poolDayLimit("urgent_business"),
        userDayLimit: MAIL_USER_URGENT_DAY,
      };
    case "urgent_important_change":
    case "urgent_late_discovery":
      // floor 收紧对低档的体现：行占用上限 = 日额度 − floor（发送时点判定，等号属触发侧）。
      return {
        pool: "urgent_business",
        rowOccupancyLimit: poolDayLimit("urgent_business") - MAIL_URGENT_FLOOR,
        userDayLimit: MAIL_USER_URGENT_DAY,
      };
  }
}
