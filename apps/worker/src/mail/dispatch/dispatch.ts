// P4-02 · §7.3：候选选择不消耗机会；只有显式批准才原子推进公平游标。
import {
  type MailIntentKind,
  OUTBOX_UNRESERVED_PERIOD_KEY,
  poolOfMailIntent,
} from "@hoyo/contracts";
import { type ConditionalCommitPlan, conditionalCommit } from "../../storage/cas";
import { isEmailAudienceEligible, occurrencePriority } from "../occurrences/eligibility";
import { BATCH_READY_SQL, loadDispatchBatch } from "./batch";
import { CONTEXT_SQL, contextParams, readDispatchContext } from "./context";
import { expireDispatchCandidates } from "./expiry";
import { stageDigestCandidates } from "./future";
import type {
  DispatchCandidate,
  DispatchContext,
  DispatchProposal,
  DispatchSelection,
} from "./types";

/** 适配既有预算意图，优先级只读 P4-01 的定义，不复制数值阶梯。 */
function intentOf(candidate: Pick<DispatchCandidate, "delivery_kind">): MailIntentKind {
  switch (candidate.delivery_kind) {
    case "cancelled_or_retracted":
      return "urgent_cancelled_or_retracted";
    case "important_change":
      return "urgent_important_change";
    case "late_discovery":
      return "urgent_late_discovery";
    case "rule":
    case "new_event":
      return "base_routine_or_announce";
    default:
      throw new Error("不支持的邮件候选类型");
  }
}
function classify(context: DispatchContext, nowMs: number) {
  const eligible: DispatchCandidate[] = [];
  const invalid: { id: string; status: string; reason: string }[] = [];
  for (const c of context.candidates) {
    let status: string | undefined;
    let reason = "eligibility_lost";
    if (
      c.invalidated_at !== null ||
      c.schedule_revision !== c.current_schedule_revision ||
      c.delivery_schedule_revision !== c.schedule_revision
    ) {
      status = "superseded";
      reason = "schedule_revision_changed";
    } else if (Math.min(c.expires_at, c.delivery_expires_at) <= nowMs) {
      status = "expired";
      reason = "notification_expired";
    } else if (
      c.channel !== "email" ||
      c.target_ref !== c.user_id ||
      !context.audience ||
      !isEmailAudienceEligible(
        c,
        context.audience,
        context.interests.filter((i) => i.game === c.game && i.region === c.region),
        nowMs,
      )
    ) {
      status = "skipped";
    }
    if (status) {
      // 未来候选尚未获得机会，不提前终结其原定到期时的匹配资格。
      if (c.due_at <= nowMs) invalid.push({ id: c.delivery_id, status, reason });
    } else {
      if (c.priority !== occurrencePriority(c.kind))
        throw new Error("Delivery 优先级与发生项不一致");
      eligible.push(c);
    }
  }
  return { eligible, invalid };
}
function overlaps(c: DispatchCandidate): boolean {
  return (
    c.delivery_kind === "important_change" ||
    c.delivery_kind === "late_discovery" ||
    c.delivery_kind === "new_event"
  );
}
function dominant(c: DispatchCandidate, all: DispatchCandidate[]): DispatchCandidate | undefined {
  if (!overlaps(c)) return undefined;
  return all.find(
    (other) =>
      overlaps(other) &&
      other.milestone_id === c.milestone_id &&
      other.schedule_revision === c.schedule_revision &&
      other.priority < c.priority,
  );
}
function digest(all: DispatchCandidate[], priority: number, nowMs: number) {
  const selected = all.filter((c) => c.priority === priority && !dominant(c, all));
  // 即将到期的候选只能搭乘一封本来就应当发送的信，不能自行触发提前批次。
  if (!selected.some((c) => c.due_at <= nowMs)) return { selected: [], superseded: [] };
  const superseded = all.filter((c) => {
    const winner = dominant(c, selected);
    return winner !== undefined;
  });
  return { selected, superseded };
}

