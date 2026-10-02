/** P3-15 / D2. 2026-10-02 所有者裁定：额外保留非墓碑未知时间节点供 omitted 计数；不改变 Feed 投影。 */
import { z } from "zod";
import { type CalendarProjectionSource, effectiveCalendarNodes } from "./calendar-nodes";
import {
  EVENT_TYPES,
  EventStatusSchema,
  EventTypeSchema,
  GameIdSchema,
  NODE_TYPES,
  NodeTypeSchema,
  RegionIdSchema,
  SUPPORTED_SCOPE_GAMES,
  SUPPORTED_SCOPE_REGIONS,
} from "./enums";
import { feedNodeLimit, personalCalendarNodes } from "./personal-calendar";
import { PublicCacheSchema, PublicPublicationSchema } from "./public-api";
import {
  CALENDAR_PATCH_KIND,
  effectivePublicSnapshotNodes,
  type PublicSnapshotNode,
} from "./public-calendar";
import { RuleIdSchema } from "./rules";
import { browseDate } from "./schedule-browse";
import { SubscriptionConfigSchema } from "./subscription";
import { DateOnlyValueSchema, ExactTimeValueSchema, TimeValueSchema } from "./time";

export const CalendarPreviewConflictReasonSchema = z.literal("preview_outdated");
export type CalendarPreviewConflictReason = z.infer<typeof CalendarPreviewConflictReasonSchema>;
export const CalendarPreviewConfigSchema = SubscriptionConfigSchema.pick({
  scope: true,
  calendar: true,
}).extend({ notifications: SubscriptionConfigSchema.shape.notifications.pick({ rule_ids: true }) });
export type CalendarPreviewConfig = z.infer<typeof CalendarPreviewConfigSchema>;
const PatchSchema = z.strictObject({
  kind: z.enum(CALENDAR_PATCH_KIND),
  fact_reason: z.string(),
  extends_window: z.boolean(),
  display_time: TimeValueSchema,
  old_time: TimeValueSchema.nullable(),
  new_time: TimeValueSchema.nullable(),
  retain_until: z.int(),
});
/** 白名单：不传内部原始投影、修订水位、锁或个人 UID。 */
export const CalendarPreviewNodeSchema = z.strictObject({
  game: GameIdSchema,
  region: RegionIdSchema,
  projection: z.strictObject({
    event_id: z.string().min(1),
    milestone_id: z.string().min(1),
    event: z.strictObject({
      event_type: EventTypeSchema,
      status: EventStatusSchema,
      title: z.string(),
      summary: z.string().nullable(),
      official_url: z.string().nullable(),
    }),
    milestone: z.strictObject({
      milestone_key: z.string(),
      node_type: NodeTypeSchema,
      title: z.string(),
      time: TimeValueSchema,
    }),
  }),
  patch: PatchSchema.nullable(),
  tombstone: z.boolean(),
});
export type CalendarPreviewNode = z.infer<typeof CalendarPreviewNodeSchema>;
export const CalendarPreviewSourceSchema = z.strictObject({
  sourceId: z.string(),
  game: GameIdSchema,
  region: z.string(),
  lastSuccessAt: z.int().nullable(),
});
export type CalendarPreviewSource = z.infer<typeof CalendarPreviewSourceSchema>;
export const CalendarPreviewItemSchema = z.strictObject({
  milestoneId: z.string(),
  eventId: z.string(),
  game: GameIdSchema,
  region: RegionIdSchema,
  eventType: EventTypeSchema,
  nodeType: NodeTypeSchema,
  eventTitle: z.string(),
  milestoneTitle: z.string(),
  time: z.union([ExactTimeValueSchema, DateOnlyValueSchema]),
  status: EventStatusSchema,
  cancelled: z.boolean(),
  inBaseWindow: z.boolean(),
  inclusion: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("base") }),
    z.strictObject({
      kind: z.literal("reminder_associated"),
      ruleIds: z.array(RuleIdSchema),
      hiddenBy: z.array(z.enum(["event_type", "node_type"])),
    }),
  ]),
  patch: z
    .strictObject({
      kind: z.enum(CALENDAR_PATCH_KIND),
      factReason: z.string(),
      oldTime: TimeValueSchema.nullable(),
      retainUntil: z.int(),
    })
    .nullable(),
  alarm: z
    .strictObject({
      ruleIds: z.array(RuleIdSchema),
      leadSeconds: z.array(z.int().nonnegative()),
      blocked: z.enum(["alarms_disabled", "cancelled", "date_only", "estimated"]).nullable(),
    })
    .nullable(),
});
export type CalendarPreviewItem = z.infer<typeof CalendarPreviewItemSchema>;
export const CalendarPreviewTotalsSchema = z.strictObject({
  items: z.int().nonnegative(),
  inBaseWindow: z.int().nonnegative(),
  patches: z.int().nonnegative(),
  reminderAssociated: z.int().nonnegative(),
  withAlarm: z.int().nonnegative(),
  cancelled: z.int().nonnegative(),
});
export const CalendarPreviewOmittedSchema = z.strictObject({
  unknownTime: z.int().nonnegative(),
  reminderNotExact: z.int().nonnegative(),
});
const WindowSchema = z.strictObject({ start: z.int(), end: z.int() });
export const CalendarNodesResponseSchema = z.strictObject({
  publication: PublicPublicationSchema,
  asOf: z.int(),
  window: WindowSchema,
  cache: PublicCacheSchema,
  sources: z.array(CalendarPreviewSourceSchema),
  totals: z.strictObject({ nodes: z.int().nonnegative() }),
  nodes: z.array(CalendarPreviewNodeSchema),
  nextCursor: z.string().nullable(),
});
export type CalendarNodesResponse = z.infer<typeof CalendarNodesResponseSchema>;
const PreviewResponseBase = z.strictObject({
  server_time: z.int(),
  subscription: z.strictObject({ revision: z.int().positive() }),
  config: CalendarPreviewConfigSchema,
  publication: PublicPublicationSchema,
  asOf: z.int(),
  window: WindowSchema,
  sources: z.strictObject({ fresh: z.boolean(), verifiedAt: z.int().nullable() }),
  totals: CalendarPreviewTotalsSchema,
  omitted: CalendarPreviewOmittedSchema,
  items: z.array(CalendarPreviewItemSchema),
  nextCursor: z.string().nullable(),
});
export const CalendarPreviewResponseSchema = z.discriminatedUnion("outcome", [
  PreviewResponseBase.extend({ outcome: z.literal("ok") }),
  PreviewResponseBase.extend({
    outcome: z.literal("blocked"),
    diagnostic: z.enum([
      "base_node_limit",
      "patch_node_limit",
      "response_byte_limit",
      "source_stale",
    ]),
  }),
]);
export type CalendarPreviewResponse = z.infer<typeof CalendarPreviewResponseSchema>;

