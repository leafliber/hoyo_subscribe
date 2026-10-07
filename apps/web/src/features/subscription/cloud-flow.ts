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
import {
  paintReceiveChoice,
  type ReceiveCapabilities,
  type ReceiveChannel,
  readReceiveCapabilities,
} from "./receive-choice";
import type { Phase, Snapshot } from "./save/machine";

type StepState = "done" | "current" | "todo";

/**
 * 订阅页的引导进度：只读取账号事实并呈现下一步；不保存、不开通任何通道。
 * 保存和通道各自由既有控制器负责；恢复码可选，在账号设置中管理（ADR-0026）。
 * 第 2 步是三种接收方式任选一种（ADR-0029），任一种已开启即完成。
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
  /** 各通道卡片报告的状态；null 表示卡片还没报告，按账号摘要判断（日历不在摘要里）。 */
  private channels: { calendar: boolean; mail: boolean | null; push: boolean | null } = {
    calendar: false,
    mail: null,
    push: null,
  };
  /** 公开能力与身份无关：每页读一次，身份变化不重读。 */
  private capabilities: ReceiveCapabilities | null = null;
  private capabilitiesRequested = false;
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
    this.channels = { calendar: false, mail: null, push: null };
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

  /** 通道卡片读到或改变了自己的状态（日历地址、邮件席位、账号下任一已验证的浏览器）。 */
  setChannel(channel: ReceiveChannel, enabled: boolean): void {
    if (this.channels[channel] === enabled) return;
    this.channels[channel] = enabled;
    this.paint();
  }

  /** 至少一种接收方式已开启。 */
  private receiving(): boolean {
    const facts = this.facts?.channels;
    const mail = this.channels.mail ?? facts?.email.state === "enabled";
    const push = this.channels.push ?? facts?.push.state === "active";
    return this.channels.calendar || mail || push;
  }

  private async loadCapabilities(): Promise<void> {
    if (this.capabilitiesRequested) return;
    this.capabilitiesRequested = true;
    this.capabilities = await readReceiveCapabilities();
    if (this.host.current()) this.paint();
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
    const choice = document.getElementById("receive-choice");
    const progress = document.getElementById("setup-progress");
    const saved = this.snapshot?.state === "initialized";
    const restricted = this.restricted();
    const signedIn = this.userId !== null;
    const receiving = this.receiving();

    // ADR-0026：恢复码可选，不再是引导步骤；只有恢复登录后的受限会话需要先保存新码。
    const steps: Record<string, StepState> = {
      save: saved ? "done" : "current",
      receive: !saved || restricted ? "todo" : receiving ? "done" : "current",
    };
    for (const [name, state] of Object.entries(steps)) {
      const item = document.querySelector<HTMLElement>(`#setup-steps [data-step="${name}"]`);
      if (item) {
        item.dataset.state = state;
        if (state === "current") item.setAttribute("aria-current", "step");
        else item.removeAttribute("aria-current");
      }
    }
    if (progress) progress.hidden = signedIn && saved && !restricted && receiving;
    if (login) login.hidden = signedIn;
    if (recovery) recovery.hidden = !(signedIn && restricted);
    const choosing = signedIn && steps.receive === "current";
    if (choice) {
      choice.hidden = !choosing;
      if (choosing) paintReceiveChoice(choice, this.capabilities);
    }
    if (choosing) void this.loadCapabilities();
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
                ? "选好内容后点「保存订阅」，再选择接收方式。"
                : receiving
                  ? "全部完成！之后可以在「接收方式」里调整或再加一种。"
                  : "订阅已保存。下一步：在下面选一种接收方式。";
    }
    // 说明性占位，只提示需要先保存一次，不是第二个通道控制器。
    const hint = document.getElementById("calendar-first-save");
    if (hint) hint.hidden = saved || !signedIn;
    this.host.gateChanged();
  }
}