/** 返回一个公平候选。拒绝预算时不调用批准函数；可排除本轮暂时无预算的用户/组再继续选择。 */
export async function selectDispatchCandidate(
  db: D1Database,
  batchId: string,
  nowMs: number,
  deferred: readonly { userId: string; priority: number }[] = [],
): Promise<DispatchSelection> {
  if (await expireDispatchCandidates(db, nowMs)) return { outcome: "advanced" };
  const batch = await loadDispatchBatch(db, batchId);
  const ids = JSON.stringify(batch.occurrenceIds);
  const ready = await db
    .prepare(`SELECT ${BATCH_READY_SQL} AS ready`)
    .bind(ids, batch.startedAt)
    .first<{ ready: number }>();
  if (!ready?.ready) return { outcome: "expanding" };
  const groups = (
    await db
      .prepare(`SELECT DISTINCT d.user_id,u."order" AS user_order,d.priority,
      COALESCE(c.last_order,-1) AS last_order,COALESCE(c.completed_lap,0) AS completed_lap
    FROM deliveries d INDEXED BY idx_deliveries_status JOIN users u ON u.id = d.user_id
    JOIN occurrences o ON o.id = d.occurrence_id
    JOIN json_each(?) g ON json_extract(g.value,'$.priority') = d.priority
    LEFT JOIN dispatch_cursors c ON c.priority = d.priority AND c.pool = json_extract(g.value,'$.pool')
    WHERE d.status = 'pending' AND d.mail_outbox_ref IS NULL AND d.channel = 'email'
      AND d.occurrence_id IN (SELECT value FROM json_each(?)) AND o.due_at <= ?
      AND NOT EXISTS (SELECT 1 FROM json_each(?) x WHERE json_extract(x.value,'$.userId') = d.user_id AND json_extract(x.value,'$.priority') = d.priority)
    ORDER BY d.priority, (u."order" <= COALESCE(c.last_order,-1)), u."order"`)
      .bind(
        JSON.stringify(
          ["cancelled_or_retracted", "important_change", "late_discovery", "rule", "new_event"].map(
            (kind) => ({
              priority: occurrencePriority(kind),
              pool: poolOfMailIntent(intentOf({ delivery_kind: kind })),
            }),
          ),
        ),
        ids,
        nowMs,
        JSON.stringify(deferred),
      )
      .all<{
        user_id: string;
        user_order: number;
        priority: number;
        last_order: number;
        completed_lap: number;
      }>()
  ).results;
  const contexts = new Map<string, Awaited<ReturnType<typeof readDispatchContext>>>();
  for (const group of groups) {
    let cached = contexts.get(group.user_id);
    if (!cached) {
      cached = await readDispatchContext(db, group.user_id, batch.occurrenceIds, nowMs);
      contexts.set(group.user_id, cached);
    }
    const { snapshot, context } = cached;
    const { eligible, invalid } = classify(context, nowMs);
    if (invalid.length) {
      await conditionalCommit(db, {
        guard: {
          sql: `UPDATE jobs SET lease_version = lease_version + 1 WHERE id = ? AND (${CONTEXT_SQL}) = ?`,
          params: [batchId, ...contextParams(group.user_id, batch.occurrenceIds, nowMs), snapshot],
        },
        effects: [
          {
            kind: "update",
            table: "deliveries",
            set: {
              status: {
                sql: "(SELECT json_extract(value,'$.status') FROM json_each(?) WHERE json_extract(value,'$.id') = deliveries.id)",
                params: [JSON.stringify(invalid)],
              },
              skip_reason: {
                sql: "(SELECT json_extract(value,'$.reason') FROM json_each(?) WHERE json_extract(value,'$.id') = deliveries.id)",
                params: [JSON.stringify(invalid)],
              },
              updated_at: nowMs,
            },
            where: {
              sql: "id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
              params: [JSON.stringify(invalid)],
            },
          },
        ],
      });
      // 快照已改变；让下一次有界调用重新选择，不把半旧半新的资格混进批准。
      return { outcome: "advanced" };
    }
    const { selected, superseded } = digest(eligible, group.priority, nowMs);
    const first = selected[0];
    if (!first) {
      continue;
    }
    if (await stageDigestCandidates(db, batch, context, group.priority, nowMs))
      return { outcome: "advanced" };
    const intent = intentOf(first);
    const pool = poolOfMailIntent(intent);
    await db
      .prepare(`INSERT INTO dispatch_cursors (pool,priority,last_order,completed_lap,updated_at)
      VALUES (?,?,-1,0,?) ON CONFLICT(pool,priority) DO NOTHING`)
      .bind(pool, group.priority, nowMs)
      .run();
    return {
      outcome: "candidate",
      proposal: {
        batchId,
        userId: group.user_id,
        order: group.user_order,
        priority: group.priority,
        pool,
        intent,
        deliveryIds: selected.map((c) => c.delivery_id),
        supersededIds: superseded.map((c) => c.delivery_id),
        lastOrder: group.last_order,
        completedLap: group.completed_lap,
        snapshot,
        selectedAt: nowMs,
      },
    };
  }
  return { outcome: "empty" };
}

