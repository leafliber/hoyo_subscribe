// P3-06 获准跨卡：个人窗口、提醒投影、缩水证据只在 contracts 定义（§5.2、§6.3—6.6）。
import type { CalendarProjectionSource } from "./calendar-nodes";
import {
  FEED_BASE_NODE_MAX,
  FEED_FUTURE_DAYS,
  FEED_MAX_STALE,
  FEED_PAST_DAYS,
  FEED_PATCH_NODE_MAX,
  FEED_SHRINK_GUARD_MIN,
  FEED_SHRINK_GUARD_RATIO,
} from "./params/registry";
import { effectivePublicSnapshotNodes, type PublicSnapshotNode } from "./public-calendar";
import { REMINDER_RULES } from "./rules";
import type { TimeValue } from "./time";

const DAY_MS = 86_400_000;
export type CalendarTime = Exclude<TimeValue, { precision: "unknown" }>;
export interface PersonalCalendarNode {
  readonly node: PublicSnapshotNode;
  readonly time: CalendarTime;
  readonly cancelled: boolean;
  readonly alarm_seconds: readonly number[];
  readonly base: boolean;
  readonly patch: boolean;
}
export function feedWindow(now: number): { start: number; end: number } {
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  return { start: day - FEED_PAST_DAYS * DAY_MS, end: day + (FEED_FUTURE_DAYS + 1) * DAY_MS };
}
export function inFeedWindow(time: TimeValue, now: number): boolean {
  const window = feedWindow(now);
  if (time.precision === "unknown") return false;
  // 日期仅比较保存的日期，不把其作为精确 DTSTART 或本地午夜。
  if (time.precision === "date")
    return (
      time.date >= new Date(window.start).toISOString().slice(0, 10) &&
      time.date < new Date(window.end).toISOString().slice(0, 10)
    );
  return time.utc_ms >= window.start && time.utc_ms < window.end;
}
function exactAlarmTime(time: TimeValue): boolean {
  return (
    time.precision === "datetime" &&
    (time.time_basis === "official_explicit" || time.time_basis === "deterministic_derived")
  );
}
export function personalCalendarNodes(
  config: CalendarProjectionSource,
  nodes: readonly PublicSnapshotNode[],
  now: number,
): readonly PersonalCalendarNode[] {
  const result: PersonalCalendarNode[] = [];
  for (const { node, reason } of effectivePublicSnapshotNodes(config, nodes)) {
    const patch = node.patch !== null && node.patch.retain_until > now ? node.patch : null;
    if (node.tombstone && patch === null) continue;
    const cancelled =
      node.tombstone ||
      node.projection.event.status === "cancelled" ||
      node.projection.event.status === "retracted" ||
      patch?.kind === "postponed_unknown";
    const time = patch?.display_time ?? node.projection.milestone.time;
    if (time.precision === "unknown") continue;
    if (reason.kind === "reminder_associated" && !exactAlarmTime(time)) continue;
    const base = !node.tombstone && inFeedWindow(time, now);
    const extendsWindow = patch?.extends_window === true;
    if (!base && !extendsWindow) continue;
    const alarm_seconds =
      config.calendar.alarms_enabled && !cancelled && exactAlarmTime(time)
        ? [
            ...new Set(
              REMINDER_RULES.filter(
                (rule) =>
                  config.notifications.rule_ids.includes(rule.rule_id) &&
                  rule.event_type === node.projection.event.event_type &&
                  rule.node_type === node.projection.milestone.node_type,
              ).map((rule) => rule.lead_time_seconds),
            ),
          ].sort((a, b) => a - b)
        : [];
    result.push({ node, time, cancelled, alarm_seconds, base, patch: patch !== null });
  }
  return result.sort((a, b) =>
    a.node.projection.milestone_id.localeCompare(b.node.projection.milestone_id),
  );
}
/** 成功输出的自然退出上界；只保存整集合的一个派生时刻，不保存私人节点集合。 */
export function feedNaturalExitAt(nodes: readonly PersonalCalendarNode[], now: number): number {
  const windowExit = (time: TimeValue): number => {
    if (time.precision === "unknown") return now;
    const timestamp =
      time.precision === "date" ? Date.parse(`${time.date}T00:00:00Z`) : time.utc_ms;
    return (Math.floor(timestamp / DAY_MS) + FEED_PAST_DAYS + 1) * DAY_MS;
  };
  let exit = now;
  for (const item of nodes) {
    // 补偿结束后会恢复事实时间；即使中间暂时缺席，也覆盖其未来自然重新进入。
    exit = Math.max(
      exit,
      windowExit(item.time),
      item.node.tombstone ? now : windowExit(item.node.projection.milestone.time),
      item.node.patch?.retain_until ?? now,
    );
  }
  if (!Number.isSafeInteger(exit)) throw new Error("invalid_feed_natural_exit");
  return exit;
}
export function feedNodeLimit(
  nodes: readonly PersonalCalendarNode[],
): "base_node_limit" | "patch_node_limit" | null {
  if (nodes.filter((node) => node.base).length > FEED_BASE_NODE_MAX) return "base_node_limit";
  if (nodes.filter((node) => node.patch).length > FEED_PATCH_NODE_MAX) return "patch_node_limit";
  return null;
}
export function feedIdentity(
  namespace: string,
  milestoneId: string,
  publicRevision: number,
  viewRevision: number,
): { uid: string; sequence: number } {
  const sequence = publicRevision + viewRevision;
  if (
    ![publicRevision, viewRevision, sequence].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    sequence >= 2 ** 31 - 1
  )
    throw new Error("feed_sequence_migration_required");
  return {
    uid: `${encodeURIComponent(namespace)}.${encodeURIComponent(milestoneId)}@hoyo.calendar`,
    sequence,
  };
}
export function feedSourcesFresh(watermarks: readonly (number | null)[], now: number): boolean {
  return (
    watermarks.length > 0 &&
    watermarks.every(
      (value) =>
        value !== null &&
        Number.isSafeInteger(value) &&
        value <= now &&
        now - value <= FEED_MAX_STALE * 1000,
    )
  );
}
export interface FeedBaseline {
  readonly count: number | null;
  readonly view_revision: number | null;
  readonly generation: number | null;
  readonly served_at: number | null;
  readonly natural_exit_at?: number | null;
}
/** 小日历指上次成功的集合；10→0 不能被误当“小日历”而放过。 */
export function feedNeedsShrinkEvidence(
  baseline: FeedBaseline,
  count: number,
  viewRevision: number,
): boolean {
  return (
    baseline.count !== null &&
    baseline.count >= FEED_SHRINK_GUARD_MIN &&
    baseline.view_revision === viewRevision &&
    (baseline.count - count) / baseline.count > FEED_SHRINK_GUARD_RATIO
  );
}
/** 只接受逐缺席项证据；代次递增、无关取消、只有部分可解释的收缩都不是通行证。 */
export function feedShrinkBlocked(input: {
  baseline: FeedBaseline;
  view_revision: number;
  config: CalendarProjectionSource;
  current: readonly PublicSnapshotNode[];
  previous: readonly PublicSnapshotNode[] | null;
  now: number;
}): boolean {
  const after = personalCalendarNodes(input.config, input.current, input.now);
  if (!feedNeedsShrinkEvidence(input.baseline, after.length, input.view_revision)) return false;
  if (input.baseline.served_at === null) return true;
  // 只用仍存在且无公共修订的节点按基线时刻重算；不假定模板永久保留历史。
  const evidence =
    input.previous ??
    input.current.filter((node) => {
      const changedAt = (node as PublicSnapshotNode & { public_changed_at?: number })
        .public_changed_at;
      return (
        changedAt !== undefined &&
        Number.isSafeInteger(changedAt) &&
        changedAt <= (input.baseline.served_at as number)
      );
    });
  const before = personalCalendarNodes(input.config, evidence, input.baseline.served_at);
  if (input.baseline.count === null || before.length > input.baseline.count) return true;
  const afterIds = new Set(after.map((item) => item.node.projection.milestone_id));
  const currentById = new Map(input.current.map((node) => [node.projection.milestone_id, node]));
  const unexplainedKnown = before.some((item) => {
    const id = item.node.projection.milestone_id;
    if (afterIds.has(id)) return false;
    // 原节点自然移出窗口或已到更正保留期；不是官方取消。
    if (personalCalendarNodes(input.config, [item.node], input.now).length === 0) return false;
    const current = currentById.get(id);
    // 当前分类/归属纠正后不再符合当前筛选，有明确公共更正证据。
    if (
      current?.patch?.kind === "classification_corrected" &&
      current.public_ical_revision > item.node.public_ical_revision &&
      personalCalendarNodes(input.config, [current], input.now).length === 0
    )
      return false;
    return true;
  });
  // 可重建的缺席项仍逐项核验，不能用标量盖过已有的反证。
  if (unexplainedKnown) return true;
  const missing = input.baseline.count - before.length;
  if (missing <= FEED_SHRINK_GUARD_RATIO * input.baseline.count) return false;
  // 只对不可重建部分使用成功时保存的上界；旧行/无值继续保守。
  const exit = input.baseline.natural_exit_at;
  return !(
    exit !== null &&
    exit !== undefined &&
    Number.isSafeInteger(exit) &&
    exit >= input.baseline.served_at &&
    input.now >= exit
  );
}
export const FEED_DIAGNOSTICS = {
  shrink_guard: "本次输出未通过完整性检查，已暂停更新以保护你现有的日历内容。",
  base_node_limit: "日历基础节点超过上限，请在订阅设置中缩小范围。",
  patch_node_limit: "日历更正节点超过上限，请在订阅设置中缩小范围。",
  response_byte_limit: "日历内容超过大小上限，请在订阅设置中缩小范围。",
  source_stale: "所需来源的成功核验水位已过期，暂时无法更新日历。",
  snapshot_unavailable: "当前完整公共代次不可用，请稍后重试。",
  changed_during_read: "日历状态在读取期间变化，请稍后重试。",
  sequence_migration: "日历版本需要迁移，暂时无法更新。",
} as const;
export type FeedDiagnostic = keyof typeof FEED_DIAGNOSTICS;

/** D2：来源规则从 Feed 原样移入；区服沿用旧实现的小写比较。 */
export function requiredCalendarSources<
  T extends {
    sourceId: string;
    game: string;
    region: string;
    contentChannelDisabled?: boolean;
  },
>(config: Pick<CalendarProjectionSource, "scope">, sources: readonly T[]): T[] {
  return sources.filter(
    (entry) =>
      !entry.contentChannelDisabled &&
      config.scope.games.some((game) => game === entry.game) &&
      config.scope.regions.some((region) => region.toLowerCase() === entry.region),
  );
}
