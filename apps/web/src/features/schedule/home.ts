import {
  BROWSE_RANGES,
  browseSearch,
  defaultBrowseFilters,
  EVENT_NAMES,
  GAME_NAMES,
  NODE_NAMES,
  parseBrowseFilters,
} from "@hoyo/contracts";
import type { DemoScenario } from "./fixtures";
import { DEMO_SCENARIOS, demoSnapshot } from "./fixtures";
import type { LoadingState } from "./render";
import { renderResults } from "./render";

const form = document.querySelector<HTMLFormElement>("#browse-filters");
const results = document.querySelector<HTMLElement>("#schedule-results");
if (form && results) {
  const filterForm = form;
  const output = results;
  let filters = parseBrowseFilters(new URLSearchParams(location.search));
  let scenario: DemoScenario = "normal";
  let snapshot = demoSnapshot(Date.now(), scenario);
  let expanded = false;
  let loading: LoadingState = "ready";
  let loadFailureShown = false;
  let generation = 0;
  // 每个历史条目只存白名单浏览 UI 状态。没有草稿、身份、能力 URL。
  type BrowseHistory = {
    schedule?: { expanded: boolean; scroll: number; scenario: DemoScenario; more: boolean };
  };
  const currentHistory = (): BrowseHistory => history.state ?? {};
  function savePosition() {
    history.replaceState(
      {
        schedule: {
          expanded,
          scroll: scrollY,
          scenario,
          more: document.querySelector<HTMLDetailsElement>("#more-filters")?.open ?? false,
        },
      },
      "",
      location.href,
    );
  }
  function announce(message: string) {
    const target = document.getElementById("browse-announcement");
    if (target) target.textContent = message;
  }
  function render() {
    const active =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.action
        : undefined;
    output.innerHTML = renderResults({
      snapshot,
      filters,
      now: Date.now(),
      expanded,
      loading,
      offline: !navigator.onLine,
      stale: scenario === "stale",
    });
    if (active)
      output
        .querySelector<HTMLElement>(`[data-action="${active}"]`)
        ?.focus({ preventScroll: true });
    const summary = document.getElementById("browse-summary");
    const games =
      filters.games.length === defaultBrowseFilters().games.length
        ? "全部游戏"
        : filters.games.map((game) => GAME_NAMES[game]).join("、") || "未选择游戏";
    if (summary)
      summary.textContent = `${games} · ${BROWSE_RANGES.find((range) => range.id === filters.range)?.label}${filters.ending ? " · 临近截止" : ""}`;
    const more = document.getElementById("more-summary");
    if (more)
      more.textContent =
        [
          ...filters.events.map((type) => EVENT_NAMES[type]),
          ...filters.nodes.map((type) => NODE_NAMES[type]),
        ].join("、") || "事件类型、节点类型";
    for (const input of filterForm.querySelectorAll<HTMLInputElement>("input")) {
      if (input.name === "range") input.checked = filters.range === input.value;
      else if (input.name === "ending") input.checked = filters.ending;
      else
        input.checked = [...filters.games, ...filters.events, ...filters.nodes].some(
          (value) => value === input.value,
        );
    }
  }
  function writeUrl() {
    const search = browseSearch(filters);
    history.replaceState(currentHistory(), "", `${location.pathname}${search ? `?${search}` : ""}`);
  }
  function update() {
    generation++;
    loading = "ready";
    expanded = false;
    writeUrl();
    render();
    savePosition();
    announce("浏览筛选已更新，已保存订阅不受影响。");
  }
  filterForm.addEventListener("submit", (event) => event.preventDefault());
  filterForm.addEventListener("change", () => {
    const data = new FormData(filterForm);
    const params = new URLSearchParams();
    for (const key of ["games", "events", "nodes"]) params.set(key, data.getAll(key).join(","));
    params.set("range", String(data.get("range") ?? ""));
    params.set("ending", String(data.get("ending") ?? ""));
    filters = parseBrowseFilters(params);
    update();
  });
  function reset() {
    filters = defaultBrowseFilters();
    update();
  }
  document.getElementById("reset-filters")?.addEventListener("click", reset);
  async function load() {
    if (loading === "loading") return;
    const requestGeneration = generation;
    loading = "loading";
    render();
    announce("正在加载更多日程。");
    // synthetic 异步适配器，模拟失败恢复；不连接尚未定案的公共分页 API。
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (requestGeneration !== generation) return;
    if (scenario === "load" && !loadFailureShown) {
      loadFailureShown = true;
      loading = "failed";
      announce("加载失败，已有日程保留，请重试。");
    } else {
      expanded = true;
      loading = "ready";
      announce("已显示完当前范围。");
    }
    render();
    savePosition();
    (
      output.querySelector<HTMLElement>('[data-action="load"]') ??
      output.querySelector<HTMLElement>("#timeline-title")
    )?.focus({ preventScroll: true });
  }
  output.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    if (!target) return;
    if (target.dataset.action === "reset") {
      reset();
      document.getElementById("reset-filters")?.focus();
    }
    if (target.dataset.action === "widen") {
      const range = BROWSE_RANGES.find((item) => item.id === target.dataset.range);
      if (range) {
        filters.range = range.id;
        update();
        filterForm.querySelector<HTMLInputElement>('input[name="range"]:checked')?.focus();
      }
    }
    if (target.dataset.action === "load") void load();
    if (target.dataset.action === "retry-source")
      announce("样例来源状态未改变。正式来源检查将在后续接口联调时接入。");
  });
  const demo = document.querySelector<HTMLSelectElement>("#demo-scenario");
  demo?.addEventListener("change", () => {
    scenario = DEMO_SCENARIOS.find(([key]) => key === demo.value)?.[0] ?? "normal";
    snapshot = demoSnapshot(Date.now(), scenario);
    loadFailureShown = false;
    update();
  });
  function restore() {
    const state = currentHistory().schedule;
    if (state) {
      expanded = state.expanded;
      scenario = DEMO_SCENARIOS.find(([key]) => key === state.scenario)?.[0] ?? "normal";
      snapshot = demoSnapshot(Date.now(), scenario);
      if (demo) demo.value = scenario;
      const more = document.querySelector<HTMLDetailsElement>("#more-filters");
      if (more) more.open = state.more;
    }
    filters = parseBrowseFilters(new URLSearchParams(location.search));
    writeUrl();
    render();
    if (state) requestAnimationFrame(() => scrollTo(0, state.scroll));
  }
  window.addEventListener("pagehide", savePosition);
  window.addEventListener("pageshow", restore);
  window.addEventListener("popstate", restore);
  window.addEventListener("offline", render);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) render();
  });
  window.addEventListener("online", () => {
    render();
    announce("网络已恢复，当前仍为隔离样例数据。");
  });
  document.addEventListener(
    "click",
    (event) => {
      if (event.target instanceof Element && event.target.closest("a")) savePosition();
    },
    { capture: true },
  );
  restore();
}
