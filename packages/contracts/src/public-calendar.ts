// P3-05 获准跨卡改动：公共更正的种类、保留水位和暂停键供快照器、P3-06 与 P3-11 共用。
// 主方案 §6.3、附录 A.3；不得在 Worker 另写更正判定或参数值。
import {
  type CalendarProjectionSource,
  type EffectiveCalendarNode,
  effectiveCalendarNodes,
} from "./calendar-nodes";
import type { GameId, RegionId } from "./enums";
import { CAL_PATCH_MIN_DAYS, CAL_PATCH_TAIL_DAYS } from "./params/registry";
import type { PublicEventFacts, PublicMilestoneFacts } from "./publishing";

export const NONCRITICAL_PUBLICATION_PAUSE_STATE_KEY = "noncritical_publication_paused";

export const CALENDAR_PATCH_KIND = {
  RESCHEDULED: "rescheduled",
  CANCELLED: "cancelled",
  RETRACTED: "retracted",
  DELETED: "deleted",
  RESTORED: "restored",
  POSTPONED_UNKNOWN: "postponed_unknown",
  CLASSIFICATION_CORRECTED: "classification_corrected",
} as const;
export type CalendarPatchKind = (typeof CALENDAR_PATCH_KIND)[keyof typeof CALENDAR_PATCH_KIND];

export interface PublicCalendarProjection {
  readonly event_id: string;
  readonly milestone_id: string;
  readonly event: PublicEventFacts;
  readonly milestone: PublicMilestoneFacts;
}

/** 公开代次的一条完整模板；UID 只能由 P3-06 在个人 Feed 组装时生成。 */
export interface PublicSnapshotNode {
  readonly game: GameId;
  readonly region: RegionId;
  readonly projection: PublicCalendarProjection;
  readonly public_ical_revision: number;
  readonly patch: PatchDecision | null;
  readonly source_projection_json: string | null;
  readonly tombstone: boolean;
  /** 本条内容（除本字段外逐字相同）连续出现的最早完整代次；缩水守卫据此认定它属于上次输出那一代。
   * 修复前写入、此后内容未变的节点没有该字段。 */
  readonly content_generation?: number;
}

/** 分类纠正沿用已存在的越界补偿；单独的分类纠正不扩展窗口。 */
export function calendarPatchExtendsWindow(patch: PatchDecision): boolean {
  return patch.extends_window;
}

/** 基础与更正共用当前配置的同一次筛选，并按稳定 Milestone 身份去重。 */
export function effectivePublicSnapshotNodes(
  source: CalendarProjectionSource,
  nodes: readonly PublicSnapshotNode[],
): readonly EffectiveCalendarNode<
  PublicSnapshotNode & {
    event_type: PublicCalendarProjection["event"]["event_type"];
    node_type: PublicCalendarProjection["milestone"]["node_type"];
  }
>[] {
  const unique = new Map(nodes.map((node) => [node.projection.milestone_id, node]));
  return effectiveCalendarNodes(
    source,
    [...unique.values()].map((node) => ({
      ...node,
      event_type: node.projection.event.event_type,
      node_type: node.projection.milestone.node_type,
    })),
  );
}

/** 日桶中的纯日期到次日零点才完整结束；不把它转换成节点的精确时刻。 */
export function retentionTimeMs(time: PublicMilestoneFacts["time"]): number | null {
  if (time.precision === "datetime") return time.utc_ms;
  if (time.precision === "date") return Date.parse(`${time.date}T00:00:00Z`) + 86_400_000;
  return null;
}

export interface PatchDecision {
  readonly kind: CalendarPatchKind;
  readonly fact_reason: string;
  readonly extends_window: boolean;
  readonly display_time: PublicMilestoneFacts["time"];
  readonly old_time: PublicMilestoneFacts["time"] | null;
  readonly new_time: PublicMilestoneFacts["time"] | null;
  readonly retain_until: number;
}

