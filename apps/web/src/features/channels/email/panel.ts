import "./style.css";
import {
  EMAIL_CONSENT_DISABLE_ACTION,
  EMAIL_CONSENT_ENABLE_ACTION,
  type EmailConsentLayer,
  emailChannelEnableAvailability,
  isApiErrorBody,
  MAIL_ROUTINE_SEATS_MAX,
  MAIL_SEATS_MAX,
} from "@hoyo/contracts";
import { feedbackForFailure } from "../../../lib/errors/feedback";
import { DRAFT_IDENTITY_EVENT, readDraftIdentityEvent } from "../../../lib/storage/identity";
import { csrfToken } from "../../subscription/save/machine";
import { EmailRequestError, type EmailUpdate, type EmailView, readEmail, updateEmail } from "./api";
import { BLOCK_COPY, blockedCopy, dateText, savedSummary } from "./copy";
import {
  type EmailSubscriptionHost,
  hasUnsavedSubscription,
  saveBeforeEmail,
} from "./subscription";

/** Mounted only after the subscription page confirms identity and the saved snapshot. */
export function mountEmailChannel(root: HTMLElement, host: EmailSubscriptionHost) {
  return new EmailPanel(root, host);
}

class EmailPanel {
  private state: EmailView | null = null;
  private busy = false;
  private active = true;
  private preparing: EmailConsentLayer | null = null;
  private pending: EmailConsentLayer | null = null;
  private marker = csrfToken();
  private readonly abort = new AbortController();
  private readonly identityChannel =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("hoyo-draft-identity");

