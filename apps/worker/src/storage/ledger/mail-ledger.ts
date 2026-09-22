// 邮件预算账本（任务卡 P1-07，验收 ID A-P1-BUDGET）。
//
// 合同依据：主方案 §9.1（settled + reserved + uncertain 均占当日额度；四池划分）、
// §9.2 末段（跨 UTC 日：任务未外发时原子释放旧预留并按新一日重新预占；已调用或
// unknown 的不释放——不能假装没调用过）、[R16]（精确配额与存量走数据库账本）；
// ADR-0003 + CONTRACTS_BASELINE.md §7（三个日池、池间不互借、不跨日结转、两个 floor
// 的当日降级）。已废止且不得出现：envelope、carry、E=1 兜底、认证软线、月末半日片段、
// 跨账单周期的预留重排（AGENTS.md 第 3 节禁止清单）。
//
// 全部阈值来自 @hoyo/contracts 的参数注册表与 planMailReservation（AGENTS.md 硬规则
// 2/3：本文件零字面常量、零第二套判定）。并发纪律沿 P1-05（conditionalCommit）：
// 容量判定写在守卫 UPDATE 的 WHERE 谓词里，判定与递增是同一条语句——禁止 COUNT 后
// 无条件 INSERT；同一 batch 是事务，守卫子查询与依赖效果之间没有可见的中间窗口
// （P0-01 证据），效果谓词在守卫命中时必然成立。
//
// 账本粒度说明：本卡只交付账本原语，不建 per-task 预留行（mail_outbox 状态机属
// P4-03）。预留的归属任务由 mail_outbox.period_key 承载（migrations/0012 注释：
// 取值由本账本写入）；结算/落不确定按 (pool, period_key, user?) 聚合行原子转换。

import {
  AUTH_MAIL_POOLS,
  BUDGET_PERIOD_KIND,
  EMPTY_OCCUPANCY,
  type MailDayLedgerSnapshot,
  type MailIntentKind,
  type MailPool,
  type MailPoolOccupancy,
  type MailReservationPlan,
  OUTBOX_UNRESERVED_PERIOD_KEY,
  OUTBOX_UNSENT_STATUSES,
  planMailReservation,
} from "@hoyo/contracts";
import {
  type ConditionalCommitOutcome,
  conditionalCommit,
  type GuardedEffect,
  type GuardStatement,
  type SqlParam,
} from "../cas";

/** SQL 字面量片段只由 contracts 的封闭常量拼出（状态/池名不出第二份）。 */
const UNSENT_STATUS_LIST = `(${OUTBOX_UNSENT_STATUSES.map((status) => `'${status}'`).join(", ")})`;
const AUTH_POOL_LIST = `(${AUTH_MAIL_POOLS.map((pool) => `'${pool}'`).join(", ")})`;

export interface MailBudgetPeriod {
  key: string;
  startMs: number;
  endMsExclusive: number;
}

export interface ReserveMailBudgetPlan {
  intent: MailIntentKind;
  period: MailBudgetPeriod;
  now: number;
  /** 业务发送归属的用户（基础/紧急走每用户日机会行）；认证意图不传。 */
  userId?: string;
  /** 预算挂靠的 mail_outbox 行：存在、未外发且尚未占用预算（period_key IS NULL）才可能命中。 */
  outboxId?: string;
}

function poolRowIdentitySql(
  pool: MailPool,
  periodKey: string,
): { sql: string; params: SqlParam[] } {
  return {
    sql: "pool = ? AND period_kind = ? AND period_key = ? AND user_id IS NULL",
    params: [pool, BUDGET_PERIOD_KIND, periodKey],
  };
}

