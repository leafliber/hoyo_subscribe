// P4-01 · 主方案 §7.1–§7.2：发布 outbox 只生成事件级发生项，不展开用户。
import {
  CHANGE_TTL,
  type EventStatus,
  type EventType,
  LATE_NOTICE_TTL,
  LATE_POST_START_WINDOW,
  NEW_EVENT_TTL,
  NOTIFICATION_PUBLICATION_TOPIC,
  type NodeType,
  PUBLISH_CHANGE_KIND,
  type PublishChangeKind,
  REMINDER_GRACE,
  REMINDER_RULES,
} from "@hoyo/contracts";
import { conditionalCommit, type GuardedEffect } from "../../storage/cas";

interface PublicationSignal {
  event_id: string;
  event_revision: number;
  schedule_revision: number;
  change_kind: PublishChangeKind;
  changed_node_ids: string[];
  newly_exact_node_ids: string[];
  /** P3-11 的历史导入编排必须显式设置；缺失不推测来源意图。 */
  backfill?: boolean;
}

interface OutboxRow {
  topic: string;
  payload_json: string;
  dispatch_state: string;
  created_at: number;
}

interface EventRow {
  id: string;
  event_type: EventType;
  status: EventStatus;
  event_revision: number;
  schedule_revision: number;
}

interface NodeRow {
  id: string;
  node_type: NodeType;
  time_exact_ms: number | null;
  time_precision: string;
  time_basis: string;
}

interface PlannedOccurrence {
  nodeId: string;
  kind: string;
  dueAt: number;
  expiresAt: number;
}

function eligibleTime(node: NodeRow): node is NodeRow & { time_exact_ms: number } {
  return (
    node.time_precision === "datetime" &&
    node.time_exact_ms !== null &&
    (node.time_basis === "official_explicit" || node.time_basis === "deterministic_derived")
  );
}

function isEndNode(node: NodeRow): boolean {
  return node.node_type === "end" || node.node_type === "actual_end";
}

function plannedOccurrences(
  event: EventRow,
  nodes: readonly NodeRow[],
  signal: PublicationSignal,
  publishedAt: number,
): PlannedOccurrence[] {
  const planned: PlannedOccurrence[] = [];
  const valid = nodes.filter(eligibleTime);
  const active = event.status !== "cancelled" && event.status !== "retracted";
  const changed = new Set(signal.changed_node_ids);
  const newlyExact = new Set(signal.newly_exact_node_ids);
  const confirmedEnded = valid.some((node) => isEndNode(node) && node.time_exact_ms <= publishedAt);

  // 同一事件的 schedule_revision 整体变化会令旧发生项全部失效，故按新计划重建所有有效节点。
  // 纯内容修订的 changed_node_ids 为空，不重建提前提醒；晚发现仍限于 newly_exact_node_ids。
  if (active && changed.size > 0) {
    for (const node of valid) {
      for (const rule of REMINDER_RULES) {
        if (rule.event_type !== event.event_type || rule.node_type !== node.node_type) continue;
        const dueAt = node.time_exact_ms - rule.lead_time_seconds * 1000;
        const expiresAt = Math.min(dueAt + REMINDER_GRACE * 1000, node.time_exact_ms);
        if (expiresAt > publishedAt) {
          planned.push({ nodeId: node.id, kind: rule.rule_id, dueAt, expiresAt });
          continue;
        }
        if (!newlyExact.has(node.id) || signal.backfill === true) continue;
        const postStart = node.node_type === "start" && node.time_exact_ms <= publishedAt;
        if (
          node.time_exact_ms <= publishedAt &&
          (!postStart ||
            confirmedEnded ||
            publishedAt - node.time_exact_ms > LATE_POST_START_WINDOW * 1000)
        )
          continue;
        const lateExpiry = postStart
          ? publishedAt + LATE_NOTICE_TTL * 1000
          : Math.min(publishedAt + LATE_NOTICE_TTL * 1000, node.time_exact_ms);
        if (lateExpiry > publishedAt)
          planned.push({
            nodeId: node.id,
            kind: `late_discovery:${rule.rule_id}`,
            dueAt: publishedAt,
            expiresAt: lateExpiry,
          });
      }
    }
  }

  // 0011 的 occurrence 必须引用节点。事件级公布只取稳定排序的首节点；用户匹配仍以事件范围为准。
  const firstNode = [...nodes].sort((a, b) => a.id.localeCompare(b.id))[0];
  if (firstNode !== undefined && signal.backfill !== true) {
    if (signal.change_kind === PUBLISH_CHANGE_KIND.CREATED) {
      planned.push({
        nodeId: firstNode.id,
        kind: "new_event",
        dueAt: publishedAt,
        expiresAt: publishedAt + NEW_EVENT_TTL * 1000,
      });
    } else if (event.status === "cancelled" || event.status === "retracted") {
      for (const node of nodes)
        planned.push({
          nodeId: node.id,
          kind: "cancelled_or_retracted",
          dueAt: publishedAt,
          expiresAt: publishedAt + CHANGE_TTL * 1000,
        });
    } else if (signal.changed_node_ids.length > 0) {
      for (const node of nodes.filter((item) => changed.has(item.id)))
        planned.push({
          nodeId: node.id,
          kind: "important_change",
          dueAt: publishedAt,
          expiresAt: publishedAt + CHANGE_TTL * 1000,
        });
    }
  }
  return planned;
}

