import { OBS_FEEDBACK_KINDS } from "@hoyo/contracts";
import { logEvent } from "../logger";
export const feedbackExpiredKeys = OBS_FEEDBACK_KINDS.map(
  (kind) => `mail_feedback:unmatched_expired:${kind}`,
);
/** 定期任务记录相邻采样的增长；固定槽，不把历史累计非零冒充持续增长。 */
export async function observeFeedbackGrowth(db: D1Database, now: number): Promise<void> {
  try {
    await db
      .prepare(`INSERT INTO system_state(key,value_json,updated_at)
 SELECT 'obs:feedback_growth',json_object('count',COALESCE(SUM(CAST(value_json AS INTEGER)),0),'delta',NULL),? FROM system_state WHERE key IN (SELECT value FROM json_each(?))
 ON CONFLICT(key) DO UPDATE SET value_json=json_object('count',json_extract(excluded.value_json,'$.count'),'delta',MAX(0,json_extract(excluded.value_json,'$.count')-json_extract(system_state.value_json,'$.count'))),updated_at=excluded.updated_at
 WHERE excluded.updated_at>system_state.updated_at`)
      .bind(now, JSON.stringify(feedbackExpiredKeys))
      .run();
  } catch {
    logEvent("error", "observability_write_failed", { reason_code: "feedback_growth" });
  }
}
