import { el, icon } from "../../../lib/dom";
import { DRAFT_IDENTITY_EVENT, readDraftIdentityEvent } from "../../../lib/storage/identity";
import { csrfToken, type Phase, type Snapshot } from "../../subscription/save/machine";
import { mountEmailChannel } from "./panel";
import type { EmailSubscriptionHost } from "./subscription";

const GUEST_TEXT = "登录并保存订阅后，可以开启邮件通知。";
const CHECKING_TEXT = "正在确认账号和已保存的订阅…";

/** Joins the existing identity and saved-subscription lifecycles; neither event alone is enough. */
export class EmailChannelLifecycle {
  private confirmed = false;
  private snapshot: Snapshot | null = null;
  private phase: Phase = "guest";
  private panel: ReturnType<typeof mountEmailChannel> | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: EmailSubscriptionHost,
  ) {
    document.addEventListener(DRAFT_IDENTITY_EVENT, (event) => {
      const identity = readDraftIdentityEvent(event);
      if (!identity) return;
      this.invalidate();
      this.confirmed = identity.status === "confirmed";
      if (identity.status === "guest") this.placeholder(GUEST_TEXT);
      // SubscriptionSaveMachine will publish the newly read snapshot through update().
    });
    // 首屏没有登录凭据就是游客；有凭据时等身份确认，不先说“请登录”。
    this.placeholder(csrfToken() ? CHECKING_TEXT : GUEST_TEXT);
  }

  invalidate(): void {
    this.confirmed = false;
    this.snapshot = null;
    this.panel?.dispose();
    this.panel = null;
    this.placeholder(csrfToken() ? CHECKING_TEXT : GUEST_TEXT);
  }

  private placeholder(message: string): void {
    this.root.classList.remove("email-panel");
    this.root.replaceChildren(
      el(
        "div",
        { class: "card-body" },
        el("h3", { id: "mail-channel-heading", class: "channel-title" }, icon("mail"), "邮件通知"),
        el("p", { class: "text-secondary", role: "status" }, message),
      ),
    );
  }

  update(phase: Phase, snapshot: Snapshot | null): void {
    const previousRevision = this.snapshot?.revision;
    this.snapshot = snapshot;
    this.phase = phase;
    if (!this.confirmed || !snapshot || phase === "loading" || !this.host.current()) return;
    if (!this.panel) {
      const machine = this.host.machine();
      this.panel = mountEmailChannel(this.root, {
        ...this.host,
        phase: () => this.phase,
        current: () => this.confirmed && this.host.machine() === machine && this.host.current(),
      });
      // 首次读取不播报“已刷新”；只有用户点刷新时才提示。
      void this.panel.refresh(true);
    } else if (previousRevision !== snapshot.revision) {
      this.panel.savedVersionChanged();
    }
  }
}
