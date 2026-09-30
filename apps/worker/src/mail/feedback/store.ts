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
// 声明式索引与这些谓词相同；JSON 兼容迁移前可能出现的非 JSON raw_ref。
const SAFE_DETAIL_SQL = "CASE WHEN json_valid(raw_ref) THEN raw_ref ELSE '{}' END";
const DONE_SQL = `json_extract(${SAFE_DETAIL_SQL},'$.stage')='done'`;
const IDLE_SQL = `COALESCE(json_extract(${SAFE_DETAIL_SQL},'$.leaseUntil'),0)<=?`;
export const FEEDBACK_COMPLETED_PAGE_SQL = `SELECT id,kind,raw_ref,mail_outbox_id FROM mail_feedback
  WHERE ${DONE_SQL} AND ${IDLE_SQL} AND created_at<=? ORDER BY created_at,id LIMIT ?`;
export const FEEDBACK_PRESSURE_PAGE_SQL = `SELECT id,kind,raw_ref,mail_outbox_id FROM mail_feedback
  WHERE ${DONE_SQL} AND ${IDLE_SQL} ORDER BY created_at,id LIMIT ?`;
export const FEEDBACK_UNMATCHED_PAGE_SQL = `SELECT id,kind,raw_ref,mail_outbox_id FROM mail_feedback INDEXED BY idx_mail_feedback_unmatched_cleanup
  WHERE mail_outbox_id IS NULL AND created_at<=? AND ${IDLE_SQL} ORDER BY created_at,id LIMIT ?`;
// 容量上限仍在 INSERT 内核验。已找到 outbox 的行直接已关联，不借用未关联名额。
// 两个 COUNT 有注册表硬上界，真实 rows_read 基准在 storage/schema.test.ts。
export const FEEDBACK_INSERT_SQL = `INSERT INTO mail_feedback(id,provider_event_id,message_id,mail_outbox_id,kind,feedback_at,raw_ref,created_at)
  SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM mail_feedback WHERE provider_event_id=?)
  AND (SELECT COUNT(*) FROM mail_feedback) < ?
  AND (? IS NOT NULL OR (SELECT COUNT(*) FROM mail_feedback WHERE mail_outbox_id IS NULL) < ?)
  ON CONFLICT(provider_event_id) DO NOTHING RETURNING *`;
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
  const lookup = () => db.prepare(FEEDBACK_LOOKUP_SQL).bind(event.eventId).first<Stored>();
  let stored = await lookup();
  if (!stored) {
    const outbox = await db
      .prepare("SELECT id FROM mail_outbox WHERE message_id=?")
      .bind(event.messageId)
      .first<{ id: string }>();
    const outboxId = outbox?.id ?? null;
    // 先回收到期行；每页固定小批，不整表删除。未关联到期也转无身份异常计数。
    await pruneFeedbackPage(db, now);
    const insert = (limit: number) =>
      db
        .prepare(FEEDBACK_INSERT_SQL)
        .bind(
          crypto.randomUUID(),
          event.eventId,
          event.messageId,
          outboxId,
          event.receipt,
          event.at,
          JSON.stringify(detail),
          now,
          event.eventId,
          limit,
          outboxId,
          MAIL_UNMATCHED_MAX,
        )
        .first<Stored>();
    // 以一批为容量余量，接近硬上限先汇总最旧的已完成行。没有可回收完成行时，
    // 第二次仍允许使用真正硬上限内的余位；绝不删除处理中/待重试记录。
    stored = (await insert(MAIL_FEEDBACK_MAX - FEEDBACK_BATCH)) ?? (await lookup());
    if (!stored) {
      if (outboxId === null) {
        const unmatched = await db
          .prepare("SELECT COUNT(*) AS n FROM mail_feedback WHERE mail_outbox_id IS NULL")
          .first<{ n: number }>();
        if ((unmatched?.n ?? MAIL_UNMATCHED_MAX) >= MAIL_UNMATCHED_MAX)
          throw new Error("feedback_unmatched_capacity");
      }
      await compactFeedbackPage(db, now);
      stored = (await insert(MAIL_FEEDBACK_MAX)) ?? (await lookup());
    }
  }
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
    .prepare(`UPDATE mail_feedback SET mail_outbox_id=COALESCE(mail_outbox_id,(SELECT id FROM mail_outbox WHERE message_id=mail_feedback.message_id)),raw_ref=json_set(raw_ref,'$.token',?,'$.leaseUntil',?)
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
      .prepare(`SELECT * FROM mail_feedback WHERE json_extract(${SAFE_DETAIL_SQL},'$.stage')='pending' AND ${IDLE_SQL}
    AND EXISTS (SELECT 1 FROM mail_outbox o WHERE o.message_id=mail_feedback.message_id)
    ORDER BY created_at,id LIMIT ?`)
      .bind(now, FEEDBACK_BATCH)
      .all<Stored>()
  ).results;
  let completed = 0;
  for (const row of pending) if (await processStoredFeedback(db, row, keys, now)) completed++;
  return completed;
}
interface ArchiveRow {
  id: string;
  kind: string;
  raw_ref: string | null;
  mail_outbox_id: string | null;
}
async function archiveRows(
  db: D1Database,
  rows: ArchiveRow[],
  exception: boolean,
  now: number,
): Promise<number> {
  let removed = 0;
  for (const row of rows) {
    const key = `mail_feedback:${exception ? "unmatched_expired" : "archived"}:${row.kind}`;
    const result = await conditionalCommit(db, {
      preamble: [
        {
          sql: "INSERT INTO system_state(key,value_json,updated_at) VALUES (?,'0',?) ON CONFLICT(key) DO NOTHING",
          params: [key, now],
        },
      ],
      // 防止选页后被领取/关联/完成的行被旧清理者删除。被别人删掉也是零效果。
      guard: {
        sql: "DELETE FROM mail_feedback WHERE id=? AND raw_ref IS ? AND mail_outbox_id IS ?",
        params: [row.id, row.raw_ref, row.mail_outbox_id],
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
/** TTL 是上限：已完成记录正常到期汇总；未关联满 TTL 后汇总为无身份异常。 */
export async function pruneFeedbackPage(db: D1Database, now: number): Promise<number> {
  const cutoff = now - MAIL_FEEDBACK_TTL * 1000;
  const unmatched = (
    await db
      .prepare(FEEDBACK_UNMATCHED_PAGE_SQL)
      .bind(cutoff, now, FEEDBACK_BATCH)
      .all<ArchiveRow>()
  ).results;
  const remaining = FEEDBACK_BATCH - unmatched.length;
  const completed =
    remaining > 0
      ? (
          await db
            .prepare(FEEDBACK_COMPLETED_PAGE_SQL)
            .bind(now, cutoff, remaining)
            .all<ArchiveRow>()
        ).results
      : [];
  return (
    (await archiveRows(db, unmatched, true, now)) + (await archiveRows(db, completed, false, now))
  );
}
/** 压力回收只选显式 done 的最旧记录；已关联但 pending/retry 的行不可当成完成。 */
export async function compactFeedbackPage(db: D1Database, now: number): Promise<number> {
  const rows = (
    await db.prepare(FEEDBACK_PRESSURE_PAGE_SQL).bind(now, FEEDBACK_BATCH).all<ArchiveRow>()
  ).results;
  return archiveRows(db, rows, false, now);
}
