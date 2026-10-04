import {
  browseDate,
  type CalendarNodesResponse,
  type CalendarPreviewItem,
  explainCalendarPreview,
  FEED_DIAGNOSTICS,
  feedSourcesFresh,
  feedWindow,
  requiredCalendarSources,
  SUBSCRIPTION_GAME_LABELS,
  SUBSCRIPTION_RULE_COPY,
  type TimeValue,
} from "@hoyo/contracts";
import { badge, el, icon } from "../../../lib/dom";
import { clock, dateOnlyLabel, dateTime } from "../../../lib/format";
import { gameIcon } from "../../../lib/game-icons";
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

function timeLabel(time: TimeValue): string {
  if (time.precision === "unknown") return "待定";
  if (time.precision === "date") return "全天";
  const estimated = time.time_basis === "official_estimate" || time.time_basis === "unresolved";
  return `${estimated ? "约 " : ""}${clock(time.utc_ms)}`;
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
  classification_corrected: "分类更正",
} satisfies Record<NonNullable<CalendarPreviewItem["patch"]>["kind"], string>;
const blockedReasons = {
  alarms_disabled: "日历提醒未开启",
  cancelled: "已取消或延期的条目不设闹钟",
  date_only: "只有日期，无法精确提醒",
  estimated: "预计时间，无法精确提醒",
} as const;

