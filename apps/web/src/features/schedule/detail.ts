import type { ScheduleNode } from "@hoyo/contracts";
import {
  BROWSE_TIMEZONE,
  browseTimestamp,
  EVENT_NAMES,
  GAME_NAMES,
  nodeAction,
  nodeStatus,
  nodeTime,
} from "@hoyo/contracts";
import type { DemoEvent } from "./fixtures";
import { escapeHtml } from "./render";

function safeOfficialUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function renderTime(node: ScheduleNode, historical = false): string {
  const displayNode = historical ? { ...node, status: "scheduled" as const } : node;
  const label = escapeHtml(nodeTime(displayNode));
  if (
    node.time.precision === "datetime" &&
    (historical || (node.status !== "cancelled" && node.status !== "retracted"))
  ) {
    return `<time datetime="${new Date(node.time.utc_ms).toISOString()}">${label}</time>`;
  }
  return `<span>${label}</span>`;
}

function renderTimelineNode(node: ScheduleNode, now: number): string {
  const historical = node.status === "cancelled" || node.status === "retracted";
  const statuses = nodeStatus(node, now);
  return `<li class="detail-milestone" data-milestone="${escapeHtml(node.id)}">
    <div class="milestone-main"><strong>${escapeHtml(nodeAction(node))}</strong><div class="milestone-time">${renderTime(node)}${historical ? `<span class="historical-label">原安排（历史）：${renderTime(node, true)}</span>` : ""}</div></div>
    ${statuses.length ? `<p class="milestone-status">${statuses.map(escapeHtml).join(" · ")}</p>` : ""}
    <details class="milestone-evidence"><summary>时间依据与证据</summary><p>原始时间表述：${escapeHtml(node.time.raw_expression)}</p><p class="evidence-text">证据片段：${escapeHtml(node.evidence)}</p><p>源时区：${escapeHtml(node.time.source_timezone)}</p><p>公告发布时间：${browseTimestamp(node.noticePublishedAt)} · UTC+8</p></details>
  </li>`;
}

function renderChange(event: DemoEvent, important: ScheduleNode): string {
  if (!event.change) return "<p>目前没有已发布变更。</p>";
  const explanation = `<p>${escapeHtml(event.change.explanation)}</p>`;
  if (event.change.kind === "rescheduled" && event.historicalTime) {
    const historical = { ...important, time: event.historicalTime };
    return `<p>当前安排已改期；旧时间仅供对照。</p><div class="change-times"><div class="historical-time"><span>原时间（历史）</span>${renderTime(historical, true)}</div><div class="current-time"><span>当前时间</span>${renderTime(important)}</div></div>${explanation}`;
  }
  return explanation;
}

/** 只对 synthetic 样例生成 HTML；每个来自公告的文本插值都先转义。 */
export function renderEventDetail(event: DemoEvent, now: number): string {
  const important =
    event.milestones.find((node) => node.id === event.importantNodeId) ?? event.milestones[0];
  if (!important) throw new Error("事件详情样例缺少实际节点");
  const officialUrl = safeOfficialUrl(event.official.url);
  const actionLink = officialUrl
    ? `<a class="button button--secondary" href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener noreferrer">查看官方公告</a>`
    : "";
  const sourceLink = officialUrl
    ? `<a href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener noreferrer">公告链接（样例）</a>`
    : "";
  const statuses = nodeStatus(important, now);
  const currentInvalid = event.status === "cancelled" || event.status === "retracted";
  const timelineNodes = event.milestones;
  return `<article class="event-detail" data-event="${escapeHtml(event.id)}">
    <header class="detail-intro"><p class="page-kicker">${escapeHtml(GAME_NAMES[event.game])} · ${escapeHtml(EVENT_NAMES[event.eventType])} · ${BROWSE_TIMEZONE}</p><h1>${escapeHtml(event.title)}</h1><p class="sample-notice"><strong>样例预览 · synthetic</strong> 以下是隔离演示数据，不代表官方日程。公告链接仅示意入口，不对应真实公告。</p>
      <nav class="detail-actions" aria-label="事件详情操作"><a class="button button--secondary" href="/">返回日程</a>${actionLink}<a class="button" href="/subscription">设置订阅</a></nav>
    </header>
    <section class="detail-section important-section" data-section="important" aria-labelledby="important-title"><h2 id="important-title">当前重要安排</h2>
      ${currentInvalid ? `<p class="important-status">${escapeHtml(statuses.join(" · "))}</p><p>原安排已失效，详情见下方变更说明。</p>` : `<div class="important-fact"><strong>${escapeHtml(nodeAction(important))}</strong><div>${renderTime(important)} <span class="timezone-note">${BROWSE_TIMEZONE}</span></div></div>${event.change?.kind === "rescheduled" ? '<p class="important-status">已改期 · 当前时间见上方</p>' : statuses.length ? `<p class="important-status">${statuses.map(escapeHtml).join(" · ")}</p>` : ""}`}
    </section>
    <section class="detail-section" data-section="timeline" aria-labelledby="detail-timeline-title"><h2 id="detail-timeline-title">完整节点时间线</h2><p class="section-note">仅列出已发布样例中实际存在的节点。日期和时刻均按原有精度展示。</p><ol class="detail-timeline">${timelineNodes.map((node) => renderTimelineNode(node, now)).join("")}</ol></section>
    <section class="detail-section" data-section="change" aria-labelledby="detail-change-title"><h2 id="detail-change-title">变更说明</h2>${renderChange(event, important)}<p class="section-note">从旧通知进入时请核对当前事实；旧邮件、Push 或客户端日历副本可能保留旧内容。</p></section>
    <section class="detail-section" data-section="official" aria-labelledby="detail-official-title"><h2 id="detail-official-title">官方依据</h2><div class="official-primary"><p><strong>${escapeHtml(event.official.publisher)}</strong><br>公告发布时间：${browseTimestamp(event.official.publishedAt)} · UTC+8</p>${sourceLink}</div><p class="section-note">上方外链为样例占位地址，不是本虚构活动的真实官方公告。</p>
      <details class="official-details"><summary>公告原文与证据片段</summary><div class="official-details-body"><p class="notice-text">公告原文：${escapeHtml(event.official.noticeText)}</p><p>重要节点原始时间表述：${escapeHtml(important.time.raw_expression)}</p><p class="evidence-text">证据片段：${escapeHtml(important.evidence)}</p><details><summary>源时区与更新时间</summary><p>源时区：${escapeHtml(important.time.source_timezone)}</p><p>样例记录更新时间：${browseTimestamp(event.official.updatedAt)} · UTC+8</p></details></div></details>
    </section>
  </article>`;
}
