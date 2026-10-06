// P6（ADR-0025）获准跨卡：邮件编排的"仍有待发"判断只看 channel=email，Push Delivery 不触发邮件批次。
// P4-04 · 只新增业务批次编排；批次/预算等待独立于认证与发生项展开。

import { SEND_CONCURRENCY, utcDayPeriod, WATCHDOG_INTERVAL } from "@hoyo/contracts";
import { approveBudgetedDispatch } from "../../mail/budget/dispatch";
import { loadDispatchBatch, startDispatchBatch } from "../../mail/dispatch/batch";
import { selectDispatchCandidate } from "../../mail/dispatch/dispatch";
import { logEvent } from "../../shell/logger";
import { recordMetric } from "../../shell/observability/metrics";
import { conditionalCommit } from "../../storage/cas";
import { classifyPipelineFailure } from "../pipeline/failure";

const COORDINATOR = "delivery:dispatch";
interface Round {
  batchId: string | null;
  deferred: { userId: string; priority: number }[];
}
interface Job {
  payload_json: string;
  status: string;
  due_at: number;
  lease_version: number;
}
export async function runDispatchPass(
  db: D1Database,
  now: () => number,
  deadline: number,
): Promise<void> {
  const start = now();
  await db
    .prepare(`INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at)
    VALUES (?,'mail_dispatch_coordinator',?,?,'pending',?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(COORDINATOR, JSON.stringify({ batchId: null, deferred: [] }), start, start, start)
    .run();
  const job = await db
    .prepare("SELECT payload_json,status,due_at,lease_version FROM jobs WHERE id=?")
    .bind(COORDINATOR)
    .first<Job>();
  if (!job || job.status === "failed" || job.due_at > start) return;
  try {
    let round = JSON.parse(job.payload_json) as Round;
    if (!round.batchId) {
      const b = await startDispatchBatch(db, `delivery:batch:${crypto.randomUUID()}`, start);
      round = { batchId: b.id, deferred: [] };
      // 先持久保存 ID。重启复用同一批，不能在已批准后忘掉 deferred 扫描进度。
      await db
        .prepare("UPDATE jobs SET payload_json=? WHERE id=? AND lease_version=?")
        .bind(JSON.stringify(round), COORDINATOR, job.lease_version)
        .run();
    }
    // 每轮仅排除已确定失败的发生项，保留其余冻结成员；失败不复活、不堵住好单元。
    const batch = await loadDispatchBatch(db, round.batchId as string);
    const active = (
      await db
        .prepare(`SELECT o.id FROM json_each(?) x JOIN occurrences o ON o.id=x.value
      WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id IN ('occurrence:'||o.id||':start','occurrence:'||o.id||':email') AND status='failed')`)
        .bind(JSON.stringify(batch.occurrenceIds))
        .all<{ id: string }>()
    ).results.map((r) => r.id);
    if (active.length !== batch.occurrenceIds.length)
      await db
        .prepare("UPDATE jobs SET payload_json=? WHERE id=?")
        .bind(JSON.stringify({ ...batch, occurrenceIds: active }), batch.id)
        .run();
    for (let unit = 0; unit < SEND_CONCURRENCY && now() < deadline; unit++) {
      const selection = await selectDispatchCandidate(
        db,
        round.batchId as string,
        now(),
        round.deferred,
      );
      if (selection.outcome === "expanding") {
        await save(db, job, round, now() + WATCHDOG_INTERVAL * 1000, now());
        return;
      }
      if (selection.outcome === "empty") {
        await db
          .prepare(`UPDATE jobs SET status='done',completed_at=?,updated_at=? WHERE id=?`)
          .bind(now(), now(), round.batchId)
          .run();
        const fresh = await db
          .prepare(`SELECT d.id FROM deliveries d JOIN occurrences o ON o.id=d.occurrence_id
          WHERE d.status='pending' AND d.mail_outbox_ref IS NULL AND d.channel='email' AND o.due_at<=? AND d.expires_at>?
          AND NOT EXISTS (SELECT 1 FROM jobs WHERE id IN ('occurrence:'||o.id||':start','occurrence:'||o.id||':email') AND status='failed')
          AND d.occurrence_id NOT IN (SELECT value FROM json_each((SELECT json_extract(payload_json,'$.occurrenceIds') FROM jobs WHERE id=?))) LIMIT 1`)
          .bind(now(), now(), round.batchId)
          .first();
        await save(
          db,
          job,
          { batchId: null, deferred: [] },
          fresh
            ? now()
            : Math.min(utcDayPeriod(now()).endMsExclusive, now() + WATCHDOG_INTERVAL * 1000),
          now(),
        );
        return;
      }
      if (selection.outcome === "candidate") {
        const result = await approveBudgetedDispatch(db, selection.proposal, now());
        if (result.outcome === "condition_missed")
          round.deferred.push({
            userId: selection.proposal.userId,
            priority: selection.proposal.priority,
          });
      }
    }
    await save(db, job, round, now(), now());
  } catch (error) {
    const failure = classifyPipelineFailure(error);
    await db
      .prepare(
        `UPDATE jobs SET status=?,due_at=?,attempts=attempts+1,last_error=?,lease_version=lease_version+1,updated_at=? WHERE id=? AND lease_version=?`,
      )
      .bind(
        failure.terminal ? "failed" : "pending",
        now() + WATCHDOG_INTERVAL * 1000,
        failure.reason,
        now(),
        COORDINATOR,
        job.lease_version,
      )
      .run();
    await recordMetric(db, "delivery_dispatch_failed", now());
    logEvent("error", "delivery_dispatch_failed", { reason_code: failure.reason });
  }
}
async function save(db: D1Database, job: Job, round: Round, due: number, now: number) {
  await conditionalCommit(db, {
    guard: {
      sql: "UPDATE jobs SET payload_json=?,due_at=?,updated_at=?,lease_version=lease_version+1 WHERE id=? AND lease_version=?",
      params: [JSON.stringify(round), due, now, COORDINATOR, job.lease_version],
    },
  });
}
export async function nextDispatchAlarm(db: D1Database, now: number): Promise<number | null> {
  const job = await db
    .prepare("SELECT due_at,status FROM jobs WHERE id=?")
    .bind(COORDINATOR)
    .first<{ due_at: number; status: string }>();
  if (job?.status === "failed") return null;
  // pending 索引排除历史；未来候选不能自行触发。
  const pending = await db
    .prepare(`SELECT d.id FROM deliveries d JOIN occurrences o ON o.id=d.occurrence_id
    WHERE d.status='pending' AND d.mail_outbox_ref IS NULL AND d.channel='email' AND o.due_at<=?
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE id IN ('occurrence:'||o.id||':start','occurrence:'||o.id||':email') AND status='failed') LIMIT 1`)
    .bind(now)
    .first();
  return pending ? Math.max(now, job?.due_at ?? now) : null;
}