function insertUsageRowStatement(
  pool: MailPool,
  period: MailBudgetPeriod,
  now: number,
  userId?: string,
): GuardStatement {
  return {
    sql: `INSERT INTO usage_periods
      (id, pool, period_kind, period_key, user_id, reserved, settled, uncertain, period_start, period_end, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    params: [
      crypto.randomUUID(),
      pool,
      BUDGET_PERIOD_KIND,
      period.key,
      userId ?? null,
      period.startMs,
      period.endMsExclusive,
      now,
      now,
    ],
  };
}

/**
 * 容量谓词（守卫 WHERE 的公共部分）：行占用、认证合计（仅认证意图）、用户日机会。
 * 阈值全部来自 planMailReservation——decideMailIntent 的 SQL 化，判定唯一来源。
 */
function capacityPredicates(
  plan: MailReservationPlan,
  periodKey: string,
  userId?: string,
): { sql: string; params: SqlParam[] } {
  const parts: string[] = ["reserved + settled + uncertain < ?"];
  const params: SqlParam[] = [plan.rowOccupancyLimit];
  if (plan.authTotalLimit !== undefined) {
    // 认证日池合计（两行相加；池间不互借——谓词不含任何基础/紧急行）。
    parts.push(
      `(SELECT coalesce(sum(reserved + settled + uncertain), 0) FROM usage_periods
        WHERE period_kind = ? AND period_key = ? AND user_id IS NULL AND pool IN ${AUTH_POOL_LIST}) < ?`,
    );
    params.push(BUDGET_PERIOD_KIND, periodKey, plan.authTotalLimit);
  }
  if (plan.userDayLimit !== undefined && userId !== undefined) {
    parts.push(
      `(SELECT coalesce(reserved + settled + uncertain, 0) FROM usage_periods
        WHERE pool = ? AND period_kind = ? AND period_key = ? AND user_id = ?) < ?`,
    );
    params.push(plan.pool, BUDGET_PERIOD_KIND, periodKey, userId, plan.userDayLimit);
  }
  return { sql: parts.join(" AND "), params };
}

/**
 * 预占一次发送预算：守卫命中即 reserved+1（池行 + 业务意图的 user 行），并按需把
 * mail_outbox.period_key 盖章为预占日。任一容量条件不满足 → condition_missed，零写入。
 * 同一 outbox 行不可能预占两次（period_key IS NULL 谓词 + 事务串行）。
 */
export async function reserveMailBudget(
  db: D1Database,
  plan: ReserveMailBudgetPlan,
): Promise<ConditionalCommitOutcome> {
  const reservation = planMailReservation(plan.intent);
  const withUser = reservation.userDayLimit !== undefined && plan.userId !== undefined;
  const outboxId = plan.outboxId;

  const identity = poolRowIdentitySql(reservation.pool, plan.period.key);
  const capacity = capacityPredicates(reservation, plan.period.key, plan.userId);

  let guardSql = `UPDATE usage_periods SET reserved = reserved + 1, updated_at = ?
    WHERE ${identity.sql} AND ${capacity.sql}`;
  const guardParams: SqlParam[] = [plan.now, ...identity.params, ...capacity.params];
  if (outboxId !== undefined) {
    guardSql += ` AND (SELECT count(*) FROM mail_outbox WHERE id = ? AND period_key = ? AND status IN ${UNSENT_STATUS_LIST}) = 1`;
    guardParams.push(outboxId, OUTBOX_UNRESERVED_PERIOD_KEY);
  }

  const effects: GuardedEffect[] = [];
  if (withUser && plan.userId !== undefined) {
    effects.push({
      kind: "update",
      table: "usage_periods",
      set: { reserved: { sql: "reserved + 1" }, updated_at: plan.now },
      where: {
        sql: "pool = ? AND period_kind = ? AND period_key = ? AND user_id = ?",
        params: [reservation.pool, BUDGET_PERIOD_KIND, plan.period.key, plan.userId],
      },
    });
  }
  if (outboxId !== undefined) {
    effects.push({
      kind: "update",
      table: "mail_outbox",
      set: { period_key: plan.period.key, updated_at: plan.now },
      where: {
        sql: `id = ? AND period_key = ? AND status IN ${UNSENT_STATUS_LIST}`,
        params: [outboxId, OUTBOX_UNRESERVED_PERIOD_KEY],
      },
    });
  }

  return conditionalCommit(db, {
    preamble: [
      insertUsageRowStatement(reservation.pool, plan.period, plan.now),
      ...(withUser
        ? [insertUsageRowStatement(reservation.pool, plan.period, plan.now, plan.userId)]
        : []),
    ],
    guard: { sql: guardSql, params: guardParams },
    effects,
  });
}

/** 预留的后续转换（§9.1：明确失败后的重发按新调用另行预占，不复活本预留）。 */
export type MailReservationTransition =
  | "settle" // 已外发且结果明确（accepted / bounced / 明确失败）——已消耗，计入 settled
  | "mark_uncertain" // 外调结果未知——预留转为 uncertain，继续占用当日额度
  | "resolve_uncertain" // unknown 落定——uncertain 转 settled（不退款，§9.1）
  | "release"; // 从未外发（过期、跳过、降级丢弃）——归还当日额度

export interface MailReservationRef {
  pool: MailPool;
  periodKey: string;
  userId?: string;
  now: number;
}

function transitionAssignments(
  transition: MailReservationTransition,
  now: number,
): Readonly<Record<string, number | { sql: string }>> {
  switch (transition) {
    case "settle":
      return {
        reserved: { sql: "reserved - 1" },
        settled: { sql: "settled + 1" },
        updated_at: now,
      };
    case "mark_uncertain":
      return {
        reserved: { sql: "reserved - 1" },
        uncertain: { sql: "uncertain + 1" },
        updated_at: now,
      };
    case "resolve_uncertain":
      return {
        uncertain: { sql: "uncertain - 1" },
        settled: { sql: "settled + 1" },
        updated_at: now,
      };
    case "release":
      return { reserved: { sql: "reserved - 1" }, updated_at: now };
  }
}

function transitionRequires(transition: MailReservationTransition): {
  column: string;
  minimum: number;
} {
  return transition === "resolve_uncertain"
    ? { column: "uncertain", minimum: 1 }
    : { column: "reserved", minimum: 1 };
}

/**
 * 转换一条预留（聚合行口径）：池行与（业务发送时的）user 行在同一条件提交内转换。
 * 无可转换的占用（如重复 settle、从未预占）→ condition_missed，不报错、不写库。
 */
export async function transitionMailReservation(
  db: D1Database,
  ref: MailReservationRef,
  transition: MailReservationTransition,
): Promise<ConditionalCommitOutcome> {
  const identity = poolRowIdentitySql(ref.pool, ref.periodKey);
  const requires = transitionRequires(transition);
  const userId = ref.userId;
  return conditionalCommit(db, {
    guard: {
      sql: `UPDATE usage_periods SET ${Object.entries(transitionAssignments(transition, ref.now))
        .map(([column, value]) =>
          typeof value === "object" ? `"${column}" = (${value.sql})` : `"${column}" = ?`,
        )
        .join(", ")}
        WHERE ${identity.sql} AND ${requires.column} >= ${requires.minimum}`,
      params: [ref.now, ...identity.params],
    },
    effects:
      userId === undefined
        ? []
        : [
            {
              kind: "update",
              table: "usage_periods",
              set: transitionAssignments(transition, ref.now),
              where: {
                sql: `pool = ? AND period_kind = ? AND period_key = ? AND user_id = ? AND ${requires.column} >= ${requires.minimum}`,
                params: [ref.pool, BUDGET_PERIOD_KIND, ref.periodKey, userId],
              },
            },
          ],
  });
}

export interface RolloverUnsentOutboxPlan {
  outboxId: string;
  intent: MailIntentKind;
  /** 旧预占日（须与 mail_outbox.period_key 一致；不一致说明任务已不在该日预算上）。 */
  fromPeriodKey: string;
  toPeriod: MailBudgetPeriod;
  now: number;
  userId?: string;
}

/**
 * 跨 UTC 日边界重排一条**未外发**任务的预算（§9.2 末段）：原子释放旧日预留并按新一日
 * 重新预占。以下情形整体不发生（condition_missed，旧预留原封不动）：
 *   - outbox 已外发（calling_provider 及之后）或 unknown——不能假装没调用过；
 *   - outbox.period_key 已不等于旧日（已被重排/释放）；
 *   - 旧日池行/user 行已无该预留可释放（重复重排）；
 *   - 新一日按同一阈值判定无余量。
 * 新日容量谓词与 reserveMailBudget 完全一致（同一 planMailReservation 来源），因此
 * 降级（floor）在重占时同样生效。
 */
export async function rolloverUnsentOutboxReservation(
  db: D1Database,
  plan: RolloverUnsentOutboxPlan,
): Promise<ConditionalCommitOutcome> {
  const reservation = planMailReservation(plan.intent);
  const withUser = reservation.userDayLimit !== undefined && plan.userId !== undefined;

  const newIdentity = poolRowIdentitySql(reservation.pool, plan.toPeriod.key);
  const capacity = capacityPredicates(reservation, plan.toPeriod.key, plan.userId);

  let guardSql = `UPDATE usage_periods SET reserved = reserved + 1, updated_at = ?
    WHERE ${newIdentity.sql} AND ${capacity.sql}
      AND (SELECT count(*) FROM mail_outbox WHERE id = ? AND period_key = ? AND status IN ${UNSENT_STATUS_LIST}) = 1
      AND (SELECT coalesce(reserved, 0) FROM usage_periods WHERE pool = ? AND period_kind = ? AND period_key = ? AND user_id IS NULL) > 0`;
  const guardParams: SqlParam[] = [
    plan.now,
    ...newIdentity.params,
    ...capacity.params,
    plan.outboxId,
    plan.fromPeriodKey,
    reservation.pool,
    BUDGET_PERIOD_KIND,
    plan.fromPeriodKey,
  ];
  if (withUser && plan.userId !== undefined) {
    guardSql +=
      " AND (SELECT coalesce(reserved, 0) FROM usage_periods WHERE pool = ? AND period_kind = ? AND period_key = ? AND user_id = ?) > 0";
    guardParams.push(reservation.pool, BUDGET_PERIOD_KIND, plan.fromPeriodKey, plan.userId);
  }

  const effects: GuardedEffect[] = [
    {
      kind: "update",
      table: "usage_periods",
      set: { reserved: { sql: "reserved - 1" }, updated_at: plan.now },
      where: {
        sql: "pool = ? AND period_kind = ? AND period_key = ? AND user_id IS NULL AND reserved > 0",
        params: [reservation.pool, BUDGET_PERIOD_KIND, plan.fromPeriodKey],
      },
    },
  ];
  if (withUser && plan.userId !== undefined) {
    effects.push(
      {
        kind: "update",
        table: "usage_periods",
        set: { reserved: { sql: "reserved - 1" }, updated_at: plan.now },
        where: {
          sql: "pool = ? AND period_kind = ? AND period_key = ? AND user_id = ? AND reserved > 0",
          params: [reservation.pool, BUDGET_PERIOD_KIND, plan.fromPeriodKey, plan.userId],
        },
      },
      {
        kind: "update",
        table: "usage_periods",
        set: { reserved: { sql: "reserved + 1" }, updated_at: plan.now },
        where: {
          sql: "pool = ? AND period_kind = ? AND period_key = ? AND user_id = ?",
          params: [reservation.pool, BUDGET_PERIOD_KIND, plan.toPeriod.key, plan.userId],
        },
      },
    );
  }
  effects.push({
    kind: "update",
    table: "mail_outbox",
    set: { period_key: plan.toPeriod.key, updated_at: plan.now },
    where: {
      sql: `id = ? AND period_key = ? AND status IN ${UNSENT_STATUS_LIST}`,
      params: [plan.outboxId, plan.fromPeriodKey],
    },
  });

  return conditionalCommit(db, {
    preamble: [
      insertUsageRowStatement(reservation.pool, plan.toPeriod, plan.now),
      ...(withUser
        ? [insertUsageRowStatement(reservation.pool, plan.toPeriod, plan.now, plan.userId)]
        : []),
    ],
    guard: { sql: guardSql, params: guardParams },
    effects,
  });
}

/**
 * 读当日账本快照（池行 + 指定用户的业务日机会行），供 decideMailIntent 判定与
 * 展示。读路径不承担并发判定——预占判定在守卫谓词内（[R16]：账本是唯一权威）。
 */
export async function readMailDayLedger(
  db: D1Database,
  periodKey: string,
  userId?: string,
): Promise<MailDayLedgerSnapshot> {
  const poolRows = await db
    .prepare(
      "SELECT pool, reserved, settled, uncertain FROM usage_periods WHERE period_kind = ? AND period_key = ? AND user_id IS NULL",
    )
    .bind(BUDGET_PERIOD_KIND, periodKey)
    .all<Pick<MailPoolOccupancy, "reserved" | "settled" | "uncertain"> & { pool: MailPool }>();
  const pools: Record<MailPool, MailPoolOccupancy> = {
    existing_auth: { ...EMPTY_OCCUPANCY },
    new_registration: { ...EMPTY_OCCUPANCY },
    base_business: { ...EMPTY_OCCUPANCY },
    urgent_business: { ...EMPTY_OCCUPANCY },
  };
  for (const row of poolRows.results ?? []) {
    pools[row.pool] = { reserved: row.reserved, settled: row.settled, uncertain: row.uncertain };
  }

  let userBase: MailPoolOccupancy | undefined;
  let userUrgent: MailPoolOccupancy | undefined;
  if (userId !== undefined) {
    const userRows = await db
      .prepare(
        "SELECT pool, reserved, settled, uncertain FROM usage_periods WHERE period_kind = ? AND period_key = ? AND user_id = ? AND pool IN ('base_business', 'urgent_business')",
      )
      .bind(BUDGET_PERIOD_KIND, periodKey, userId)
      .all<Pick<MailPoolOccupancy, "reserved" | "settled" | "uncertain"> & { pool: MailPool }>();
    for (const row of userRows.results ?? []) {
      const occupancy = { reserved: row.reserved, settled: row.settled, uncertain: row.uncertain };
      if (row.pool === "base_business") userBase = occupancy;
      if (row.pool === "urgent_business") userUrgent = occupancy;
    }
  }
  return { periodKey, pools, userBase, userUrgent };
}
