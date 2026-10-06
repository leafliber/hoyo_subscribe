import {
  BROWSE_RANGES,
  type BrowseFilters,
  type BrowseRange,
  browseDate,
  deadlineUrgency,
  EVENT_NAMES,
  GAME_NAMES,
  isDeadline,
  nodeAction,
  nodeStatus,
  type PublicScheduleNode,
  type ScheduleDay,
  selectScheduleCore,
} from "@hoyo/contracts";
import { type BadgeKind, badge, callout, el, emptyState, icon } from "../../lib/dom";
import { feedbackForFailure } from "../../lib/errors/feedback";
import {
  beijingDayStart,
  clock,
  countdownParts,
  dateOnlyLabel,
  dateTime,
  dayLabel,
  monthDay,
  relative,
  remaining,
  stamp,
  weekday,
} from "../../lib/format";
import { gameIcon } from "../../lib/game-icons";
import { PublicReadError } from "../../lib/public-api/client";
import { cacheNotice, timeNode } from "./dom";
import type { ScheduleLoadState } from "./load";
import { widerRange } from "./ranges";
import { sourceFeedback } from "./source-status";

export const changeLabels: Record<NonNullable<PublicScheduleNode["change"]>["kind"], string> = {
  rescheduled: "安排已改期",
  cancelled: "官方已取消",
  retracted: "本站撤回：此前收录有误",
  pending: "已延期，新时间待公布",
  deleted: "本站删除节点（非官方取消）",
  restored: "安排已恢复",
  classification_corrected: "分类已更正",
};
const changeKinds: Record<NonNullable<PublicScheduleNode["change"]>["kind"], BadgeKind> = {
  rescheduled: "warning",
  cancelled: "danger",
  retracted: "warning",
  pending: "warning",
  deleted: "neutral",
  restored: "success",
  classification_corrected: "neutral",
};

/** 变更详情：当前事实在前，历史时间明确标注。 */
export function renderChange(change: NonNullable<PublicScheduleNode["change"]>) {
  return el(
    "div",
    { class: "change-body" },
    el("p", { class: "change-label" }, badge(changeLabels[change.kind], changeKinds[change.kind])),
    el("p", { class: "change-explanation" }, change.explanation),
    change.historicalTime || change.currentTime
      ? el(
          "div",
          { class: "change-times" },
          change.historicalTime &&
            el(
              "div",
              { class: "historical-time" },
              el("span", { class: "change-time-label" }, "原时间（历史）"),
              timeNode(change.historicalTime),
            ),
          change.currentTime &&
            el(
              "div",
              { class: "current-time" },
              el("span", { class: "change-time-label" }, "当前时间"),
              timeNode(change.currentTime),
            ),
        )
      : null,
    el("p", { class: "evidence-text" }, "公开依据：", change.evidence),
  );
}

type Kind = "start" | "end" | "deadline" | "phase" | "maintenance" | "other";
function nodeKind(node: PublicScheduleNode): Kind {
  if (node.eventType === "maintenance") return "maintenance";
  if (node.nodeType === "reward_deadline") return "deadline";
  if (node.nodeType === "phase_unlock") return "phase";
  if (node.nodeType === "start") return "start";
  if (node.nodeType === "end") return "end";
  return "other";
}

const STATUS_BADGES: Record<string, { text: string; kind: BadgeKind; title?: string }> = {
  官方已取消: { text: "官方已取消", kind: "danger" },
  "本站撤回：此前收录有误": { text: "本站已撤回", kind: "warning" },
  "已延期，新时间待公布": { text: "延期 · 新时间待公布", kind: "warning" },
  官方预计: { text: "官方预计", kind: "neutral", title: "官方公告给出的是预计时间" },
  确定性推导: { text: "按公告推算", kind: "neutral", title: "根据官方公告的表述推算出的确定时间" },
  时间待核实: { text: "时间待核实", kind: "warning" },
  已到计划开始时间: { text: "已到开始时间", kind: "success" },
};
export function statusBadges(node: PublicScheduleNode, now: number): HTMLElement[] {
  return nodeStatus(node, now).map((status) => {
    const meta = STATUS_BADGES[status] ?? { text: status, kind: "neutral" as const };
    const element = badge(meta.text, meta.kind);
    element.classList.add("node-status");
    if (meta.title) element.title = meta.title;
    return element;
  });
}

