// P4-01 · 逻辑执行入口：从 pending outbox 取发布信号，不按 created_at 维护高水位；到期后完整展开受众。
import { NOTIFICATION_PUBLICATION_TOPIC, WATCHDOG_INTERVAL } from "@hoyo/contracts";
import { expandOccurrencePage, startDueOccurrenceExpansion } from "../../mail/occurrences/expand";
import { generatePublicationOccurrences } from "../../mail/occurrences/generate";
import { logEvent } from "../../shell/logger";
import { classifyPipelineFailure, PipelineDataError } from "../pipeline/failure";

/** 由后续 DeliveryDO/Watchdog 调用；各上限由调用方的单批预算决定。 */
export async function runOccurrencePass(
  db: D1Database,
  nowMs: number,
  limits: { signalLimit: number; occurrenceLimit: number; pageLimit: number },
): Promise<{ signals: number; started: number; pages: number }> {
  const signals =
    (
      await db
        .prepare(`SELECT id FROM outbox WHERE topic = ? AND dispatch_state = 'pending'
    ORDER BY id LIMIT ?`)
        .bind(NOTIFICATION_PUBLICATION_TOPIC, limits.signalLimit)
        .all<{ id: string }>()
    ).results ?? [];
  for (const row of signals) await generatePublicationOccurrences(db, row.id, nowMs);
  const started = await startDueOccurrenceExpansion(db, nowMs, limits.occurrenceLimit);
  const jobs =
    (
      await db
        .prepare(`SELECT id,lease_version,attempts,payload_json FROM jobs WHERE kind = 'occurrence_email_expansion'
    AND status = 'pending' AND due_at <= ? ORDER BY due_at,id LIMIT ?`)
        .bind(nowMs, limits.pageLimit)
        .all<{ id: string; lease_version: number; attempts: number; payload_json: string }>()
    ).results ?? [];
  // Job ID 是 occurrence:{id}:email；按 payload 中的 occurrence_id 定位，避免解析业务 ID 分隔符。
  let pages = 0;
  for (const job of jobs) {
    try {
      const payload = JSON.parse(job.payload_json) as { occurrence_id?: string };
      if (typeof payload?.occurrence_id !== "string")
        throw new PipelineDataError("occurrence_job_shape");
      await expandOccurrencePage(db, payload.occurrence_id, nowMs);
    } catch (error) {
      const failure = classifyPipelineFailure(error);
      await db
        .prepare(`UPDATE jobs SET status=?,due_at=?,attempts=attempts+1,last_error=?,updated_at=?
        WHERE id=? AND status='pending' AND lease_version=?`)
        .bind(
          failure.terminal ? "failed" : "pending",
          nowMs + WATCHDOG_INTERVAL * 1000,
          failure.reason,
          nowMs,
          job.id,
          job.lease_version,
        )
        .run();
      logEvent("error", "delivery_expansion_failed", {
        reason_code: failure.reason,
        count: job.attempts + 1,
      });
    }
    pages++;
  }
  return { signals: signals.length, started, pages };
}
