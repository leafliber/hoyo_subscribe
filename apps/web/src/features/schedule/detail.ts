import {
  BROWSE_TIMEZONE,
  EVENT_NAMES,
  GAME_NAMES,
  nodeAction,
  nodeStatus,
  type PublicEventDetailResponse,
  type PublicScheduleNode,
} from "@hoyo/contracts";
import { cacheNotice, el, timeNode, timestamp } from "./dom";
import { renderChange } from "./render";

function officialLink(raw: string | null, label: string) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol)
      ? el("a", { href: url.href, target: "_blank", rel: "noopener noreferrer" }, label)
      : null;
  } catch {
    return null;
  }
}
function timelineNode(node: PublicScheduleNode) {
  const historical = node.status === "cancelled" || node.status === "retracted";
  return el(
    "li",
    { class: "detail-milestone", "data-milestone": node.id },
    el(
      "div",
      { class: "milestone-main" },
      el("strong", {}, nodeAction(node)),
      el(
        "div",
        { class: "milestone-time" },
        timeNode(node.time, node.status),
        historical &&
          el("span", { class: "historical-label" }, "原安排（历史）：", timeNode(node.time)),
      ),
    ),
    el("p", { class: "milestone-status" }, nodeStatus(node, Date.now()).join(" · ")),
    el(
      "details",
      { class: "milestone-evidence", "data-disclosure": node.id },
      el("summary", {}, "时间依据与证据"),
      el("p", {}, `原始时间表述：${node.time.raw_expression}`),
      el("p", { class: "evidence-text" }, `证据片段：${node.evidence}`),
      el("p", {}, `源时区：${node.time.source_timezone}`),
      el("p", {}, `公告发布时间：${timestamp(node.noticePublishedAt)}`),
    ),
  );
}
export function renderEventDetail(response: PublicEventDetailResponse) {
  const { event } = response;
  const important = event.milestones.find((node) => node.id === event.importantNodeId);
  const currentInvalid = event.status === "cancelled" || event.status === "retracted";
  const article = el(
    "article",
    { class: "event-detail", "data-event": event.id },
    el(
      "header",
      { class: "detail-intro" },
      el(
        "p",
        { class: "page-kicker" },
        `${GAME_NAMES[event.game]} · ${EVENT_NAMES[event.eventType]} · ${BROWSE_TIMEZONE}`,
      ),
      el("h1", {}, event.title),
      el("p", {}, BROWSE_TIMEZONE),
      el(
        "nav",
        { class: "detail-actions", "aria-label": "事件详情操作" },
        el("a", { class: "button button--secondary", href: "/" }, "返回日程"),
        officialLink(event.official.url, "查看官方公告"),
        el("a", { class: "button", href: "/subscription" }, "设置订阅"),
      ),
    ),
  );
  const notice = cacheNotice(response.cache, "事件详情");
  if (notice) article.append(notice);
  article.append(
    el(
      "section",
      { class: "detail-section important-section", "data-section": "important" },
      el("h2", {}, "当前重要安排"),
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
              el("strong", {}, nodeAction(important)),
              timeNode(important.time, important.status),
              el("p", {}, nodeStatus(important, Date.now()).join(" · ")),
            )
          : el("p", {}, "暂无可确认的当前重要安排。"),
    ),
    el(
      "section",
      { class: "detail-section", "data-section": "timeline" },
      el("h2", {}, "完整节点时间线"),
      el(
        "p",
        { class: "section-note" },
        "仅列出当前完整发布代次中实际存在的节点，按原有时间精度展示。",
      ),
      el("ol", { class: "detail-timeline" }, ...event.milestones.map(timelineNode)),
    ),
    el(
      "section",
      { class: "detail-section", "data-section": "change" },
      el("h2", {}, "变更说明"),
      ...event.changes.map(({ nodeId, change }) =>
        el("div", { "data-change": nodeId }, renderChange(change)),
      ),
      !event.changes.length && el("p", {}, "目前没有已发布变更。"),
      el(
        "p",
        { class: "section-note" },
        "从旧通知进入时请核对当前事实；旧邮件、Push 或客户端日历副本可能保留旧内容。",
      ),
    ),
    el(
      "section",
      { class: "detail-section", "data-section": "official" },
      el("h2", {}, "官方依据"),
      el(
        "div",
        { class: "official-primary" },
        el("p", {}, `发布者：${event.official.publisher ?? "未知"}`),
        officialLink(event.official.url, "公告链接"),
        el("p", {}, `公告发布时间：${timestamp(event.official.publishedAt)}`),
      ),
      el(
        "details",
        { class: "official-details" },
        el("summary", {}, "原始时间表述与证据片段"),
        ...event.official.excerpts.map((text) => el("p", { class: "notice-text" }, text)),
        el(
          "details",
          {},
          el("summary", {}, "源时区与更新时间"),
          ...[...new Set(event.milestones.map((node) => node.time.source_timezone))].map((zone) =>
            el("p", {}, `源时区：${zone}`),
          ),
          el("p", {}, `官方更新时间：${timestamp(event.official.updatedAt)}`),
        ),
      ),
      el(
        "p",
        { class: "data-note" },
        `发布代次时间：${timestamp(response.publication.publishedAt)}（${response.publication.generation}）`,
      ),
    ),
  );
  return article;
}
