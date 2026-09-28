// P2-06 跨卡合同：Feed 版本只响应 CalendarProjectionSource 中影响 ICS 的语义（§5.4）。
// 关闭日历提醒时 rule_ids 不引入节点或 VALARM，因而不参与比较。
import type { CalendarProjectionSource } from "./calendar-nodes";

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/** 用户设置是否改变个人 ICS 的投影语义；P2 保存与 P3 日历组装共用。 */
export function changesCalendarView(
  before: CalendarProjectionSource,
  after: CalendarProjectionSource,
): boolean {
  return (
    !sameSet(before.scope.games, after.scope.games) ||
    !sameSet(before.scope.regions, after.scope.regions) ||
    !sameSet(before.calendar.event_types, after.calendar.event_types) ||
    !sameSet(before.calendar.node_types, after.calendar.node_types) ||
    before.calendar.alarms_enabled !== after.calendar.alarms_enabled ||
    (after.calendar.alarms_enabled &&
      !sameSet(before.notifications.rule_ids, after.notifications.rule_ids))
  );
}