/**
 * P4-04 接口：预算批准必须与此计划组成同一次 conditionalCommit。
 * 在 guard 追加预算谓词、在末尾多行 Delivery 效果之前插入单行账本效果；不能先推进游标再单独预占。
 * 此计划本身不承诺预算已预占、不调用供应商；pending outbox 的 period_key 保持未预留值。
 */
export async function planDispatchAttempt(
  db: D1Database,
  proposal: DispatchProposal,
  nowMs: number,
): Promise<{ outboxId: string; plan: ConditionalCommitPlan } | null> {
  const batch = await loadDispatchBatch(db, proposal.batchId);
  const { snapshot, context } = await readDispatchContext(
    db,
    proposal.userId,
    batch.occurrenceIds,
    nowMs,
  );
  if (snapshot !== proposal.snapshot || !context.audience) return null;
  const { eligible, invalid } = classify(context, nowMs);
  const { selected, superseded } = digest(eligible, proposal.priority, nowMs);
  if (
    invalid.length ||
    !selected.length ||
    JSON.stringify(selected.map((c) => c.delivery_id)) !== JSON.stringify(proposal.deliveryIds) ||
    JSON.stringify(superseded.map((c) => c.delivery_id)) !== JSON.stringify(proposal.supersededIds)
  )
    return null;
  const first = selected[0];
  if (
    !first ||
    proposal.pool !== poolOfMailIntent(intentOf(first)) ||
    proposal.order !== context.audience.user_order
  )
    return null;
  const outboxId = crypto.randomUUID();
  const ids = JSON.stringify(batch.occurrenceIds);
  const mutations = JSON.stringify([
    ...proposal.deliveryIds.map((id) => ({
      id,
      outbox: outboxId,
      status: "pending",
      reason: null,
    })),
    ...proposal.supersededIds.map((id) => ({
      id,
      outbox: null,
      status: "superseded",
      reason: "higher_priority_same_node",
    })),
  ]);
  return {
    outboxId,
    plan: {
      guard: {
        sql: `UPDATE dispatch_cursors SET last_order = ?, completed_lap = completed_lap + ?, updated_at = ?
      WHERE pool = ? AND priority = ? AND last_order = ? AND completed_lap = ?
      AND ${BATCH_READY_SQL} AND (${CONTEXT_SQL}) = ?`,
        params: [
          proposal.order,
          Number(proposal.order <= proposal.lastOrder),
          nowMs,
          proposal.pool,
          proposal.priority,
          proposal.lastOrder,
          proposal.completedLap,
          ids,
          batch.startedAt,
          ...contextParams(proposal.userId, batch.occurrenceIds, nowMs),
          snapshot,
        ],
      },
      effects: [
        {
          kind: "insert",
          table: "mail_outbox",
          columns: [
            "id",
            "purpose",
            "priority",
            "period_key",
            "recipient_user_id",
            "email_binding_id",
            "address_version",
            "payload_kind",
            "payload_ref",
            "status",
            "idempotency_key",
            "created_at",
            "updated_at",
          ],
          rows: [
            [
              outboxId,
              proposal.pool,
              proposal.priority,
              OUTBOX_UNRESERVED_PERIOD_KEY,
              proposal.userId,
              context.audience.email_binding_id,
              context.audience.email_version,
              "notification_digest",
              outboxId,
              "pending",
              JSON.stringify([proposal.batchId, proposal.pool, proposal.priority, proposal.userId]),
              nowMs,
              nowMs,
            ],
          ],
        },
        {
          kind: "update",
          table: "deliveries",
          set: {
            mail_outbox_ref: {
              sql: "(SELECT json_extract(value,'$.outbox') FROM json_each(?) WHERE json_extract(value,'$.id') = deliveries.id)",
              params: [mutations],
            },
            status: {
              sql: "(SELECT json_extract(value,'$.status') FROM json_each(?) WHERE json_extract(value,'$.id') = deliveries.id)",
              params: [mutations],
            },
            skip_reason: {
              sql: "(SELECT json_extract(value,'$.reason') FROM json_each(?) WHERE json_extract(value,'$.id') = deliveries.id)",
              params: [mutations],
            },
            updated_at: nowMs,
          },
          where: {
            sql: "id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
            params: [mutations],
          },
        },
      ],
    },
  };
}
