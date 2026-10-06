// F5-01 · 订阅页「浏览器通知」卡片（前端 §9.3、§9.4；主方案 §7.8；D3 §1.2、§1.3、§2.8；ADR-0025）。
//
// 红线：
// - 只在 Push 能力开放后出现开启入口；能力关闭但本人已有绑定时仍显示状态与暂停/删除入口（§9 接收方式）。
// - 用户点击「在当前浏览器开启通知」之前，不申请系统权限、不创建绑定、不发送任何通知。
// - 浏览器权限与服务端绑定分别显示；平台已接受 ≠ 激活成功，只有合法回执后才显示"本浏览器接收验证通过"。
// - 权限被拒时只说明去浏览器设置里调整，不循环弹窗。
// - 绑定属于其他账号时解释冲突，不按 endpoint 认领或删除他人绑定；用户可明确选择为当前账号重新订阅。
// - 测试与重发受冷却和额度约束并显示可重试时间；不做静默心跳或定时测试。
import {
  derivePushActions,
  isApiErrorBody,
  isPushBlockReason,
  type PushBindingView,
  type PushChannelView,
} from "@hoyo/contracts";
import { el, icon } from "../../../lib/dom";
import { feedbackForFailure } from "../../../lib/errors/feedback";
import {
  activatePush,
  createPush,
  deletePush,
  PushRequestError,
  pausePush,
  pushCapability,
  readPush,
  testPush,
} from "./api";
import {
  browserPermission,
  clearLocalBinding,
  currentBrowserSubscription,
  iosNeedsHomeScreen,
  type LocalBinding,
  onReceipt,
  pushSupported,
  readLocalBinding,
  requestBrowserPermission,
  resetBrowserSubscription,
  subscribeBrowser,
  unsubscribeBrowser,
  writeLocalBinding,
} from "./browser";
import {
  CROSS_CHANNEL_NOTE,
  ENABLE_LABEL,
  NO_GUARANTEE_NOTE,
  OUTCOME_COPY,
  PERMISSION_COPY,
  PUSH_REASON_COPY,
  serviceLabel,
  stateText,
  time,
} from "./copy";

export interface PushPanelHost {
  /** 身份与页面仍是挂载时的那一个；否则丢弃迟到结果。 */
  current(): boolean;
}

type Busy = "idle" | "reading" | "writing";