/** 消费一个确定 ID 的发布信号；重复调用不复制 occurrence，过时修订不回放旧通知。 */
export async function generatePublicationOccurrences(
  db: D1Database,
  outboxId: string,
  nowMs: number,
): Promise<"generated" | "stale" | "unchanged"> {
  const signalRow = await db
    .prepare("SELECT topic,payload_json,dispatch_state,created_at FROM outbox WHERE id = ?")
    .bind(outboxId)
    .first<OutboxRow>();
  if (signalRow === null || signalRow.topic !== NOTIFICATION_PUBLICATION_TOPIC)
    throw new Error("通知发布信号不存在");
  if (signalRow.dispatch_state !== "pending") return "unchanged";
  const signal = JSON.parse(signalRow.payload_json) as PublicationSignal;
  const event = await db
    .prepare(
      "SELECT id,event_type,status,event_revision,schedule_revision FROM events WHERE id = ?",
    )
    .bind(signal.event_id)
    .first<EventRow>();
  if (event === null) throw new Error("发布信号所指事件不存在");
  // 后续仅改标题的发布会推进 event_revision、保持 schedule_revision；旧信号仍需生成原计划。
  const current =
    event.event_revision >= signal.event_revision &&
    event.schedule_revision === signal.schedule_revision;
  const nodes = current
    ? ((
        await db
          .prepare(
            "SELECT id,node_type,time_exact_ms,time_precision,time_basis FROM milestones WHERE event_id = ?",
          )
          .bind(event.id)
          .all<NodeRow>()
      ).results ?? [])
    : [];
  const planned = current ? plannedOccurrences(event, nodes, signal, signalRow.created_at) : [];
  const existing = current
    ? ((
        await db
          .prepare(
            "SELECT milestone_id,kind FROM occurrences WHERE event_id = ? AND schedule_revision = ?",
          )
          .bind(event.id, event.schedule_revision)
          .all<{ milestone_id: string; kind: string }>()
      ).results ?? [])
    : [];
  const keys = new Set(existing.map((row) => `${row.milestone_id}\u0000${row.kind}`));
  const effects: GuardedEffect[] = planned
    .filter((item) => !keys.has(`${item.nodeId}\u0000${item.kind}`))
    .map((item) => ({
      kind: "insert" as const,
      table: "occurrences",
      columns: [
        "id",
        "event_id",
        "milestone_id",
        "schedule_revision",
        "kind",
        "due_at",
        "expires_at",
        "audience_upper_order",
        "backfill",
        "invalidated_at",
        "created_at",
      ],
      rows: [
        [
          crypto.randomUUID(),
          event.id,
          item.nodeId,
          event.schedule_revision,
          item.kind,
          item.dueAt,
          item.expiresAt,
          null,
          Number(signal.backfill === true),
          null,
          nowMs,
        ],
      ],
    }));
  // 先作幂等失效：若后续提交失败，pending outbox 仍会重试；发送链也必须即时复核版本。
  if (current && signal.changed_node_ids.length > 0) {
    await db.batch([
      db
        .prepare(
          "UPDATE occurrences SET invalidated_at = ? WHERE event_id = ? AND schedule_revision < ? AND invalidated_at IS NULL",
        )
        .bind(nowMs, event.id, event.schedule_revision),
      db
        .prepare(`UPDATE deliveries SET status = 'superseded', skip_reason = 'schedule_revision_changed', updated_at = ?
        WHERE milestone_id IN (SELECT id FROM milestones WHERE event_id = ?) AND schedule_revision < ?
          AND status IN ('pending','leased','retry_wait')`)
        .bind(nowMs, event.id, event.schedule_revision),
    ]);
  }
  const outcome = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE outbox SET dispatch_state = 'dispatched', dispatched_at = ? WHERE id = ? AND topic = ? AND dispatch_state = 'pending'
        AND EXISTS (SELECT 1 FROM events WHERE id = ? AND event_revision = ? AND schedule_revision = ?)`,
      params: [
        nowMs,
        outboxId,
        NOTIFICATION_PUBLICATION_TOPIC,
        signal.event_id,
        event.event_revision,
        event.schedule_revision,
      ],
    },
    effects,
  });
  if (outcome.outcome !== "committed") return "unchanged";
  // 已提交平台的消息无法撤回，发送链仍须即时复核版本。
  return current ? "generated" : "stale";
}