function renderItem(item: CalendarPreviewItem): HTMLElement {
  const correction = Boolean(item.patch || item.cancelled);
  const row = el(
    "li",
    {
      class: `preview-item${correction ? " is-correction" : ""}`,
      "data-milestone": item.milestoneId,
    },
    el("span", { class: "preview-time" }, timeLabel(item.time)),
  );
  const tags: HTMLElement[] = [];
  if (item.inclusion.kind === "reminder_associated") {
    const tag = badge("提醒关联", "accent");
    tag.title = `为「${rulesText(item.inclusion.ruleIds)}」保留`;
    tags.push(tag);
  }
  if (item.patch) tags.push(badge(patchLabels[item.patch.kind], "warning"));
  if (item.cancelled) tags.push(badge("已取消", "danger"));
  let alarmNote: string;
  if (item.alarm === null) alarmNote = "无闹钟：没有匹配的提醒规则";
  else if (item.alarm.blocked)
    alarmNote = `无闹钟：${blockedReasons[item.alarm.blocked]}（${rulesText(item.alarm.ruleIds)}）`;
  else alarmNote = `日历闹钟：${rulesText(item.alarm.ruleIds)}`;
  const hasAlarm = item.alarm !== null && !item.alarm.blocked;
  row.append(
    el(
      "div",
      { class: "preview-main" },
      el("p", { class: "preview-title" }, `${item.eventTitle} · ${item.milestoneTitle}`),
      el(
        "p",
        { class: "preview-meta" },
        el(
          "span",
          { class: "game-tag", "data-game": item.game },
          gameIcon(item.game),
          SUBSCRIPTION_GAME_LABELS[item.game],
        ),
        ...tags,
      ),
      item.inclusion.kind === "reminder_associated"
        ? el(
            "p",
            { class: "preview-note" },
            `提醒关联节点：为「${rulesText(item.inclusion.ruleIds)}」保留；${item.inclusion.hiddenBy
              .map((by) => (by === "event_type" ? "事件类型已隐藏" : "节点类型已隐藏"))
              .join("、")}。`,
          )
        : null,
      item.patch
        ? el(
            "p",
            { class: "preview-note" },
            `${patchLabels[item.patch.kind]}：${item.patch.factReason}${item.patch.oldTime && item.patch.oldTime.precision === "datetime" ? `（原 ${dateTime(item.patch.oldTime.utc_ms)}）` : ""}`,
          )
        : null,
      el("p", { class: "sr-only" }, alarmNote),
    ),
    el(
      "span",
      {
        class: `preview-alarm${hasAlarm ? " is-on" : ""}`,
        title: alarmNote,
      },
      hasAlarm ? icon("bell") : null,
    ),
  );
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
  const head = el(
    "div",
    { class: "preview-head" },
    badge(
      saved ? `已保存设置 · 第 ${input.snapshot?.revision} 版` : "未保存草稿",
      saved ? "success" : "warning",
    ),
  );
  content.append(head);
  const status = el("p", { class: "preview-status", role: "status" });
  const real = state.snapshot;
  const sample = state.sampleAt !== null;
  status.textContent = state.loading
    ? `正在读取公开数据… ${state.progress}`
    : state.error
      ? `${state.error}${sample ? "；下面是样例预览（合成数据），不代表真实日历。" : "；请重试，不能据此判断日历为空。"}`
      : "";
  content.append(status);
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
        ? "基于最新公开数据"
        : `数据不完整：${diagnostic ? FEED_DIAGNOSTICS[diagnostic] : "无法核验"}`;
    head.append(
      badge(
        sample ? "样例" : complete ? "真实数据 · 完整" : "真实数据 · 不完整",
        sample ? "neutral" : complete ? "accent" : "warning",
      ),
    );
    content.append(
      el(
        "div",
        { class: "preview-stats" },
        el(
          "div",
          { class: "stat" },
          el("strong", {}, String(result.totals.items)),
          el("span", {}, "个日程"),
        ),
        el(
          "div",
          { class: "stat" },
          el("strong", {}, String(result.totals.withAlarm)),
          el("span", {}, "个带提醒"),
        ),
        el(
          "div",
          { class: "stat" },
          el(
            "strong",
            {},
            String(result.items.filter((item) => item.patch || item.cancelled).length),
          ),
          el("span", {}, "个更正"),
        ),
      ),
      el(
        "p",
        { class: "preview-window" },
        `${sample ? "样例生成" : "数据"}时间 ${timestampText(asOf)}${real ? ` · 发布代次 ${real.publication.generation}` : ""}。包含 ${timestampText(window.start)} 至 ${timestampText(window.end)} 的活动（不含结束时刻，更正条目可能超出）。`,
      ),
      el(
        "p",
        { class: "sr-only" },
        `共 ${result.totals.items} 条 · 窗口内 ${result.totals.inBaseWindow} · 更正 ${result.totals.patches} · 提醒关联 ${result.totals.reminderAssociated} · 带闹钟 ${result.totals.withAlarm} · 已取消 ${result.totals.cancelled}`,
      ),
    );
    if (diagnostic && (state.loading || state.error))
      content.append(el("p", { class: "callout callout--warning" }, FEED_DIAGNOSTICS[diagnostic]));
    if (result.items.length === 0)
      content.append(
        el(
          "p",
          { class: "preview-empty" },
          complete
            ? "真实数据中没有符合这份设置的日历条目。"
            : sample
              ? "样例中没有匹配条目，不能据此判断真实日历为空。"
              : "当前无法确认完整日历内容，请按诊断处理后重试。",
        ),
      );
    const list = el("div", { class: "preview-list" });
    let day = "";
    let group: HTMLUListElement | undefined;
    for (const item of result.items) {
      const nextDay =
        item.time.precision === "date" ? item.time.date : browseDate(item.time.utc_ms);
      if (day !== nextDay) {
        day = nextDay;
        list.append(el("h3", { class: "preview-day" }, dateOnlyLabel(day)));
        group = el("ul", { class: "preview-items" });
        list.append(group);
      }
      group?.append(renderItem(item));
    }
    if (result.items.length) content.append(list);
    if (result.omitted.unknownTime || result.omitted.reminderNotExact)
      content.append(
        el(
          "p",
          { class: "preview-omitted" },
          `未进入日历：时间待定 ${result.omitted.unknownTime} 条；仅为提醒保留但没有精确时间 ${result.omitted.reminderNotExact} 条。`,
        ),
      );
  }
  if (!state.loading) {
    const button = el(
      "button",
      { type: "button", class: "button button--ghost button--sm" },
      icon("refresh"),
      "刷新预览数据",
    );
    button.addEventListener("click", retry);
    content.append(el("div", { class: "preview-actions" }, button));
  }
  content.append(
    el(
      "p",
      { class: "preview-foot" },
      "预览在浏览器中生成；启用日历时服务器会按已保存设置再核对一次。日历何时刷新由日历应用决定。",
    ),
  );
  root.replaceChildren(content);
}
