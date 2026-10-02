import {
  browseDate,
  type CalendarNodesResponse,
  type CalendarPreviewItem,
  explainCalendarPreview,
  FEED_DIAGNOSTICS,
  feedSourcesFresh,
  feedWindow,
  requiredCalendarSources,
  SUBSCRIPTION_EVENT_TYPE_LABELS,
  SUBSCRIPTION_GAME_LABELS,
  SUBSCRIPTION_NODE_TYPE_LABELS,
  SUBSCRIPTION_RULE_COPY,
  type TimeValue,
} from "@hoyo/contracts";
import type { Draft, Snapshot } from "../save/machine";
import { sampleNodes } from "./sample";

export type PreviewInput = {
  draft: Draft;
  snapshot: Snapshot | null;
  saved: boolean;
  identityGeneration: number;
};
export type PreviewState = {
  snapshot: CalendarNodesResponse | null;
  sampleAt: number | null;
  loading: boolean;
  progress: string;
  error: string | null;
};
const formatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export const timestampText = (ms: number) => formatter.format(ms);
function timeText(time: TimeValue): string {
  if (time.precision === "unknown") return "时间待定";
  if (time.precision === "date") return `${time.date} · 具体时刻未公布`;
  const estimated = time.time_basis === "official_estimate" || time.time_basis === "unresolved";
  return `${timestampText(time.utc_ms)}${estimated ? " · 预计／尚未确定" : ""}`;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
const rulesText = (ids: readonly string[]) =>
  ids
    .map((id) => SUBSCRIPTION_RULE_COPY.find((rule) => rule.rule_id === id)?.label ?? id)
    .join("、");
const patchLabels = {
  rescheduled: "改期",
  cancelled: "官方取消",
  retracted: "本站撤回",
  deleted: "节点删除",
  restored: "恢复安排",
  postponed_unknown: "延期待定",
  classification_corrected: "分类／归属更正",
} satisfies Record<NonNullable<CalendarPreviewItem["patch"]>["kind"], string>;
function renderItem(item: CalendarPreviewItem): HTMLElement {
  const row = element("li", "");
  row.dataset.milestone = item.milestoneId;
  row.className = `calendar-preview-item${item.patch || item.cancelled ? " is-correction" : ""}`;
  row.append(element("h4", `${item.eventTitle} · ${item.milestoneTitle}`));
  row.append(
    element(
      "p",
      `${SUBSCRIPTION_GAME_LABELS[item.game]} · ${SUBSCRIPTION_EVENT_TYPE_LABELS[item.eventType]} · ${SUBSCRIPTION_NODE_TYPE_LABELS[item.nodeType]} · ${timeText(item.time)}`,
    ),
  );
  if (item.inclusion.kind === "reminder_associated") {
    const hidden = item.inclusion.hiddenBy.map((by) =>
      by === "event_type" ? "事件类型已隐藏" : "节点类型已隐藏",
    );
    row.append(
      element(
        "p",
        `提醒关联节点：为「${rulesText(item.inclusion.ruleIds)}」保留；${hidden.join("、")}。`,
      ),
    );
  } else row.append(element("p", "基础显示节点"));
  if (item.patch) {
    row.append(element("p", `${patchLabels[item.patch.kind]}：${item.patch.factReason}`));
    if (item.patch.oldTime) row.append(element("p", `更正前：${timeText(item.patch.oldTime)}`));
    if (!item.inBaseWindow) row.append(element("p", "作为更正保留，不计入基础窗口条目。"));
  }
  if (item.cancelled) row.append(element("strong", "日历标记为已取消；不是即将发生的安排。"));
  if (item.alarm === null) row.append(element("p", "无闹钟：没有匹配的所选提醒规则。"));
  else {
    const reason =
      item.alarm.blocked === null
        ? null
        : {
            alarms_disabled: "日历提醒未开启",
            cancelled: "取消、撤回、删除或延期待定条目不设闹钟",
            date_only: "只有日期，不能生成精确闹钟",
            estimated: "预计或未确定时间，不能生成精确闹钟",
          }[item.alarm.blocked];
    row.append(
      element(
        "p",
        reason
          ? `无闹钟：${reason}；所选规则：${rulesText(item.alarm.ruleIds)}。`
          : `日历闹钟：${rulesText(item.alarm.ruleIds)}（提前 ${item.alarm.leadSeconds.join("、")} 秒）。`,
      ),
    );
  }
  return row;
}

export function renderPreview(
  root: HTMLElement,
  input: PreviewInput,
  state: PreviewState,
  retry: () => void,
) {
  const content = document.createDocumentFragment();
  const saved = input.saved && input.snapshot?.config;
  content.append(
    element(
      "p",
      saved ? `正在预览：已保存设置 · 版本 ${input.snapshot?.revision}` : "正在预览：未保存草稿",
    ),
  );
  const status = element("p", "");
  status.setAttribute("role", "status");
  const real = state.snapshot;
  const sample = state.sampleAt !== null;
  status.textContent = state.loading
    ? `不完整 · 正在更新公开数据 ${state.progress}`
    : state.error
      ? `不完整 · ${state.error}${sample ? "；以下是样例预览（合成），不代表真实日历。" : "；请重试，不能据此判断日历为空。"}`
      : "";
  content.append(status);
  if (!state.loading) {
    const button = element("button", "刷新预览数据");
    button.type = "button";
    button.className = "secondary-button";
    button.addEventListener("click", retry);
    content.append(button);
  }
  if (real || sample) {
    const asOf = real?.asOf ?? (state.sampleAt as number);
    const window = real?.window ?? feedWindow(asOf);
    const config = saved || input.draft;
    const result = explainCalendarPreview(config, real?.nodes ?? sampleNodes(asOf), asOf);
    const fresh =
      real !== null &&
      feedSourcesFresh(
        requiredCalendarSources(config, real.sources).map((s) => s.lastSuccessAt),
        asOf,
      );
    const diagnostic = result.nodeLimit ?? (real && !fresh ? "source_stale" : null);
    const complete = real !== null && !state.loading && !state.error && diagnostic === null;
    if (!state.loading && !state.error)
      status.textContent = complete
        ? "真实数据 · 完整（输出大小启用前再核对一次）"
        : `真实数据 · 不完整 · ${diagnostic ? FEED_DIAGNOSTICS[diagnostic] : "无法核验"}`;
    content.append(
      element(
        "p",
        `${sample ? "样例生成" : "数据"}时间：${timestampText(asOf)} · 北京时间 UTC+8${real ? ` · 发布代次 ${real.publication.generation}` : ""}`,
      ),
    );
    content.append(
      element(
        "p",
        `基础窗口：${timestampText(window.start)} 至 ${timestampText(window.end)}（不含结束时刻，北京时间 UTC+8）；更正条目可能延长窗口。`,
      ),
    );
    content.append(
      element(
        "p",
        `共 ${result.totals.items} 条 · 窗口内 ${result.totals.inBaseWindow} · 更正 ${result.totals.patches} · 提醒关联 ${result.totals.reminderAssociated} · 带闹钟 ${result.totals.withAlarm} · 已取消 ${result.totals.cancelled}`,
      ),
    );
    content.append(
      element(
        "p",
        `未进入日历：时间待定 ${result.omitted.unknownTime} 条；仅为提醒保留但没有精确时间 ${result.omitted.reminderNotExact} 条。这些节点不占日历条目数。`,
      ),
    );
    if (diagnostic && (state.loading || state.error))
      content.append(element("p", FEED_DIAGNOSTICS[diagnostic]));
    if (result.items.length === 0)
      content.append(
        element(
          "p",
          complete
            ? "真实数据中没有符合这份设置的日历条目。"
            : sample
              ? "样例中没有匹配条目，不能据此判断真实日历为空。"
              : "当前无法确认完整日历内容，请按诊断处理后重试。",
        ),
      );
    let day = "";
    let list: HTMLUListElement | undefined;
    for (const item of result.items) {
      const nextDay =
        item.time.precision === "date" ? item.time.date : browseDate(item.time.utc_ms);
      if (day !== nextDay) {
        day = nextDay;
        content.append(element("h3", day));
        list = document.createElement("ul");
        list.className = "calendar-preview-list";
        content.append(list);
      }
      list?.append(renderItem(item));
    }
  }
  content.append(
    element(
      "p",
      "此处为浏览器即时预览。启用前需核对服务端的已保存设置预览；未经验证的客户端不保证提醒可用；外部日历何时更新由客户端决定。",
    ),
  );
  root.replaceChildren(content);
}