const ALL: CalendarProjectionSource = {
  scope: { games: SUPPORTED_SCOPE_GAMES, regions: SUPPORTED_SCOPE_REGIONS },
  calendar: { event_types: EVENT_TYPES, node_types: NODE_TYPES, alarms_enabled: true },
  notifications: { rule_ids: [] },
};
/** 私有字段不参与投影；仅适配已有函数所需类型，不创造事实。 */
function snapshotNodes(nodes: readonly CalendarPreviewNode[]): PublicSnapshotNode[] {
  return nodes.map((n) => ({
    ...n,
    public_ical_revision: 0,
    source_projection_json: null,
    projection: {
      ...n.projection,
      event: { ...n.projection.event, human_locked: false },
      milestone: { ...n.projection.milestone, human_locked: false },
    },
  }));
}
function unknownForExplanation(node: PublicSnapshotNode, asOf: number): boolean {
  // 此处仅识别新增的未知时间解释集合。有效更正的已知展示时间仍交原投影处理。
  return (
    !node.tombstone &&
    (node.patch !== null && node.patch.retain_until > asOf
      ? node.patch.display_time
      : node.projection.milestone.time
    ).precision === "unknown"
  );
}
export function calendarPreviewNode(node: CalendarPreviewNode): CalendarPreviewNode {
  const p = node.projection;
  return CalendarPreviewNodeSchema.parse({
    game: node.game,
    region: node.region,
    tombstone: node.tombstone,
    patch: node.patch,
    projection: {
      event_id: p.event_id,
      milestone_id: p.milestone_id,
      event: {
        event_type: p.event.event_type,
        status: p.event.status,
        title: p.event.title,
        summary: p.event.summary,
        official_url: p.event.official_url,
      },
      milestone: {
        milestone_key: p.milestone.milestone_key,
        node_type: p.milestone.node_type,
        title: p.milestone.title,
        time: p.milestone.time,
      },
    },
  });
}
/** 全选实际投影 + 所有者批准的未知时间解释补集；去重沿用已有函数。 */
export function calendarPreviewCandidates(
  nodes: readonly CalendarPreviewNode[],
  asOf: number,
): CalendarPreviewNode[] {
  const snapshot = snapshotNodes(nodes);
  const emitted = new Set(
    personalCalendarNodes(ALL, snapshot, asOf).map((n) => n.node.projection.milestone_id),
  );
  return effectivePublicSnapshotNodes(ALL, snapshot)
    .filter(
      ({ node }) => emitted.has(node.projection.milestone_id) || unknownForExplanation(node, asOf),
    )
    .map(({ node }) => calendarPreviewNode(node))
    .sort((a, b) => a.projection.milestone_id.localeCompare(b.projection.milestone_id));
}
export function compareCalendarPreviewItems(
  a: CalendarPreviewItem,
  b: CalendarPreviewItem,
): number {
  const date = (n: CalendarPreviewItem) =>
    n.time.precision === "date" ? n.time.date : browseDate(n.time.utc_ms);
  return (
    date(a).localeCompare(date(b)) ||
    (a.time.precision === "date" ? 1 : 0) - (b.time.precision === "date" ? 1 : 0) ||
    (a.time.precision === "datetime" && b.time.precision === "datetime"
      ? a.time.utc_ms - b.time.utc_ms
      : 0) ||
    a.milestoneId.localeCompare(b.milestoneId)
  );
}
export function explainCalendarPreview(
  config: CalendarProjectionSource,
  nodes: readonly CalendarPreviewNode[],
  asOf: number,
) {
  const snapshot = snapshotNodes(nodes);
  const projected = personalCalendarNodes(config, snapshot, asOf);
  const reasons = effectivePublicSnapshotNodes(config, snapshot);
  const reasonById = new Map(reasons.map((n) => [n.node.projection.milestone_id, n.reason]));
  const allProjected = new Set(
    personalCalendarNodes(ALL, snapshot, asOf).map((n) => n.node.projection.milestone_id),
  );
  const selected = new Set(projected.map((n) => n.node.projection.milestone_id));
  const omitted = {
    unknownTime: reasons.filter(({ node }) => unknownForExplanation(node, asOf)).length,
    reminderNotExact: reasons.filter(
      ({ node, reason }) =>
        reason.kind === "reminder_associated" &&
        allProjected.has(node.projection.milestone_id) &&
        !selected.has(node.projection.milestone_id),
    ).length,
  };
  const items: CalendarPreviewItem[] = projected
    .map((item): CalendarPreviewItem => {
      const n = item.node,
        p = n.projection;
      const reason = reasonById.get(p.milestone_id);
      if (!reason) throw new Error("preview_projection_reason_missing");
      const matching = effectiveCalendarNodes(
        { ...config, calendar: { event_types: [], node_types: [], alarms_enabled: true } },
        [
          {
            game: n.game,
            region: n.region,
            event_type: p.event.event_type,
            node_type: p.milestone.node_type,
          },
        ],
      )[0]?.reason;
      const ruleIds = matching?.kind === "reminder_associated" ? [...matching.rule_ids] : [];
      const hiddenBy: ("event_type" | "node_type")[] = [];
      if (!config.calendar.event_types.includes(p.event.event_type)) hiddenBy.push("event_type");
      if (!config.calendar.node_types.includes(p.milestone.node_type)) hiddenBy.push("node_type");
      return {
        milestoneId: p.milestone_id,
        eventId: p.event_id,
        game: n.game,
        region: n.region,
        eventType: p.event.event_type,
        nodeType: p.milestone.node_type,
        eventTitle: p.event.title,
        milestoneTitle: p.milestone.title,
        time: item.time,
        status: p.event.status,
        cancelled: item.cancelled,
        inBaseWindow: item.base,
        inclusion:
          reason.kind === "base"
            ? { kind: "base" }
            : { kind: "reminder_associated", ruleIds: [...reason.rule_ids], hiddenBy },
        patch:
          item.patch && n.patch
            ? {
                kind: n.patch.kind,
                factReason: n.patch.fact_reason,
                oldTime: n.patch.old_time,
                retainUntil: n.patch.retain_until,
              }
            : null,
        alarm:
          ruleIds.length === 0
            ? null
            : {
                ruleIds,
                leadSeconds: [...item.alarm_seconds],
                blocked: !config.calendar.alarms_enabled
                  ? "alarms_disabled"
                  : item.cancelled
                    ? "cancelled"
                    : item.time.precision === "date"
                      ? "date_only"
                      : item.alarm_seconds.length === 0
                        ? "estimated"
                        : null,
              },
      };
    })
    .sort(compareCalendarPreviewItems);
  return {
    items,
    omitted,
    totals: {
      items: items.length,
      inBaseWindow: projected.filter((n) => n.base).length,
      patches: projected.filter((n) => n.patch).length,
      reminderAssociated: items.filter((n) => n.inclusion.kind === "reminder_associated").length,
      withAlarm: items.filter((n) => (n.alarm?.leadSeconds.length ?? 0) > 0).length,
      cancelled: items.filter((n) => n.cancelled).length,
    },
    nodeLimit: feedNodeLimit(projected),
  };
}

/** 仅分页定位；不携带个人身份或设置。 */
export const CalendarPreviewCursorSchema = z.strictObject({
  generation: z.int().positive(),
  asOf: z.int(),
  offset: z.int().nonnegative(),
  revision: z.int().positive().optional(),
});
export type CalendarPreviewCursor = z.infer<typeof CalendarPreviewCursorSchema>;