/** 已向客户端公开的旧时间水位只可增大；连续改期不能缩短此前补偿期。 */
export function decideCalendarPatch(
  previous: PublicCalendarProjection | null,
  current: PublicCalendarProjection | null,
  previousPatch: PatchDecision | null,
  changedAt: number,
  previousWasDeleted = false,
): PatchDecision | null {
  if (previous === null || (current === null && previous.milestone.time.precision === "unknown"))
    return null;
  const oldTime = previous.milestone.time;
  const newTime = current?.milestone.time ?? null;
  const oldClock = retentionTimeMs(oldTime);
  const newClock = newTime === null ? null : retentionTimeMs(newTime);
  let kind: CalendarPatchKind;
  let factReason: string;
  if (current === null) {
    kind = CALENDAR_PATCH_KIND.DELETED;
    factReason = "已发布节点被删除";
  } else if (
    previousWasDeleted ||
    ((previous.event.status === "cancelled" || previous.event.status === "retracted") &&
      current.event.status !== "cancelled" &&
      current.event.status !== "retracted" &&
      newClock !== null)
  ) {
    kind = CALENDAR_PATCH_KIND.RESTORED;
    factReason = "已恢复确定安排";
  } else if (current.event.status === "cancelled" && previous.event.status !== "cancelled") {
    kind = CALENDAR_PATCH_KIND.CANCELLED;
    factReason = "官方取消";
  } else if (current.event.status === "retracted" && previous.event.status !== "retracted") {
    kind = CALENDAR_PATCH_KIND.RETRACTED;
    factReason = "本站纠错撤回";
  } else if (current.event.status === "postponed" && newClock === null && oldClock !== null) {
    kind = CALENDAR_PATCH_KIND.POSTPONED_UNKNOWN;
    factReason = "延期且新时间未定";
  } else if (
    (oldClock !== newClock || oldTime.precision !== newTime?.precision) &&
    newClock !== null
  ) {
    kind = CALENDAR_PATCH_KIND.RESCHEDULED;
    factReason = "已公布新时间";
  } else if (
    current.event_id !== previous.event_id ||
    current.event.event_type !== previous.event.event_type ||
    current.milestone.node_type !== previous.milestone.node_type
  ) {
    kind = CALENDAR_PATCH_KIND.CLASSIFICATION_CORRECTED;
    factReason = "分类或归属已更正";
  } else {
    return null;
  }
  const highWater =
    [oldTime, previousPatch?.old_time ?? null]
      .filter((time): time is PublicMilestoneFacts["time"] => time !== null)
      .filter((time) => retentionTimeMs(time) !== null)
      .sort((a, b) => (retentionTimeMs(b) ?? 0) - (retentionTimeMs(a) ?? 0))[0] ?? null;
  const displayTime =
    kind === CALENDAR_PATCH_KIND.CANCELLED ||
    kind === CALENDAR_PATCH_KIND.RETRACTED ||
    kind === CALENDAR_PATCH_KIND.DELETED ||
    kind === CALENDAR_PATCH_KIND.POSTPONED_UNKNOWN
      ? oldClock === null
        ? (previousPatch?.display_time ?? null)
        : oldTime
      : newTime;
  if (displayTime === null || retentionTimeMs(displayTime) === null) return null;
  const dayMs = 86_400_000;
  return {
    kind,
    fact_reason: factReason,
    extends_window:
      kind !== CALENDAR_PATCH_KIND.CLASSIFICATION_CORRECTED ||
      (previousPatch?.extends_window ?? false),
    display_time: displayTime,
    old_time: highWater,
    new_time: newTime,
    retain_until: Math.max(
      changedAt + CAL_PATCH_MIN_DAYS * dayMs,
      (highWater === null ? changedAt : (retentionTimeMs(highWater) ?? changedAt)) +
        CAL_PATCH_TAIL_DAYS * dayMs,
    ),
  };
}
