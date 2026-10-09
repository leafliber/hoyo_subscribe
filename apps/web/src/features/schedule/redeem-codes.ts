/**
 * ADR-0030 「有效兑换码」条：米游社官方直播页接口取得、仍在显示期内的兑换码。
 * 有可显示的兑换码时才出现（按首页选中的游戏），没有时整块隐藏、不占位。
 * 每条可一键复制；到截止时间自动从条里移除，不必重新请求（ADR-0034：没有截止时间的，服务端在
 * 官方不再列出时收回，页面只按跟踪期满兜底）。
 * 兑换码、奖励说明都按文本写入，不执行任何来自接口的 HTML。
 */
import type { GameId, PublicRedeemCode } from "@hoyo/contracts";
import { el, icon } from "../../lib/dom";
import { dateTime, remaining } from "../../lib/format";
import { GAME_SHORT_NAMES, gameIcon } from "../../lib/game-icons";
import { copyText, toast } from "../../lib/toast";

/** 当前应显示的兑换码：选中的游戏、已发放、未到隐藏时刻。顺序按发放时刻（接口已排好）。 */
export function visibleRedeemCodes(
  codes: readonly PublicRedeemCode[],
  games: readonly GameId[],
  now: number,
): PublicRedeemCode[] {
  return codes.filter(
    (code) => games.includes(code.game) && code.revealedAt <= now && now < code.hiddenAt,
  );
}

function expiryText(code: PublicRedeemCode, now: number): string {
  // ADR-0034：没有截止时间时只提示尽快兑换（所有者 2026-10-09 定的文案）。
  if (code.expiresAt === null) return "请尽快兑换";
  const left = remaining(code.expiresAt, now);
  return `${dateTime(code.expiresAt)} 过期${left ? ` · ${left}` : ""}`;
}

function item(code: PublicRedeemCode, now: number): HTMLElement {
  return el(
    "li",
    {
      class: "redeem-item",
      "data-redeem": `${code.game}:${code.code}`,
      "data-game": code.game,
      "data-hidden-at": code.hiddenAt,
    },
    el(
      "div",
      { class: "redeem-top" },
      gameIcon(code.game, "game-icon"),
      el("span", { class: "redeem-game" }, GAME_SHORT_NAMES[code.game]),
      el(
        "a",
        {
          class: "redeem-live",
          href: code.eventId ? `/events/${encodeURIComponent(code.eventId)}` : code.officialUrl,
          ...(code.eventId ? {} : { target: "_blank", rel: "noopener noreferrer" }),
          title: code.liveTitle,
        },
        code.liveTitle,
      ),
    ),
    el(
      "div",
      { class: "redeem-code-row" },
      el("code", { class: "redeem-code", translate: "no" }, code.code),
      el(
        "button",
        {
          type: "button",
          class: "redeem-copy",
          "data-copy": code.code,
          "aria-label": `复制兑换码 ${code.code}`,
        },
        icon("copy"),
        "复制",
      ),
    ),
    code.reward ? el("p", { class: "redeem-reward" }, code.reward) : null,
    el(
      "p",
      {
        class: `redeem-expiry${code.expiresAt === null ? " is-undated" : ""}`,
        "data-expiry": code.expiresAt ?? "",
      },
      expiryText(code, now),
    ),
  );
}

/** 条的内容；没有可显示的兑换码时返回 null（调用方隐藏整块）。 */
export function renderRedeemBar(
  codes: readonly PublicRedeemCode[] | null,
  games: readonly GameId[],
  now: number,
): HTMLElement[] | null {
  const shown = codes === null ? [] : visibleRedeemCodes(codes, games, now);
  if (shown.length === 0) return null;
  return [
    el(
      "div",
      { class: "redeem-head" },
      el(
        "h2",
        { id: "redeem-title", class: "redeem-heading" },
        el("span", { class: "redeem-mark", "aria-hidden": "true" }, icon("gift")),
        "有效兑换码",
      ),
      el("p", { class: "redeem-sub" }, "来自米游社官方直播页，点击复制"),
    ),
    el("ul", { class: "redeem-list" }, ...shown.map((code) => item(code, now))),
  ];
}

/** 复制按钮：成功给轻提示；剪贴板不可用时选中兑换码文字，方便手动复制。 */
export function bindRedeemCopy(root: HTMLElement): void {
  root.addEventListener("click", async (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-copy]")
        : null;
    const value = button?.dataset.copy;
    if (!button || !value) return;
    if (await copyText(value)) {
      toast(`已复制兑换码 ${value}`);
      return;
    }
    const code = button.closest(".redeem-code-row")?.querySelector(".redeem-code");
    if (code) {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    toast("无法写入剪贴板，已选中兑换码，请手动复制");
  });
}

/** 每分钟：刷新"还剩多久"；返回下一次有条目到点隐藏的时刻（没有为 null）。 */
export function tickRedeemBar(root: HTMLElement, now: number): void {
  for (const node of root.querySelectorAll<HTMLElement>(".redeem-expiry[data-expiry]")) {
    const expiresAt = Number(node.dataset.expiry);
    if (!node.dataset.expiry || !Number.isFinite(expiresAt)) continue;
    const left = remaining(expiresAt, now);
    const text = `${dateTime(expiresAt)} 过期${left ? ` · ${left}` : ""}`;
    if (node.textContent !== text) node.textContent = text;
  }
}

/** 条里是否有已到隐藏时刻的条目（页面每秒检查一次，睡眠唤醒或计时器漂移后也能及时移除）。 */
export function redeemBarExpired(root: HTMLElement, now: number): boolean {
  for (const item of root.querySelectorAll<HTMLElement>(".redeem-item[data-hidden-at]"))
    if (Number(item.dataset.hiddenAt) <= now) return true;
  return false;
}

/** 最近一个要从条里移除的时刻，供页面定时重绘。 */
export function nextRedeemChange(
  codes: readonly PublicRedeemCode[] | null,
  games: readonly GameId[],
  now: number,
): number | null {
  if (codes === null) return null;
  let next: number | null = null;
  for (const code of codes) {
    if (!games.includes(code.game)) continue;
    const at = code.revealedAt > now ? code.revealedAt : code.hiddenAt > now ? code.hiddenAt : null;
    if (at !== null && (next === null || at < next)) next = at;
  }
  return next;
}
