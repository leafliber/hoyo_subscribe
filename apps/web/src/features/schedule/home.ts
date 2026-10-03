import {
  BROWSE_RANGES,
  browseSearch,
  defaultBrowseFilters,
  EVENT_NAMES,
  GAME_NAMES,
  NODE_NAMES,
  parseBrowseFilters,
} from "@hoyo/contracts";
import { relative, remaining } from "../../lib/format";
import { ScheduleLoader } from "./load";
import { renderAside, renderResults } from "./render";

const form = document.querySelector<HTMLFormElement>("#browse-filters");
const results = document.querySelector<HTMLElement>("#schedule-results");
const aside = document.querySelector<HTMLElement>("#schedule-aside-dynamic");
if (form && results) {
  const filterForm = form;
  const output = results;
  let filters = parseBrowseFilters(new URLSearchParams(location.search));
  let restoreScroll: number | null =
    typeof history.state?.schedule?.scroll === "number" ? history.state.schedule.scroll : null;
  const moreFilters = document.querySelector<HTMLDetailsElement>("#more-filters");
  if (moreFilters && typeof history.state?.schedule?.more === "boolean")
    moreFilters.open = history.state.schedule.more;
  window.addEventListener("pagehide", () =>
    history.replaceState(
      { schedule: { scroll: scrollY, more: moreFilters?.open ?? false } },
      "",
      location.href,
    ),
  );
  let wake: ReturnType<typeof setTimeout> | undefined;
  const loader = new ScheduleLoader(render);

  function openDisclosures(root: HTMLElement): string[] {
    return [...root.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
      (item) => item.dataset.disclosure ?? item.className,
    );
  }
  function restoreDisclosures(root: HTMLElement, opened: string[]): void {
    for (const detail of root.querySelectorAll<HTMLDetailsElement>("details"))
      if (opened.includes(detail.dataset.disclosure ?? detail.className)) detail.open = true;
  }

  function render() {
    const opened = openDisclosures(output);
    const asideOpened = aside ? openDisclosures(aside) : [];
    const focusKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.focus
        : undefined;
    const active =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.action
        : undefined;
    output.replaceChildren(renderResults(loader.state, filters));
    output.setAttribute("aria-busy", String(loader.state.phase === "loading"));
    restoreDisclosures(output, opened);
    if (aside) {
      aside.replaceChildren(renderAside(loader.state, filters));
      restoreDisclosures(aside, asideOpened);
    }
    if (active)
      document
        .querySelector<HTMLElement>(`.schedule-layout [data-action="${active}"]`)
        ?.focus({ preventScroll: true });
    if (focusKey)
      output
        .querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`)
        ?.focus({ preventScroll: true });
    for (const action of document.querySelectorAll<HTMLButtonElement>(
      '.schedule-layout [data-action="refresh"]',
    ))
      action.disabled = loader.state.phase === "loading" || Date.now() < loader.state.retryAt;
    if (restoreScroll !== null && loader.state.phase === "ready") {
      const position = restoreScroll;
      restoreScroll = null;
      requestAnimationFrame(() => scrollTo(0, position));
    }
    const announcement = document.getElementById("browse-announcement");
    if (announcement)
      announcement.textContent =
        loader.state.phase === "loading"
          ? "正在加载公开日程。"
          : loader.state.phase === "failed"
            ? "加载失败，已有条目保留，可重试。"
            : "已显示完当前范围。";
    clearTimeout(wake);
    const deadlines = [
      ...loader.state.pages.map((page) => page.cache.freshUntil + 1),
      loader.state.status?.cache.freshUntil === undefined
        ? 0
        : loader.state.status.cache.freshUntil + 1,
      loader.state.retryAt,
    ].filter((time) => time > Date.now());
    if (deadlines.length) wake = setTimeout(render, Math.min(...deadlines) - Date.now());
  }

  /** 每分钟只刷新相对时间文字，不重建列表、不发请求。 */
  function tick() {
    const now = Date.now();
    for (const node of document.querySelectorAll<HTMLElement>("[data-relative-to]")) {
      const target = Number(node.dataset.relativeTo);
      if (!Number.isFinite(target)) continue;
      const text =
        node.dataset.relativeMode === "remaining" && target > now
          ? remaining(target, now)
          : relative(target, now);
      if (text && node.textContent !== text) node.textContent = text;
    }
  }
  setInterval(tick, 60_000);

  function isDefault(): boolean {
    return browseSearch(filters) === "";
  }

  function updateControls() {
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${browseSearch(filters) ? `?${browseSearch(filters)}` : ""}`,
    );
    const summary = document.getElementById("browse-summary");
    if (summary) {
      const games =
        filters.games.length === 0
          ? "未选择游戏"
          : filters.games.length === 3
            ? "全部游戏"
            : filters.games.map((g) => GAME_NAMES[g]).join("、");
      summary.textContent = `${games} · ${BROWSE_RANGES.find((r) => r.id === filters.range)?.label}${filters.ending ? " · 只看截止" : ""}`;
    }
    const reset = document.getElementById("reset-filters");
    if (reset) reset.hidden = isDefault();
    const more = document.getElementById("more-summary");
    const selected = [
      ...filters.events.map((v) => EVENT_NAMES[v]),
      ...filters.nodes.map((v) => NODE_NAMES[v]),
    ];
    if (more) {
      more.textContent = selected.length ? `${selected.length}` : "";
      more.hidden = selected.length === 0;
      more.title = selected.join("、");
    }
    for (const input of filterForm.querySelectorAll<HTMLInputElement>("input")) {
      input.checked =
        input.name === "range"
          ? input.value === filters.range
          : input.name === "ending"
            ? filters.ending
            : [...filters.games, ...filters.events, ...filters.nodes].some(
                (value) => value === input.value,
              );
    }
  }
  function update(remote = true) {
    updateControls();
    if (remote) loader.start({ range: filters.range, games: filters.games });
    else render();
  }
  filterForm.addEventListener("submit", (event) => event.preventDefault());
  filterForm.addEventListener("change", (event) => {
    const data = new FormData(filterForm);
    const params = new URLSearchParams();
    for (const key of ["games", "events", "nodes"]) params.set(key, data.getAll(key).join(","));
    params.set("range", String(data.get("range") ?? ""));
    params.set("ending", String(data.get("ending") ?? ""));
    filters = parseBrowseFilters(params);
    update(
      event.target instanceof HTMLInputElement && ["games", "range"].includes(event.target.name),
    );
  });
  function reset() {
    filters = defaultBrowseFilters();
    update();
  }
  document.getElementById("reset-filters")?.addEventListener("click", () => {
    reset();
    filterForm.querySelector<HTMLInputElement>('input[name="games"]')?.focus();
  });
  document.querySelector(".schedule-layout")?.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    if (target?.dataset.action === "reset") {
      reset();
      filterForm.querySelector<HTMLInputElement>('input[name="games"]')?.focus();
    }
    if (target?.dataset.action === "widen") {
      const range = BROWSE_RANGES.find((item) => item.id === target.dataset.range);
      if (range) {
        filters.range = range.id;
        update();
        filterForm.querySelector<HTMLInputElement>('input[name="range"]:checked')?.focus();
      }
    }
    if (target?.dataset.action === "retry") loader.retry();
    if (target?.dataset.action === "refresh" && loader.state.phase !== "loading")
      loader.start({ range: filters.range, games: filters.games }, true);
  });
  window.addEventListener("offline", render);
  window.addEventListener("online", render);
  window.addEventListener("pageshow", () => {
    if (loader.state.pages.length) render();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      tick();
      render();
    }
  });
  window.addEventListener("popstate", () => {
    filters = parseBrowseFilters(new URLSearchParams(location.search));
    update();
  });
  update();
}