export function gameTag(game: PublicScheduleNode["game"], size?: "md" | "lg"): HTMLElement {
  return el(
    "span",
    { class: "game-tag", "data-game": game },
    gameIcon(game, size ? `game-icon game-icon--${size}` : "game-icon"),
    GAME_NAMES[game],
  );
}

function relativeLabel(node: PublicScheduleNode, now: number): HTMLElement | null {
  if (node.time.precision !== "datetime") return null;
  const target = node.time.utc_ms;
  const endLike = isDeadline(node) || node.nodeType === "end";
  const text = endLike && target > now ? remaining(target, now) : relative(target, now);
  return el(
    "span",
    {
      class: `node-relative${target <= now ? " is-past" : endLike && deadlineUrgency(target, now) === "critical" ? " is-critical" : ""}`,
      "data-relative-to": target,
      "data-relative-mode": endLike ? "remaining" : "relative",
    },
    text ?? relative(target, now),
  );
}

export function renderNode(node: PublicScheduleNode, now: number) {
  const exact = node.time.precision === "datetime";
  const estimate = node.time.time_basis === "official_estimate";
  const time =
    node.time.precision === "datetime"
      ? el(
          "time",
          { datetime: new Date(node.time.utc_ms).toISOString(), class: "clock" },
          `${estimate ? "约 " : ""}${clock(node.time.utc_ms)}`,
        )
      : node.time.precision === "date"
        ? el(
            "span",
            { class: "uncertain-time" },
            el("span", { class: "clock clock--muted" }, "全天"),
            el("span", { class: "sr-only" }, `${node.time.date} · 具体时间未公布`),
          )
        : el(
            "span",
            { class: "uncertain-time" },
            el("span", { class: "clock clock--muted" }, "待定"),
          );
  const href = `/events/${encodeURIComponent(node.eventId)}`;
  return el(
    "li",
    {
      class: `schedule-node kind-${nodeKind(node)}${exact && node.time.precision === "datetime" && node.time.utc_ms <= now ? " is-past" : ""}`,
      "data-node": node.id,
      "data-precision": node.time.precision,
      "data-time": node.time.precision === "datetime" ? node.time.utc_ms : null,
    },
    el(
      "div",
      { class: "node-time" },
      time,
      exact
        ? relativeLabel(node, now)
        : el(
            "span",
            { class: "node-relative" },
            // 窄列里按词不拆字，<wbr> 给"具体时间/未公布"之间留一个换行点。
            ...(node.time.precision === "date"
              ? ["具体时间", el("wbr"), "未公布"]
              : ["时间待公布"]),
          ),
      estimate ? el("span", { class: "sr-only" }, "预计") : null,
    ),
    el("span", { class: "node-rail", "aria-hidden": "true" }),
    el(
      "div",
      { class: "node-content" },
      el(
        "div",
        { class: "node-top" },
        el("span", { class: "node-action" }, nodeAction(node)),
        el("span", { class: "node-type" }, EVENT_NAMES[node.eventType]),
      ),
      el("a", { class: "event-title", "data-focus": `${node.id}-title`, href }, node.title),
      el("div", { class: "node-meta" }, gameTag(node.game), ...statusBadges(node, now)),
    ),
    icon("chevron-right", "icon node-chevron"),
  );
}

/**
 * 「现在」标记：在今天的精确时间列表里，放在第一条未到时间的条目之前；读屏忽略。
 * 今天没有精确时间的条目（没有安排或只有全天条目）时单独成列表，时刻线不消失（F1-09）。
 */
export function nowMarker(now: number): HTMLElement {
  return el(
    "li",
    { class: "now-marker", "aria-hidden": "true" },
    el("span", { class: "now-time" }, "现在 ", el("span", { "data-now-clock": "" }, clock(now))),
    el("span", { class: "now-dot" }),
    el("span", { class: "now-line" }),
  );
}

/**
 * 一天：日期是时间轴上的一个标记行（日期在时间列、轨道上一个日期点），轨道跨日连续不截断。
 * 只有日期的条目接在当天精确时间之后，各自标"全天"，不排进精确时间序列。
 * 今天总带「现在」标记；今天没有安排时也画出这一天（F1-09）。
 */
