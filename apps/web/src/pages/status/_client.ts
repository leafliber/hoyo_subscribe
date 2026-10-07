import { GAME_NAMES, PUBLIC_SOURCE_KIND_LABELS } from "@hoyo/contracts";
import { sourceFeedback } from "../../features/schedule/source-status";
import { type BadgeKind, badge, el, icon } from "../../lib/dom";
import { stamp } from "../../lib/format";
import { gameIcon } from "../../lib/game-icons";
import { PublicApiClient } from "../../lib/public-api/client";

const api = new PublicApiClient();
const message = document.getElementById("release-status-message");
const facts = document.getElementById("release-status-facts");
const retry = document.getElementById("release-status-retry");
const capability = { open: "已开放", closed: "已关闭", unknown: "未知" } as const;
const kindOf = (text: string): BadgeKind =>
  text === "已开放" ? "success" : text === "已关闭" ? "neutral" : "warning";
let busy = false;
let expiry: ReturnType<typeof setTimeout> | undefined;

function setMessage(text: string, kind: "info" | "success" | "warning") {
  if (!message) return;
  message.textContent = text;
  message.className = `status-banner callout callout--${kind}`;
}

function capabilityTile(label: string, desc: string, value: string, stale: boolean) {
  const shown = stale ? "未知（副本过期）" : value;
  return el(
    "li",
    { class: "status-tile", "data-capability": label },
    el(
      "div",
      {},
      el("p", { class: "status-tile-title" }, label),
      el("p", { class: "status-tile-desc" }, desc),
    ),
    el("span", { class: "status-tile-value" }, badge(shown, stale ? "warning" : kindOf(value))),
    el("span", { class: "sr-only" }, `${label}：${shown}`),
  );
}

async function refresh() {
  if (busy || !message || !facts) return;
  busy = true;
  clearTimeout(expiry);
  if (retry instanceof HTMLButtonElement) retry.disabled = true;
  setMessage("正在读取公开状态…", "info");
  // ADR-0032：刷新期间保留上一次读到的内容（不整块清空再出现）；读完整体换上，失败才清空。
  facts.setAttribute("aria-busy", "true");
  try {
    const status = await api.status(undefined, true);
    const stale = status.cache.stale || Date.now() > status.cache.freshUntil;
    setMessage(
      stale
        ? "公开状态副本已过期，当前能力未知，请稍后刷新。"
        : "已读取公开状态（不代表提醒已送达）。",
      stale ? "warning" : "success",
    );
    const tiles: [string, string, string][] = [
      ["注册", "新用户注册", status.registration_open ? "已开放" : "已关闭"],
      ["邮件发送", "验证码与通知邮件", status.mail_sending_available ? "已开放" : "已关闭"],
      ["日历", "启用个人日历订阅", capability[status.capabilities.calendar]],
      ["邮件新席位", "开启邮件通知", capability[status.capabilities.email_seats]],
      ["常规邮件", "常规提醒与新活动邮件", capability[status.capabilities.routine_email]],
      ["浏览器通知", "在当前浏览器接收提醒（可选）", capability[status.capabilities.push]],
    ];
    const list = el(
      "ul",
      { class: "status-tiles list-plain" },
      ...tiles.map(([label, desc, value]) => capabilityTile(label, desc, value, stale)),
    );
    const sections: Node[] = [];
    sections.push(
      el(
        "section",
        { class: "card info-section", "aria-labelledby": "capability-heading" },
        el("h2", { id: "capability-heading" }, "能力开放状态"),
        list,
      ),
    );
    if (!stale)
      expiry = setTimeout(
        () => {
          setMessage("公开状态副本已过期，当前能力未知，请稍后刷新。", "warning");
          list.replaceChildren(
            ...tiles.map(([label, desc, value]) => capabilityTile(label, desc, value, true)),
          );
        },
        Math.max(0, status.cache.freshUntil - Date.now() + 1),
      );

    const data = el(
      "section",
      { class: "card info-section", "aria-labelledby": "data-heading" },
      el("h2", { id: "data-heading" }, "公开数据"),
      el(
        "p",
        { class: "status-publication" },
        icon("calendar"),
        status.publication
          ? `日程第 ${status.publication.generation} 版，发布于 ${stamp(status.publication.publishedAt)}`
          : "尚无已发布的日程（发布代次未知，不能视为没有活动）。",
      ),
    );
    if (status.sources === null) data.append(el("p", {}, "来源状态未知。"));
    else if (status.sources.length === 0)
      data.append(el("p", { class: "text-secondary" }, "接口未登记来源，不能视为全部正常。"));
    else
      data.append(
        el(
          "ul",
          { class: "list-plain source-rows" },
          ...status.sources.map((source) => {
            const feedback = sourceFeedback(source);
            return el(
              "li",
              { "data-source": source.sourceId },
              el(
                "span",
                { class: "game-tag", "data-game": source.game },
                gameIcon(source.game),
                GAME_NAMES[source.game],
              ),
              // ADR-0030：同一游戏有公告与直播兑换码两个来源，写明用途。
              el("span", { class: "source-kind" }, PUBLIC_SOURCE_KIND_LABELS[source.kind]),
              el("span", { class: "source-id" }, source.sourceId),
              badge(feedback.label, feedback.affected ? "warning" : "success"),
              el("span", { class: "source-time" }, `最近成功：${stamp(source.verifiedAt)}`),
            );
          }),
        ),
      );
    data.append(
      el(
        "ul",
        { class: "list-plain gap-rows" },
        ...status.reviewGaps.map((gap) =>
          el(
            "li",
            {},
            `${GAME_NAMES[gap.game]} 待审核缺口：${gap.count === null ? "未知" : gap.count}`,
          ),
        ),
      ),
      el("p", { class: "text-aux" }, `公开副本有效至：${stamp(status.cache.freshUntil)}`),
    );
    sections.push(data);
    facts.replaceChildren(...sections);
  } catch {
    facts.replaceChildren();
    setMessage("公开状态读取失败，当前状态未知。请稍后刷新，或查看帮助中的限制说明。", "warning");
  } finally {
    facts.removeAttribute("aria-busy");
    busy = false;
    if (retry instanceof HTMLButtonElement) retry.disabled = false;
  }
}
retry?.addEventListener("click", () => void refresh());
void refresh();
