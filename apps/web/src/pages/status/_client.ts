import { GAME_NAMES } from "@hoyo/contracts";
import { el } from "../../features/schedule/dom";
import { sourceFeedback } from "../../features/schedule/source-status";
import { PublicApiClient } from "../../lib/public-api/client";

const api = new PublicApiClient();
const message = document.getElementById("release-status-message");
const facts = document.getElementById("release-status-facts");
const retry = document.getElementById("release-status-retry");
const capability = { open: "已开放", closed: "已关闭", unknown: "未知" } as const;
let busy = false;
let expiry: ReturnType<typeof setTimeout> | undefined;
async function refresh() {
  if (busy || !message || !facts) return;
  busy = true;
  clearTimeout(expiry);
  if (retry instanceof HTMLButtonElement) retry.disabled = true;
  message.textContent = "正在读取公开状态…";
  facts.replaceChildren();
  try {
    const status = await api.status(undefined, true);
    const stale = status.cache.stale || Date.now() > status.cache.freshUntil;
    message.textContent = stale
      ? "公开状态副本已过期，当前能力未知，请稍后刷新。"
      : "已读取公开状态；不代表提醒已送达。";
    const list = el("ul");
    for (const [label, value] of [
      ["注册", status.registration_open ? "已开放" : "已关闭"],
      ["邮件发送", status.mail_sending_available ? "已开放" : "已关闭"],
      ["日历", capability[status.capabilities.calendar]],
      ["邮件新席位", capability[status.capabilities.email_seats]],
      ["常规邮件", capability[status.capabilities.routine_email]],
      ["浏览器推送", capability[status.capabilities.push]],
    ])
      list.append(el("li", {}, `${label}：${stale ? "未知（副本过期）" : value}`));
    facts.append(el("h2", {}, "能力开放状态"), list);
    if (!stale)
      expiry = setTimeout(
        () => {
          message.textContent = "公开状态副本已过期，当前能力未知，请稍后刷新。";
          for (const item of list.children)
            item.textContent = `${item.textContent?.split("：")[0]}：未知（副本过期）`;
        },
        Math.max(0, status.cache.freshUntil - Date.now() + 1),
      );
    facts.append(
      el("h2", {}, "公开数据"),
      el(
        "p",
        {},
        status.publication
          ? `发布代次：${status.publication.generation}`
          : "发布代次未知，不能视为没有活动。",
      ),
    );
    const sources = el("ul");
    for (const source of status.sources ?? [])
      sources.append(
        el(
          "li",
          {},
          `${GAME_NAMES[source.game]} / ${source.sourceId}：${sourceFeedback(source).label}；最近成功：${source.verifiedAt === null ? "未知" : new Date(source.verifiedAt).toISOString()}`,
        ),
      );
    facts.append(
      status.sources === null
        ? el("p", {}, "来源状态未知。")
        : status.sources.length === 0
          ? el("p", {}, "接口未登记来源，不能视为全部正常。")
          : sources,
    );
    const gaps = el("ul");
    for (const gap of status.reviewGaps)
      gaps.append(
        el(
          "li",
          {},
          `${GAME_NAMES[gap.game]} 待审核缺口：${gap.count === null ? "未知" : gap.count}`,
        ),
      );
    facts.append(
      gaps,
      el("p", {}, `公开副本有效至：${new Date(status.cache.freshUntil).toISOString()}（UTC）`),
    );
  } catch {
    message.textContent = "公开状态读取失败，当前状态未知。请稍后刷新，或查看帮助中的限制说明。";
  } finally {
    busy = false;
    if (retry instanceof HTMLButtonElement) retry.disabled = false;
  }
}
retry?.addEventListener("click", () => void refresh());
void refresh();
