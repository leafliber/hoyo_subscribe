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

/** Onboarding uses the existing save, recovery and channel owners; it cannot enable a channel. */
export class SubscriptionCloudFlow {
  private userId: string | null = null;
  private generation = 0;
  private facts: AccountSummary | null = null;
  private clockOffset = 0;
  private lastKnownRestriction = false;
  private loading = false;
  private snapshot: Snapshot | null = null;
  private phase: Phase = "guest";
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
    this.paint();
  }

  /** Share the initial /me read with the existing draft identity lifecycle. */
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
      /* Unknown identity never falls back to a guest cache. */
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

  saveBlocked(): boolean {
    return this.loading || this.restricted();
  }

  private restricted(): boolean {
    return this.facts
      ? !deriveAccountActions(this.facts, Date.now() + this.clockOffset).save_subscription.allowed
      : this.lastKnownRestriction;
  }

  private paint(): void {
    const status = document.getElementById("cloud-flow-status");
    const recovery = document.getElementById("save-recovery-link");
    const login = document.getElementById("subscription-login");
    const saved = this.snapshot?.state === "initialized";
    const restricted = this.restricted();
    if (login) login.hidden = this.userId !== null;
    if (recovery)
      recovery.hidden = !restricted && (!saved || !this.facts || this.facts.recovery_code_saved);
    if (status) {
      status.textContent = this.loading
        ? "正在核对账号状态。"
        : restricted
          ? "请先保存并确认恢复登录后的新恢复码，再保存订阅或启用接收方式。"
          : this.phase === "conflict"
            ? "请先比较云端与本机草稿，选择采用云端或保留草稿继续编辑；不会自动覆盖。"
            : !saved
              ? "当前是未保存的预选或草稿。先保存一次订阅内容，再保存恢复码和选择接收方式；游客请先登录。"
              : !this.facts
                ? "云端订阅已保存；恢复码状态尚未确认，请重新核对账号状态。"
                : !this.facts.recovery_code_saved
                  ? "云端订阅已保存。下一步：保存并确认恢复码；离开本页不会撤销已保存内容。"
                  : "订阅与恢复码已保存。请在下方日历订阅区读取状态、核对完整服务端预览，再明确确认启用；邮件与本浏览器通知不会附带开启。";
    }
    // These are explanatory placeholders, never a second calendar / Push controller.
    for (const id of ["calendar-first-save", "push-first-save"]) {
      const hint = document.getElementById(id);
      if (hint) hint.hidden = saved;
    }
    this.host.gateChanged();
  }
}