function renderDay(day: ScheduleDay<PublicScheduleNode>, today: string, now: number) {
  const label = dayLabel(day.date, today);
  const start = beijingDayStart(day.date);
  const total = day.timed.length + day.dateOnly.length;
  const rows: HTMLElement[] = day.timed.map((node) => renderNode(node, now));
  if (day.date === today) {
    const next = day.timed.findIndex(
      (node) => node.time.precision === "datetime" && node.time.utc_ms > now,
    );
    rows.splice(next === -1 ? rows.length : next, 0, nowMarker(now));
  }
  return el(
    "section",
    { class: `schedule-day${day.date === today ? " is-today" : ""}`, "data-date": day.date },
    el(
      "h3",
      { class: "day-heading" },
      el(
        "span",
        { class: "day-label" },
        el("span", { class: "day-date" }, monthDay(start)),
        " ",
        el(
          "span",
          { class: "day-week" },
          weekday(start),
          label.relative ? el("span", { class: "day-relative" }, ` · ${label.relative}`) : null,
        ),
      ),
      el("span", { class: "node-rail day-rail", "aria-hidden": "true" }),
      " ",
      el("span", { class: "day-count" }, total ? `${total} 项` : "暂无安排"),
    ),
    rows.length ? el("ul", { class: "timed-list" }, ...rows) : null,
    day.dateOnly.length
      ? el("ul", { class: "date-only" }, ...day.dateOnly.map((node) => renderNode(node, now)))
      : null,
  );
}

export function loadFeedback(error: unknown, hasCopy = false) {
  if (error instanceof PublicReadError && error.status === 409)
    return "数据刚刚更新过，请重新加载。";
  if (error instanceof PublicReadError && error.body) {
    const feedback = feedbackForFailure(error.body, { affectedOperation: "公开日程读取" });
    return `${feedback.title}。${feedback.nextStep}`;
  }
  return hasCopy
    ? "加载失败，已显示的日程仍保留。请检查网络后重试。"
    : "加载失败，尚无可展示的公共副本。请检查网络后重试。";
}

function actionButton(
  label: string,
  action: string,
  primary = false,
  name?: Parameters<typeof icon>[0],
) {
  return el(
    "button",
    {
      type: "button",
      class: primary ? "button" : "button button--secondary",
      "data-action": action,
    },
    name ? icon(name) : null,
    label,
  );
}

/** 公共接口在尚无发布代次时以 503 拒绝列表读取；目录同时明确 publication=null。 */
function nothingPublished(state: ScheduleLoadState): boolean {
  return (
    state.pages.length === 0 &&
    state.phase === "failed" &&
    state.catalog !== null &&
    state.catalog.publication === null &&
    state.error instanceof PublicReadError &&
    state.error.status === 503
  );
}

