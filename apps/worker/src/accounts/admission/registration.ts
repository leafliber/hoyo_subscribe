// 注册准入判定与注册槽预占（任务卡 P2-01 交付物三/四；主方案 §4.2、§9.4、附录 A.2）。
//
// 合同约束（§4.2）：
// - `/status` 公布全局 registration_open；**不提供任何按邮箱查询是否注册的接口**。
//   本模块只导出全局开关读取与预占原语，不存在邮箱存在性查询函数。
// - 新身份只有「注册开放、容量、注册邮件预算」都可预占时才进入发码：三条件缺一即
//   折叠拒绝（同形 202），不生成任何发信任务。
// - 注册槽预占走 P1-05 admission 原语（conditionalCommit + 部分唯一索引），禁止
//   COUNT 后无条件 INSERT；同一规范邮箱至多一条 reserved（并发输家 UNIQUE 冲突）。
// - **已有用户登录不占新注册槽**：登录路径不触碰 accounts_total 计数。
// - REGISTRATIONS_DAY 是「完成注册」口径（A.2）：计数在 P2-03 转换时递增；准入侧只做
//   读侧早闸——当日完成数已满时不再为未知邮箱预占（发出的验证码无法转换）。
//
// 预占时序（§4.2「注册槽在验证码有效期间保留」）：预占到期时刻 = 挑战最初截止
// （now + OTP_TTL），由 pipeline 统一计算后传入，保证同一请求内预占与挑战共用同一时刻。

import {
  ACCOUNT_MAX_STORED,
  type MailIntentKind,
  REGISTRATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { releaseAdmissionSlot, reserveAdmissionSlot } from "../../storage/admission";

/** system_state 中全局注册开关的键（§4.2「攻击下可以全局关闭注册」的运营开关）。 */
export const REGISTRATION_OPEN_STATE_KEY = "registration_open";

/** 账号存量容量计数行键（capacity_state；P1-05 admission 原语约定的键名）。 */
export const ACCOUNTS_TOTAL_CAPACITY_KEY = "accounts_total";

/** 每日完成注册计数的容量行键前缀（A.2 REGISTRATIONS_DAY：每 UTC 日完成注册上限）。 */
export function registrationsDayKey(now: number): string {
  return `registrations:${utcDayPeriod(now).key}`;
}

/** 全局注册开关：行缺失、值非 true 一律视为关闭（失败关闭，不默认开放）。 */
export async function readRegistrationOpen(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT value_json FROM system_state WHERE key = ?")
    .bind(REGISTRATION_OPEN_STATE_KEY)
    .first<{ value_json: string }>();
  if (row === null) {
    return false;
  }
  try {
    return JSON.parse(row.value_json) === true;
  } catch {
    return false;
  }
}

/** 写入全局注册开关（部署/运维用；system_state 行 upsert）。 */
export async function writeRegistrationOpen(
  db: D1Database,
  open: boolean,
  now: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    )
    .bind(REGISTRATION_OPEN_STATE_KEY, JSON.stringify(open), now)
    .run();
}

/** 容量与全局注册状态的读侧快照（与邮箱配额快照一起构成第 5 步的全部读）。 */
export interface RegistrationCapacitySnapshot {
  readonly registrationOpen: boolean;
  /** 账号存量当前计数（capacity_state.accounts_total；行缺失为 0）。 */
  readonly accountsTotal: number;
  /** 当 UTC 日已完成注册数（capacity_state.registrations:<day>；行缺失为 0）。 */
  readonly registrationsToday: number;
}

export async function readRegistrationCapacity(
  db: D1Database,
  now: number,
): Promise<RegistrationCapacitySnapshot> {
  const [registrationOpen, rows] = await Promise.all([
    readRegistrationOpen(db),
    db
      .prepare("SELECT key, value FROM capacity_state WHERE key IN (?, ?)")
      .bind(ACCOUNTS_TOTAL_CAPACITY_KEY, registrationsDayKey(now))
      .all<{ key: string; value: number }>(),
  ]);
  let accountsTotal = 0;
  let registrationsToday = 0;
  for (const row of rows.results ?? []) {
    if (row.key === ACCOUNTS_TOTAL_CAPACITY_KEY) {
      accountsTotal = row.value;
    } else {
      registrationsToday = row.value;
    }
  }
  return { registrationOpen, accountsTotal, registrationsToday };
}

