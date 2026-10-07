// P3-04 获准跨卡改动：发布版本判定和取值是 Worker/后续 ICS 共用的业务合同。
// 主方案 §3.3/§3.6、ENGINEERING §5.2；不得在发布器或快照器另写第二份判断。
import type { EventStatus, EventType, NodeType } from "./enums";
import type { TimeValue } from "./time";

export const PUBLISH_CHANGE_KIND = {
  CREATED: "created",
  CONTENT_UPDATED: "content_updated",
  SCHEDULE_UPDATED: "schedule_updated",
  STATUS_UPDATED: "status_updated",
  MANUAL_CORRECTED: "manual_corrected",
  RETRACTED: "retracted",
  ASSOCIATED: "associated",
} as const;
export type PublishChangeKind = (typeof PUBLISH_CHANGE_KIND)[keyof typeof PUBLISH_CHANGE_KIND];

export const PUBLISH_ACTOR_PATH = { RULE: "rule", MODEL: "model", MANUAL: "manual" } as const;
export type PublishActorPath = (typeof PUBLISH_ACTOR_PATH)[keyof typeof PUBLISH_ACTOR_PATH];

export const SNAPSHOT_REBUILD_TOPIC = "snapshot_rebuild";
// P4-01 获准跨卡改动：发布与通知发生项之间使用持久 outbox 信号，不以提交前取得的时间作游标。
export const NOTIFICATION_PUBLICATION_TOPIC = "notification_publication";
export const PUBLIC_SNAPSHOT_PENDING_STATE_KEY = "public_snapshot_pending";

/**
 * P3-05/06 消费的公共 ICS 输入：事件/节点标题 → SUMMARY，事件简介、原始表达、
 * 来源时区、时间依据 → DESCRIPTION（ADR-0031 起由 calendar-entry.ts 统一组装，URL 为本站活动详情页），
 * 类型 → CATEGORIES 与筛选，
 * 状态 → STATUS/可见性，时间精度和值 → DTSTART/DTEND，依据/状态/类型/节点类型 → VALARM 资格。
 * 人锁与证据只影响审核/追溯，不进入 ICS。
 */
export interface PublicEventFacts {
  readonly event_type: EventType;
  readonly status: EventStatus;
  readonly title: string;
  readonly summary: string | null;
  readonly official_url: string | null;
  readonly human_locked: boolean;
}

/** 完整 TimeValue 保留精度、原文和依据，日期不转成 UTC 午夜。 */
export interface PublicMilestoneFacts {
  readonly milestone_key: string;
  readonly node_type: NodeType;
  readonly title: string;
  readonly time: TimeValue;
  readonly human_locked: boolean;
}

export interface MilestoneChange {
  readonly changed: boolean;
  readonly schedule_changed: boolean;
  readonly public_ical_changed: boolean;
}

export interface EventChange {
  readonly event_revision: boolean;
  readonly schedule_revision: boolean;
  readonly milestones: Readonly<Record<string, MilestoneChange>>;
}

function sameTime(a: TimeValue, b: TimeValue): boolean {
  return (
    a.precision === b.precision &&
    (a.precision !== "datetime" || (b.precision === "datetime" && a.utc_ms === b.utc_ms)) &&
    (a.precision !== "date" || (b.precision === "date" && a.date === b.date)) &&
    a.time_basis === b.time_basis &&
    a.source_timezone === b.source_timezone &&
    a.raw_expression === b.raw_expression
  );
}

function sameClock(a: TimeValue, b: TimeValue): boolean {
  return (
    a.precision === b.precision &&
    (a.precision !== "datetime" || (b.precision === "datetime" && a.utc_ms === b.utc_ms)) &&
    (a.precision !== "date" || (b.precision === "date" && a.date === b.date))
  );
}

/** 改变 VALARM 资格；事件类型/节点类型改变也会改变规则匹配。 */
export function canUseExactAlarm(status: EventStatus, time: TimeValue): boolean {
  return (
    status !== "cancelled" &&
    status !== "retracted" &&
    time.precision === "datetime" &&
    (time.time_basis === "official_explicit" || time.time_basis === "deterministic_derived")
  );
}

/** 单一判定表：证据变动不取号，人锁仅取事件修订号。 */
export function classifyPublicationChange(
  before: PublicEventFacts | null,
  after: PublicEventFacts,
  previousNodes: readonly PublicMilestoneFacts[],
  nextNodes: readonly PublicMilestoneFacts[],
): EventChange {
  const eventPublicChanged =
    before === null ||
    before.event_type !== after.event_type ||
    before.status !== after.status ||
    before.title !== after.title ||
    before.summary !== after.summary ||
    before.official_url !== after.official_url;
  const eventLockChanged = before !== null && before.human_locked !== after.human_locked;
  const oldNodes = new Map(previousNodes.map((node) => [node.milestone_key, node]));
  const milestones: Record<string, MilestoneChange> = {};
  let anyNodeChanged = false;
  let scheduleChanged = before === null;
  for (const next of nextNodes) {
    const old = oldNodes.get(next.milestone_key);
    const changed =
      old === undefined ||
      old.node_type !== next.node_type ||
      old.title !== next.title ||
      !sameTime(old.time, next.time) ||
      old.human_locked !== next.human_locked;
    const reminderChanged =
      old === undefined ||
      before === null ||
      !sameClock(old.time, next.time) ||
      old.node_type !== next.node_type ||
      before.event_type !== after.event_type ||
      canUseExactAlarm(before.status, old.time) !== canUseExactAlarm(after.status, next.time);
    const publicChanged =
      old === undefined ||
      eventPublicChanged ||
      old.node_type !== next.node_type ||
      old.title !== next.title ||
      !sameTime(old.time, next.time);
    milestones[next.milestone_key] = {
      changed,
      schedule_changed: reminderChanged,
      public_ical_changed: publicChanged,
    };
    anyNodeChanged ||= changed;
    scheduleChanged ||= reminderChanged;
  }
  // 省略节点不等于官方取消，不隐式删除旧事实。
  return {
    event_revision: eventPublicChanged || eventLockChanged || anyNodeChanged,
    schedule_revision: scheduleChanged,
    milestones,
  };
}