export function renderResults(state: ScheduleLoadState, filters: BrowseFilters) {
  const root = el("div", { class: "results-stack" });
  const first = state.pages[0];
  const now = Date.now();
  const status = state.status;
  const sources = status?.sources ?? null;
  const gaps = status?.reviewGaps ?? filters.games.map((game) => ({ game, count: null }));
  if (state.metadataFailed && !nothingPublished(state))
    root.append(
      callout(
        "warning",
        `目录或来源状态读取失败。${state.catalog || state.status ? "已读取的目录或来源副本仍保留。" : "尚无目录或来源副本。"}${loadFeedback(state.metadataError, state.pages.length > 0)}`,
        { className: "data-warning" },
      ),
    );
  if (!first) {
    if (state.phase === "loading") {
      root.append(
        el(
          "section",
          { class: "timeline card", "aria-labelledby": "timeline-title" },
          el(
            "div",
            { class: "timeline-heading" },
            el("h2", { id: "timeline-title", tabindex: "-1" }, "接下来的安排"),
            loadStatus(state),
          ),
          el(
            "div",
            { class: "timeline-skeleton" },
            el("div", { class: "skeleton skeleton-line" }),
            el("div", { class: "skeleton skeleton-row" }),
            el("div", { class: "skeleton skeleton-row" }),
            el("div", { class: "skeleton skeleton-row" }),
          ),
        ),
      );
    } else if (nothingPublished(state)) {
      root.append(
        el(
          "section",
          { class: "timeline card", "data-empty": "unpublished" },
          emptyState(
            "inbox",
            "日程正在准备中",
            "官方公告抓取与核对完成后，活动安排会出现在这里。可以先设置订阅，日程发布后会自动同步到你的日历。",
            el("a", { class: "button", href: "/subscription" }, "先设置订阅"),
            el("a", { class: "button button--secondary", href: "/status" }, "查看服务状态"),
          ),
        ),
      );
    } else {
      const retry = actionButton("重试加载", "retry", true, "refresh");
      retry.disabled = Date.now() < state.retryAt;
      root.append(
        el(
          "section",
          { class: "timeline card" },
          emptyState("wifi-off", "暂时无法加载日程", loadFeedback(state.error, false), retry),
          el(
            "div",
            { class: "load-row sr-only", role: "status" },
            el("p", {}, loadFeedback(state.error, false)),
          ),
        ),
      );
    }
    return root;
  }

  const oldest = state.pages.reduce((a, b) =>
    a.cache.freshUntil <= b.cache.freshUntil ? a : b,
  ).cache;
  const notice = cacheNotice(oldest);
  if (notice) root.append(notice);
  // 页面显示的是已读完的那一档；"显示更多"读取下一档期间，筛选已切到下一档，数据仍是这一档。
  const shown = state.loadedRange ?? filters.range;
  const view = selectScheduleCore(
    {
      nodes: state.pages.flatMap((page) => page.nodes),
      recentChanges: first.recentChanges,
      window: first.window,
      sources,
      reviewGaps: gaps,
    },
    { ...filters, range: shown },
  );
  if (view.changes.length)
    root.append(
      el(
        "details",
        { class: "recent-changes card", "data-disclosure": "recent-changes" },
        el(
          "summary",
          {},
          el("span", { class: "recent-icon", "aria-hidden": "true" }, icon("history")),
          el(
            "span",
            { class: "recent-text" },
            el("span", { class: "recent-title" }, "近期重要变更"),
            el("span", { class: "change-count" }, `${view.changes.length} 项`),
          ),
        ),
        el(
          "ul",
          { class: "change-list" },
          ...view.changes.map((node) =>
            el(
              "li",
              { "data-change": node.id, class: "change-item" },
              el(
                "div",
                { class: "change-head" },
                gameTag(node.game),
                el("a", { href: `/events/${encodeURIComponent(node.eventId)}` }, node.title),
              ),
              node.change && renderChange(node.change),
              el("p", { class: "change-meta" }, `公告发布时间 ${stamp(node.noticePublishedAt)}`),
            ),
          ),
        ),
        first.recentChangesTruncated && el("p", { class: "data-note" }, "还有更早的变更未列出"),
      ),
    );
  if (view.unavailable.length)
    root.append(
      callout("warning", "部分来源暂不可用；已有公开条目保留，不代表整个游戏不可用。", {
        className: "data-warning",
      }),
    );
  if (view.reviewUnknown || view.review)
    root.append(
      callout(
        "info",
        view.reviewUnknown
          ? "审核缺口数量未知，可能还有尚未收录的安排。"
          : `还有 ${view.review} 项待核对的公告，核对完成后会补充到日程（${view.review} 项待核对）。`,
        { className: "data-warning" },
      ),
    );

  const timeline = el(
    "section",
    { class: "timeline card", "aria-labelledby": "timeline-title" },
    el(
      "div",
      { class: "timeline-heading" },
      el("h2", { id: "timeline-title", tabindex: "-1" }, "接下来的安排"),
      el("span", { class: "badge" }, `${view.count} 项`),
      // 加载提示放在时间线顶部（ADR-0017）：列表很长时底部看不到。
      loadStatus(state),
      el(
        "span",
        { class: "window-caption" },
        `${rangeLabel(shown)}${first.window.end === null ? "" : ` · 截至 ${dateTime(first.window.end - 1)}`}`,
      ),
    ),
  );
  // 当前范围为空时，空态里已有"试试下一档"的出口，末行不再重复"显示更多"。
  const offerMore = !(state.phase === "ready" && view.empty === "range");
  if (state.phase === "ready" && view.empty) {
    const next = widerRange(shown);
    const copy: Record<string, [string, string]> = {
      range: ["当前范围没有已发布日程", "这段时间里没有已发布的活动安排。"],
      filtered: ["筛选没有匹配项", "换个筛选条件试试，或者清除全部筛选。"],
      source: ["来源暂不可用", "部分官方数据源暂时无法访问，稍后再来看看。"],
      review: [
        view.reviewUnknown ? "审核缺口数量未知" : "仍有待审核缺口",
        "有新公告正在核对中，核对完成后会显示在这里。",
      ],
      unknown: ["来源状态未知", "暂时无法确认当前范围的数据情况，请稍后重新检查。"],
    };
    const [title, text] = copy[view.empty];
    let action: HTMLButtonElement;
    if (view.empty === "range" && next) {
      action = actionButton(`试试${next.label}`, "widen", true);
      action.dataset.range = next.id;
    } else if (view.empty === "filtered") action = actionButton("清除筛选", "reset", true);
    else action = actionButton("重新检查", "refresh", false, "refresh");
    timeline.append(
      el(
        "div",
        { class: "schedule-empty", "data-empty": view.empty },
        emptyState(view.empty === "filtered" ? "search" : "calendar", title, text, action),
      ),
    );
  }
  const today = browseDate(first.window.start);
  const yesterdayCount = view.yesterday.groups.reduce(
    (total, day) => total + day.timed.length + day.dateOnly.length,
    0,
  );
  // 回看昨天接在主时间轴上（F1-09，ADR-0020）：折叠时是轨道上的一行，展开后昨天的日期段落与下方
  // 同一网格、同一条轨道，出现在今天之上；不再是另开的一段列表。
  timeline.append(
    el(
      "details",
      { class: "yesterday-band", "data-region": "yesterday", "data-disclosure": "yesterday" },
      el(
        "summary",
        { class: "rail-toggle" },
        el("span", { class: "rail-toggle-time" }),
        el("span", { class: "node-rail toggle-rail", "aria-hidden": "true" }, icon("history")),
        el(
          "span",
          { class: "rail-toggle-text" },
          `回看昨天（${dateOnlyLabel(view.yesterday.date)}）`,
          el("span", { class: "day-count" }, `${yesterdayCount} 项`),
        ),
      ),
      ...view.yesterday.groups.map((day) => renderDay(day, today, now)),
      !view.yesterday.groups.length &&
        el(
          "p",
          { class: "data-note band-note" },
          state.phase === "ready" ? "昨天没有符合当前筛选的安排。" : "昨天的安排仍在加载。",
        ),
    ),
  );
  // 今天总在时间轴上（F1-09）：今天没有安排时补一个空的今天，带「现在」时刻线。
  const days =
    view.empty || view.days.some((day) => day.date === today)
      ? view.days
      : [
          ...view.days.filter((day) => day.date < today),
          { date: today, timed: [], dateOnly: [] },
          ...view.days.filter((day) => day.date > today),
        ];
  // 从上到下按时间先后（ADR-0017）：昨天 → 今天 → 当前范围逐日 → 末行；时间待定在下方单独的卡片。
  timeline.append(
    el(
      "div",
      { "data-region": "days", class: "days" },
      ...days.map((day) => renderDay(day, today, now)),
    ),
  );
  const end = endRow(state, shown, offerMore);
  if (end) timeline.append(end);
  root.append(timeline);
  // 时间待定单独一张卡片，默认折叠（F1-09）；展开状态随重绘保留。时间未知，排在时间轴之后。
  if (view.pending.length)
    root.append(
      el(
        "details",
        { class: "pending-card card", "data-region": "pending", "data-disclosure": "pending" },
        el(
          "summary",
          {},
          el("span", { class: "pending-icon", "aria-hidden": "true" }, icon("hourglass")),
          el("span", { class: "pending-title" }, "时间待定"),
          el("span", { class: "day-count" }, `${view.pending.length} 项`),
        ),
        el("ul", { class: "node-list" }, ...view.pending.map((node) => renderNode(node, now))),
      ),
    );
  return root;
}