  constructor(
    private readonly root: HTMLElement,
    private readonly host: EmailSubscriptionHost,
  ) {
    root.classList.add("email-panel");
    // Constant markup only; all server/user data is assigned with textContent.
    root.innerHTML = `
      <h3 id="mail-channel-heading">邮件提醒</h3>
      <p data-email="message" role="status" aria-live="polite"></p>
      <div data-email="facts"></div>
      <section class="email-layer" aria-label="邮件提醒席位">
        <h4>邮件提醒（席位）</h4>
        <p>活动取消或时间变了，用邮件通知我。也可补充晚收录提醒，默认关闭。</p>
        <p data-email="seat-status"></p>
        <p id="email-seat-reason" data-email="seat-reason"></p>
        <button type="button" data-email="seat-start" aria-describedby="email-seat-reason">开启邮件提醒</button>
        <button type="button" data-email="seat-stop">关闭全部业务邮件</button>
      </section>
      <section class="email-layer" aria-label="常规提醒邮件子名额">
        <h4>常规提醒邮件（子名额）</h4>
        <p>常规提醒和新活动也发一份邮件，默认关闭。</p>
        <p>已启用日历提醒的话，日历本身会提醒、新活动也会直接出现，这一项通常不需要。再发邮件可能重复提醒；不用外部日历或客户端不支持提醒时，可单独同意开启。</p>
        <p data-email="routine-status"></p>
        <p id="email-routine-reason" data-email="routine-reason"></p>
        <button type="button" data-email="routine-start" aria-describedby="email-routine-reason">开启常规提醒邮件</button>
        <button type="button" data-email="routine-stop">关闭常规提醒邮件</button>
      </section>
      <section data-email="draft-choice" class="email-confirmation" hidden aria-label="处理未保存的订阅改动">
        <h4 tabindex="-1" data-email="draft-heading">有未保存的订阅改动</h4>
        <p>邮件只使用云端已保存内容。请选择保存后继续，或保留草稿并使用已保存设置。</p>
        <button type="button" data-email="save-continue">保存后继续</button>
        <button type="button" data-email="use-saved">使用已保存设置</button>
        <button type="button" data-email="cancel-draft">取消</button>
      </section>
      <section data-email="confirmation" class="email-confirmation" hidden aria-label="确认邮件同意">
        <h4 tabindex="-1" data-email="confirm-heading">确认邮件提醒</h4>
        <div data-email="disclosure"></div>
        <label data-email="seat-label"><input type="checkbox" data-email="seat-consent">我同意开启邮件提醒席位，接收取消、更正和晚收录补充邮件。</label>
        <label data-email="routine-label"><input type="checkbox" data-email="routine-consent">我另外同意开启常规提醒邮件，接收常规提醒和新活动邮件。</label>
        <p data-email="consent-reason"></p>
        <button type="button" data-email="confirm">按以上内容确认开启</button>
        <button type="button" data-email="cancel-confirm">取消</button>
      </section>
      <p>各通道独立，没有自动故障转移，也无法控制外部日历去重。关闭邮件不影响日历、账号登录或浏览器通知。换邮箱后业务邮件需要重新同意。</p>
      <button type="button" data-email="refresh">重新读取邮件状态</button>
      <nav aria-label="邮件帮助"><a href="/account">前往账号页</a> · <a href="/status">查看服务状态</a></nav>`;
    const bind = (name: string, fn: () => void | Promise<void>) =>
      this.el(name).addEventListener("click", () => void fn(), { signal: this.abort.signal });
    bind("refresh", () => this.refresh());
    bind("seat-start", () => this.begin("seat"));
    bind("routine-start", () => this.begin("routine"));
    bind("seat-stop", () => this.disable("seat"));
    bind("routine-stop", () => this.disable("routine"));
    bind("save-continue", () => this.resolveDraft(true));
    bind("use-saved", () => this.resolveDraft(false));
    bind("cancel-draft", () => this.cancel());
    bind("cancel-confirm", () => this.cancel());
    bind("confirm", () => this.confirm());
    for (const layer of ["seat", "routine"] as const)
      this.el(`${layer}-consent`).addEventListener("change", () => this.paint(), {
        signal: this.abort.signal,
      });
    document.addEventListener(
      DRAFT_IDENTITY_EVENT,
      (event) => {
        if (readDraftIdentityEvent(event)) this.dispose();
      },
      { signal: this.abort.signal },
    );
    window.addEventListener("pagehide", () => this.dispose(), { signal: this.abort.signal });
    if (this.identityChannel) this.identityChannel.onmessage = () => this.dispose();
    this.paint();
  }
  private el(name: string): HTMLElement {
    const element = this.root.querySelector<HTMLElement>(`[data-email="${name}"]`);
    if (!element) throw new Error("email_panel_missing_element");
    return element;
  }
  private check(layer: EmailConsentLayer): HTMLInputElement {
    return this.el(`${layer}-consent`) as HTMLInputElement;
  }
  private button(name: string): HTMLButtonElement {
    return this.el(name) as HTMLButtonElement;
  }
  private current(): boolean {
    if (!this.active) return false;
    if (this.marker !== csrfToken() || !this.host.current()) {
      this.dispose();
      return false;
    }
    return true;
  }
  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.state = null;
    this.abort.abort();
    this.identityChannel?.close();
    this.root.replaceChildren();
    this.root.textContent = "身份待确认，已清除邮件状态。请重新读取账号后继续。";
  }
  private message(value: string): void {
    this.el("message").textContent = value;
  }
  private clearConfirmation(): void {
    this.preparing = null;
    this.pending = null;
    this.check("seat").checked = false;
    this.check("routine").checked = false;
    this.el("confirmation").hidden = true;
    this.el("draft-choice").hidden = true;
    this.el("disclosure").replaceChildren();
  }
  private cancel(): void {
    if (!this.current() || this.busy) return;
    this.clearConfirmation();
    this.message("已取消本次同意，没有提交邮件设置。");
    this.paint();
  }
  private paragraph(parent: HTMLElement, text: string): void {
    const p = document.createElement("p");
    p.textContent = text;
    parent.append(p);
  }
  private paint(): void {
    if (!this.current()) return;
    const state = this.state;
    const facts = this.el("facts");
    facts.replaceChildren();
    if (state) {
      this.paragraph(facts, `当前已验证邮箱（脱敏）：${state.email.masked}`);
      const consent = document.createElement("section");
      consent.setAttribute("aria-label", "同意与主动关闭");
      const consentHeading = document.createElement("h4");
      consentHeading.textContent = "同意与主动关闭";
      consent.append(consentHeading);
      for (const layer of ["seat", "routine"] as const) {
        const item = state.consent[layer];
        const label = layer === "seat" ? "席位层" : "常规层";
        this.paragraph(
          consent,
          `${label}同意：${item.version === null ? "尚无同意记录" : `版本 ${item.version}，${dateText(item.enabled_at)}`}；最近操作：${item.last_event === null ? "暂无记录" : `${item.last_event.action === EMAIL_CONSENT_DISABLE_ACTION ? "已关闭" : item.last_event.action === EMAIL_CONSENT_ENABLE_ACTION ? "已记录同意" : "未知"}，${dateText(item.last_event.created_at)}`}。`,
        );
      }
      facts.append(consent);
      const lease = document.createElement("section");
      lease.setAttribute("aria-label", "租期与名额");
      const leaseHeading = document.createElement("h4");
      leaseHeading.textContent = "租期与名额";
      lease.append(leaseHeading);
      this.paragraph(
        lease,
        `名额余量：席位 ${state.remaining.seat === "unknown" ? "未知" : state.remaining.seat} / ${MAIL_SEATS_MAX}；常规提醒子名额 ${state.remaining.routine === "unknown" ? "未知" : state.remaining.routine} / ${MAIL_ROUTINE_SEATS_MAX}。`,
      );
      this.paragraph(
        lease,
        `租期到期：${dateText(state.lease.expires_at)}；最近续租：${dateText(state.lease.last_renewed_at)}。`,
      );
      this.paragraph(
        lease,
        `最近续租依据：${({ explicit_consent: "明确同意", last_interactive_at: "账号真实交互", last_feed_poll_at: "外部日历拉取", last_push_processed_at: "客户端处理信号" } as Record<string, string>)[state.lease.last_renewed_reason ?? ""] ?? "未知 / 暂无记录"}。`,
      );
      this.paragraph(
        lease,
        "租期按账号活动自动续。只要你还在用（包括外部日历在拉取），名额不会因为没回网页而被收走。仍能登录不等于邮件服务仍有效。",
      );
      this.paragraph(
        lease,
        `后台续租处理状态：${state.lease.background_processing === "unknown" ? "未知，尚不能确认后台处理已运行" : "请以服务端记录为准"}。`,
      );
      facts.append(lease);
      const delivery = document.createElement("section");
      delivery.setAttribute("aria-label", "可投递性");
      const deliveryHeading = document.createElement("h4");
      deliveryHeading.textContent = "可投递性";
      delivery.append(deliveryHeading);
      this.paragraph(
        delivery,
        `可投递性：${{ deliverable: "当前未被抑制，不保证送达", suppressed: "当前邮箱无法投递，已被抑制；重新勾选不能解除", unknown: "未知" }[state.deliverability]}。`,
      );
      if (state.suppression_kind)
        this.paragraph(
          delivery,
          `抑制原因：${({ complaint: "投诉", hard_bounce: "硬退信" } as Record<string, string>)[state.suppression_kind] ?? "受控抑制"}。请到账号页处理或验证新邮箱。`,
        );
      facts.append(delivery);
      const service = document.createElement("section");
      service.setAttribute("aria-label", "全站预算与发送状态");
      const serviceHeading = document.createElement("h4");
      serviceHeading.textContent = "全站预算与发送状态";
      service.append(serviceHeading);
      this.paragraph(
        service,
        `发送状态：${{ normal: "正常（不保证每条送达）", budget_limited: "预算受限", sending_paused: "发送暂停", unknown: "未知" }[state.service.state]}。同意已记录也不表示正在发送。`,
      );
      facts.append(service);
    } else this.paragraph(facts, "邮件状态未知，请读取当前事实后再操作。");
    for (const layer of ["seat", "routine"] as const) {
      const enabled = state && (layer === "seat" ? state.enabled : state.routine_enabled);
      this.el(`${layer}-status`).textContent = state
        ? enabled
          ? "已开启"
          : "未开启 / 已关闭"
        : "状态未知";
      const availability = state ? emailChannelEnableAvailability(state, layer) : null;
      this.el(`${layer}-reason`).textContent =
        availability && !availability.allowed ? BLOCK_COPY[availability.reason] : "";
      this.button(`${layer}-start`).disabled =
        this.busy || enabled === true || !availability?.allowed;
      // Suppression/budget must not remove termination access. Server still checks session authority.
      this.button(`${layer}-stop`).disabled = this.busy || !state;
    }
    const canSeat = state ? emailChannelEnableAvailability(state, "seat") : null;
    const canRoutine = state
      ? emailChannelEnableAvailability(
          {
            ...state,
            enabled: state.enabled || (this.preparing === "seat" && this.check("seat").checked),
          },
          "routine",
        )
      : null;
    this.check("seat").disabled = this.busy || !canSeat?.allowed;
    this.check("routine").disabled = this.busy || !canRoutine?.allowed;
    if (!canRoutine?.allowed) this.check("routine").checked = false;
    this.el("consent-reason").textContent =
      canRoutine && !canRoutine.allowed ? BLOCK_COPY[canRoutine.reason] : "";
    this.button("confirm").disabled =
      this.busy ||
      !this.preparing ||
      (this.preparing === "seat"
        ? !this.check("seat").checked || !canSeat?.allowed
        : !this.check("routine").checked || !canRoutine?.allowed);
    for (const name of ["refresh", "save-continue", "use-saved", "cancel-draft", "cancel-confirm"])
      this.button(name).disabled = this.busy;
  }
  private async load(): Promise<boolean> {
    try {
      const state = await readEmail();
      if (!this.current()) return false;
      if (state.subscription.revision < (this.host.machine().getSnapshot()?.revision ?? 0)) {
        throw new Error("stale_email_subscription");
      }
      this.state = state;
      return true;
    } catch (error) {
      if (!this.current()) return false;
      this.state = null;
      const feedback = feedbackForFailure(error instanceof EmailRequestError ? error.body : error);
      this.message(`无法读取邮件状态。${feedback.title}。${feedback.nextStep}`);
      return false;
    }
  }
  savedVersionChanged(): void {
    if (!this.current()) return;
    // Saving through this panel continues by reading a fresh disclosure in prepare().
    if (this.busy) return;
    this.state = null;
    void this.refresh();
  }
  async refresh(): Promise<void> {
    if (!this.current() || this.busy) return;
    this.busy = true;
    this.clearConfirmation();
    this.message("正在读取邮件状态…");
    this.paint();
    if (await this.load()) this.message("已读取当前邮件状态；没有提交任何变更。");
    this.busy = false;
    this.paint();
  }
  private async begin(layer: EmailConsentLayer): Promise<void> {
    if (
      !this.current() ||
      this.busy ||
      !this.state ||
      !emailChannelEnableAvailability(this.state, layer).allowed
    )
      return;
    this.clearConfirmation();
    if (hasUnsavedSubscription(this.host)) {
      this.pending = layer;
      this.el("draft-choice").hidden = false;
      this.el("draft-heading").focus();
      this.paint();
    } else await this.prepare(layer);
  }
  private async resolveDraft(save: boolean): Promise<void> {
    if (!this.current() || this.busy || !this.pending) return;
    const layer = this.pending;
    if (save) {
      this.busy = true;
      this.paint();
      let saved = false;
      try {
        saved = await saveBeforeEmail(this.host);
      } catch {
        /* Host owns save feedback. */
      }
      this.busy = false;
      if (!this.current()) return;
      if (!saved) {
        this.message("订阅尚未确认保存；请先处理保存结果或冲突，再继续。邮件尚未提交。");
        this.paint();
        return;
      }
    }
    await this.prepare(layer);
  }
  private async prepare(layer: EmailConsentLayer): Promise<void> {
    this.clearConfirmation();
    this.busy = true;
    this.paint();
    const loaded = await this.load();
    this.busy = false;
    if (!this.current()) return;
    if (loaded && this.state) {
      const availability = emailChannelEnableAvailability(this.state, layer);
      if (availability.allowed) {
        this.preparing = layer;
        const disclosure = this.el("disclosure");
        this.paragraph(disclosure, `当前已验证邮箱（脱敏）：${this.state.email.masked}`);
        this.paragraph(
          disclosure,
          `已保存内容（版本 ${this.state.subscription.revision}）：${savedSummary(this.state.subscription.config)}`,
        );
        const terms = this.state.disclosure;
        this.paragraph(
          disclosure,
          `每个 UTC 日最多发送机会：席位层 ${terms.daily_limits.seat} 次，常规层 ${terms.daily_limits.routine} 次。非保证每条必达。同一时段的多条提醒会合并成一封；不按浏览器本地午夜重置。`,
        );
        this.paragraph(disclosure, `名额租期 ${terms.lease_days} 天。${terms.renewal}`);
        this.paragraph(disclosure, terms.budget);
        this.paragraph(
          disclosure,
          `同意说明版本 ${terms.consent_version}。第二层默认关闭，因为日历本身已有提醒和新活动，再发邮件可能重复。`,
        );
        this.el("seat-label").hidden = layer !== "seat";
        this.el("confirmation").hidden = false;
        this.message("请核对当前邮箱与已保存内容，分别勾选同意后再确认。");
        this.el("confirm-heading").focus();
      } else this.message(BLOCK_COPY[availability.reason]);
    }
    this.paint();
  }
  private versions(state: EmailView): EmailUpdate {
    return {
      expected_revision: state.channel_revision,
      email_version: state.email.email_version,
      subscription_revision: state.subscription.revision,
    };
  }
  private async confirm(): Promise<void> {
    if (
      !this.current() ||
      this.busy ||
      !this.state ||
      !this.preparing ||
      this.button("confirm").disabled
    )
      return;
    const state = this.state;
    const update = this.versions(state);
    if (this.preparing === "seat") {
      update.enabled = true;
      update.seat_consent_version = state.disclosure.consent_version;
    }
    if (this.check("routine").checked) {
      update.routine_enabled = true;
      update.routine_consent_version = state.disclosure.consent_version;
    }
    await this.write(update);
  }
  private async disable(layer: EmailConsentLayer): Promise<void> {
    if (!this.current() || this.busy || !this.state) return;
    await this.write({
      ...this.versions(this.state),
      ...(layer === "seat" ? { enabled: false } : { routine_enabled: false }),
    });
  }
  private async write(update: EmailUpdate): Promise<void> {
    this.busy = true;
    this.clearConfirmation();
    this.message("正在提交邮件设置…");
    this.paint();
    try {
      const result = await updateEmail(update);
      if (!this.current()) return;
      this.state = result.state;
      const actual = `邮件席位：${result.state.enabled ? "已开启" : "已关闭"}；常规提醒邮件：${result.state.routine_enabled ? "已开启" : "已关闭"}。`;
      this.message(
        result.result === "partial"
          ? `部分完成。${actual}常规提醒子名额已满，本次未能开启常规层。请分别核对下方状态。`
          : `已核对操作结果。${actual}发送情况见下方独立状态。`,
      );
    } catch (error) {
      if (!this.current()) return;
      const body = error instanceof EmailRequestError ? error.body : error;
      const feedback = feedbackForFailure(body);
      const reason =
        typeof body === "object" && body !== null && "blocked_reason" in body
          ? blockedCopy(body.blocked_reason)
          : null;
      const reconfirm =
        error instanceof EmailRequestError &&
        (error.status === 409 || (isApiErrorBody(body) && body.error.code === "validation"));
      const description = reason ?? `${feedback.title}。${feedback.nextStep}`;
      const loaded = await this.load();
      if (!this.current()) return;
      this.message(
        `${description} ${loaded ? "已重新读取当前事实。" : "当前事实仍无法读取，操作结果尚未确认。"}${reconfirm ? "请重新开启确认流程并核对内容，本次同意未重试。" : feedback.outcome === "uncertain" ? "请求结果未知，仅展示重新读取的状态，没有自动重发。" : "请处理原因后再操作，没有自动重发。"}`,
      );
    } finally {
      this.busy = false;
      this.paint();
    }
  }
}
