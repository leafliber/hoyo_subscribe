import { DRAFT_IDENTITY_EVENT, readDraftIdentityEvent } from "../../../lib/storage/identity";
import type { Phase, Snapshot } from "../../subscription/save/machine";
import { type CalendarHost, CalendarPanel } from "./panel";
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
      },
      { signal: this.abort.signal },
    );
  }
  invalidate(): void {
    this.userId = null;
    this.revision = null;
    this.panel?.dispose();
    this.panel = null;
    this.host.addressChanged(false);
    this.root.textContent = "身份待确认，未展示日历状态。";
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