const rangeLabel = (range: BrowseRange) =>
  BROWSE_RANGES.find((item) => item.id === range)?.label ?? "";

/** 时间线顶部的加载提示（ADR-0017）：首次加载、续页与"显示更多"都在这里说明。 */
function loadStatus(state: ScheduleLoadState): HTMLElement | null {
  if (state.phase !== "loading") return null;
  return el(
    "span",
    { class: "load-status" },
    el("span", { class: "spinner", "aria-hidden": "true" }),
    state.extending ? `正在加载${rangeLabel(state.extending)}…` : "正在加载日程…",
  );
}

/**
 * 列表末行（ADR-0017）：写明已显示到哪一档，并可"显示更多"读取下一档，新条目接在这一行之前。
 * 读取下一档期间按钮保留（焦点不丢），标为不可用；读取失败时给出原因和重试。
 * 首次加载与续页期间不显示，提示在时间线顶部。
 */
function endRow(
  state: ScheduleLoadState,
  shown: BrowseRange,
  offerMore: boolean,
): HTMLElement | null {
  if (state.phase === "failed") {
    const retry = actionButton("重试加载", "retry", false, "refresh");
    retry.disabled = Date.now() < state.retryAt;
    return el(
      "div",
      { class: "load-row is-failed", role: "status" },
      el("p", {}, loadFeedback(state.error, state.pages.length > 0)),
      retry,
    );
  }
  if (state.phase === "loading" && state.extending === null) return null;
  const row = el(
    "div",
    { class: `load-row is-${state.phase}`, role: "status", tabindex: "-1" },
    el("p", {}, shown === "all" ? "已显示完全部日程" : `已显示完${rangeLabel(shown)}`),
  );
  const next = widerRange(shown);
  if (next && offerMore) {
    const more = actionButton("显示更多", "show-more", false, "chevron-down");
    more.dataset.range = next.id;
    if (state.extending !== null) {
      more.setAttribute("aria-disabled", "true");
      more.replaceChildren(
        el("span", { class: "spinner", "aria-hidden": "true" }),
        `正在加载${rangeLabel(next.id)}…`,
      );
    }
    row.append(more);
  }
  return row;
}

