// P4-02 · §7.3：冻结有限发生项集合；完整受众展开完毕才允许调度。
import { MAIL_DIGEST_WINDOW } from "@hoyo/contracts";
import { conditionalCommit } from "../../storage/cas";
import { expandOccurrencePage } from "../occurrences/expand";

export interface DispatchBatch {
  id: string;
  startedAt: number;
  horizon: number;
  occurrenceIds: string[];
}

export async function loadDispatchBatch(db: D1Database, id: string): Promise<DispatchBatch> {
  const row = await db
    .prepare("SELECT payload_json FROM jobs WHERE id = ? AND kind = 'mail_dispatch_batch'")
    .bind(id)
    .first<{ payload_json: string }>();
  if (!row) throw new Error("邮件调度批次不存在");
  return JSON.parse(row.payload_json) as DispatchBatch;
}

/** ID 由编排器持久保存并重用；重启不改变本批的发生项集合或时间窗口。 */
export async function startDispatchBatch(
  db: D1Database,
  id: string,
  nowMs: number,
): Promise<DispatchBatch> {
  // 同一 INSERT SELECT 快照冻结集合，避免先读后写的发布竞态。未来候选只是提前合并的备选。
  await db
    .prepare(`INSERT INTO jobs (id,kind,payload_json,due_at,status,created_at,updated_at)
    SELECT ?, 'mail_dispatch_batch', json_object('id', ?, 'startedAt', ?, 'horizon', ?,
      'occurrenceIds', json_group_array(o.id)), ?, 'pending', ?, ?
    FROM occurrences o JOIN events e ON e.id = o.event_id
    WHERE o.invalidated_at IS NULL AND o.expires_at > ? AND o.due_at <= ?
      AND e.schedule_revision = o.schedule_revision
    ON CONFLICT(id) DO NOTHING`)
    .bind(
      id,
      id,
      nowMs,
      nowMs + MAIL_DIGEST_WINDOW * 1000,
      nowMs,
      nowMs,
      nowMs,
      nowMs,
      nowMs + MAIL_DIGEST_WINDOW * 1000,
    )
    .run();
  return loadDispatchBatch(db, id);
}

/** 一次最多推进一个 MATCH_PAGE；真实 now 与合并窗口分离，不能把未来时间传给资格复核。 */
export async function expandDispatchBatchPage(
  db: D1Database,
  batchId: string,
  nowMs: number,
): Promise<"advanced" | "ready"> {
  const batch = await loadDispatchBatch(db, batchId);
  const next = await db
    .prepare(`SELECT o.id, o.audience_upper_order FROM json_each(?) b
    JOIN occurrences o ON o.id = b.value
    LEFT JOIN jobs j ON j.id = 'occurrence:' || o.id || ':email'
    WHERE o.due_at <= ? AND (j.id IS NULL OR j.status != 'done') ORDER BY o.due_at,o.id LIMIT 1`)
    .bind(JSON.stringify(batch.occurrenceIds), batch.startedAt)
    .first<{ id: string; audience_upper_order: number | null }>();
  if (!next) return "ready";
  if (next.audience_upper_order === null) {
    const upper =
      (await db.prepare('SELECT COALESCE(MAX("order"), -1) AS n FROM users').first<{ n: number }>())
        ?.n ?? -1;
    await conditionalCommit(db, {
      guard: {
        sql: "UPDATE occurrences SET audience_upper_order = ? WHERE id = ? AND audience_upper_order IS NULL",
        params: [upper, next.id],
      },
      effects: [
        {
          kind: "insert",
          table: "jobs",
          columns: ["id", "kind", "payload_json", "due_at", "status", "created_at", "updated_at"],
          rows: [
            [
              `occurrence:${next.id}:email`,
              "occurrence_email_expansion",
              JSON.stringify({ occurrence_id: next.id, cursor: -1, upper }),
              nowMs,
              "pending",
              nowMs,
              nowMs,
            ],
          ],
        },
      ],
    });
  }
  await expandOccurrencePage(db, next.id, nowMs);
  return "advanced";
}

/** 必须由 SQL 守卫再次检查，不能只凭调用方传入 ready。 */
export const BATCH_READY_SQL = `NOT EXISTS (
  SELECT 1 FROM json_each(?) b JOIN occurrences o ON o.id = b.value
  LEFT JOIN jobs j ON j.id = 'occurrence:' || b.value || ':email'
  WHERE o.due_at <= ? AND (j.id IS NULL OR j.status != 'done')
)`;
