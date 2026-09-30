/** P3-14：真实公共读接口。所有时间沿用 TimeValue；null 表示事实未知。
 * ScheduleNode 的字段名保留；增加 eventId，noticePublishedAt 允许 unknown。
 * 不使用 synthetic ScheduleSnapshot；F1-06 应直接消费以下 schema。
 * GET events: range= today|3d|7d|30d|90d|all，games=逗号分隔游戏，cursor=不透明游标。
 * 分页按稳定节点身份；页面内排序交给前端。空页仍可能有 nextCursor。
 * 同代游标含 UTC+8 浏览日起点；换代返回 conflict，客户端清空后重载。
 * all 仅指服务端当前有限代次内今天起的节点，绝非无限历史查询。
 */
import { z } from "zod";
import {
  EventStatusSchema,
  EventTypeSchema,
  GameIdSchema,
  NodeTypeSchema,
  RegionIdSchema,
} from "./enums";
import { TimeValueSchema } from "./time";

const Timestamp = z.int();
export const PublicPublicationSchema = z.strictObject({
  generation: z.int().positive(),
  publishedAt: Timestamp,
});
export const PublicCacheSchema = z.strictObject({
  generatedAt: Timestamp,
  freshUntil: Timestamp,
  stale: z.boolean(),
});
export const PublicChangeSchema = z.strictObject({
  kind: z.enum([
    "rescheduled",
    "cancelled",
    "retracted",
    "pending",
    "deleted",
    "restored",
    "classification_corrected",
  ]),
  explanation: z.string(),
  /** 共享层保留的历史时间水位，可能早于最近一次改期，不是当前安排。 */
  historicalTime: TimeValueSchema.nullable(),
  currentTime: TimeValueSchema.nullable(),
  retainUntil: Timestamp,
  evidence: z.string(),
});
export const PublicScheduleNodeSchema = z.strictObject({
  id: z.string().min(1),
  eventId: z.string().min(1),
  title: z.string(),
  game: GameIdSchema,
  eventType: EventTypeSchema,
  nodeType: NodeTypeSchema,
  status: EventStatusSchema,
  time: TimeValueSchema,
  evidence: z.string(),
  noticePublishedAt: Timestamp.nullable(),
  change: PublicChangeSchema.nullable(),
});
export const PublicCatalogResponseSchema = z.strictObject({
  games: z.array(GameIdSchema),
  regions: z.array(RegionIdSchema),
  eventTypes: z.array(EventTypeSchema),
  nodeTypes: z.array(NodeTypeSchema),
  publication: PublicPublicationSchema.nullable(),
  cache: PublicCacheSchema,
});
export const PublicEventsResponseSchema = z.strictObject({
  publication: PublicPublicationSchema,
  cache: PublicCacheSchema,
  window: z.strictObject({ start: Timestamp, end: Timestamp.nullable() }),
  nodes: z.array(PublicScheduleNodeSchema),
  /** 只按游戏筛选，不随浏览日期隐藏；仅当前快照中仍在共享更正保留期的有限结果。 */
  recentChanges: z.array(PublicScheduleNodeSchema),
  recentChangesTruncated: z.boolean(),
  nextCursor: z.string().nullable(),
});
export const PublicOfficialEvidenceSchema = z.strictObject({
  url: z.url().nullable(),
  publisher: z.string().nullable(),
  publishedAt: Timestamp.nullable(),
  updatedAt: Timestamp.nullable(),
  /** 已发布事实的原始时间表述；不是完整公告 HTML 或抽取原文。按文本渲染。 */
  excerpts: z.array(z.string()),
});
export const PublicEventDetailResponseSchema = z.strictObject({
  publication: PublicPublicationSchema,
  cache: PublicCacheSchema,
  event: z.strictObject({
    id: z.string(),
    title: z.string(),
    game: GameIdSchema,
    eventType: EventTypeSchema,
    status: EventStatusSchema,
    /** 仅从实际存在的节点挑选；没有可确认的当前安排时为 null。 */
    importantNodeId: z.string().nullable(),
    milestones: z.array(PublicScheduleNodeSchema),
    changes: z.array(z.strictObject({ nodeId: z.string(), change: PublicChangeSchema })),
    official: PublicOfficialEvidenceSchema,
  }),
});
export const PublicSourceStatusSchema = z.strictObject({
  game: GameIdSchema,
  verifiedAt: Timestamp.nullable(),
  verificationState: z.enum(["verified", "unavailable", "unknown"]),
  degradationReasons: z.array(
    z.enum(["source_unavailable", "maintenance_required", "not_verified"]),
  ),
  reviewCount: z.int().nonnegative(),
});
export const PublicStatusResponseSchema = z.strictObject({
  registration_open: z.boolean(),
  mail_sending_available: z.boolean(),
  publication: PublicPublicationSchema.nullable(),
  cache: PublicCacheSchema,
  sources: z.array(PublicSourceStatusSchema),
  capabilities: z.strictObject({
    calendar: z.literal("unknown"),
    email_seats: z.literal("unknown"),
    routine_email: z.literal("unknown"),
    push: z.literal("unknown"),
  }),
  calendarClients: z.array(
    z.strictObject({
      client: z.enum(["apple_calendar_macos", "google_calendar", "outlook"]),
      support: z.enum(["verified", "unknown"]),
    }),
  ),
});
export type PublicPublication = z.infer<typeof PublicPublicationSchema>;
export type PublicCache = z.infer<typeof PublicCacheSchema>;
export type PublicScheduleNode = z.infer<typeof PublicScheduleNodeSchema>;
export type PublicEventsResponse = z.infer<typeof PublicEventsResponseSchema>;
export type PublicEventDetailResponse = z.infer<typeof PublicEventDetailResponseSchema>;
export type PublicStatusResponse = z.infer<typeof PublicStatusResponseSchema>;
