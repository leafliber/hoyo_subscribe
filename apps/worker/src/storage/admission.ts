// 容量预占/释放原语（任务卡 P1-05，验收 ID A-P1-CAS）。
//
// 合同依据：主方案 §4.2（注册预占）、§8.1 末段（容量判断不能 COUNT → 无条件 INSERT）、§9.4。
// 禁止 COUNT 后无条件 INSERT：容量判断与预占写入在同一个条件提交边界内完成——
//   - 守卫就是对 capacity_state 计数行的条件更新（`value < cap` 才 +1），判定与写入是同一条语句；
//   - 预占行 INSERT 由 changes() 谓词接管，守卫零行（满额）时自动空操作；
//   - 同一规范邮箱的并发预占由部分唯一索引 idx_admission_reservations_open 兜底
//     （数据库约束保证）：输家触发 UNIQUE 报错，整批回滚，计数不被吃掉。
// 释放沿同一纪律：预占行 CAS（reserved → released）成功才递减计数并落审计。
//
// 参数策略：计数键与上限由调用方传入（P2 从参数注册表取，如 ACCOUNT_MAX_STORED），
// 本层不复制任何阈值（AGENTS.md 硬规则 2）。注册完成（reserved → converted）属 P2-03
// 业务流，用 conditionalCommit 组合，不在本原语内。
import { type ConditionalCommitOutcome, conditionalCommit, type SqlParam } from "./cas";

export interface ReserveAdmissionSlotPlan {
  reservationId: string;
  emailKey: string;
  /** 预占类别；首版合同只有 registration（migrations/0014），保持参数化。 */
  kind: string;
  now: number;
  /** 预占到期时刻（验证码有效期内保留注册槽，§4.2）。 */
  expiresAt: number;
  /** 容量计数行键（如 accounts_total）。 */
  capacityKey: string;
  /** 该键的容量上限（来自参数注册表）。 */
  capacityCap: number;
}

/** 预占一个注册名额：满额返回 condition_missed，不写入任何行。 */
export async function reserveAdmissionSlot(
  db: D1Database,
  plan: ReserveAdmissionSlotPlan,
): Promise<ConditionalCommitOutcome> {
  return conditionalCommit(db, {
    // 计数行缺失时先幂等补行（首次部署/清理后），不参与条件判定。
    preamble: [
      {
        sql: "INSERT INTO capacity_state (key, value, version, updated_at) VALUES (?, 0, 0, ?) ON CONFLICT (key) DO NOTHING",
        params: [plan.capacityKey, plan.now],
      },
    ],
    guard: {
      sql: "UPDATE capacity_state SET value = value + 1, version = version + 1, updated_at = ? WHERE key = ? AND value < ?",
      params: [plan.now, plan.capacityKey, plan.capacityCap],
    },
    effects: [
      {
        kind: "insert",
        table: "admission_reservations",
        columns: [
          "id",
          "kind",
          "email_key",
          "state",
          "reserved_at",
          "expires_at",
          "created_at",
          "updated_at",
        ],
        rows: [
          [
            plan.reservationId,
            plan.kind,
            plan.emailKey,
            "reserved",
            plan.now,
            plan.expiresAt,
            plan.now,
            plan.now,
          ],
        ],
      },
    ],
  });
}

export interface ReleaseAdmissionSlotPlan {
  reservationId: string;
  now: number;
  /** 与预占时相同的容量计数行键：释放时递减回去。 */
  capacityKey: string;
  audit: {
    auditId: string;
    actorId: string;
    action: string;
    reason: string;
    expiresAt: number;
  };
}

/** 释放一个注册名额：只有 reserved 状态的预占能释放，成功时计数递减并落审计。 */
export async function releaseAdmissionSlot(
  db: D1Database,
  plan: ReleaseAdmissionSlotPlan,
): Promise<ConditionalCommitOutcome> {
  const auditParams: readonly SqlParam[] = [
    plan.audit.auditId,
    "system",
    plan.audit.actorId,
    plan.audit.action,
    "admission_reservation",
    plan.reservationId,
    plan.audit.reason,
    plan.now,
    plan.audit.expiresAt,
  ];
  return conditionalCommit(db, {
    guard: {
      sql: "UPDATE admission_reservations SET state = 'released', updated_at = ? WHERE id = ? AND state = 'reserved'",
      params: [plan.now, plan.reservationId],
    },
    effects: [
      {
        kind: "update",
        table: "capacity_state",
        set: { value: { sql: "value - 1" }, updated_at: plan.now },
        where: { sql: "key = ?", params: [plan.capacityKey] },
      },
      {
        kind: "insert",
        table: "audit_log",
        columns: [
          "id",
          "actor_type",
          "actor_id",
          "action",
          "target_type",
          "target_id",
          "reason",
          "created_at",
          "expires_at",
        ],
        rows: [auditParams],
      },
    ],
  });
}