const ENDING_LIMIT = 4;

/** 即将截止的候选：已加载的公开节点里尚未到时间的截止类节点，按时间先后；遵从全部浏览筛选。 */
export function endingSoonNodes(state: ScheduleLoadState, filters: BrowseFilters, now: number) {
  const seen = new Set<string>();
  return state.pages
    .flatMap((page) => page.nodes)
    .filter((node) => {
      if (seen.has(node.id)) return false;
      seen.add(node.id);
      return (
        filters.games.includes(node.game) &&
        (!filters.events.length || filters.events.includes(node.eventType)) &&
        (!filters.nodes.length || filters.nodes.includes(node.nodeType)) &&
        node.status !== "cancelled" &&
        node.status !== "retracted" &&
        isDeadline(node) &&
        node.time.precision === "datetime" &&
        node.time.utc_ms > now
      );
    })
    .sort(
      (a, b) =>
        (a.time.precision === "datetime" ? a.time.utc_ms : 0) -
          (b.time.precision === "datetime" ? b.time.utc_ms : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/** 倒计时数字：按秒更新的只有数字本身，不做读屏播报。 */
export function countdownValue(target: number, now: number): HTMLElement[] {
  return countdownParts(target, now).flatMap(([value, unit]) => [
    el("span", { class: "cd-num" }, String(value)),
    el("span", { class: "cd-unit" }, unit),
  ]);
}

function endingCard(node: PublicScheduleNode, today: string, now: number, index: number) {
  if (node.time.precision !== "datetime") throw new Error("截止卡片只接受精确时间");
  const target = node.time.utc_ms;
  const day = dayLabel(browseDate(target), today);
  return el(
    "li",
    {
      class: `ending-card is-${deadlineUrgency(target, now)}`,
      "data-ending": node.id,
      style: `--i: ${index}`,
    },
    el(
      "div",
      { class: "ending-card-top" },
      gameTag(node.game, "md"),
      el("span", { class: "ending-action" }, nodeAction(node)),
    ),
    el(
      "a",
      { class: "ending-title", href: `/events/${encodeURIComponent(node.eventId)}` },
      node.title,
    ),
    el(
      "div",
      { class: "ending-countdown" },
      el("span", { class: "cd-label" }, "剩余"),
      el(
        "span",
        { class: "cd-value", "data-countdown-to": target },
        ...countdownValue(target, now),
      ),
    ),
    el(
      "p",
      { class: "ending-when" },
      el(
        "time",
        { datetime: new Date(target).toISOString() },
        `${day.relative ?? monthDay(target)} ${clock(target)}`,
      ),
      " 截止",
    ),
  );
}

/**
 * 首屏「即将截止」：只用已加载的公开数据。返回 null 表示整块隐藏
 * （尚无数据且不在加载、未发布、筛选排除了截止类节点）。
 */
export function renderEndingSoon(
  state: ScheduleLoadState,
  filters: BrowseFilters,
): HTMLElement[] | null {
  const now = Date.now();
  const head = (count: HTMLElement | null) =>
    el(
      "div",
      { class: "ending-head" },
      el(
        "h2",
        { id: "ending-soon-title", class: "ending-heading" },
        el("span", { class: "ending-pulse", "aria-hidden": "true" }),
        "即将截止",
      ),
      count,
      el("a", { class: "ending-remind", href: "/subscription" }, icon("bell"), "截止前提醒我"),
    );
  const first = state.pages[0];
  if (!first) {
    if (state.phase !== "loading" || !filters.games.length) return null;
    return [
      head(null),
      el(
        "div",
        { class: "ending-cards", role: "status" },
        el("span", { class: "sr-only" }, "正在加载即将截止的活动…"),
        ...Array.from({ length: ENDING_LIMIT }, () =>
          el(
            "div",
            { class: "ending-card skeleton-card" },
            el("div", { class: "skeleton skeleton-line" }),
            el("div", { class: "skeleton skeleton-block" }),
          ),
        ),
      ),
    ];
  }
  const excludesDeadlines =
    !filters.games.length ||
    (filters.nodes.length > 0 &&
      !filters.nodes.some((type) => type === "end" || type === "reward_deadline"));
  if (excludesDeadlines) return null;
  const nodes = endingSoonNodes(state, filters, now);
  const shownRange = state.loadedRange ?? filters.range;
  const scope = shownRange === "all" ? "已发布日程中" : `${rangeLabel(shownRange)}内`;
  if (!nodes.length) {
    if (filters.events.length || filters.nodes.length) return null;
    return [
      head(null),
      el(
        "p",
        { class: "ending-none" },
        icon("check-circle"),
        state.phase === "loading" ? "正在读取截止安排…" : `${scope}没有即将截止的活动。`,
      ),
    ];
  }
  const today = browseDate(first.window.start);
  const shown = nodes.slice(0, ENDING_LIMIT);
  const parts: HTMLElement[] = [
    head(el("p", { class: "ending-sub" }, `${scope} · 共 ${nodes.length} 项`)),
    el(
      "ol",
      { class: "ending-cards" },
      ...shown.map((node, index) => endingCard(node, today, now, index)),
    ),
  ];
  if (nodes.length > shown.length)
    parts.push(
      el(
        "button",
        { type: "button", class: "ending-more", "data-action": "ending-all" },
        `查看全部 ${nodes.length} 项截止安排`,
        icon("arrow-right"),
      ),
    );
  return parts;
}

/** 侧栏：数据状态。只使用已加载的公开数据。 */
export function renderAside(state: ScheduleLoadState, filters: BrowseFilters) {
  const root = document.createDocumentFragment();
  const status = state.status;
  const sources = status?.sources ?? null;
  const visibleSources = sources?.filter((source) => filters.games.includes(source.game)) ?? null;
  const first = state.pages[0];
  const freshness = el(
    "details",
    { class: "card aside-card data-freshness", "data-disclosure": "freshness" },
    el(
      "summary",
      {},
      el("span", { class: "aside-title" }, icon("activity"), "数据状态"),
      el(
        "span",
        { class: "freshness-summary" },
        first ? `更新于 ${dateTime(first.publication.publishedAt)}` : "来源核验与数据时间",
      ),
    ),
  );
  const body = el("div", { class: "freshness-body" });
  if (status) {
    const notice = cacheNotice(status.cache);
    if (notice) body.append(notice);
  }
  if (visibleSources === null) body.append(el("p", {}, "来源状态未知"));
  else if (!visibleSources.length) body.append(el("p", {}, "当前没有登记来源"));
  else
    body.append(
      el(
        "ul",
        { class: "list-plain source-list" },
        ...visibleSources.map((source) => {
          const feedback = sourceFeedback(source);
          return el(
            "li",
            { "data-source": source.sourceId },
            gameTag(source.game),
            el(
              "span",
              { class: "source-state" },
              badge(feedback.label, feedback.affected ? "warning" : "success"),
            ),
            el("span", { class: "source-time" }, `核验于 ${stamp(source.verifiedAt)}`),
          );
        }),
      ),
    );
  body.append(
    el(
      "p",
      { class: "text-aux" },
      `日程发布于 ${stamp(first?.publication.publishedAt ?? null)}${first ? `（第 ${first.publication.generation} 版）` : ""}`,
    ),
    el(
      "div",
      { class: "button-row" },
      actionButton("重新检查", "refresh", false, "refresh"),
      el("a", { href: "/status", class: "button button--ghost" }, "查看服务状态"),
    ),
  );
  freshness.append(body);
  root.append(freshness);
  return root;
}
