import {
  BROWSE_RANGES,
  BROWSE_TIMEZONE,
  type BrowseFilters,
  browseDate,
  browseTimestamp,
  GAME_NAMES,
  nodeAction,
  nodeStatus,
  nodeTime,
  type PublicScheduleNode,
  type ScheduleDay,
  selectScheduleCore,
} from "@hoyo/contracts";
import { feedbackForFailure } from "../../lib/errors/feedback";
import { PublicReadError } from "../../lib/public-api/client";
import { button, cacheNotice, el, timeNode, timestamp } from "./dom";
import type { ScheduleLoadState } from "./load";
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
export function renderChange(change: NonNullable<PublicScheduleNode["change"]>) {
  return el(
    "div",
    {},
    el("p", {}, changeLabels[change.kind]),
    el("p", {}, change.explanation),
    el(
      "div",
      { class: "change-times" },
      change.historicalTime &&
        el("div", { class: "historical-time" }, "原时间（历史）", timeNode(change.historicalTime)),
      change.currentTime &&
        el("div", { class: "current-time" }, "当前时间", timeNode(change.currentTime)),
    ),
    el("p", { class: "evidence-text" }, "公开依据：", change.evidence),
  );
}
export function renderNode(node: PublicScheduleNode, now: number) {
  const fullTime = nodeTime(node);
  const exact =
    node.time.precision === "datetime" &&
    node.status !== "cancelled" &&
    node.status !== "retracted";
  const time =
    exact && node.time.precision === "datetime"
      ? el(
          "time",
          { datetime: new Date(node.time.utc_ms).toISOString() },
          el("span", { class: "clock" }, fullTime.slice(-5)),
          el("span", { class: "absolute-date" }, `${fullTime.slice(0, -6)} · UTC+8`),
        )
      : el("span", { class: "uncertain-time" }, fullTime);
  return el(
    "li",
    { class: "schedule-node", "data-node": node.id, "data-precision": node.time.precision },
    el("div", { class: "node-time" }, time),
    el(
      "div",
      { class: "node-content" },
      el("p", { class: "node-action" }, nodeAction(node)),
      el(
        "a",
        {
          class: "event-title",
          "data-focus": `${node.id}-title`,
          href: `/events/${encodeURIComponent(node.eventId)}`,
        },
        node.title,
      ),
      el(
        "p",
        { class: "node-meta" },
        el("span", {}, GAME_NAMES[node.game]),
        ...nodeStatus(node, now).map((s) => el("span", { class: "node-status" }, s)),
      ),
      el(
        "details",
        { class: "node-evidence", "data-disclosure": node.id },
        el("summary", { "data-focus": `${node.id}-evidence` }, "时间依据与说明"),
        el("p", { class: "evidence-text" }, node.evidence),
        el("p", {}, `原始表述：${node.time.raw_expression}`),
        el("p", {}, `公告发布时间：${timestamp(node.noticePublishedAt)}`),
      ),
    ),
  );
}
function renderDay(
  day: ScheduleDay<PublicScheduleNode>,
  today: string,
  now: number,
  yesterday = false,
) {
  return el(
    "section",
    { class: "schedule-day", "data-date": day.date },
    !yesterday &&
      el("h3", { class: "day-heading" }, day.date === today ? `今天 ${day.date}` : day.date),
    el("ul", { class: "timed-list" }, ...day.timed.map((node) => renderNode(node, now))),
    day.dateOnly.length > 0 &&
      el(
        "div",
        { class: "date-only" },
        el("h4", {}, "具体时刻未公布"),
        el("ul", {}, ...day.dateOnly.map((node) => renderNode(node, now))),
      ),
  );
}
export function loadFeedback(error: unknown) {
  if (error instanceof PublicReadError && error.status === 409)
    return "发布代次再次变化，请重新加载。";
  if (error instanceof PublicReadError && error.body) {
    const feedback = feedbackForFailure(error.body, { affectedOperation: "公开日程读取" });
    return `${feedback.title}。${feedback.nextStep}`;
  }
  return "加载失败，已显示的日程仍保留。请检查网络后重试。";
}
export function renderResults(state: ScheduleLoadState, filters: BrowseFilters) {
  const root = el("div");
  const first = state.pages[0];
  const now = Date.now();
  const status = state.status;
  const sources = status?.sources ?? null;
  const gaps = status?.reviewGaps ?? filters.games.map((game) => ({ game, count: null }));
  if (state.metadataFailed)
    root.append(
      el(
        "p",
        { class: "data-warning" },
        `目录或来源状态读取失败；已读取的公共副本仍保留。${loadFeedback(state.metadataError)}`,
      ),
    );
  if (first) {
    const oldest = state.pages.reduce((a, b) =>
      a.cache.freshUntil <= b.cache.freshUntil ? a : b,
    ).cache;
    const notice = cacheNotice(oldest);
    if (notice) root.append(notice);
    const view = selectScheduleCore(
      {
        nodes: state.pages.flatMap((page) => page.nodes),
        recentChanges: first.recentChanges,
        window: first.window,
        sources,
        reviewGaps: gaps,
      },
      filters,
    );
    if (view.changes.length)
      root.append(
        el(
          "details",
          { class: "recent-changes" },
          el(
            "summary",
            {},
            el("span", {}, "近期重要变更"),
            el("span", { class: "change-count" }, `${view.changes.length} 项`),
          ),
          el(
            "ul",
            {},
            ...view.changes.map((node) =>
              el(
                "li",
                { "data-change": node.id },
                el("a", { href: `/events/${encodeURIComponent(node.eventId)}` }, node.title),
                node.change && renderChange(node.change),
                el("p", {}, `公告发布时间 ${timestamp(node.noticePublishedAt)}`),
              ),
            ),
          ),
          first.recentChangesTruncated &&
            el("p", { class: "data-note" }, "还有未列出的近期变更，此处不是完整变更历史。"),
        ),
      );
    if (view.unavailable.length)
      root.append(
        el(
          "p",
          { class: "data-warning" },
          "部分来源暂不可用；已有公开条目保留，不代表整个游戏不可用。",
        ),
      );
    if (view.reviewUnknown || view.review)
      root.append(
        el(
          "p",
          { class: "data-warning" },
          view.reviewUnknown
            ? "审核缺口数量未知，不能确认没有待审核内容。"
            : `仍有待审核缺口：${view.review} 项待核对（聚合信息）。`,
        ),
      );
    const timeline = el(
      "section",
      { class: "timeline" },
      el(
        "div",
        { class: "timeline-heading" },
        el("h2", { id: "timeline-title", tabindex: "-1" }, "接下来的安排"),
        el("span", {}, `${view.count} 项`),
      ),
      el(
        "p",
        { class: "window-caption" },
        `${browseTimestamp(first.window.start)} — ${first.window.end === null ? "服务端已发布窗口末尾" : `${browseTimestamp(first.window.end)}（不含）`} · ${BROWSE_TIMEZONE}`,
      ),
    );
    if (state.phase === "ready" && view.empty) {
      const copy = {
        range: "当前范围没有已发布日程",
        filtered: "筛选没有匹配项",
        source: "来源暂不可用",
        review: view.reviewUnknown ? "审核缺口数量未知" : "仍有待审核缺口",
        unknown: "来源状态未知，暂不能确认当前范围的数据情况",
      };
      const empty = el(
        "section",
        { class: "schedule-empty", "data-empty": view.empty },
        el("h3", {}, copy[view.empty]),
      );
      const next =
        BROWSE_RANGES[BROWSE_RANGES.findIndex((range) => range.id === filters.range) + 1];
      if (view.empty === "range" && next) {
        const action = button(`试试${next.label}`, "widen");
        action.dataset.range = next.id;
        empty.append(action);
      } else
        empty.append(
          button(
            view.empty === "filtered" ? "放宽筛选" : "重新检查",
            view.empty === "filtered" ? "reset" : "refresh",
          ),
        );
      timeline.append(empty);
    }
    timeline.append(
      el(
        "div",
        { "data-region": "days" },
        ...view.days.map((day) => renderDay(day, browseDate(first.window.start), now)),
      ),
    );
    if (view.pending.length)
      timeline.append(
        el(
          "section",
          { class: "pending-area", "data-region": "pending" },
          el("h3", {}, "待定安排"),
          el("ul", {}, ...view.pending.map((node) => renderNode(node, now))),
        ),
      );
    timeline.append(loadRow(state));
    timeline.append(
      el(
        "section",
        { class: "yesterday-band", "data-region": "yesterday" },
        el(
          "div",
          { class: "band-content" },
          el("h3", {}, `昨天 ${view.yesterday.date} · 回看`),
          ...view.yesterday.groups.map((day) =>
            renderDay(day, browseDate(first.window.start), now, true),
          ),
          !view.yesterday.groups.length &&
            el(
              "p",
              { class: "data-note" },
              state.phase === "ready"
                ? "昨天没有符合当前筛选的已发布节点。"
                : "昨天的节点仍待加载完成。",
            ),
        ),
      ),
    );
    root.append(timeline);
  } else root.append(loadRow(state));
  const freshness = el(
    "details",
    { class: "data-freshness" },
    el("summary", {}, "来源核验与数据时间"),
  );
  if (status) {
    const notice = cacheNotice(status.cache, "来源状态");
    if (notice) freshness.append(notice);
  }
  if (sources === null) freshness.append(el("p", {}, "来源状态未知"));
  else if (!sources.length) freshness.append(el("p", {}, "当前没有登记来源"));
  else
    for (const source of sources.filter((source) => filters.games.includes(source.game)))
      freshness.append(
        el(
          "p",
          { "data-source": source.sourceId },
          `${GAME_NAMES[source.game]} · ${source.sourceId}：${sourceFeedback(source).label}；来源成功核验时间：${timestamp(source.verifiedAt)}`,
        ),
      );
  freshness.append(
    el(
      "p",
      {},
      `日程发布代次时间：${timestamp(first?.publication.publishedAt ?? null)}${first ? `（${first.publication.generation}）` : ""}`,
    ),
    el("p", {}, `目录发布代次时间：${timestamp(state.catalog?.publication?.publishedAt ?? null)}`),
    el("p", {}, "公告发布时间：见各条目的时间依据，未知时间不会以页面刷新时间代替。"),
    button("重新检查", "refresh"),
    el("a", { href: "/status" }, "查看服务状态"),
  );
  root.append(freshness);
  return root;
}
function loadRow(state: ScheduleLoadState) {
  const row = el(
    "div",
    { class: "load-row", role: "status" },
    el(
      "p",
      {},
      state.phase === "loading"
        ? "正在加载日程…"
        : state.phase === "failed"
          ? loadFeedback(state.error)
          : "已显示完当前范围",
    ),
  );
  if (state.phase === "failed") {
    const retry = button("重试加载", "retry");
    retry.disabled = Date.now() < state.retryAt;
    row.append(retry);
  }
  return row;
}
