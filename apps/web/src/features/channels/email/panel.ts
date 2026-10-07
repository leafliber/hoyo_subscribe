import {
  EMAIL_CONSENT_DISABLE_ACTION,
  EMAIL_CONSENT_ENABLE_ACTION,
  type EmailConsentLayer,
  emailChannelEnableAvailability,
  isApiErrorBody,
  MAIL_ROUTINE_SEATS_MAX,
  MAIL_SEATS_MAX,
} from "@hoyo/contracts";
import { el } from "../../../lib/dom";
import { feedbackForFailure } from "../../../lib/errors/feedback";
import { ICONS } from "../../../lib/icons";
import { DRAFT_IDENTITY_EVENT, readDraftIdentityEvent } from "../../../lib/storage/identity";
import { csrfToken } from "../../subscription/save/machine";
import {
  EmailRequestError,
  type EmailUpdate,
  type EmailView,
  readEmail,
  renewAfterEmailOperation,
  updateEmail,
} from "./api";
import { paintCapacityNotice } from "./capacity";
import { BLOCK_COPY, blockedCopy, dateText, savedSummary } from "./copy";
import {
  type EmailSubscriptionHost,
  hasUnsavedSubscription,
  saveBeforeEmail,
} from "./subscription";

const svg = (name: keyof typeof ICONS) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/** 订阅页确认身份与已保存快照后才挂载。 */
export function mountEmailChannel(root: HTMLElement, host: EmailSubscriptionHost) {
  return new EmailPanel(root, host);
}

