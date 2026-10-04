// P3-17（ADR-0009）· Workers AI 日账本：所有模型 profile 共用一张表（P3-09 以后复用）。
// 调用前条件预占，结束后结算；失败与超时由调用方按整笔预占结算（"失败与重试都计入"）。
import { utcDayPeriod } from "@hoyo/contracts";

export interface AiUsageDay {
  readonly day: string;
  readonly reserved: number;
  readonly settled: number;
  readonly calls: number;
}

export interface NeuronReservation {
  readonly day: string;
  readonly amount: number;
}

/**
 * 条件预占：只有 reserved + settled + amount <= cap 时才成立，判断与累加在同一条 UPDATE 里。
 * 跨日的在途预占仍记在发起日，不挪到新的一天。
 */
export async function reserveNeurons(
  db: D1Database,
  nowMs: number,
  amount: number,
  cap: number,
): Promise<NeuronReservation | null> {
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(cap) || cap < 0)
    throw new Error("invalid_ai_reservation");
  const day = utcDayPeriod(nowMs).key;
  const [, reserved] = await db.batch([
    db
      .prepare(
        `INSERT INTO ai_usage_days (day, reserved, settled, calls, updated_at)
         VALUES (?, 0, 0, 0, ?) ON CONFLICT(day) DO NOTHING`,
      )
      .bind(day, nowMs),
    db
      .prepare(
        `UPDATE ai_usage_days SET reserved = reserved + ?, calls = calls + 1, updated_at = ?
          WHERE day = ? AND reserved + settled + ? <= ?`,
      )
      .bind(amount, nowMs, day, amount, cap),
  ]);
  return reserved?.meta.changes === 1 ? { day, amount } : null;
}

/** 把预占转为实际用量（Neurons 向上取整）；实际值超过预占也如实入账，由调用方告警。 */
export async function settleNeurons(
  db: D1Database,
  reservation: NeuronReservation,
  actual: number,
  nowMs: number,
): Promise<number> {
  const settled = Number.isFinite(actual) && actual >= 0 ? Math.ceil(actual) : reservation.amount;
  await db
    .prepare(
      `UPDATE ai_usage_days SET reserved = MAX(reserved - ?, 0), settled = settled + ?, updated_at = ?
        WHERE day = ?`,
    )
    .bind(reservation.amount, settled, nowMs, reservation.day)
    .run();
  return settled;
}

export async function readUsageDay(db: D1Database, nowMs: number): Promise<AiUsageDay> {
  const day = utcDayPeriod(nowMs).key;
  const row = await db
    .prepare("SELECT day, reserved, settled, calls FROM ai_usage_days WHERE day = ?")
    .bind(day)
    .first<AiUsageDay>();
  return row ?? { day, reserved: 0, settled: 0, calls: 0 };
}
