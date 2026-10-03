import {
  EVENT_NAMES,
  nodeAction,
  type PublicEventDetailResponse,
  type PublicScheduleNode,
} from "@hoyo/contracts";
import { type BadgeKind, badge, el, icon, statusPill } from "../../lib/dom";
import { relative, remaining, stamp } from "../../lib/format";
import { cacheNotice, timeNode } from "./dom";
import { gameTag, renderChange, statusBadges } from "./render";

function officialLink(raw: string | null, label: string, className: string) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol)
      ? el(
          "a",
          { href: url.href, target: "_blank", rel: "noopener noreferrer", class: className },
          label,
          icon("external-link"),
        )
      : null;
  } catch {
    return null;
  }
}

function exactTime(node: PublicScheduleNode | undefined): number | null {
  return node && node.time.precision === "datetime" && node.status !== "cancelled"
    ? node.time.utc_ms
    : null;
}

/** 活动整体状态：只在有精确开始/结束时间时推断进行阶段。 */
function eventPhase(
  event: PublicEventDetailResponse["event"],
  now: number,
): { text: string; kind: BadgeKind } | null {
  if (event.status === "cancelled") return { text: "官方已取消", kind: "danger" };
  if (event.status === "retracted") return { text: "本站已撤回", kind: "warning" };
  if (event.status === "postponed") return { text: "已延期", kind: "warning" };
  const start = exactTime(event.milestones.find((node) => node.nodeType === "start"));
  const end = exactTime(
    event.milestones.find((node) => node.nodeType === "end" || node.nodeType === "actual_end"),
  );
  if (end !== null && end <= now) return { text: "已结束", kind: "neutral" };
  if (start !== null && start <= now)
    return end !== null ? { text: "进行中", kind: "success" } : { text: "已开始", kind: "success" };
  if (start !== null) return { text: "即将开始", kind: "accent" };
  return null;
}

function timelineNode(node: PublicScheduleNode, now: number, important: boolean) {
  const historical = node.status === "cancelled" || node.status === "retracted";
  const time = exactTime(node);
  return el(
    "li",
    {
      class: `detail-milestone${important ? " is-important" : ""}${time !== null && time <= now ? " is-past" : ""}`,
      "data-milestone": node.id,
    },
    el("span", { class: "milestone-dot", "aria-hidden": "true" }),
    el(
      "div",
      { class: "milestone-body" },
      el(
        "div",
        { class: "milestone-main" },
        el("strong", { class: "milestone-action" }, nodeAction(node)),
        important ? badge("关键节点", "accent") : null,
      ),
      el(
        "div",
        { class: "milestone-time" },
        timeNode(node.time, node.status),
        historical
          ? el("span", { class: "historical-label" }, "原安排（历史）：", timeNode(node.time))
          : null,
        time !== null ? el("span", { class: "milestone-relative" }, relative(time, now)) : null,
      ),
      el("div", { class: "milestone-status" }, ...statusBadges(node, now)),
      el(
        "details",
        { class: "milestone-evidence disclosure--inline disclosure", "data-disclosure": node.id },
        el("summary", {}, "时间依据"),
        el(
          "div",
          { class: "evidence-box" },
          el("p", {}, `原始时间表述：${node.time.raw_expression}`),
          el("p", { class: "evidence-text" }, `证据片段：${node.evidence}`),
          el("p", {}, `源时区：${node.time.source_timezone}`),
          el("p", {}, `公告发布时间：${stamp(node.noticePublishedAt)}`),
        ),
      ),
    ),
  );
}