/** 注册侧（未知邮箱）三条件的读侧判定：开放、账号容量、当日完成数。 */
export function registrationGatesOpen(snapshot: RegistrationCapacitySnapshot): boolean {
  return (
    snapshot.registrationOpen &&
    snapshot.accountsTotal < ACCOUNT_MAX_STORED &&
    snapshot.registrationsToday < REGISTRATIONS_DAY
  );
}

/** 预占结果：成功 / 容量或条件未命中（零写入）/ 同邮箱已持有未决预占（UNIQUE 冲突）。 */
export type RegistrationSlotResult = "reserved" | "condition_missed" | "email_conflict";

export interface RegistrationSlotPlan {
  readonly reservationId: string;
  readonly emailKey: string;
  readonly now: number;
  /** 预占到期 = 挑战最初截止（§4.2：验证码有效期间保留注册槽）。 */
  readonly challengeDeadline: number;
  /**
   * 是否真的尝试占位：只有「未知邮箱且三条件读侧全开」才传 true；false 时以同样的
   * conditionalCommit 形状走必败守卫（容量上限传 0），保证登录/折叠路径与注册路径
   * 的数据库工作等形状（存在性折叠的时序配平，见 pipeline）。
   */
  readonly attempt: boolean;
}

function isUniqueOpenReservationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed/i.test(error.message) &&
    /admission_reservations/i.test(error.message)
  );
}

/**
 * 注册槽预占（包装 P1-05 reserveAdmissionSlot）：
 * - attempt=true：真实守卫（accounts_total < ACCOUNT_MAX_STORED 才 +1），部分唯一索引
 *   保证同一规范邮箱至多一条 reserved——并发输家收到 UNIQUE 冲突，整批回滚、计数不被吃掉。
 * - attempt=false：同形状必败守卫（上限 0），零写入——已有用户登录与其他折叠路径用它
 *   保持等成本（不占新注册槽，存量计数不变）。
 */
export async function reserveRegistrationSlot(
  db: D1Database,
  plan: RegistrationSlotPlan,
): Promise<RegistrationSlotResult> {
  try {
    const outcome = await reserveAdmissionSlot(db, {
      reservationId: plan.reservationId,
      emailKey: plan.emailKey,
      kind: "registration",
      now: plan.now,
      expiresAt: plan.challengeDeadline,
      capacityKey: ACCOUNTS_TOTAL_CAPACITY_KEY,
      capacityCap: plan.attempt ? ACCOUNT_MAX_STORED : 0,
    });
    return outcome.outcome === "committed" ? "reserved" : "condition_missed";
  } catch (error) {
    if (isUniqueOpenReservationError(error)) {
      return "email_conflict";
    }
    throw error;
  }
}

export interface ExpiredRegistration {
  readonly id: string;
  readonly expiresAt: number;
}

/** 到期未转换的注册预占（清理任务入口的候选清单；§4.2「过期释放」）。 */
export async function listExpiredRegistrations(
  db: D1Database,
  now: number,
): Promise<ExpiredRegistration[]> {
  const rows = await db
    .prepare(
      "SELECT id, expires_at FROM admission_reservations WHERE state = 'reserved' AND expires_at <= ?",
    )
    .bind(now)
    .all<{ id: string; expires_at: number }>();
  return (rows.results ?? []).map((row) => ({ id: row.id, expiresAt: row.expires_at }));
}

/**
 * 释放一条过期注册预占（§4.2：验证码过期即释放注册槽；沿 P1-05 releaseAdmissionSlot，
 * 仅 reserved 状态可释放，成功时容量计数递减并落审计）。
 */
export async function releaseExpiredRegistration(
  db: D1Database,
  expired: ExpiredRegistration,
  now: number,
): Promise<boolean> {
  const outcome = await releaseAdmissionSlot(db, {
    reservationId: expired.id,
    now,
    capacityKey: ACCOUNTS_TOTAL_CAPACITY_KEY,
    audit: {
      auditId: crypto.randomUUID(),
      actorId: "system",
      action: "registration_slot_expired",
      reason: "challenge deadline passed without conversion (§4.2)",
      expiresAt: expired.expiresAt,
    },
  });
  return outcome.outcome === "committed";
}

/** 发码意图的映射（§4.2「存在账号时按登录路径处理」；发送预算按此意图判定）。 */
export function admissionMailIntent(exists: boolean): MailIntentKind {
  return exists ? "existing_auth_first_login" : "signup_auth";
}