export class PushPanel {
  private view: PushChannelView | null = null;
  private capability: "open" | "closed" | "unknown" = "unknown";
  private local: LocalBinding | null = null;
  private browserEndpoint = false;
  private busy: Busy = "idle";
  private conflict = false;
  private message = "";
  private clockAnchor = { server: 0, local: 0 };
  private readonly abort = new AbortController();
  /** 销毁后不再碰 DOM：迟到的读取或写入结果一律丢弃（同一根节点可能已挂上新身份的卡片）。 */
  private active = true;
  /** 请求进行中又要求刷新（回执、切回页面、保存了新版本）：记下，当前请求结束后再读，免得旧结果盖掉新状态。 */
  private refreshQueued = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: PushPanelHost,
  ) {
    onReceipt(() => void this.refresh(true), this.abort.signal);
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible" && this.waiting()) void this.refresh(true);
      },
      { signal: this.abort.signal },
    );
    this.paint();
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.abort.abort();
    this.view = null;
    this.local = null;
    this.root.replaceChildren();
    this.root.hidden = true;
  }
  /** 本卡片仍有效：未销毁，且身份与页面仍是挂载时的那一个。 */
  private current(): boolean {
    if (!this.active) return false;
    if (this.host.current()) return true;
    this.dispose();
    return false;
  }

  private now(): number {
    return this.clockAnchor.server + (performance.now() - this.clockAnchor.local);
  }
  private thisBinding(): PushBindingView | null {
    if (!this.view || !this.local) return null;
    return this.view.bindings.find((binding) => binding.id === this.local?.binding_id) ?? null;
  }
  private waiting(): boolean {
    const binding = this.thisBinding();
    return binding?.state === "pending" && (binding.activation?.deadline ?? 0) > this.now();
  }
  private accept(view: PushChannelView): void {
    this.view = view;
    this.clockAnchor = { server: view.server_time, local: performance.now() };
  }

  async refresh(quiet = false): Promise<void> {
    if (!this.current()) return;
    if (this.busy !== "idle") {
      this.refreshQueued = true;
      return;
    }
    this.busy = "reading";
    if (!quiet) this.message = "正在读取浏览器通知状态…";
    this.paint();
    try {
      const [capability, view, local, endpoint] = await Promise.all([
        pushCapability(),
        readPush(),
        readLocalBinding(),
        currentBrowserSubscription(),
      ]);
      if (!this.current()) return;
      this.capability = capability;
      this.accept(view);
      this.local = local;
      this.browserEndpoint = endpoint !== null;
      if (!quiet) this.message = "";
    } catch (error) {
      if (!this.current()) return;
      this.view = null;
      this.message = `无法读取浏览器通知状态。${this.explain(error)}`;
    } finally {
      this.settle();
    }
  }

  /** 请求结束：回到空闲并重画；期间排队的刷新此时执行。 */
  private settle(): void {
    this.busy = "idle";
    this.paint();
    if (!this.refreshQueued || !this.active) return;
    this.refreshQueued = false;
    void this.refresh(true);
  }

  private explain(error: unknown): string {
    const body = error instanceof PushRequestError ? error.body : error;
    if (
      typeof body === "object" &&
      body !== null &&
      "blocked_reason" in body &&
      typeof body.blocked_reason === "string" &&
      isPushBlockReason(body.blocked_reason)
    ) {
      const retry =
        isApiErrorBody(body) &&
        body.error.details?.code === "rate_limited" &&
        typeof body.error.details.retry_after_ms === "number"
          ? `约 ${Math.ceil(body.error.details.retry_after_ms / 1000)} 秒后可再试。`
          : "";
      return `${PUSH_REASON_COPY[body.blocked_reason]}${retry}`;
    }
    const feedback = feedbackForFailure(body);
    return `${feedback.title}。${feedback.nextStep}`;
  }

  private isOwnedElsewhere(error: unknown): boolean {
    return (
      error instanceof PushRequestError &&
      isApiErrorBody(error.body) &&
      error.body.error.details?.code === "conflict" &&
      error.body.error.details.reason === "push_endpoint_owned_elsewhere"
    );
  }

  private async write(work: () => Promise<void>): Promise<void> {
    if (this.busy !== "idle" || !this.current()) return;
    this.busy = "writing";
    this.paint();
    try {
      await work();
      if (!this.current()) return;
    } catch (error) {
      if (!this.current()) return;
      if (this.isOwnedElsewhere(error)) {
        this.conflict = true;
        this.message =
          "这个浏览器的通知订阅已登记在另一个账号下。本站不会替你认领或删除它。你可以登录那个账号在账号页删除它，或在下面为当前账号重新创建本浏览器的通知订阅（原账号在这个浏览器上的通知随之失效）。";
      } else if (error instanceof PushRequestError || isApiErrorBody(error)) {
        this.message = `未执行。${this.explain(error)}`;
      } else {
        // 超时、断网、5xx 无结构化错误体：结果未知，重新读取核对（D3 §1.3、§3）。
        this.message = "结果未知：请求可能已经生效，也可能没有。正在重新读取状态核对…";
        this.refreshQueued = true;
      }
    } finally {
      this.settle();
    }
  }

  /** 唯一的开启入口：先申请系统权限（紧跟用户点击），再订阅、登记、存凭证、发可见激活通知。 */
  private enable(reset = false): void {
    if (!pushSupported() || this.busy !== "idle") return;
    const permission = requestBrowserPermission();
    void this.write(async () => {
      const granted = await permission;
      if (granted !== "granted") {
        this.message =
          granted === "denied"
            ? "通知权限已被拒绝。请在浏览器的网站设置里允许本站发送通知，然后点「刷新状态」。本页不会再次弹出请求。"
            : "没有获得通知权限，未登记本浏览器。";
        return;
      }
      const view = this.view ?? (await readPush());
      if (!view.application_server_key) {
        this.message = PUSH_REASON_COPY.feature_closed;
        return;
      }
      const subscription = reset
        ? await resetBrowserSubscription(view.application_server_key)
        : await subscribeBrowser(view.application_server_key);
      const created = await createPush(subscription);
      // 先把凭证存进本机，再请服务器发激活通知：Service Worker 收到时一定读得到它。
      await writeLocalBinding({
        binding_id: created.binding_id,
        receipt_token: created.receipt_token,
      });
      this.local = { binding_id: created.binding_id, receipt_token: created.receipt_token };
      this.browserEndpoint = true;
      this.conflict = false;
      this.accept(created.state);
      const binding = this.thisBinding();
      if (binding?.state === "pending" && binding.activation?.attempts === 0) {
        const sent = await activatePush(binding.id, binding.binding_version);
        this.accept(sent.state);
        this.message = `正在验证本浏览器接收能力：请留意系统通知。${sent.outcome ? `（${OUTCOME_COPY[sent.outcome]}）` : ""}`;
      } else {
        this.message =
          created.result === "existing" ? "已为本浏览器重新登记接收凭证。" : "已登记本浏览器。";
      }
    });
  }

  private act(
    kind: "resend" | "test" | "pause" | "resume" | "remove",
    binding: PushBindingView,
  ): void {
    void this.write(async () => {
      if (kind === "remove") {
        const result = await deletePush(binding.id);
        this.accept(result.state);
        if (this.local?.binding_id === binding.id) {
          await clearLocalBinding();
          await unsubscribeBrowser();
          this.local = null;
          this.browserEndpoint = false;
        }
        this.message = "已删除本浏览器的通知绑定。";
        return;
      }
      const result =
        kind === "pause"
          ? await pausePush(binding.id, binding.binding_version)
          : kind === "test"
            ? await testPush(binding.id, binding.binding_version)
            : await activatePush(binding.id, binding.binding_version);
      this.accept(result.state);
      this.message =
        kind === "pause"
          ? "已暂停本浏览器通知。恢复时需要重新验证接收。"
          : kind === "test"
            ? `测试通知：${result.outcome ? OUTCOME_COPY[result.outcome] : "结果未知"}。收到后这里会显示"本浏览器已收到"。`
            : `已发出验证通知：${result.outcome ? OUTCOME_COPY[result.outcome] : "结果未知"}。请留意系统通知。`;
    });
  }

  private paint(): void {
    if (!this.active) return;
    const view = this.view;
    const binding = this.thisBinding();
    const hasBindings = (view?.bindings.length ?? 0) > 0;
    // 能力未开放且本人没有任何绑定：不占主流程（§9 接收方式、§9.3 第一段）。
    this.root.hidden = this.capability !== "open" && !hasBindings && this.busy === "idle";
    if (this.root.hidden) {
      this.root.replaceChildren();
      return;
    }
    const permission = browserPermission();
    const now = this.now();
    const actions = view ? derivePushActions(view, binding, now) : null;
    const pill = !view
      ? { text: this.busy === "reading" ? "读取中" : "状态未知", kind: "" }
      : binding?.state === "active"
        ? { text: "验证通过", kind: "success" }
        : binding?.state === "pending" && this.waiting()
          ? { text: "验证中", kind: "warning" }
          : binding?.state === "paused"
            ? { text: "已暂停", kind: "" }
            : { text: "未开启", kind: "" };
    const facts = el("dl", { class: "kv kv--compact", "data-push": "facts" });
    const row = (label: string, value: string) =>
      facts.append(el("dt", {}, label), el("dd", {}, value));
    row("浏览器权限", PERMISSION_COPY[permission]);
    row(
      "本浏览器",
      !view
        ? "未知"
        : binding
          ? `${stateText(binding, now)}（${serviceLabel(binding)}）`
          : this.local && !binding
            ? "本机记录的绑定不属于当前账号或已删除"
            : "尚未为当前账号开启",
    );
    if (binding?.state === "pending" && binding.activation)
      row(
        "验证",
        `已发 ${binding.activation.attempts} 次；截止 ${time(binding.activation.deadline)}${binding.activation.last_outcome ? `；最近一次：${OUTCOME_COPY[binding.activation.last_outcome]}` : ""}`,
      );
    if (binding?.state === "active") {
      row("服务租期", `到 ${time(binding.lease_expires_at)}；收到通知或在本站操作会自动续期。`);
      if (binding.last_test)
        row(
          "最近测试",
          `${time(binding.last_test.sent_at)}：${binding.last_test.outcome ? OUTCOME_COPY[binding.last_test.outcome] : "结果未知"}${binding.last_test.received_at ? "；本浏览器已收到" : ""}`,
        );
    }
    if (binding && !this.browserEndpoint && binding.state !== "gone")
      row("浏览器订阅", "本浏览器当前没有推送订阅（可能被浏览器或你清除）；重新开启即可恢复。");

    const buttons: HTMLElement[] = [];
    const reasonLines: string[] = [];
    const button = (
      label: string,
      handler: () => void,
      availability: {
        allowed: boolean;
        reason?: keyof typeof PUSH_REASON_COPY;
        retry_at?: number;
      } | null,
      secondary = true,
      name = "",
    ) => {
      const item = el(
        "button",
        {
          type: "button",
          class: secondary ? "button button--secondary button--sm" : "button button--sm",
          "data-push": name,
        },
        label,
      ) as HTMLButtonElement;
      item.disabled = this.busy !== "idle" || !availability?.allowed;
      if (availability && !availability.allowed && availability.reason) {
        const retry =
          availability.retry_at !== undefined ? `${time(availability.retry_at)} 后可再试。` : "";
        reasonLines.push(`${label}：${PUSH_REASON_COPY[availability.reason]}${retry}`);
      }
      item.addEventListener("click", handler, { signal: this.abort.signal });
      buttons.push(item);
    };
    if (!pushSupported()) {
      reasonLines.push(
        iosNeedsHomeScreen()
          ? "iPhone / iPad 需要先用 Safari 把本站「添加到主屏幕」，再从主屏幕打开本站，才能开启通知。"
          : "此浏览器不支持网页通知。日历订阅和邮件不受影响。",
      );
    } else if (view) {
      const canEnable =
        this.capability === "open" &&
        (binding === null ||
          binding.state === "gone" ||
          (binding.state === "pending" && !this.waiting()));
      if (canEnable && permission !== "denied")
        button(ENABLE_LABEL, () => this.enable(), actions?.enable ?? null, false, "enable");
      if (permission === "denied")
        reasonLines.push(
          "通知权限已被拒绝：请在浏览器的网站设置里允许本站通知，然后点「刷新状态」。本页不会再次弹出请求。",
        );
      if (this.conflict && this.capability === "open")
        button(
          "为当前账号重新创建本浏览器的通知订阅",
          () => this.enable(true),
          // 重新订阅得到新端点，按全新登记核对名额与日额。
          actions?.enable ?? null,
          true,
          "reset",
        );
      if (binding?.state === "pending" && this.waiting())
        button(
          "重新发送验证通知",
          () => this.act("resend", binding),
          actions?.activate ?? null,
          true,
          "resend",
        );
      if (binding?.state === "active")
        button(
          "发送测试通知",
          () => this.act("test", binding),
          actions?.test ?? null,
          true,
          "test",
        );
      if (binding?.state === "paused")
        button(
          "恢复（需要重新验证）",
          () => this.act("resume", binding),
          actions?.activate ?? null,
          false,
          "resume",
        );
      if (binding?.state === "pending" || binding?.state === "active")
        button(
          "暂停本浏览器通知",
          () => this.act("pause", binding),
          actions?.pause ?? null,
          true,
          "pause",
        );
      if (binding)
        button(
          "删除本浏览器的通知",
          () => this.act("remove", binding),
          actions?.delete ?? null,
          true,
          "remove",
        );
    }
    const refresh = el(
      "button",
      { type: "button", class: "link-button", "data-push": "refresh" },
      icon("refresh"),
      "刷新状态",
    ) as HTMLButtonElement;
    refresh.disabled = this.busy !== "idle";
    refresh.addEventListener("click", () => void this.refresh(), { signal: this.abort.signal });

    this.root.replaceChildren(
      el(
        "div",
        { class: "card-body" },
        el(
          "div",
          { class: "channel-head" },
          el("span", { class: "channel-icon", "aria-hidden": "true" }, icon("bell")),
          el(
            "div",
            { class: "channel-head-text" },
            el("h3", { id: "push-channel-heading" }, "浏览器通知"),
            el("p", { class: "channel-sub" }, "在这个浏览器里直接弹出提醒（可选）"),
          ),
          el(
            "span",
            {
              class: `status-pill${pill.kind ? ` status-pill--${pill.kind}` : ""}`,
              "data-push": "pill",
            },
            pill.text,
          ),
        ),
        el(
          "p",
          {
            class: "channel-message result-message",
            role: "status",
            "aria-live": "polite",
            "data-push": "message",
          },
          this.message,
        ),
        view ? facts : null,
        reasonLines.length
          ? el(
              "div",
              { class: "layer-reason", "data-push": "reasons" },
              ...reasonLines.map((line) => el("p", {}, line)),
            )
          : null,
        buttons.length
          ? el("div", { class: "button-row", "data-push": "actions" }, ...buttons)
          : null,
        el("p", { class: "text-aux channel-note" }, NO_GUARANTEE_NOTE),
        el("p", { class: "text-aux channel-note" }, CROSS_CHANNEL_NOTE),
        el(
          "div",
          { class: "channel-foot" },
          el(
            "a",
            { class: "link-button", href: "/account#account-push" },
            icon("monitor"),
            "在账号页管理所有浏览器",
          ),
          refresh,
        ),
      ),
    );
  }
}
