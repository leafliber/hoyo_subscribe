import {
  SUBSCRIPTION_CHANGE_COPY,
  SUBSCRIPTION_NODE_TYPE_LABELS,
  type TimeBasis,
} from "@hoyo/contracts";
import { MailDataError } from "../outbox/types";
import type { ServerMail } from "./types";
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
export function safeHttps(raw: string, origin?: string): string {
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    throw new MailDataError("invalid_link");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (origin && url.origin !== new URL(origin).origin)
  )
    throw new MailDataError("invalid_link");
  return url.href;
}
const beijing = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const timeBasisCopy: Record<TimeBasis, string> = {
  official_explicit: "官方明确时间",
  deterministic_derived: "按官方信息确定推导",
  official_estimate: "官方预计时间",
  unresolved: "时间依据待确认",
};
const displayTime = (time: number) => `${beijing.format(time)}（北京时间 UTC+8）`;
export function authTemplate(to: string, code: string, deadline: number): ServerMail {
  const text = `HoYo日历验证码：${code}\n有效截止：${new Date(deadline).toISOString()}（UTC）。\n请勿将验证码提供给他人；如果不是你本人操作，请忽略此邮件。`;
  return {
    channel: "auth",
    to,
    subject: "HoYo日历 · 邮箱验证码",
    text,
    html: `<p>${escapeHtml(text).replaceAll("\n", "<br>")}</p>`,
  };
}
export interface DigestNode {
  event_title: string;
  node_title: string;
  node_type: string;
  kind: string;
  time_exact_ms: number | null;
  time_date: string | null;
  time_precision: string;
  source_timezone: string;
  time_basis: string;
  raw_expression: string;
  reason: string | null;
  official_url: string | null;
  detail_path: string | null;
}
export function digestTemplate(
  to: string,
  nodes: readonly DigestNode[],
  origin: string,
  unsubscribe: { page: string; oneClick: string },
): ServerMail {
  if (nodes.length === 0) throw new MailDataError("empty_digest");
  const parts = nodes.map((node) => {
    if (!node.official_url || !node.detail_path) throw new MailDataError("missing_event_links");
    const time =
      node.time_precision === "datetime" && node.time_exact_ms !== null
        ? displayTime(node.time_exact_ms)
        : (node.time_date ?? "时间待官方确认");
    const late =
      node.kind === "late_discovery" && node.node_type === "start"
        ? "晚发现提示仅表示计划时间；不代表活动正在进行或尚未结束。"
        : "";
    return [
      node.event_title,
      `${node.node_title}（${Object.hasOwn(SUBSCRIPTION_NODE_TYPE_LABELS, node.node_type) ? SUBSCRIPTION_NODE_TYPE_LABELS[node.node_type as keyof typeof SUBSCRIPTION_NODE_TYPE_LABELS] : "日程节点"}）`,
      `通知类型：${node.kind === "rule" ? "常规提前提醒" : (SUBSCRIPTION_CHANGE_COPY.find((entry) => entry.key === node.kind)?.label ?? "日程更新")}`,
      `时间：${time}`,
      `源时区：${node.source_timezone}`,
      `时间依据：${Object.hasOwn(timeBasisCopy, node.time_basis) ? timeBasisCopy[node.time_basis as TimeBasis] : "时间依据待确认"}；${node.raw_expression}`,
      `变化原因：${node.reason ?? "官方日程发布或更新，详见来源"}`,
      late,
      `官方来源：${safeHttps(node.official_url)}`,
      `最新详情：${safeHttps(node.detail_path, origin)}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const links = {
    page: safeHttps(unsubscribe.page, origin),
    oneClick: safeHttps(unsubscribe.oneClick, origin),
  };
  const text = `HoYo日历 · 日程通知\n\n${parts.join("\n\n")}\n\n退订业务邮件：${links.page}`;
  // 所有数据库文字只作为文本转义；无任意 HTML、图片、附件。
  const html = `<div>${parts.map((part, index) => `<p>${escapeHtml(part).replaceAll("\n", "<br>")}</p><p><a href="${escapeHtml(safeHttps(nodes[index].official_url ?? ""))}">官方来源</a> · <a href="${escapeHtml(safeHttps(nodes[index].detail_path ?? "", origin))}">最新详情</a></p>`).join("")}<p><a href="${escapeHtml(links.page)}">退订业务邮件</a></p></div>`;
  return {
    channel: "business",
    to,
    subject: "HoYo日历 · 日程通知",
    text,
    html,
    unsubscribe: links,
  };
}