// 常量结构；服务端与用户数据一律用 textContent 写入。
const MARKUP = `
<div class="channel-head">
  <span class="channel-icon" aria-hidden="true">${svg("mail")}</span>
  <div class="channel-head-text">
    <h3 id="mail-channel-heading">邮件通知</h3>
    <p class="channel-sub">活动取消或改期时，第一时间发邮件告诉你</p>
  </div>
  <span class="status-pill" data-email="pill">读取中</span>
</div>
<p class="channel-message result-message" data-email="message" role="status" aria-live="polite"></p>
<section class="email-capacity" data-email="capacity" aria-label="邮件名额与日历替代方案" hidden></section>
<div class="layer-list">
  <section class="layer" aria-label="邮件提醒席位">
    <div class="layer-text">
      <p class="layer-title">重要变化 <span class="badge" data-email="seat-status">状态未知</span></p>
      <p class="text-aux">活动被取消、时间更正，或较晚才收录的活动。日历无法主动告诉你这些变化，邮件可以。</p>
      <p class="layer-reason" id="email-seat-reason" data-email="seat-reason"></p>
    </div>
    <div class="layer-actions">
      <button type="button" class="button button--sm" data-email="seat-start" aria-describedby="email-seat-reason">开启邮件提醒</button>
      <button type="button" class="button button--secondary button--sm" data-email="seat-stop">关闭全部业务邮件</button>
    </div>
  </section>
  <section class="layer" aria-label="常规提醒邮件子名额">
    <div class="layer-text">
      <p class="layer-title">常规提醒和新活动 <span class="badge" data-email="routine-status">状态未知</span></p>
      <p class="text-aux">按你的提醒规则发提前提醒，以及新活动公布。已启用日历提醒的话，日历本身会提醒、新活动也会直接出现，这一项通常不需要。</p>
      <p class="layer-reason" id="email-routine-reason" data-email="routine-reason"></p>
    </div>
    <div class="layer-actions">
      <button type="button" class="button button--secondary button--sm" data-email="routine-start" aria-describedby="email-routine-reason">开启常规提醒邮件</button>
      <button type="button" class="button button--secondary button--sm" data-email="routine-stop">关闭常规提醒邮件</button>
    </div>
  </section>
</div>
<section class="channel-panel" data-email="draft-choice" hidden aria-label="处理未保存的订阅改动">
  <p class="channel-panel-title" tabindex="-1" data-email="draft-heading">有未保存的修改</p>
  <p class="text-secondary">邮件只使用云端已保存的设置。要先保存这些修改吗？</p>
  <div class="button-row">
    <button type="button" class="button" data-email="save-continue">保存后继续</button>
    <button type="button" class="button button--secondary" data-email="use-saved">使用已保存设置</button>
    <button type="button" class="button button--ghost" data-email="cancel-draft">取消</button>
  </div>
</section>
<section class="channel-panel email-confirmation" data-email="confirmation" hidden aria-label="确认邮件同意">
  <p class="channel-panel-title" tabindex="-1" data-email="confirm-heading">确认开启邮件通知</p>
  <div class="disclosure-list" data-email="disclosure"></div>
  <label class="check check--bordered" data-email="seat-label"><input type="checkbox" data-email="seat-consent"><span class="check-text"><span class="check-title">我同意开启邮件提醒席位</span><span class="check-desc">接收取消、更正和晚收录补充邮件。</span></span></label>
  <label class="check check--bordered" data-email="routine-label"><input type="checkbox" data-email="routine-consent"><span class="check-text"><span class="check-title">我另外同意开启常规提醒邮件</span><span class="check-desc">接收常规提醒和新活动邮件。</span></span></label>
  <p class="layer-reason" data-email="consent-reason"></p>
  <div class="button-row">
    <button type="button" class="button" data-email="confirm">按以上内容确认开启</button>
    <button type="button" class="button button--secondary" data-email="cancel-confirm">取消</button>
  </div>
</section>
<details class="disclosure email-details">
  <summary>邮件状态详情</summary>
  <div data-email="facts"></div>
</details>
<p class="text-aux channel-note">邮件和日历相互独立，同一件事可能各提醒一次。关闭邮件不影响日历、账号登录；换邮箱后需要重新开启。</p>
<div class="channel-foot">
  <a class="link-button" href="/account">${svg("user")}在账号设置中管理邮箱</a>
  <button type="button" class="link-button" data-email="refresh">${svg("refresh")}刷新状态</button>
</div>`;

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
    root.innerHTML = `<div class="card-body">${MARKUP}</div>`;
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
    this.root.classList.remove("email-panel");
    this.root.replaceChildren(
      el(
        "div",
        { class: "card-body" },
        el("h3", { id: "mail-channel-heading", class: "channel-title" }, "邮件通知"),
        el("p", { class: "text-secondary" }, "身份待确认，已清除邮件状态。请重新读取账号后继续。"),
      ),
    );
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
    this.message("已取消，没有修改邮件设置。");
    this.paint();
  }
  private paint(): void {
    if (!this.current()) return;
    const state = this.state;
    const facts = this.el("facts");
    facts.replaceChildren();
    const pill = this.el("pill");
    const pillState = !state
      ? { text: this.busy ? "正在读取…" : "状态未知", kind: "" }
      : state.enabled && state.routine_enabled
        ? { text: "全部开启", kind: "success" }
        : state.enabled
          ? { text: "已开启", kind: "success" }
          : { text: "未开启", kind: "" };
    pill.textContent = pillState.text;
    pill.className = `status-pill${pillState.kind ? ` status-pill--${pillState.kind}` : ""}`;
    if (state) {
      const consent = (layer: "seat" | "routine") => {
        const item = state.consent[layer];
        return `${item.version === null ? "尚无同意记录" : `版本 ${item.version}，${dateText(item.enabled_at)}`}；最近操作：${item.last_event === null ? "暂无记录" : `${item.last_event.action === EMAIL_CONSENT_DISABLE_ACTION ? "已关闭" : item.last_event.action === EMAIL_CONSENT_ENABLE_ACTION ? "已记录同意" : "未知"}，${dateText(item.last_event.created_at)}`}`;
      };
      const renewal =
        (
          {
            explicit_consent: "明确同意",
            last_interactive_at: "账号真实交互",
            last_feed_poll_at: "外部日历拉取",
            last_push_processed_at: "客户端处理信号",
          } as Record<string, string>
        )[state.lease.last_renewed_reason ?? ""] ?? "暂无记录";
      const rows: [string, string][] = [
        ["收件邮箱", `当前已验证邮箱（脱敏）：${state.email.masked}`],
        ["席位层同意", consent("seat")],
        ["常规层同意", consent("routine")],
        [
          "名额余量",
          `席位 ${state.remaining.seat === "unknown" ? "未知" : state.remaining.seat} / ${MAIL_SEATS_MAX}；常规提醒子名额 ${state.remaining.routine === "unknown" ? "未知" : state.remaining.routine} / ${MAIL_ROUTINE_SEATS_MAX}`,
        ],
        [
          "名额租期",
          `到期 ${dateText(state.lease.expires_at)}；最近续租 ${dateText(state.lease.last_renewed_at)}（${renewal}）。只要你还在使用（包括日历应用在拉取），名额会自动续期。`,
        ],
        [
          "可投递性",
          {
            deliverable: "正常（不保证每封都送达）",
            suppressed: "当前邮箱无法投递，已被抑制；重新勾选不能解除",
            unknown: "未知",
          }[state.deliverability] +
            (state.suppression_kind
              ? `；原因：${({ complaint: "投诉", hard_bounce: "硬退信" } as Record<string, string>)[state.suppression_kind] ?? "受控抑制"}。请到账号设置处理或验证新邮箱。`
              : ""),
        ],
        [
          "发送状态",
          `${{ normal: "正常（不保证每条送达）", budget_limited: "预算受限", sending_paused: "发送暂停", unknown: "未知" }[state.service.state]}。同意已记录也不表示正在发送。`,
        ],
      ];
      const list = el("dl", { class: "kv kv--compact" });
      for (const [label, value] of rows) list.append(el("dt", {}, label), el("dd", {}, value));
      facts.append(list);
      facts.append(
        el(
          "section",
          { "aria-label": "同意与主动关闭", class: "sr-only" },
          el("p", {}, `席位层同意：${consent("seat")}`),
          el("p", {}, `常规层同意：${consent("routine")}`),
        ),
      );
    } else facts.append(el("p", { class: "text-aux" }, "邮件状态未知，请刷新后再操作。"));
    for (const layer of ["seat", "routine"] as const) {
      const enabled = state && (layer === "seat" ? state.enabled : state.routine_enabled);
      const status = this.el(`${layer}-status`);
      status.textContent = state ? (enabled ? "已开启" : "未开启") : "状态未知";
      status.className = enabled ? "badge badge--success" : "badge";
      const availability = state ? emailChannelEnableAvailability(state, layer) : null;
      this.el(`${layer}-reason`).textContent =
        availability && !availability.allowed && !enabled ? BLOCK_COPY[availability.reason] : "";
      const start = this.button(`${layer}-start`);
      const stop = this.button(`${layer}-stop`);
      start.hidden = enabled === true;
      stop.hidden = enabled !== true && !(layer === "seat" && state?.routine_enabled);
      start.disabled = this.busy || enabled === true || !availability?.allowed;
      // 抑制或预算问题不能挡住关闭入口；服务端仍校验会话权限。
      stop.disabled = this.busy || !state;
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
    paintCapacityNotice(this.el("capacity"), state, canSeat, canRoutine);
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
  private snapshotIsCurrent(state: EmailView): boolean {
    return state.subscription.revision >= (this.host.machine().getSnapshot()?.revision ?? 0);
  }
  private async load(): Promise<boolean> {
    try {
      const state = await readEmail();
      if (!this.current()) return false;
      if (!this.snapshotIsCurrent(state)) {
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
    // 经本面板保存时，由 prepare() 读取新的披露内容继续。
    if (this.busy) return;
    this.state = null;
    void this.refresh(true);
  }
  async refresh(quiet = false): Promise<void> {
    if (!this.current() || this.busy) return;
    this.busy = true;
    this.clearConfirmation();
    if (!quiet) this.message("正在读取邮件状态…");
    this.paint();
    if (await this.load()) this.message(quiet ? "" : "已刷新邮件状态。");
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
        /* 保存反馈由订阅页负责。 */
      }
      this.busy = false;
      if (!this.current()) return;
      if (!saved) {
        this.message("订阅还没有保存成功，请先处理保存结果；邮件设置未提交。");
        this.paint();
        return;
      }
    }
    await this.prepare(layer);
  }
  private paragraph(parent: HTMLElement, text: string): void {
    parent.append(el("p", {}, text));
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
        this.message("请核对邮箱和内容，勾选同意后再确认。");
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
      // 即使操作已完成，续期前也必须确认身份仍一致。
      void renewAfterEmailOperation(this.abort.signal);
      const actual = `邮件席位：${result.state.enabled ? "已开启" : "已关闭"}；常规提醒邮件：${result.state.routine_enabled ? "已开启" : "已关闭"}。`;
      if (!this.snapshotIsCurrent(result.state)) {
        this.state = null;
        this.message(
          `本次操作${result.result === "partial" ? "部分完成" : "已完成"}（保存版本 ${result.state.subscription.revision}）：${actual}${result.result === "partial" ? "常规提醒子名额已满，本次未能开启常规层。" : ""}订阅已更新为更新版本，请刷新邮件状态；没有自动重发。`,
        );
      } else {
        this.state = result.state;
        this.message(
          result.result === "partial"
            ? `部分完成。${actual}常规提醒子名额已满，本次未能开启常规层。`
            : `已更新。${actual}`,
        );
      }
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
        `${description} ${loaded ? "已重新读取当前状态。" : "当前状态仍无法读取，操作结果尚未确认。"}${reconfirm ? "请重新开启并核对内容，本次同意未重试。" : feedback.outcome === "uncertain" ? "请求结果未知，下面显示的是重新读取的状态，没有自动重发。" : "请处理原因后再操作，没有自动重发。"}`,
      );
    } finally {
      this.busy = false;
      this.paint();
    }
  }
}
