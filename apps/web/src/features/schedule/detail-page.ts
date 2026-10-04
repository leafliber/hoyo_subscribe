import type { PublicEventDetailResponse } from "@hoyo/contracts";
import { el, emptyState, icon } from "../../lib/dom";
import { PublicApiClient, PublicReadError } from "../../lib/public-api/client";
import { openArticleDialog } from "./article-dialog";
import { renderEventDetail } from "./detail";
import { loadFeedback } from "./render";

// 从日程列表进入时，「返回」回到原筛选与滚动位置。
const back = document.querySelector<HTMLAnchorElement>("#back-link");
try {
  const referrer = document.referrer ? new URL(document.referrer) : null;
  if (back && referrer?.origin === location.origin && referrer.pathname === "/") {
    back.href = `/${referrer.search}`;
    back.addEventListener("click", (event) => {
      if (history.length > 1) {
        event.preventDefault();
        history.back();
      }
    });
  }
} catch {
  /* 无法解析来源时保持默认返回首页。 */
}

const target = document.querySelector<HTMLElement>("#event-detail");
if (target) {
  const output = target;
  const api = new PublicApiClient();
  let current: PublicEventDetailResponse | null = null;
  let failure: unknown = null;
  let busy = false;
  let missing = false;
  let retryAt = 0;
  let wake: ReturnType<typeof setTimeout> | undefined;
  let eventId: string | null = null;
  try {
    const match = /^\/events\/([^/]+)\/?$/.exec(location.pathname);
    if (match) eventId = decodeURIComponent(match[1]);
  } catch {
    /* malformed URL */
  }
  function refreshButton(label: string) {
    const button = el(
      "button",
      { type: "button", class: "button button--secondary", "data-action": "refresh" },
      icon("refresh"),
      label,
    );
    button.disabled = busy || Date.now() < retryAt || eventId === null;
    return button;
  }
  function render() {
    const opened = [...output.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
      (item) => item.dataset.disclosure ?? item.querySelector("summary")?.textContent,
    );
    const focused = output.querySelector('[data-action="refresh"]') === document.activeElement;
    const nodes: Node[] = [];
    if (current) {
      nodes.push(renderEventDetail(current));
      if (failure)
        nodes.push(
          el(
            "p",
            { class: "callout callout--warning data-warning", role: "status" },
            loadFeedback(failure, true),
          ),
        );
      const footer = el(
        "div",
        { class: "detail-footer" },
        busy ? el("p", { role: "status", class: "text-aux" }, "正在读取最新已发布事实…") : null,
        refreshButton(failure ? "重试加载" : "重新检查"),
      );
      nodes.push(footer);
    } else if (missing) {
      nodes.push(
        el(
          "div",
          { class: "card" },
          el("h1", { class: "sr-only" }, "活动详情"),
          emptyState(
            "search",
            "找不到这个活动",
            "当前发布代次没有此事件。它可能已被更正或合并，请返回日程查看最新安排。",
            el("a", { class: "button", href: "/" }, "返回日程"),
          ),
        ),
      );
    } else if (failure) {
      nodes.push(
        el(
          "div",
          { class: "card" },
          el("h1", { class: "sr-only" }, "活动详情"),
          emptyState("wifi-off", "暂时无法加载活动详情", null, refreshButton("重试加载")),
          el(
            "p",
            { class: "data-warning callout callout--warning detail-error", role: "status" },
            loadFeedback(failure, false),
          ),
        ),
      );
    } else {
      nodes.push(
        el(
          "div",
          { class: "detail-skeleton", role: "status" },
          el("h1", { class: "sr-only" }, "活动详情"),
          el("span", { class: "sr-only" }, "正在读取最新已发布事实…"),
          el("div", { class: "skeleton skeleton-title" }),
          el("div", { class: "skeleton skeleton-block" }),
          el("div", { class: "skeleton skeleton-block" }),
        ),
      );
    }
    output.replaceChildren(...nodes);
    output.setAttribute("aria-busy", String(busy));
    for (const detail of output.querySelectorAll<HTMLDetailsElement>("details"))
      if (
        opened.includes(detail.dataset.disclosure ?? detail.querySelector("summary")?.textContent)
      )
        detail.open = true;
    if (focused)
      output.querySelector<HTMLElement>('[data-action="refresh"]')?.focus({ preventScroll: true });
    if (current) document.title = `${current.event.title} · HoYo日历`;
    clearTimeout(wake);
    const due = [current ? current.cache.freshUntil + 1 : 0, retryAt].filter(
      (time) => time > Date.now(),
    );
    if (due.length) wake = setTimeout(render, Math.min(...due) - Date.now());
  }
  async function load(reload = false) {
    if (busy || Date.now() < retryAt) return;
    if (eventId === null) {
      missing = true;
      render();
      return;
    }
    busy = true;
    failure = null;
    render();
    try {
      current = await api.detail(eventId, undefined, reload);
      missing = false;
    } catch (error) {
      failure = error;
      retryAt = Date.now() + (error instanceof PublicReadError ? (error.retryAfterMs ?? 0) : 0);
      if (error instanceof PublicReadError && error.status === 404) {
        current = null;
        missing = true;
      }
    } finally {
      busy = false;
      render();
    }
  }
  output.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('[data-action="refresh"]')) void load(true);
    const reader = event.target.closest<HTMLElement>('[data-action="read-article"]');
    if (reader && current) openArticleDialog(current.event.id, current.event.official.url, reader);
  });
  window.addEventListener("offline", render);
  window.addEventListener("online", render);
  window.addEventListener("pageshow", render);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) render();
  });
  void load();
}
