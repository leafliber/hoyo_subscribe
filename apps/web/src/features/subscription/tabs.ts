// 我的订阅分区（ADR-0026）：「订阅内容」与「接收方式」两个标签页。
// 只切换显示，不发请求、不改保存状态；两个分区共用同一套保存状态机与通道控制器。
// 地址片段可直达分区，旧的卡片锚点（#calendar-channel 等）继续有效。

export type SubscriptionTab = "content" | "channels";

const CHANNEL_TARGETS = new Set(["channels", "calendar-channel", "mail-channel", "push-channel"]);

/** 地址片段对应的分区；不认识的片段返回 null，保持当前分区。 */
export function tabForHash(hash: string): SubscriptionTab | null {
  const id = hash.replace(/^#/, "");
  if (CHANNEL_TARGETS.has(id)) return "channels";
  return id === "content" ? "content" : null;
}

export class SubscriptionTabs {
  private readonly tabs: HTMLButtonElement[];
  private current: SubscriptionTab = "content";

  constructor(root: HTMLElement) {
    this.tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"][data-tab]')];
    for (const tab of this.tabs) {
      tab.addEventListener("click", () => this.select(this.name(tab), { updateHash: true }));
      tab.addEventListener("keydown", (event) => this.keydown(event, tab));
    }
    window.addEventListener("hashchange", () => this.followHash());
    // 站内锚点（如「去添加到日历」）在浏览器滚动之前先切到目标分区；片段未变时也生效。
    document.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href^='#']") : null;
      const tab = link ? tabForHash(link.getAttribute("href") ?? "") : null;
      if (tab) this.select(tab);
    });
    this.followHash();
  }

  get selected(): SubscriptionTab {
    return this.current;
  }

  select(tab: SubscriptionTab, options: { updateHash?: boolean; focus?: boolean } = {}): void {
    this.current = tab;
    for (const item of this.tabs) {
      const on = this.name(item) === tab;
      item.setAttribute("aria-selected", String(on));
      item.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(item.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !on;
      if (on && options.focus) item.focus();
    }
    // 只替换当前历史记录：切换分区不应让「返回」在两个分区之间来回跳。
    if (options.updateHash && location.hash !== `#${tab}`)
      history.replaceState(history.state, "", `#${tab}`);
  }

  private name(tab: HTMLElement): SubscriptionTab {
    return tab.dataset.tab === "channels" ? "channels" : "content";
  }

  private followHash(): void {
    const tab = tabForHash(location.hash);
    if (!tab) return;
    this.select(tab);
    // 隐藏分区里的锚点在切换前无法滚动到位；显示后再定位到具体卡片。
    const target = location.hash.slice(1);
    if (target !== tab) document.getElementById(target)?.scrollIntoView({ block: "start" });
  }

  private keydown(event: KeyboardEvent, tab: HTMLButtonElement): void {
    const index = this.tabs.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % this.tabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + this.tabs.length) % this.tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? this.tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const target = this.tabs[next];
    if (target) this.select(this.name(target), { updateHash: true, focus: true });
  }
}