export function renderEventDetail(response: PublicEventDetailResponse) {
  const { event } = response;
  const now = Date.now();
  const important = event.milestones.find((node) => node.id === event.importantNodeId);
  const currentInvalid = event.status === "cancelled" || event.status === "retracted";
  const phase = eventPhase(event, now);
  const article = el(
    "article",
    { class: "event-detail", "data-event": event.id },
    el(
      "header",
      { class: "detail-hero" },
      el(
        "div",
        { class: "detail-tags" },
        gameTag(event.game),
        badge(EVENT_NAMES[event.eventType]),
        phase ? statusPill(phase.text, phase.kind) : null,
      ),
      el("h1", {}, event.title),
      el(
        "nav",
        { class: "detail-actions", "aria-label": "活动操作" },
        el("a", { class: "button", href: "/subscription" }, icon("calendar-check"), "设置订阅"),
        officialLink(event.official.url, "查看官方公告", "button button--secondary"),
      ),
    ),
  );
  const notice = cacheNotice(response.cache, "活动详情");
  if (notice) article.append(notice);

  const importantTime = exactTime(important);
  const left =
    importantTime !== null && important && important.nodeType !== "start"
      ? remaining(importantTime, now)
      : importantTime !== null
        ? relative(importantTime, now)
        : null;
  article.append(
    el(
      "div",
      { class: "detail-grid" },
      el(
        "div",
        { class: "detail-main" },
        el(
          "section",
          { class: "card detail-section important-section", "data-section": "important" },
          el("h2", { class: "detail-section-title" }, "当前重要安排"),
          currentInvalid
            ? el(
                "p",
                { class: "important-status" },
                event.status === "cancelled"
                  ? "官方已取消；原安排已失效。"
                  : "本站撤回：此前收录有误；原安排已失效。",
              )
            : important
              ? el(
                  "div",
                  { class: "important-fact" },
                  el("p", { class: "important-action" }, nodeAction(important)),
                  el("p", { class: "important-time" }, timeNode(important.time, important.status)),
                  left ? el("p", { class: "important-left" }, icon("clock"), left) : null,
                  el("div", { class: "milestone-status" }, ...statusBadges(important, now)),
                )
              : el("p", { class: "text-secondary" }, "暂无可确认的当前重要安排。"),
        ),
        el(
          "section",
          { class: "card detail-section", "data-section": "timeline" },
          el("h2", { class: "detail-section-title" }, "完整时间线"),
          el(
            "ol",
            { class: "detail-timeline" },
            ...event.milestones.map((node) => timelineNode(node, now, node.id === important?.id)),
          ),
          el(
            "p",
            { class: "section-note" },
            "只列出官方公告中实际出现的节点，按原有时间精度展示。",
          ),
        ),
        el(
          "section",
          { class: "card detail-section", "data-section": "change" },
          el("h2", { class: "detail-section-title" }, "变更记录"),
          ...event.changes.map(({ nodeId, change }) =>
            el("div", { "data-change": nodeId, class: "detail-change" }, renderChange(change)),
          ),
          !event.changes.length
            ? el("p", { class: "text-secondary" }, "目前没有已发布的变更。")
            : null,
          el(
            "p",
            { class: "section-note" },
            "这里总是显示最新事实；之前收到的邮件或已同步到日历的旧内容可能还未更新。",
          ),
        ),
      ),
      el(
        "aside",
        { class: "detail-side" },
        el(
          "section",
          { class: "card detail-section", "data-section": "official" },
          el("h2", { class: "detail-section-title" }, "官方来源"),
          el(
            "dl",
            { class: "kv kv--compact official-primary" },
            el("dt", {}, "发布者"),
            el("dd", {}, event.official.publisher ?? "未知"),
            el("dt", {}, "发布时间"),
            el("dd", {}, stamp(event.official.publishedAt)),
          ),
          officialLink(event.official.url, "公告链接", "official-link"),
          el(
            "details",
            { class: "official-details disclosure" },
            el("summary", {}, "原始时间表述与证据片段"),
            ...event.official.excerpts.map((text) => el("p", { class: "notice-text" }, text)),
            el(
              "details",
              { class: "disclosure" },
              el("summary", {}, "源时区与更新时间"),
              ...[...new Set(event.milestones.map((node) => node.time.source_timezone))].map(
                (zone) => el("p", {}, `源时区：${zone}`),
              ),
              el("p", {}, `官方更新时间：${stamp(event.official.updatedAt)}`),
            ),
          ),
          el(
            "p",
            { class: "data-note" },
            `本站发布时间：${stamp(response.publication.publishedAt)}（第 ${response.publication.generation} 版）`,
          ),
        ),
        el(
          "section",
          { class: "card card--accent detail-cta" },
          el("div", { class: "subscribe-icon", "aria-hidden": "true" }, icon("bell")),
          el("h2", { class: "detail-section-title" }, "不想错过这类活动？"),
          el(
            "p",
            {},
            `订阅「${EVENT_NAMES[event.eventType]}」等活动类型后，开始和截止时间会自动出现在你的日历里，还能提前提醒。`,
          ),
          el("a", { class: "button button--block", href: "/subscription" }, "设置订阅"),
        ),
      ),
    ),
  );
  return article;
}
