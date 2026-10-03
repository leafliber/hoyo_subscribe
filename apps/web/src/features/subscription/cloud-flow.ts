import {
  type AccountSummary,
  AccountSummarySchema,
  deriveAccountActions,
  isApiErrorBody,
} from "@hoyo/contracts";
import type { DraftIdentity } from "../../lib/storage/drafts";
import {
  DRAFT_IDENTITY_EVENT,
  publishDraftIdentity,
  readDraftIdentityEvent,
} from "../../lib/storage/identity";
import type { Phase, Snapshot } from "./save/machine";

type StepState = "done" | "current" | "todo";

/**
 * 订阅页的引导进度：只读取账号事实并呈现下一步；不保存、不开通任何通道。
 * 保存、恢复码和通道各自由既有控制器负责。
 */
export class SubscriptionCloudFlow {
  private userId: string | null = null;
  private generation = 0;
  private facts: AccountSummary | null = null;
  private clockOffset = 0;
  private lastKnownRestriction = false;
  private loading = false;
  private snapshot: Snapshot | null = null;
  private phase: Phase = "guest";
  private calendarEnabled = false;
  private initialRead: { identity: DraftIdentity; facts: AccountSummary | null } | null = null;

  constructor(private readonly host: { current(): boolean; gateChanged(): void }) {
    document.addEventListener(DRAFT_IDENTITY_EVENT, (event) => {
      const identity = readDraftIdentityEvent(event);
      if (!identity) return;
      const initialRead = this.initialRead;
      this.invalidate();
      if (identity.status === "confirmed") {
        this.userId = identity.userId;
        if (
          initialRead?.identity.status === "confirmed" &&
          initialRead.identity.userId === identity.userId
        ) {
          this.acceptFacts(initialRead.facts);
          this.paint();
        } else void this.refresh();
      }
    });
    this.paint();
  }

  invalidate(): void {
    this.generation += 1;
    this.userId = null;
    this.facts = null;
    this.initialRead = null;
    this.lastKnownRestriction = false;
    this.snapshot = null;
    this.loading = false;
    this.calendarEnabled = false;
    this.paint();
  }

  /** 与草稿身份生命周期共用首次 /me 读取。 */
  async identify(): Promise<DraftIdentity> {
    const generation = this.generation;
    let identity: DraftIdentity = { status: "unknown" };
    let facts: AccountSummary | null = null;
    try {
      const response = await fetch("/api/v2/me", { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) identity = { status: "guest" };
      else if (response.status === 200) {
        const body: unknown = await response.json();
        const userId =
          typeof body === "object" && body !== null && "user_id" in body ? body.user_id : undefined;
        identity =
          readDraftIdentityEvent(
            new CustomEvent(DRAFT_IDENTITY_EVENT, { detail: { status: "confirmed", userId } }),
          ) ?? identity;
        const parsed = AccountSummarySchema.safeParse(body);
        facts = parsed.success ? parsed.data : null;
      }
    } catch {
      /* 身份未知时绝不退回游客缓存。 */
    }
    if (!this.host.current() || generation !== this.generation) return { status: "unknown" };
    this.initialRead = { identity, facts };
    return identity;
  }

  private acceptFacts(facts: AccountSummary | null): void {
    this.facts = facts;
    this.clockOffset = facts ? facts.server_time - Date.now() : 0;
    if (facts)
      this.lastKnownRestriction = !deriveAccountActions(facts, Date.now() + this.clockOffset)
        .save_subscription.allowed;
  }

  async refresh(): Promise<void> {
    if (!this.userId || !this.host.current()) return;
    const generation = ++this.generation;
    const userId = this.userId;
    this.loading = true;
    this.paint();
    try {
      const response = await fetch("/api/v2/me", { credentials: "same-origin", cache: "no-store" });
      const body: unknown = await response.json();
      if (!this.host.current() || generation !== this.generation) return;
      if (
        response.status === 401 &&
        isApiErrorBody(body) &&
        body.error.details?.code === "unauthorized" &&
        ["no_session", "session_expired"].includes(body.error.details.reason)
      ) {
        publishDraftIdentity({ status: "unknown" });
        return;
      }
      const result = AccountSummarySchema.safeParse(body);
      if (response.ok && result.success && result.data.user_id !== userId) {
        publishDraftIdentity({ status: "unknown" });
        return;
      }
      this.acceptFacts(
        response.ok && result.success && result.data.user_id === userId ? result.data : null,
      );
    } catch {
      if (generation !== this.generation) return;
      this.facts = null;
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.paint();
      }
    }
  }

