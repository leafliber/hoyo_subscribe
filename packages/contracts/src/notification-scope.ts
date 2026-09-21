// 变更通知范围纯函数（主方案 §5.3；CONTRACTS_BASELINE.md §4）。
//
// ```text
// 变更通知范围 = scope ∩ ( calendar.event_types ∪ rule_ids 所涉及的事件类型 )
// ```
//
// - 取并集：日历里看得见的事件出了变化该被告知；只选了提醒规则、没把类型放进日历
//   显示的用户也不该漏掉取消。
// - **不与 calendar.node_types 相交**（AGENTS.md 第 3 节禁止清单："隐式三重筛选"）。
//   日历基础可见性参与范围计算（通过 event_types），但不决定是否发送。
// - rule_ids 为空是合法输入：此时范围 = scope ∩ calendar.event_types。
// - uninitialized 订阅（空 scope）自然得到空范围，不参与任何通知匹配（§4.4），
//   由本函数的集合语义直接保证，不需要调用方另加判断。
import type { EventType, GameId, RegionId } from "./enums";
import { ruleEventTypes } from "./rules";

/** 计算变更通知范围所需的配置面（解析后的 SubscriptionConfig 结构上即满足）。 */
export interface ChangeNotificationScopeSource {
  readonly scope: {
    readonly games: readonly GameId[];
    readonly regions: readonly RegionId[];
  };
  readonly calendar: {
    readonly event_types: readonly EventType[];
  };
  readonly notifications: {
    readonly rule_ids: readonly string[];
  };
}

/** 已解析的变更通知范围：游戏、区域、事件类型三个维度的集合。 */
export interface ResolvedChangeNotificationScope {
  readonly games: ReadonlySet<GameId>;
  readonly regions: ReadonlySet<RegionId>;
  readonly event_types: ReadonlySet<EventType>;
}

/** 求解变更通知范围。纯函数，Worker（调度）与 Web（预览说明）共用同一份。 */
export function changeNotificationScope(
  source: ChangeNotificationScopeSource,
): ResolvedChangeNotificationScope {
  const eventTypes = new Set<EventType>(source.calendar.event_types);
  for (const type of ruleEventTypes(source.notifications.rule_ids)) {
    eventTypes.add(type);
  }
  return {
    games: new Set(source.scope.games),
    regions: new Set(source.scope.regions),
    event_types: eventTypes,
  };
}

/** 待判定的候选事件在订阅范围内的最小维度。 */
export interface ScopeMatchableEvent {
  readonly game: GameId;
  readonly region: RegionId;
  readonly event_type: EventType;
}

/** 一个事件是否落在变更通知范围内（游戏与区域受 scope 限制，类型受并集限制）。 */
export function isWithinChangeNotificationScope(
  scope: ResolvedChangeNotificationScope,
  event: ScopeMatchableEvent,
): boolean {
  return (
    scope.games.has(event.game) &&
    scope.regions.has(event.region) &&
    scope.event_types.has(event.event_type)
  );
}
