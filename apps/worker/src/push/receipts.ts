// P6-01 / P6-02 · Service Worker 的 receipt 窄能力（主方案 §7.8、§8.2、§9.4；ADR-0025）。
//
// `POST /api/v2/push-bindings/{id}/activate`：receipt token + 本轮随机挑战 → 绑定转 active。
// `POST /api/v2/push-bindings/{id}/processed`：receipt token + 消息 ID → 真实处理确认。
// 这两个入口不吃 Cookie、不读会话：receipt token 只证明"本浏览器收到了这条通知"，
// 不能取邮箱、改账号、改偏好或管理其他设备；响应体只有固定的结果码，不含任何账号信息。
// 合并写入：业务确认按 PUSH_RECEIPT_WRITE_INTERVAL 最多写一次（续租 + 账号活动水位），激活独立处理。
import {
  PUSH_ACTIVE_MAX,
  PushActivateRequestSchema,
  PushProcessedRequestSchema,
  pushLeaseExpiresAt,
  pushReceiptWriteDue,
} from "@hoyo/contracts";
import { recordActivityFailure } from "../accounts/activity/telemetry";
import { ApiError } from "../shell/errors";
import { conditionalCommit } from "../storage/cas";
import { sha256Hex } from "./crypto";
import { ACTIVE_COUNT_SQL } from "./store";

function invalid(): never {
  throw new ApiError("validation", {
    code: "validation",
    fields: [{ path: "", reason: "invalid_receipt" }],
  });
}
/** 绑定不存在、凭证不符、挑战不符、期限已过一律同一个 404，不区分原因。 */
export class ReceiptNotFoundError extends Error {
  constructor() {
    super("push_receipt_not_found");
    this.name = "ReceiptNotFoundError";
  }
}

export async function activateReceipt(
  db: D1Database,
  bindingId: string,
  body: unknown,
  now: number,
): Promise<{ result: "activated" | "already_active" }> {
  const parsed = PushActivateRequestSchema.safeParse(body);
  if (!parsed.success) invalid();
  const receiptHash = await sha256Hex(parsed.data.receipt_token);
  const challengeHash = await sha256Hex(parsed.data.challenge);
  const outcome = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE push_bindings SET state='active', activated_at=?, lease_expires_at=?, last_processed_at=?,
          activation_challenges_json=NULL, activation_outcome='accepted', paused_reason=NULL,
          binding_version=binding_version+1, updated_at=?
        WHERE id=? AND receipt_token_hash=? AND state='pending' AND activation_deadline>?
          AND EXISTS (SELECT 1 FROM json_each(push_bindings.activation_challenges_json) WHERE value=?)
          AND ${ACTIVE_COUNT_SQL}<?
          AND EXISTS (SELECT 1 FROM users u WHERE u.id=push_bindings.user_id AND u.status='active')`,
      params: [
        now,
        pushLeaseExpiresAt(now),
        now,
        now,
        bindingId,
        receiptHash,
        now,
        challengeHash,
        PUSH_ACTIVE_MAX,
      ],
    },
  });
  if (outcome.outcome === "committed") return { result: "activated" };
  const row = await db
    .prepare(
      "SELECT state, activation_deadline, activation_challenges_json FROM push_bindings WHERE id=? AND receipt_token_hash=?",
    )
    .bind(bindingId, receiptHash)
    .first<{
      state: string;
      activation_deadline: number | null;
      activation_challenges_json: string | null;
    }>();
  // 重放已生效的回执：幂等成功。
  if (row?.state === "active") return { result: "already_active" };
  if (
    row?.state === "pending" &&
    row.activation_deadline !== null &&
    row.activation_deadline > now &&
    (JSON.parse(row.activation_challenges_json ?? "[]") as string[]).includes(challengeHash)
  ) {
    const active = await db.prepare(`SELECT ${ACTIVE_COUNT_SQL} AS n`).first<{ n: number }>();
    if ((active?.n ?? 0) >= PUSH_ACTIVE_MAX)
      throw new ApiError("capacity_reached", { code: "capacity_reached", capability: "push" });
  }
  throw new ReceiptNotFoundError();
}

export async function processedReceipt(
  db: D1Database,
  bindingId: string,
  body: unknown,
  now: number,
): Promise<{ result: "recorded" }> {
  const parsed = PushProcessedRequestSchema.safeParse(body);
  if (!parsed.success) invalid();
  const receiptHash = await sha256Hex(parsed.data.receipt_token);
  const row = await db
    .prepare(`SELECT b.state, b.user_id, b.last_processed_at, b.last_test_at,
      m.purpose, m.status, m.created_at AS message_created_at, m.delivery_id
    FROM push_bindings b JOIN push_messages m ON m.binding_id=b.id
    WHERE b.id=? AND b.receipt_token_hash=? AND m.id=?`)
    .bind(bindingId, receiptHash, parsed.data.message_id)
    .first<{
      state: string;
      user_id: string;
      last_processed_at: number | null;
      last_test_at: number | null;
      purpose: string;
      status: string;
      message_created_at: number;
      delivery_id: string | null;
    }>();
  if (row === null) throw new ReceiptNotFoundError();
  if (row.purpose === "test") {
    // 只认最近一次测试：本浏览器确实收到并显示了它。
    await db
      .prepare(`UPDATE push_bindings SET last_test_received_at=? WHERE id=? AND receipt_token_hash=?
      AND last_test_at=? AND last_test_received_at IS NULL`)
      .bind(now, bindingId, receiptHash, row.message_created_at)
      .run();
    return { result: "recorded" };
  }
  if (row.purpose !== "business") return { result: "recorded" };
  if (row.status === "unknown") {
    // 外调超时但浏览器收到了：以客户端回执确认推送服务已接受。
    await db.batch([
      db
        .prepare(`UPDATE push_messages SET status='accepted', accepted_at=COALESCE(accepted_at,?),
        reason='client_receipt', updated_at=? WHERE id=? AND status='unknown'`)
        .bind(now, now, parsed.data.message_id),
      db
        .prepare(
          "UPDATE deliveries SET status='accepted', updated_at=? WHERE id=? AND status='unknown'",
        )
        .bind(now, row.delivery_id),
    ]);
  }
  if (row.state !== "active" || !pushReceiptWriteDue(row.last_processed_at, now))
    return { result: "recorded" };
  try {
    // 合并写入：续租与账号活动水位同一事务；间隔内的重复确认不写库。
    await conditionalCommit(db, {
      guard: {
        sql: `UPDATE push_bindings SET last_processed_at=?, lease_expires_at=MAX(COALESCE(lease_expires_at,0),?), updated_at=?
          WHERE id=? AND receipt_token_hash=? AND state='active' AND (last_processed_at IS NULL OR last_processed_at=?)`,
        params: [now, pushLeaseExpiresAt(now), now, bindingId, receiptHash, row.last_processed_at],
      },
      effects: [
        {
          kind: "update",
          table: "users",
          set: {
            last_push_processed_at: {
              sql: "MAX(COALESCE(last_push_processed_at,0),?)",
              params: [now],
            },
          },
          where: { sql: "id=?", params: [row.user_id] },
        },
      ],
    });
  } catch (error) {
    // 活动水位写失败不能静默：持久暂停回收，直到维护者确认水位可信（§6.6、§9.4）。
    await recordActivityFailure(db, now, "push_processed_merge");
    throw error;
  }
  return { result: "recorded" };
}
