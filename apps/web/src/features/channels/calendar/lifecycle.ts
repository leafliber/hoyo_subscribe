import { el, icon } from "../../../lib/dom";
import { DRAFT_IDENTITY_EVENT, readDraftIdentityEvent } from "../../../lib/storage/identity";
import { csrfToken, type Phase, type Snapshot } from "../../subscription/save/machine";
import { type CalendarHost, CalendarPanel } from "./panel";

const GUEST_TEXT = "登录并保存订阅后，就能生成私人日历链接。";
const CHECKING_TEXT = "正在确认账号和已保存的订阅…";

export class CalendarChannelLifecycle {
  private userId: string | null = null;
  private revision: number | null = null;
  private panel: CalendarPanel | null = null;
  private readonly abort = new AbortController();
  constructor(
    private readonly root: HTMLElement,
    private readonly host: Omit<CalendarHost, "userId">,
  ) {
    document.addEventListener(
      DRAFT_IDENTITY_EVENT,
      (event) => {
        const identity = readDraftIdentityEvent(event);
        if (!identity) return;
        this.invalidate();
        this.userId = identity.status === "confirmed" ? identity.userId : null;
        if (identity.status === "guest") this.placeholder(GUEST_TEXT);
      },
      { signal: this.abort.signal },
    );
    // 首屏没有登录凭据就是游客；有凭据时等身份确认，不先说“请登录”。
    this.placeholder(csrfToken() ? CHECKING_TEXT : GUEST_TEXT);
  }
  invalidate(): void {
    this.userId = null;
    this.revision = null;
    this.panel?.dispose();
    this.panel = null;
    this.host.addressChanged(false);
    this.placeholder(csrfToken() ? CHECKING_TEXT : GUEST_TEXT);
  }
  private placeholder(message: string): void {
    this.root.replaceChildren(
      el(
        "div",
        { class: "card-body" },
        el(
          "h3",
          { id: "calendar-channel-heading", class: "channel-title" },
          icon("calendar"),
          "日历订阅",
        ),
        el("p", { class: "text-secondary" }, message),
      ),
    );
  }
  update(phase: Phase, snapshot: Snapshot | null): void {
    if (!this.userId || !snapshot || phase === "loading" || !this.host.current()) return;
    const previous = this.revision;
    this.revision = snapshot.revision;
    if (!this.panel) {
      const machine = this.host.machine();
      this.panel = new CalendarPanel(this.root, {
        ...this.host,
        userId: () => this.userId,
        current: () =>
          this.userId !== null && this.host.machine() === machine && this.host.current(),
      });
    } else if (previous !== snapshot.revision) this.panel.savedVersionChanged();
  }
  destroy(): void {
    this.invalidate();
    this.abort.abort();
  }
}
