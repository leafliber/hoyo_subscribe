import {
  BROWSE_RANGES,
  browseSearch,
  deadlineUrgency,
  defaultBrowseFilters,
  EVENT_NAMES,
  GAME_NAMES,
  NODE_NAMES,
  parseBrowseFilters,
} from "@hoyo/contracts";
import { clock, relative, remaining } from "../../lib/format";
import { ScheduleLoader } from "./load";
import { HOME_RANGES, homeRange } from "./ranges";
import {
  bindRedeemCopy,
  nextRedeemChange,
  redeemBarExpired,
  renderRedeemBar,
  tickRedeemBar,
} from "./redeem-codes";
import { countdownValue, renderAside, renderEndingSoon, renderResults } from "./render";

const form = document.querySelector<HTMLFormElement>("#browse-filters");
const results = document.querySelector<HTMLElement>("#schedule-results");
const aside = document.querySelector<HTMLElement>("#schedule-aside-dynamic");
const ending = document.querySelector<HTMLElement>("#ending-soon");
const redeemBar = document.querySelector<HTMLElement>("#redeem-codes");
const pageRoot = document.querySelector<HTMLElement>(".schedule-page");

/** 白名单解析后再把已下线的档位映射到首页档位（旧链接 range=90d → 全部）。 */
function readFilters(params: URLSearchParams) {
  const filters = parseBrowseFilters(params);
  filters.range = homeRange(filters.range);
  return filters;
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

if (form && results) {
  const filterForm = form;
  const output = results;
  let filters = readFilters(new URLSearchParams(location.search));
  let restoreScroll: number | null =
    typeof history.state?.schedule?.scroll === "number" ? history.state.schedule.scroll : null;
  window.addEventListener("pagehide", () =>
    history.replaceState({ schedule: { scroll: scrollY } }, "", location.href),
  );
  let wake: ReturnType<typeof setTimeout> | undefined;
  const loader = new ScheduleLoader(render);
  /** 已经展示过的条目：只有新出现的条目播放入场动效，加载续页或刷新时旧条目不闪动。 */
  let shownRows = new Set<string>();
  let shownCards = new Set<string>();
  /**
   * "显示更多"期间以列表里最后一天为锚（ADR-0017）：上方区块（即将截止、提示）重绘时视口不跳，
   * 下一档的条目接在这一天之后、原末行的位置出现。
   */
  let anchoring = false;
  const rangeLabel = (range: string) => BROWSE_RANGES.find((item) => item.id === range)?.label;
  function lastDay(): HTMLElement | null {
    const days = output.querySelectorAll<HTMLElement>('[data-region="days"] > .schedule-day');
    return days[days.length - 1] ?? null;
  }

  function openDisclosures(root: HTMLElement): string[] {
    return [...root.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
      (item) => item.dataset.disclosure ?? item.className,
    );
  }
  function restoreDisclosures(root: HTMLElement, opened: string[]): void {
    for (const detail of root.querySelectorAll<HTMLDetailsElement>("details"))
      if (opened.includes(detail.dataset.disclosure ?? detail.className)) detail.open = true;
  }
  function markEntering(root: ParentNode, attribute: string, previous: Set<string>): Set<string> {
    const current = new Set<string>();
    let order = 0;
    for (const item of root.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
      const id = item.getAttribute(attribute);
      if (!id) continue;
      current.add(id);
      if (previous.has(id)) continue;
      item.classList.add("is-entering");
      item.style.setProperty("--enter-delay", `${Math.min(order, 10) * 45}ms`);
      order++;
    }
    return current;
  }

  function render() {
    const anchor = anchoring ? lastDay() : null;
    const anchorDate = anchor?.dataset.date;
    const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
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
    shownRows = markEntering(output, "data-node", shownRows);
    if (ending) {
      const parts = renderEndingSoon(loader.state, filters);
      ending.hidden = parts === null;
      ending.setAttribute(
        "aria-busy",
        String(loader.state.phase === "loading" && loader.state.pages.length === 0),
      );
      if (parts) ending.replaceChildren(...parts);
      shownCards = markEntering(ending, "data-ending", parts ? shownCards : new Set());
    }
    if (aside) {
      aside.replaceChildren(renderAside(loader.state, filters));
      restoreDisclosures(aside, asideOpened);
    }
    // ADR-0030：有可显示的兑换码才出现，按选中的游戏筛；没有时整块隐藏、不占位。
    if (redeemBar) {
      const parts = renderRedeemBar(loader.state.redeem?.codes ?? null, filters.games, Date.now());
      redeemBar.hidden = parts === null;
      redeemBar.replaceChildren(...(parts ?? []));
    }
    if (active) {
      const target = pageRoot?.querySelector<HTMLElement>(`[data-action="${active}"]`);
      // 已到最大一档时"显示更多"不再出现：焦点留在末行，不掉回页首。
      const fallback =
        active === "show-more" ? output.querySelector<HTMLElement>(".load-row") : null;
      (target ?? fallback)?.focus({ preventScroll: true });
    }
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
    if (anchorDate) {
      const again = output.querySelector<HTMLElement>(
        `[data-region="days"] > [data-date="${CSS.escape(anchorDate)}"]`,
      );
      const shift = again ? again.getBoundingClientRect().top - anchorTop : 0;
      if (shift) scrollBy({ top: shift, behavior: "instant" });
    }
    if (anchoring && loader.state.extending === null) anchoring = false;
    const shown = loader.state.loadedRange ?? filters.range;
    const announcement = document.getElementById("browse-announcement");
    if (announcement)
      announcement.textContent =
        loader.state.phase === "loading"
          ? loader.state.extending
            ? `正在加载${rangeLabel(loader.state.extending)}。`
            : "正在加载公开日程。"
          : loader.state.phase === "failed"
            ? "加载失败，已有条目保留，可重试。"
            : shown === "all"
              ? "已显示完全部日程。"
              : `已显示完${rangeLabel(shown)}。`;
    clearTimeout(wake);
    const deadlines = [
      ...loader.state.pages.map((page) => page.cache.freshUntil + 1),
      loader.state.status?.cache.freshUntil === undefined
        ? 0
        : loader.state.status.cache.freshUntil + 1,
      loader.state.retryAt,
      nextRedeemChange(loader.state.redeem?.codes ?? null, filters.games, Date.now()) ?? 0,
    ].filter((time) => time > Date.now());
    if (deadlines.length) wake = setTimeout(render, Math.min(...deadlines) - Date.now());
  }

  /** 每分钟：相对时间文字、过去/未来分界与「现在」标记；不重建列表、不发请求。 */
  function tick() {
    const now = Date.now();
    if (redeemBar && !redeemBar.hidden) tickRedeemBar(redeemBar, now);
    for (const node of document.querySelectorAll<HTMLElement>("[data-relative-to]")) {
      const target = Number(node.dataset.relativeTo);
      if (!Number.isFinite(target)) continue;
      const counting = node.dataset.relativeMode === "remaining" && target > now;
      const text = counting ? remaining(target, now) : relative(target, now);
      if (text && node.textContent !== text) node.textContent = text;
      // 截止类剩余时间进入 24 小时即标为高危；过了时间转为已过。
      node.classList.toggle("is-past", target <= now);
      node.classList.toggle("is-critical", counting && deadlineUrgency(target, now) === "critical");
    }
    for (const row of output.querySelectorAll<HTMLElement>(".schedule-node[data-time]"))
      row.classList.toggle("is-past", Number(row.dataset.time) <= now);
    for (const marker of output.querySelectorAll<HTMLElement>(".now-marker")) {
      const label = marker.querySelector<HTMLElement>("[data-now-clock]");
      if (label) label.textContent = clock(now);
      const list = marker.parentElement;
      if (!list) continue;
      const next = [...list.querySelectorAll<HTMLElement>(":scope > [data-time]")].find(
        (row) => Number(row.dataset.time) > now,
      );
      if (next && marker.nextElementSibling !== next) list.insertBefore(marker, next);
      if (!next && list.lastElementChild !== marker) list.append(marker);
    }
  }
  /** 每秒：只更新倒计时数字与紧迫程度；有条目到点时整体重绘一次，把它移出「即将截止」。 */
  function tickCountdowns() {
    const now = Date.now();
    let expired = false;
    for (const value of document.querySelectorAll<HTMLElement>("[data-countdown-to]")) {
      const target = Number(value.dataset.countdownTo);
      if (!Number.isFinite(target)) continue;
      if (target <= now) {
        expired = true;
        continue;
      }
      const parts = countdownValue(target, now);
      const text = parts.map((part) => part.textContent).join("");
      if (value.textContent !== text) value.replaceChildren(...parts);
      const card = value.closest<HTMLElement>(".ending-card");
      const level = `is-${deadlineUrgency(target, now)}`;
      if (card && !card.classList.contains(level)) {
        card.classList.remove("is-critical", "is-soon", "is-later");
        card.classList.add(level);
      }
    }
    // ADR-0030：兑换码到点（官方有效期或显示上限）从条里移除。
    if (redeemBar && !redeemBar.hidden && redeemBarExpired(redeemBar, now)) expired = true;
    if (expired) render();
  }
  let lastMinute = Math.floor(Date.now() / 60_000);
  setInterval(() => {
    tickCountdowns();
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== lastMinute) {
      lastMinute = minute;
      tick();
    }
  }, 1000);

  function isDefault(): boolean {
    return browseSearch(filters) === "";
  }

  /** 时间范围的滑块：量出选中项的位置，交给 CSS 过渡；首次定位不播放动画。 */
  const rangeGroup = filterForm.querySelector<HTMLElement>(".range-options");
  function placeThumb() {
    const checked = rangeGroup
      ?.querySelector<HTMLInputElement>('input[name="range"]:checked')
      ?.closest<HTMLElement>("label");
    if (!rangeGroup || !checked?.offsetWidth) return;
    rangeGroup.style.setProperty("--thumb-x", `${checked.offsetLeft}px`);
    rangeGroup.style.setProperty("--thumb-w", `${checked.offsetWidth}px`);
    if (!rangeGroup.classList.contains("has-thumb")) {
      rangeGroup.classList.add("has-thumb");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => rangeGroup.classList.add("thumb-ready")),
      );
    }
  }
  window.addEventListener("resize", placeThumb);
  void document.fonts?.ready.then(placeThumb);

  /** 筛选栏：吸顶时显示毛玻璃底；单行放不下时按滚动位置给两端加渐隐提示。 */
  const scroller = filterForm.querySelector<HTMLElement>(".filter-scroller");
  let frame = 0;
  function measureBar() {
    frame = 0;
    const header = document.querySelector<HTMLElement>(".app-header")?.offsetHeight ?? 0;
    filterForm.classList.toggle(
      "is-stuck",
      scrollY > 0 && filterForm.getBoundingClientRect().top <= header + 0.5,
    );
    if (scroller) {
      const end = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft;
      scroller.classList.toggle("fade-start", scroller.scrollLeft > 4);
      scroller.classList.toggle("fade-end", end > 4);
    }
  }
  const scheduleMeasure = () => {
    if (frame) return;
    frame = requestAnimationFrame(measureBar);
  };
  window.addEventListener("scroll", scheduleMeasure, { passive: true });
  window.addEventListener("resize", scheduleMeasure);
  scroller?.addEventListener("scroll", scheduleMeasure, { passive: true });
  scheduleMeasure();

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
    // 时间范围收进「筛选」后（ADR-0017），按钮上始终写明当前档位。
    const moreRange = document.getElementById("more-range");
    if (moreRange) moreRange.textContent = rangeLabel(filters.range) ?? "";
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
    const moreClear = document.getElementById("more-clear");
    if (moreClear instanceof HTMLButtonElement)
      moreClear.disabled = selected.length === 0 && filters.range === defaultBrowseFilters().range;
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
    placeThumb();
  }
  function update(remote = true) {
    updateControls();
    if (remote) loader.start({ range: filters.range, games: filters.games });
    else render();
  }
  if (redeemBar) bindRedeemCopy(redeemBar);
  filterForm.addEventListener("submit", (event) => event.preventDefault());
  filterForm.addEventListener("change", (event) => {
    const data = new FormData(filterForm);
    const params = new URLSearchParams();
    for (const key of ["games", "events", "nodes"]) params.set(key, data.getAll(key).join(","));
    params.set("range", String(data.get("range") ?? ""));
    params.set("ending", String(data.get("ending") ?? ""));
    filters = readFilters(params);
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
  // 「清除这些条件」只管弹层里的条件：时间范围回到默认档、活动与节点类型清空。
  document.getElementById("more-clear")?.addEventListener("click", () => {
    const range = defaultBrowseFilters().range;
    const remote = filters.range !== range;
    filters = { ...filters, range, events: [], nodes: [] };
    update(remote);
  });

  // 「筛选」：浏览器顶层弹层（不会被横向滚动的筛选栏裁掉）。桌面端贴在按钮下方，
  // 窄屏由 CSS 呈现为底部面板。轻点外部或 Esc 关闭由浏览器处理。
  const morePanel = document.getElementById("more-filters");
  const moreToggle = document.getElementById("more-filters-toggle");
  const popoverSupported = typeof HTMLElement.prototype.togglePopover === "function";
  function placeMore() {
    if (!morePanel || !moreToggle) return;
    if (matchMedia("(max-width: 640px)").matches) {
      morePanel.style.removeProperty("top");
      morePanel.style.removeProperty("left");
      return;
    }
    const rect = moreToggle.getBoundingClientRect();
    const width = Math.min(380, innerWidth - 32);
    morePanel.style.top = `${Math.round(rect.bottom + 8)}px`;
    morePanel.style.left = `${Math.round(Math.max(16, Math.min(rect.right - width, innerWidth - width - 16)))}px`;
  }
  if (morePanel && moreToggle && popoverSupported) {
    morePanel.addEventListener("beforetoggle", (event) => {
      if ((event as ToggleEvent).newState === "open") placeMore();
    });
    morePanel.addEventListener("toggle", (event) => {
      const open = (event as ToggleEvent).newState === "open";
      moreToggle.setAttribute("aria-expanded", String(open));
      // 弹层关着时量不到选项宽度；打开后再定位时间范围的滑块。
      if (open) placeThumb();
    });
    const follow = () => {
      if (morePanel.matches(":popover-open")) placeMore();
    };
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, { passive: true });
  } else if (morePanel && moreToggle) {
    // 不支持顶层弹层的旧浏览器：退化为按钮下方的普通展开区。
    morePanel.hidden = true;
    morePanel.classList.add("is-fallback");
    filterForm.classList.add("no-popover");
    const toggle = (open: boolean) => {
      morePanel.hidden = !open;
      moreToggle.setAttribute("aria-expanded", String(open));
      if (open) placeThumb();
    };
    moreToggle.addEventListener("click", () => toggle(Boolean(morePanel.hidden)));
    for (const close of morePanel.querySelectorAll("[popovertargetaction='hide']"))
      close.addEventListener("click", () => toggle(false));
  }

  pageRoot?.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    if (target?.dataset.action === "reset") {
      reset();
      filterForm.querySelector<HTMLInputElement>('input[name="games"]')?.focus();
    }
    if (target?.dataset.action === "widen") {
      const range = HOME_RANGES.find((item) => item.id === target.dataset.range);
      if (range) {
        filters.range = range.id;
        update();
        // 时间范围在「筛选」里（ADR-0017）；焦点落到写着当前档位的按钮上。
        moreToggle?.focus();
      }
    }
    // 「显示更多」：读取下一档，已显示的条目保留，新条目接在末行的位置（ADR-0017）。
    if (target?.dataset.action === "show-more" && target.getAttribute("aria-disabled") !== "true") {
      const range = HOME_RANGES.find((item) => item.id === target.dataset.range);
      if (range) {
        filters.range = range.id;
        anchoring = true;
        updateControls();
        loader.extend({ range: filters.range, games: filters.games });
      }
    }
    if (target?.dataset.action === "ending-all") {
      filters.ending = true;
      update(false);
      const heading = document.getElementById("timeline-title");
      heading?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
      heading?.focus({ preventScroll: true });
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
    filters = readFilters(new URLSearchParams(location.search));
    update();
  });
  update();
}
