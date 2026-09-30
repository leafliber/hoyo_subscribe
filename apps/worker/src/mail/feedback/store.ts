// 持久收件箱：先去重留存，再租约处理。回执只能调用 P4-03 原语。

import type { EmailLookupKey, FieldEncryptionKey } from "@hoyo/contracts";
import {
  EXECUTOR_BATCH_WALL_LIMIT,
  FEEDBACK_BATCH,
  MAIL_FEEDBACK_MAX,
  MAIL_FEEDBACK_TTL,
  MAIL_UNMATCHED_MAX,
} from "@hoyo/contracts";
import { conditionalCommit } from "../../storage/cas";
import { recordMailReceipt } from "../outbox/state";
import type { MailRow } from "../outbox/types";
import {
  resolveFeedbackBinding,
  suppressionAddressKey,
  suppressionStatements,
} from "../suppression";
import type { Feedback } from "./schema";

export interface FeedbackKeys {
  lookup: EmailLookupKey;
  field: FieldEncryptionKey;
}
interface Stored {
  id: string;
  message_id: string;
  kind: Feedback["receipt"];
  raw_ref: string;
  mail_outbox_id: string | null;
}
interface SafeDetail {
  addressKey: string;
  suppression: Feedback["suppression"];
  stage: "pending" | "done";
  leaseUntil: number;
  token: string | null;
}
export const FEEDBACK_LOOKUP_SQL = "SELECT * FROM mail_feedback WHERE provider_event_id=?";
export async function ingestFeedback(
  db: D1Database,
  event: Feedback,
  keys: FeedbackKeys,
  now: number,
): Promise<boolean> {
  const detail: SafeDetail = {
    addressKey: await suppressionAddressKey(keys.lookup, event.recipient),
    suppression: event.suppression,
    stage: "pending",
    leaseUntil: 0,
    token: null,
  };
  // 单 SQL 容量判定 + INSERT；无 COUNT 后无条件 INSERT 的并发窗口。
  await db
    .prepare(`INSERT INTO mail_feedback(id,provider_event_id,message_id,kind,feedback_at,raw_ref,created_at)
    SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM mail_feedback WHERE provider_event_id=?)
    AND (SELECT COUNT(*) FROM mail_feedback) < ?
    AND (SELECT COUNT(*) FROM mail_feedback WHERE mail_outbox_id IS NULL) < ?
    ON CONFLICT(provider_event_id) DO NOTHING`)
    .bind(
      crypto.randomUUID(),
      event.eventId,
      event.messageId,
      event.receipt,
      event.at,
      JSON.stringify(detail),
      now,
      event.eventId,
      MAIL_FEEDBACK_MAX,
      MAIL_UNMATCHED_MAX,
    )
    .run();
  const stored = await db.prepare(FEEDBACK_LOOKUP_SQL).bind(event.eventId).first<Stored>();
  if (!stored) throw new Error("feedback_capacity");
  const previous = JSON.parse(stored.raw_ref) as SafeDetail;
  if (
    stored.message_id !== event.messageId ||
    stored.kind !== event.receipt ||
    previous.addressKey !== detail.addressKey ||
    previous.suppression !== detail.suppression
  )
    throw new Error("feedback_event_conflict");
  return processStoredFeedback(db, stored, keys, now);
}
export async function processStoredFeedback(
  db: D1Database,
  stored: Stored,
  keys: FeedbackKeys,
  now: number,
): Promise<boolean> {
  const detail = JSON.parse(stored.raw_ref) as SafeDetail;
  if (detail.stage === "done") return true;
  if (detail.leaseUntil > now) return false;
  const token = crypto.randomUUID();
  const claimed = await db
    .prepare(`UPDATE mail_feedback SET raw_ref=json_set(raw_ref,'$.token',?,'$.leaseUntil',?)
    WHERE id=? AND raw_ref=? RETURNING id`)
    .bind(token, now + EXECUTOR_BATCH_WALL_LIMIT * 1000, stored.id, stored.raw_ref)
    .first();
  if (!claimed) return false;
  try {
    const row = await db
      .prepare("SELECT * FROM mail_outbox WHERE message_id=?")
      .bind(stored.message_id)
      .first<MailRow>();
    if (!row) return false;
    // false 也可能是迟到状态被支配或崩溃重放，不等于 messageId 不存在。
    const recorded = await recordMailReceipt(db, stored.message_id, stored.kind, now);
    if (!recorded) {
      const current = await db
        .prepare(`SELECT o.status,json_extract(j.payload_json,'$.provider_status') AS receipt
        FROM mail_outbox o LEFT JOIN jobs j ON j.id='delivery:mail:'||o.id WHERE o.id=?`)
        .bind(row.id)
        .first<{ status: string; receipt: string | null }>();
      const dominated =
        current &&
        (["bounced", "complained", "failed", "rejected"].includes(current.status) ||
          (current.status === "accepted" &&
            current.receipt === "delivered" &&
            stored.kind === "deferred"));
      if (!dominated) return false;
    }
    // 先以反馈租约作同批守卫；零行时后续抑制与关通道也必须零效果。
    const effects: D1PreparedStatement[] = [
      db
        .prepare(`UPDATE mail_feedback SET mail_outbox_id=?,raw_ref=json_set(raw_ref,'$.stage','done','$.token',NULL,'$.leaseUntil',0)
      WHERE id=? AND json_extract(raw_ref,'$.token')=?`)
        .bind(row.id, stored.id, token),
    ];
    if (detail.suppression) {
      const binding = await resolveFeedbackBinding(db, row, detail.addressKey, keys);
      effects.push(
        ...suppressionStatements(db, {
          addressKey: detail.addressKey,
          binding,
          kind: detail.suppression,
          userId: row.recipient_user_id,
          addressVersion: row.address_version,
          now,
        }),
      );
    }
    // 所有本地抑制/通道关闭与完成标记在同一 batch；失败回滚，Queue 不 ack。
    // 回执事务已落库时重试仍走原语，终态不会被晚到成功恢复。
    const results = await db.batch(effects);
    return results[0]?.meta.changes === 1;
  } finally {
    await db
      .prepare(`UPDATE mail_feedback SET raw_ref=json_set(raw_ref,'$.token',NULL,'$.leaseUntil',0)
      WHERE id=? AND json_extract(raw_ref,'$.token')=?`)
      .bind(stored.id, token)
      .run();
  }
}
// 无流量时由后续 P5 维护调用；正常 Queue 重试自行再次关联，不依赖新事件到来。
export async function reconcileFeedbackPage(
  db: D1Database,
  keys: FeedbackKeys,
  now: number,
): Promise<number> {
  const pending = (
    await db
      .prepare(`SELECT * FROM mail_feedback WHERE mail_outbox_id IS NULL
    AND EXISTS (SELECT 1 FROM mail_outbox o WHERE o.message_id=mail_feedback.message_id)
    ORDER BY created_at,id LIMIT ?`)
      .bind(FEEDBACK_BATCH)
      .all<Stored>()
  ).results;
  let completed = 0;
  for (const row of pending) if (await processStoredFeedback(db, row, keys, now)) completed++;
  return completed;
}
export async function pruneFeedbackPage(db: D1Database, now: number): Promise<number> {
  // 未决异常不删除腾容量；已完成元数据到期按 kind 汇总后删除，汇总无身份字段。
  const cutoff = now - MAIL_FEEDBACK_TTL * 1000;
  const rows = (
    await db
      .prepare(`SELECT id,kind FROM mail_feedback WHERE created_at < ? AND mail_outbox_id IS NOT NULL
    ORDER BY created_at,id LIMIT ?`)
      .bind(cutoff, FEEDBACK_BATCH)
      .all<{ id: string; kind: string }>()
  ).results;
  let removed = 0;
  for (const row of rows) {
    const key = `mail_feedback:archived:${row.kind}`;
    const result = await conditionalCommit(db, {
      preamble: [
        {
          sql: "INSERT INTO system_state(key,value_json,updated_at) VALUES (?,'0',?) ON CONFLICT(key) DO NOTHING",
          params: [key, now],
        },
      ],
      guard: {
        sql: "DELETE FROM mail_feedback WHERE id=? AND created_at < ? AND mail_outbox_id IS NOT NULL",
        params: [row.id, cutoff],
      },
      effects: [
        {
          kind: "update",
          table: "system_state",
          set: {
            value_json: { sql: "CAST(CAST(value_json AS INTEGER)+1 AS TEXT)" },
            updated_at: now,
          },
          where: { sql: "key=?", params: [key] },
        },
      ],
    });
    if (result.outcome === "committed") removed++;
  }
  return removed;
}
