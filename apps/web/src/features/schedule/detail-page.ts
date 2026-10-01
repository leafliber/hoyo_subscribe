import type { PublicEventDetailResponse } from "@hoyo/contracts";
import { PublicApiClient, PublicReadError } from "../../lib/public-api/client";
import { renderEventDetail } from "./detail";
import { button, el } from "./dom";
import { loadFeedback } from "./render";

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
  function render() {
    const opened = [...output.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
      (item) => item.dataset.disclosure ?? item.querySelector("summary")?.textContent,
    );
    const focused = output.querySelector('[data-action="refresh"]') === document.activeElement;
    const nodes: Node[] = [];
    if (current) nodes.push(renderEventDetail(current));
    else nodes.push(el("h1", {}, "事件详情"));
    if (missing)
      nodes.push(
        el("p", { role: "status" }, "当前发布代次没有此事件。请返回日程查看最新安排。"),
        el("a", { href: "/" }, "返回日程"),
      );
    else if (failure)
      nodes.push(el("p", { class: "data-warning", role: "status" }, loadFeedback(failure)));
    if (busy) nodes.push(el("p", { role: "status" }, "正在读取最新已发布事实…"));
    const refresh = button(failure ? "重试加载" : "重新检查", "refresh");
    refresh.disabled = busy || Date.now() < retryAt || eventId === null;
    nodes.push(refresh);
    output.replaceChildren(...nodes);
    output.setAttribute("aria-busy", String(busy));
    for (const detail of output.querySelectorAll<HTMLDetailsElement>("details"))
      if (
        opened.includes(detail.dataset.disclosure ?? detail.querySelector("summary")?.textContent)
      )
        detail.open = true;
    if (focused) refresh.focus({ preventScroll: true });
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
    if (event.target instanceof Element && event.target.closest('[data-action="refresh"]'))
      void load(true);
  });
  window.addEventListener("offline", render);
  window.addEventListener("online", render);
  window.addEventListener("pageshow", render);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) render();
  });
  void load();
}