  update(phase: Phase, snapshot: Snapshot | null): void {
    this.phase = phase;
    this.snapshot = snapshot;
    this.paint();
  }

  setCalendarEnabled(enabled: boolean): void {
    if (this.calendarEnabled === enabled) return;
    this.calendarEnabled = enabled;
    this.paint();
  }

  saveBlocked(): boolean {
    return this.loading || this.restricted();
  }

  signedIn(): boolean {
    return this.userId !== null;
  }

  restricted(): boolean {
    return this.facts
      ? !deriveAccountActions(this.facts, Date.now() + this.clockOffset).save_subscription.allowed
      : this.lastKnownRestriction;
  }

  private paint(): void {
    const status = document.getElementById("cloud-flow-status");
    const recovery = document.getElementById("save-recovery-link");
    const login = document.getElementById("subscription-login");
    const calendarLink = document.getElementById("setup-calendar-link");
    const progress = document.getElementById("setup-progress");
    const saved = this.snapshot?.state === "initialized";
    const restricted = this.restricted();
    const recoverySaved = this.facts?.recovery_code_saved === true;
    const signedIn = this.userId !== null;

    const steps: Record<string, StepState> = {
      save: saved ? "done" : "current",
      recovery: !saved ? "todo" : recoverySaved && !restricted ? "done" : "current",
      calendar:
        !saved || !recoverySaved || restricted ? "todo" : this.calendarEnabled ? "done" : "current",
    };
    for (const [name, state] of Object.entries(steps)) {
      const item = document.querySelector<HTMLElement>(`#setup-steps [data-step="${name}"]`);
      if (item) {
        item.dataset.state = state;
        if (state === "current") item.setAttribute("aria-current", "step");
        else item.removeAttribute("aria-current");
      }
    }
    if (progress)
      progress.hidden = signedIn && saved && recoverySaved && !restricted && this.calendarEnabled;
    if (login) login.hidden = signedIn;
    if (recovery)
      recovery.hidden = !(signedIn && (restricted || (saved && this.facts && !recoverySaved)));
    if (calendarLink) calendarLink.hidden = steps.calendar !== "current" || !signedIn;
    if (status) {
      status.textContent = this.loading
        ? "正在核对账号状态…"
        : restricted
          ? "恢复登录后需要先保存新的恢复码，才能继续保存订阅或开启接收方式。"
          : this.phase === "conflict"
            ? "云端设置和本机修改不一致，请先在下方选择保留哪一份。"
            : !signedIn
              ? "先选好订阅内容，登录后保存到云端。未登录时设置只保存在本机。"
              : !saved
                ? "选好内容后点「保存订阅」，就可以继续下一步。"
                : !this.facts
                  ? "订阅已保存；恢复码状态暂未确认，请稍后刷新。"
                  : !recoverySaved
                    ? "订阅已保存。下一步：保存恢复码，之后才能启用日历订阅。"
                    : this.calendarEnabled
                      ? "全部完成！日历会自动同步你的订阅内容。"
                      : "最后一步：在下方「日历订阅」中生成私人链接并添加到日历。";
    }
    // 说明性占位，只提示需要先保存一次，不是第二个通道控制器。
    const hint = document.getElementById("calendar-first-save");
    if (hint) hint.hidden = saved || !signedIn;
    this.host.gateChanged();
  }
}
