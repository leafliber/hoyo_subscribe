import type { BrowseFilters, ScheduleDay, ScheduleNode, ScheduleSnapshot } from "@hoyo/contracts";
import {
  BROWSE_RANGES,
  BROWSE_TIMEZONE,
  browseDate,
  browseTimestamp,
  browseWindow,
  GAME_NAMES,
  nodeAction,
  nodeStatus,
  nodeTime,
  selectSchedule,
} from "@hoyo/contracts";
/** 公告/标题均按纯文本转义；不执行来源 HTML。 */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
export function renderNode(node: ScheduleNode, now: number): string {
  const statuses = nodeStatus(node, now);
  const exact =
    node.time.precision === "datetime" &&
    node.status !== "cancelled" &&
    node.status !== "retracted";
  const fullTime = nodeTime(node);
  const time = exact
    ? `<time datetime="${new Date(node.time.precision === "datetime" ? node.time.utc_ms : now).toISOString()}"><span class="clock">${escapeHtml(fullTime.slice(-5))}</span><span class="absolute-date">${escapeHtml(fullTime.slice(0, -6))} · UTC+8</span></time>`
    : `<span class="uncertain-time">${escapeHtml(fullTime)}</span>`;
  return `<li class="schedule-node" data-node="${escapeHtml(node.id)}" data-precision="${node.time.precision}">
    <div class="node-time">${time}</div>
    <div class="node-content"><p class="node-action">${escapeHtml(nodeAction(node))}</p>
    <a class="event-title" href="/events/sample">${escapeHtml(node.title)}</a>
    <p class="node-meta"><span>${GAME_NAMES[node.game]}</span>${statuses.map((status) => `<span class="node-status">${escapeHtml(status)}</span>`).join("")}</p>
    ${statuses.length || node.time.precision !== "datetime" ? `<details class="node-evidence"><summary>时间依据与说明</summary><p>${escapeHtml(node.evidence)}</p><p>原始表述：${escapeHtml(node.time.raw_expression)}</p><p>公告发布时间：${browseTimestamp(node.noticePublishedAt)} · UTC+8</p></details>` : ""}</div>
  </li>`;
}
function renderDay(day: ScheduleDay, now: number, isYesterday = false): string {
  const today = browseDate(now);
  const label = day.date === today ? "今天" : day.date;
  const heading = isYesterday
    ? ""
    : `<h3 class="day-heading"><span>${label}</span>${day.date === today ? `<span class="day-date">${day.date}</span>` : ""}<span class="day-count">${day.timed.length + day.dateOnly.length} 项安排</span></h3>`;
  return `<section class="schedule-day" data-date="${day.date}">${heading}<ul class="timed-list">${day.timed.map((node) => renderNode(node, now)).join("")}</ul>${day.dateOnly.length ? `<div class="date-only"><h4>具体时刻未公布</h4><ul>${day.dateOnly.map((node) => renderNode(node, now)).join("")}</ul></div>` : ""}</section>`;
}
export type LoadingState = "ready" | "loading" | "failed";
export interface RenderOptions {
  snapshot: ScheduleSnapshot;
  filters: BrowseFilters;
  now: number;
  expanded: boolean;
  loading: LoadingState;
  offline: boolean;
  stale: boolean;
}
export function renderResults({
  snapshot,
  filters,
  now,
  expanded,
  loading,
  offline,
  stale,
}: RenderOptions): string {
  const view = selectSchedule(snapshot, filters, now);
  const firstDay = view.days[0]?.date;
  // 按日期逐组展开，不创造第二份业务分页配额；隔离样例已完整在本地。
  const shown = expanded ? view.days : view.days.filter((day) => day.date === firstDay);
  const hasMore = shown.length < view.days.length;
  const range = BROWSE_RANGES.find((item) => item.id === filters.range);
  const emptyCopy = {
    range: [
      "这几天，留一点从容。",
      "当前范围没有已发布日程",
      "可以看看更远的安排，或通过「昨天」回看刚刚过去的节点。",
    ],
    filtered: [
      "换个筛选，继续发现。",
      "筛选没有匹配项",
      "试着放宽游戏、事件类型或节点类型；这不会修改已保存的订阅。",
    ],
    source: [
      "部分日程暂时无法确认。",
      "来源暂不可用",
      "来源访问异常，不能据此判断没有活动。请稍后重试或查看服务状态。",
    ],
    review: [
      "有些安排，还在核对中。",
      "仍有待审核缺口",
      "仅公开待审核数量；未通过审核的内容不会作为日程展示。",
    ],
  };
  const window = browseWindow(filters.range, now);
  const nextRange = BROWSE_RANGES[BROWSE_RANGES.findIndex((item) => item.id === filters.range) + 1];
  const broaden = nextRange
    ? `<button class="button" data-action="widen" data-range="${nextRange.id}">试试${nextRange.label}</button>`
    : "";
  const empty = view.empty
    ? `<section class="schedule-empty" data-empty="${view.empty}"><span class="empty-mark" aria-hidden="true">—</span><p class="empty-eyebrow">${emptyCopy[view.empty][1]}</p><h3>${emptyCopy[view.empty][0]}</h3><p>${emptyCopy[view.empty][2]}</p><div class="empty-actions">${view.empty === "range" ? broaden : view.empty === "filtered" ? '<button class="button" data-action="reset">放宽筛选</button>' : '<button class="button button--secondary" data-action="retry-source">重新检查</button><a href="/status">查看服务状态 →</a>'}</div></section>`
    : "";
  return `${view.changes.length ? `<details class="recent-changes"><summary><span>近期重要变更</span><span class="change-count">${view.changes.length} 项</span><span class="change-preview">改期、取消与待定安排</span></summary><ul>${view.changes.map((node) => `<li data-change="${escapeHtml(node.id)}"><p><strong>${escapeHtml(nodeStatus(node, now).join(" · ") || "安排已改期")}</strong> · ${GAME_NAMES[node.game]}</p><p>${escapeHtml(node.title)}</p><p>${escapeHtml(node.change?.explanation ?? "")}</p><p class="data-note">公告发布时间 ${browseTimestamp(node.noticePublishedAt)} · UTC+8</p></li>`).join("")}</ul><p class="data-note">以上均为 synthetic 公开依据样例，非官方事实。</p></details>` : ""}
    ${offline || stale ? `<aside class="data-warning" role="status">${offline ? "离线" : "陈旧缓存"}：正在展示公共旧缓存。实际缓存时间 ${browseTimestamp(snapshot.capturedAt)} · UTC+8；恢复联网后请重新检查。</aside>` : ""}
    ${view.unavailable.length && !view.empty ? `<aside class="data-warning">来源暂不可用：${view.unavailable.map((source) => GAME_NAMES[source.game]).join("、")}。已有公开条目保留，不能据此判断没有活动。</aside>` : ""}
    ${view.review ? `<aside class="data-warning">仍有待审核缺口：${view.review} 项待核对（聚合信息）。</aside>` : ""}
    <section class="timeline" aria-labelledby="timeline-title"><div class="timeline-heading"><h2 id="timeline-title" tabindex="-1">接下来的安排</h2><span>${range?.label} · ${view.count} 项</span></div><p class="window-caption">${filters.range === "all" ? "服务端已发布窗口全量" : `${browseDate(window.start)} 00:00 — ${browseDate(window.end ?? now)} 00:00（不含）`} · ${BROWSE_TIMEZONE}</p>${empty}
    <div data-region="days">${shown.map((day) => renderDay(day, now)).join("")}</div>
    ${!view.empty ? `<div class="load-row" role="status">${loading === "failed" ? '<p>加载失败，已显示的日程仍保留。</p><button class="button button--secondary" data-action="load">重试加载</button>' : loading === "loading" ? "<p>正在加载更多日程…</p>" : hasMore ? '<button class="button button--secondary" data-action="load">继续查看日程 ↓</button>' : "<p>已显示完当前范围</p>"}</div>` : ""}
    ${view.pending.length ? `<section class="pending-area" data-region="pending"><h3>待定安排</h3><p class="data-note">日期尚未确定，另列于此。</p><ul>${view.pending.map((node) => renderNode(node, now)).join("")}</ul></section>` : ""}
    <section class="yesterday-band" data-region="yesterday"><div class="band-content"><h3>昨天 <span>${view.yesterday.date} · 回看</span></h3>${view.yesterday.groups.length ? view.yesterday.groups.map((day) => renderDay(day, now, true)).join("") : '<p class="data-note">昨天没有符合当前筛选的已发布节点。</p>'}</div></section></section>
    <details class="data-freshness"><summary>来源核验 ${view.verifiedAt === null ? "未选择游戏" : `${browseTimestamp(view.verifiedAt)} · UTC+8`}<span>详情 · synthetic</span></summary><dl><dt>来源成功核验时间（摘要取所选来源最早值）</dt><dd>${view.sources.map((source) => `${GAME_NAMES[source.game]}：${browseTimestamp(source.verifiedAt)} · UTC+8`).join("<br>") || "未选择游戏"}</dd><dt>发布代次时间</dt><dd>${browseTimestamp(snapshot.publishedAt)} · UTC+8（${snapshot.generation}）</dd><dt>公告发布时间</dt><dd>每条公告各自记录；在时间依据或重要变更中查看，不以页面刷新时间替代。</dd><dt>样例缓存时间</dt><dd>${browseTimestamp(snapshot.capturedAt)} · UTC+8</dd></dl><a href="/status">服务状态 →</a></details>`;
}
