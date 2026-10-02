import { DRAFT_IDENTITY_EVENT, readDraftIdentityEvent } from "../../../lib/storage/identity";
import type { Phase, Snapshot } from "../../subscription/save/machine";
import { mountEmailChannel } from "./panel";
import type { EmailSubscriptionHost } from "./subscription";

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
      if (identity.status === "guest") this.placeholder("请先登录；邮件状态尚未读取。");
      // SubscriptionSaveMachine will publish the newly read snapshot through update().
    });
  }

  invalidate(): void {
    this.confirmed = false;
    this.snapshot = null;
    this.panel?.dispose();
    this.panel = null;
    this.placeholder("身份或已保存订阅待确认，未展示邮件状态。");
  }

  private placeholder(message: string): void {
    this.root.classList.remove("email-panel");
    const heading = document.createElement("h3");
    heading.id = "mail-channel-heading";
    heading.textContent = "邮件提醒";
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = message;
    this.root.replaceChildren(heading, status);
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
      void this.panel.refresh();
    } else if (previousRevision !== snapshot.revision) {
      this.panel.savedVersionChanged();
    }
  }
}
