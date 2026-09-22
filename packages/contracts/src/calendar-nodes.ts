// 日历有效节点纯函数（主方案 §5.2；前端 v1.0 §6.5 预览遵守同一投影语义）。
//
// ```text
// 有效日历节点 = 基础可见节点 ∪ 当前提醒规则需要的节点（均受 scope 约束）
// ```
//
// - 公式整体以"日历提醒启用"为前提（§5.2 首句）；alarms_enabled=false 时只有基础可见节点
//   （前端 §6.3：关闭日历提醒只移除提醒引入的额外节点和闹钟，基础显示保留）。
// - 基础可见 = scope ∧ calendar.event_types ∧ calendar.node_types。
// - 提醒所需 = scope ∧ ∃所选规则 (event_type, node_type) 匹配。**不与 calendar.node_types、
//   calendar.event_types 相交**（AGENTS.md 第 3 节禁止清单：提醒资格不得与 node_types 隐式
//   相交）——被基础筛选隐藏但仍被规则选中的节点输出为"提醒关联节点"，标注引入它的规则 ID，
//   沿用同一 Milestone/UID，不另造重复事件。
// - 时间依据与第 6 章窗口合同（FEED_*_DAYS、VALARM 只对合法精确节点）约束的是后续投影
//   （P3-06），不在本函数职责内；调用方传入的候选节点应已按窗口裁剪。
import type { EventType, GameId, NodeType, RegionId } from "./enums";
import type { RuleId } from "./rules";
import { REMINDER_RULES } from "./rules";

/** 参与有效节点计算的候选节点最小维度（milestone 身份由调用方携带，用于同 UID 去重）。 */
export interface CalendarCandidateNode {
  readonly game: GameId;
  readonly region: RegionId;
  readonly event_type: EventType;
  readonly node_type: NodeType;
}

/** 计算有效节点所需的配置面（解析后的 SubscriptionConfig 结构上即满足）。 */
export interface CalendarProjectionSource {
  readonly scope: {
    readonly games: readonly GameId[];
    readonly regions: readonly RegionId[];
  };
  readonly calendar: {
    readonly event_types: readonly EventType[];
    readonly node_types: readonly NodeType[];
    readonly alarms_enabled: boolean;
  };
  readonly notifications: {
    readonly rule_ids: readonly string[];
  };
}

/** 有效节点的入选原因：基础可见，或提醒关联（附引入它的全部规则 ID）。 */
export type EffectiveCalendarReason =
  | { readonly kind: "base" }
  | { readonly kind: "reminder_associated"; readonly rule_ids: readonly RuleId[] };

export interface EffectiveCalendarNode<N extends CalendarCandidateNode> {
  readonly node: N;
  readonly reason: EffectiveCalendarReason;
}

function inScope(source: CalendarProjectionSource, node: CalendarCandidateNode): boolean {
  return source.scope.games.includes(node.game) && source.scope.regions.includes(node.region);
}

/** 引入该节点的所选规则（event_type 与 node_type 都匹配）。 */
function matchingRuleIds(source: CalendarProjectionSource, node: CalendarCandidateNode): RuleId[] {
  const selected = new Set(source.notifications.rule_ids);
  return REMINDER_RULES.filter(
    (rule) =>
      selected.has(rule.rule_id) &&
      rule.event_type === node.event_type &&
      rule.node_type === node.node_type,
  ).map((rule) => rule.rule_id);
}

/**
 * 计算有效日历节点。纯函数：输出保持候选输入的顺序；同一节点既是基础可见又被规则需要时
 * 只输出一次，原因记为 base（提醒关联标记只用于"被基础筛选隐藏"的节点）。
 */
export function effectiveCalendarNodes<N extends CalendarCandidateNode>(
  source: CalendarProjectionSource,
  candidates: readonly N[],
): readonly EffectiveCalendarNode<N>[] {
  const result: EffectiveCalendarNode<N>[] = [];
  for (const node of candidates) {
    if (!inScope(source, node)) {
      continue;
    }
    const baseVisible =
      source.calendar.event_types.includes(node.event_type) &&
      source.calendar.node_types.includes(node.node_type);
    if (baseVisible) {
      result.push({ node, reason: { kind: "base" } });
      continue;
    }
    if (source.calendar.alarms_enabled) {
      const rule_ids = matchingRuleIds(source, node);
      if (rule_ids.length > 0) {
        result.push({ node, reason: { kind: "reminder_associated", rule_ids } });
      }
    }
  }
  return result;
}
