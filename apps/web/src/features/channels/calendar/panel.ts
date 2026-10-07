import {
  type AccountSummary,
  AccountSummarySchema,
  type CalendarPreviewResponse,
  type CalendarView,
  deriveCalendarActions,
  FEED_DIAGNOSTICS,
} from "@hoyo/contracts";
import { feedbackForFailure } from "../../../lib/errors/feedback";
import { stamp } from "../../../lib/format";
import { ICONS } from "../../../lib/icons";
import { PublicApiClient, PublicReadError } from "../../../lib/public-api/client";
import { publishDraftIdentity } from "../../../lib/storage/identity";
import { copyText, toast } from "../../../lib/toast";
import { type EmailSubscriptionHost, hasUnsavedSubscription } from "../email/subscription";
import { CalendarRequestError, errorDetail, type Operation, readCalendar, request } from "./api";
import { renderSavedPreview, savedPreview } from "./preview";

export interface CalendarHost extends EmailSubscriptionHost {
  disableAlarms(): Promise<void>;
  addressChanged(enabled: boolean): void;
  userId(): string | null;
}

const svg = (name: keyof typeof ICONS) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// 只有常量结构；服务端与用户数据一律用 textContent 写入。私人地址从不进入 DOM，
// 仅在复制失败时由用户主动触发的手动复制框显示。
const MARKUP = `
<div class="channel-head">
  <span class="channel-icon" aria-hidden="true">${svg("calendar")}</span>
  <div class="channel-head-text">
    <h3 id="calendar-channel-heading" tabindex="-1">日历订阅</h3>
    <p class="channel-sub">自动同步到 Apple 日历、Google 日历、Outlook 等</p>
  </div>
  <span class="status-pill" data-calendar="pill">读取中</span>
</div>
<p class="channel-message result-message" data-calendar="message" role="status" aria-live="polite"></p>
<div class="channel-intro" data-calendar="intro">
  <p class="text-secondary">生成一个只属于你的订阅链接。添加到日历应用后，新活动、改期和取消都会自动同步，还能按你的设置提前提醒。</p>
  <p class="callout callout--info" data-calendar="reason" hidden></p>
  <div class="button-row">
    <button type="button" class="button" data-calendar="begin">${svg("calendar-check")}<span data-calendar="begin-label">启用日历订阅</span></button>
    <a class="button button--secondary" data-calendar="recovery" href="/recover#save" hidden>${svg("key")}保存新恢复码</a>
  </div>
</div>
<section class="channel-panel" data-calendar="draft" hidden aria-label="处理日历未保存改动">
  <p class="channel-panel-title">有未保存的修改</p>
  <p class="text-secondary">日历只使用云端已保存的设置。要先保存这些修改吗？</p>
  <div class="button-row">
    <button type="button" class="button" data-calendar="save">保存后继续</button>
    <button type="button" class="button button--secondary" data-calendar="saved">使用已保存设置</button>
  </div>
</section>
<section class="channel-preview" data-calendar="preview" aria-label="启用前服务端预览"></section>
<div class="channel-confirm" data-calendar="confirmation" hidden>
  <p class="text-aux">订阅链接是私人凭证，任何拿到链接的人都能看到你的订阅内容，请勿分享或截图公开。</p>
</div>
<div class="button-row confirm-actions">
  <button type="button" class="button" data-calendar="confirm" hidden>${svg("check")}确认启用</button>
  <button type="button" class="button button--secondary" data-calendar="cancel" hidden>取消</button>
</div>
<div class="channel-active" data-calendar="active" hidden>
  <div class="button-row add-actions">
    <button type="button" class="button" data-calendar="copy">${svg("copy")}复制订阅链接</button>
    <button type="button" class="button button--secondary" data-calendar="webcal">${svg("calendar")}用日历应用打开</button>
  </div>
  <div class="manual-copy" data-calendar="manual" hidden>
    <label for="calendar-manual-url">复制失败，请手动选择下面的链接并复制</label>
    <input id="calendar-manual-url" class="input mono" readonly data-calendar="manual-input" />
  </div>
  <details class="disclosure guide">
    <summary>查看订阅步骤</summary>
    <ol class="guide-steps">
      <li><strong>Apple 日历（iPhone / Mac）</strong>：点「用日历应用打开」，或在日历中选择「文件 → 新建日历订阅」并粘贴链接。<span class="badge badge--success">已实测</span></li>
      <li><strong>Google 日历</strong>：在网页版左侧「其他日历 → 通过网址添加」，粘贴链接。同步较慢（可能数小时），且不会使用这里的提醒设置。<span class="badge">未实测</span></li>
      <li><strong>Outlook</strong>：在「添加日历 → 从 Web 订阅」中粘贴链接。<span class="badge">未实测</span></li>
    </ol>
    <p class="text-aux">请使用「订阅」而不是「导入」，导入的文件不会自动更新。日历多久刷新一次由日历应用决定。</p>
  </details>
</div>
<div class="callout callout--warning" data-calendar="guard" hidden>
  ${svg("alert-triangle")}
  <div class="callout-body">
    <p class="callout-title">日历暂时没有更新</p>
    <p>本次输出未通过完整性检查，已暂停更新以保护你现有的日历内容。你的日历会保留上一次成功的内容，请保持订阅，不要重置链接或重新订阅。</p>
    <p><a href="https://github.com/leafliber/hoyo_subscribe/issues/new" target="_blank" rel="noopener noreferrer">反馈问题（请勿附上私人链接）</a></p>
  </div>
</div>
<dl class="kv channel-facts">
  <dt>链接状态</dt><dd data-calendar="address">未知</dd>
  <dt>使用的设置</dt><dd data-calendar="config">未知</dd>
  <dt>内容输出</dt><dd><span data-calendar="output">未知</span><span class="fact-sub" data-calendar="last-output"></span></dd>
  <dt>日历应用拉取</dt><dd data-calendar="polling">未知</dd>
</dl>
<details class="disclosure manage" data-calendar="manage">
  <summary>管理订阅链接</summary>
  <div class="manage-list">
    <div class="manage-row">
      <div><p class="manage-title">关闭日历提醒</p><p class="text-aux">日历仍然显示活动，只是不再弹出提醒。会同时保存当前的其他修改。</p></div>
      <button type="button" class="button button--secondary button--sm" data-calendar="alarms">关闭提醒</button>
    </div>
    <div class="manage-row">
      <div><p class="manage-title">重置链接</p><p class="text-aux">旧链接立即失效，所有已添加的日历都要换成新链接。适合链接泄露时使用。</p></div>
      <button type="button" class="button button--danger-outline button--sm" data-calendar="reset">重置链接</button>
    </div>
    <div class="manage-row">
      <div><p class="manage-title">停用日历订阅</p><p class="text-aux">链接永久失效；已同步到日历里的内容不会被删除。以后可以重新启用，会得到新链接。</p></div>
      <button type="button" class="button button--danger-outline button--sm" data-calendar="disable">停用</button>
    </div>
  </div>
</details>
<div class="channel-foot">
  <button type="button" class="button button--secondary button--sm" data-calendar="retry" hidden>用同一操作核对结果</button>
  <button type="button" class="link-button" data-calendar="refresh">${svg("refresh")}刷新状态</button>
</div>`;

export class CalendarPanel {
  private state: CalendarView | null = null;
  private account: AccountSummary | null = null;
  private preview: CalendarPreviewResponse | null = null;
  private operation: Operation | null = null;
  private capability: "open" | "closed" | "unknown" = "unknown";
  private busy = false;
  private active = true;
  private loaded = false;
  private previewAbort: AbortController | null = null;
  private previewSerial = 0;
  private readonly abort = new AbortController();
  constructor(
    private readonly root: HTMLElement,
    private readonly host: CalendarHost,
  ) {
    root.classList.add("calendar-panel");
    root.innerHTML = `<div class="card-body">${MARKUP}</div>`;
    const bind = (key: string, fn: () => void | Promise<void>) =>
      this.el(key).addEventListener("click", () => void fn(), { signal: this.abort.signal });
    bind("begin", () => this.begin());
    bind("refresh", () => this.refresh());
    bind("copy", () => this.copy());
    bind("webcal", () => this.openInApp());
    bind("save", () => this.resolveDraft(true));
    bind("saved", () => this.resolveDraft(false));
    bind("confirm", () => this.enable());
    bind("retry", () => this.write());
    bind("disable", () => this.manage("disable"));
    bind("reset", () => this.manage("reset"));
    bind("alarms", () => this.disableAlarms());
    bind("cancel", () => {
      this.clearPreview();
      this.busy = false;
      this.message("已取消，没有启用日历订阅。");
      this.paint();
    });
    (this.el("manual-input") as HTMLInputElement).addEventListener(
      "focus",
      (event) => (event.target as HTMLInputElement).select(),
      { signal: this.abort.signal },
    );
    this.paint();
    // 只读读取：不续期会话，不提交任何变更。
    void this.refresh(true);
  }
  private el(key: string): HTMLElement {
    return this.root.querySelector(`[data-calendar="${key}"]`) as HTMLElement;
  }
  private button(key: string): HTMLButtonElement {
    return this.el(key) as HTMLButtonElement;
  }
  private current(): boolean {
    return this.active && this.host.current();
  }
  private message(text: string): void {
    if (this.current()) this.el("message").textContent = text;
  }
  dispose(): void {
    this.active = false;
    this.abort.abort();
    this.previewAbort?.abort();
    this.state = null;
    this.account = null;
    this.preview = null;
    this.operation = null;
    this.host.addressChanged(false);
    this.root.classList.remove("calendar-panel");
    this.root.innerHTML = "";
    const body = document.createElement("div");
    body.className = "card-body";
    const heading = document.createElement("h3");
    heading.id = "calendar-channel-heading";
    heading.className = "channel-title";
    heading.textContent = "日历订阅";
    const text = document.createElement("p");
    text.className = "text-secondary";
    text.textContent = "身份待确认，已清除日历状态。";
    body.append(heading, text);
    this.root.append(body);
  }
  private clearPreview(): void {
    this.previewSerial++;
    this.previewAbort?.abort();
    this.previewAbort = null;
    this.preview = null;
    this.el("preview").replaceChildren();
    this.el("confirmation").hidden = true;
    this.el("draft").hidden = true;
    this.el("cancel").hidden = true;
  }
  savedVersionChanged(): void {
    this.clearPreview();
    if (!this.busy && this.state) void this.refresh(true);
  }
  private paint(): void {
    if (!this.current()) return;
    this.root.setAttribute("aria-busy", String(this.busy));
    const state = this.state;
    const actions = this.account ? deriveCalendarActions(this.account) : null;
    const enabled = state?.address_state === "enabled";
    const pill = this.el("pill");
    const pillState = !state
      ? this.loaded
        ? { text: "状态未知", kind: "warning" }
        : { text: "读取中", kind: "" }
      : enabled
        ? state.output.state === "integrity_blocked"
          ? { text: "暂停更新", kind: "warning" }
          : { text: "已启用", kind: "success" }
        : state.address_state === "disabled"
          ? { text: "已停用", kind: "" }
          : { text: "未启用", kind: "" };
    pill.textContent = pillState.text;
    pill.className = `status-pill${pillState.kind ? ` status-pill--${pillState.kind}` : ""}`;

    this.el("address").textContent = state
      ? {
          not_enabled: "未启用",
          enabled: "有效 · 日历订阅地址已创建",
          disabled: "已停用 · 旧地址已失效",
        }[state.address_state]
      : "未知";
    this.el("config").textContent = state
      ? state.configuration.state === "uninitialized"
        ? "尚未保存订阅设置"
        : `已保存版本 ${state.configuration.revision} · 日历提醒${state.configuration.alarms_enabled ? "已开启" : "已关闭"}`
      : "未知";
    let output = state
      ? {
          unknown: "尚无输出记录",
          normal: "正常，能生成完整内容",
          integrity_blocked: "本次输出未通过完整性检查，已暂停更新以保护你现有的日历内容",
          unavailable: "暂不可用，请稍后重试或查看服务状态",
        }[state.output.state]
      : "未知";
    if (
      state?.output.state === "unavailable" &&
      state.output.diagnostic &&
      Object.hasOwn(FEED_DIAGNOSTICS, state.output.diagnostic)
    )
      output += `：${FEED_DIAGNOSTICS[state.output.diagnostic as keyof typeof FEED_DIAGNOSTICS]}`;
    this.el("output").textContent = output;
    this.el("last-output").textContent =
      state && state.output.last_served_at !== null
        ? `上次成功输出：${stamp(state.output.last_served_at)}，共 ${state.output.last_served_node_count ?? "未知"} 条`
        : "";
    this.el("polling").textContent = state
      ? state.polling.last_feed_poll_at === null
        ? "还没有日历应用拉取过"
        : `${stamp(state.polling.last_feed_poll_at)}（按天记录，最多滞后 ${state.polling.merge_interval_days} 天；不代表所有设备都已同步）`
      : "未知";
    this.el("guard").hidden = state?.output.state !== "integrity_blocked";

    const reason = actions && !actions.enable.allowed ? actions.enable.reason : null;
    const closed = this.capability === "closed";
    const reasonText = closed
      ? "日历订阅暂未开放，开放后就可以在这里启用。"
      : reason
        ? {
            pending_activation: "请先完成登录激活。",
            recovery_code_unconfirmed: "请先保存并确认恢复登录后的新恢复码。",
            subscription_uninitialized: "请先保存一次订阅设置。",
            recent_auth_required: "请重新验证身份。",
            capacity_full: "名额已满。",
            quota_paused: "额度暂停。",
            feature_closed: "日历订阅暂未开放。",
          }[reason]
        : this.account || !this.loaded
          ? ""
          : "账号状态未知，请刷新后再试。";
    const reasonEl = this.el("reason");
    reasonEl.textContent = reasonText;
    reasonEl.hidden = !reasonText || enabled;
    // 恢复码可选（ADR-0026）；只有恢复登录后的受限会话要先保存新码。
    this.el("recovery").hidden = enabled || reason !== "recovery_code_unconfirmed";

    const locked = this.busy || this.operation !== null;
    const previewing =
      this.preview !== null || !this.el("draft").hidden || this.previewAbort !== null;
    this.el("intro").hidden = enabled || previewing;
    this.el("active").hidden = !enabled;
    this.el("begin-label").textContent =
      state?.address_state === "disabled" ? "重新启用日历订阅" : "启用日历订阅";
    this.button("begin").disabled =
      locked || !state || enabled || !actions?.enable.allowed || closed;
    this.button("copy").disabled = locked || !enabled;
    this.button("webcal").disabled = locked || !enabled;
    this.el("manage").hidden = !state || state.address_state === "not_enabled";
    this.button("disable").disabled = locked || !state || !actions?.disable.allowed || !enabled;
    this.button("reset").disabled = locked || !enabled || !actions?.reset.allowed;
    this.button("alarms").disabled =
      locked ||
      !this.account ||
      this.account.session.recovery_code_required ||
      !state?.configuration.alarms_enabled;
    this.button("confirm").disabled = locked || this.preview?.outcome !== "ok";
    this.button("confirm").hidden = this.el("confirmation").hidden;
    for (const key of ["save", "saved", "refresh", "retry"]) this.button(key).disabled = this.busy;
    this.el("retry").hidden = !this.operation;
    if (!enabled) this.el("manual").hidden = true;
  }
  private async readCapability(): Promise<void> {
    try {
      // ADR-0032：与本页其他入口共用一次 `/api/v2/status` 读取。
      this.capability = (await new PublicApiClient().capabilities()).calendar;
    } catch (error) {
      // 服务端明确报错时保留原值（与改动前一致）；网络失败或形状不符按 unknown。
      if (!(error instanceof PublicReadError && error.kind === "http")) this.capability = "unknown";
    }
  }
  private async load(): Promise<void> {
    const account = AccountSummarySchema.parse(await request("me", this.abort.signal));
    if (!this.current()) return;
    if (account.user_id !== this.host.userId()) {
      publishDraftIdentity({ status: "unknown" });
      return;
    }
    const view = await readCalendar(this.abort.signal);
    if (!this.current()) return;
    if (view.configuration.revision < (this.host.machine().getSnapshot()?.revision ?? 0))
      throw new Error("stale_calendar_view");
    // 只保留非秘密状态；复制时再按需读取地址。
    this.account = account;
    this.state = { ...view, url: null };
    this.host.addressChanged(view.address_state === "enabled");
  }
  private failed(error: unknown): void {
    if (!this.current()) return;
    const reason = errorDetail(error).reason;
    if (
      error instanceof CalendarRequestError &&
      error.status === 401 &&
      (reason === "no_session" ||
        reason === "session_expired" ||
        reason === "pending_activation" ||
        reason === "wrong_domain")
    ) {
      publishDraftIdentity({ status: "unknown" });
      return;
    }
    const feedback = feedbackForFailure(error instanceof CalendarRequestError ? error.body : error);
    this.message(`${feedback.title}。${feedback.nextStep}`);
  }
  async refresh(initial = false): Promise<void> {
    if (!this.current() || this.busy) return;
    this.clearPreview();
    this.busy = true;
    this.paint();
    try {
      await Promise.all([this.load(), this.readCapability()]);
      this.loaded = true;
      if (!initial || this.operation)
        this.message(
          this.operation
            ? "已读取当前状态；原操作的结果仍需用同一操作核对，没有发起新的重置。"
            : "已刷新日历状态。",
        );
    } catch (error) {
      if (!this.current()) return;
      this.loaded = true;
      this.state = null;
      this.account = null;
      this.host.addressChanged(false);
      this.failed(error);
    } finally {
      this.busy = false;
      this.paint();
    }
  }
  async begin(): Promise<void> {
    if (!this.current() || this.busy || this.button("begin").disabled) return;
    this.clearPreview();
    if (hasUnsavedSubscription(this.host)) {
      this.el("draft").hidden = false;
      this.paint();
      this.el("draft").scrollIntoView({ block: "center" });
    } else await this.prepare();
  }
  private async resolveDraft(save: boolean): Promise<void> {
    if (!this.current() || this.busy) return;
    if (save) {
      this.busy = true;
      this.paint();
      try {
        await this.host.save();
      } finally {
        this.busy = false;
      }
      if (!this.current()) return;
      if (this.host.phase() !== "saved" || hasUnsavedSubscription(this.host)) {
        this.message("订阅还没有保存成功，请先处理保存结果。");
        this.paint();
        return;
      }
    }
    await this.prepare();
  }
  private async prepare(restarted = false): Promise<void> {
    this.clearPreview();
    this.busy = true;
    const controller = new AbortController();
    this.previewAbort = controller;
    this.el("cancel").hidden = false;
    this.paint();
    const serial = this.previewSerial;
    let outdated = false;
    try {
      await this.load();
      if (!this.current() || controller.signal.aborted) return;
      const preview = await savedPreview(controller.signal, (text) => this.message(text));
      if (!this.current() || serial !== this.previewSerial) return;
      this.preview = preview;
      renderSavedPreview(this.el("preview"), preview);
      this.el("confirmation").hidden = preview.outcome !== "ok";
      this.message(
        preview.outcome === "ok"
          ? "请确认下面的日历内容，然后点「确认启用」。"
          : "预览受阻，暂时不能启用；请缩小订阅范围或稍后重试。",
      );
    } catch (error) {
      if (!this.current() || serial !== this.previewSerial) return;
      outdated = errorDetail(error).reason === "preview_outdated";
      this.clearPreview();
      if (outdated)
        this.message(
          restarted
            ? "预览反复过期，已停止自动重取。订阅范围很大时可能无法一次取全，请缩小范围后再试。"
            : "数据刚刚更新，正在重新生成预览…",
        );
      else this.failed(error);
    } finally {
      if (this.current() && (serial === this.previewSerial || !this.previewAbort)) {
        this.busy = false;
        this.previewAbort = null;
        this.paint();
      }
    }
    if (outdated && !restarted && this.current()) await this.prepare(true);
  }
  private async enable(): Promise<void> {
    if (!this.current() || this.button("confirm").disabled || !this.state || !this.preview) return;
    this.operation = {
      action: "enable",
      key: crypto.randomUUID(),
      body: {
        confirmed: true,
        expected_generation: this.state.token_generation,
        expected_revision: this.preview.subscription.revision,
        publication_generation: this.preview.publication.generation,
      },
    };
    await this.write();
  }
  private async manage(action: "disable" | "reset"): Promise<void> {
    if (!this.current() || this.button(action).disabled || !this.state) return;
    if (
      !window.confirm(
        action === "disable"
          ? "停用后当前链接将永久失效（已同步到日历里的内容不会被删除）。以后重新启用会得到新链接。确定停用吗？"
          : "重置后旧链接立即失效，所有已添加这个日历的设备都需要换成新链接。确定重置吗？",
      )
    )
      return;
    this.operation = {
      action,
      key: crypto.randomUUID(),
      body: { confirmed: true, expected_generation: this.state.token_generation },
    };
    await this.write();
  }
  private async write(): Promise<void> {
    if (!this.current() || this.busy || !this.operation) return;
    const operation = this.operation;
    this.clearPreview();
    this.busy = true;
    this.paint();
    let outdated = false;
    try {
      const result = await request(
        `me/calendar/${operation.action}`,
        this.abort.signal,
        operation.body,
        operation.key,
      );
      if (!this.current()) return;
      if (
        !result ||
        typeof result !== "object" ||
        !("token_generation" in result) ||
        !("address_state" in result) ||
        !("changed" in result) ||
        typeof result.changed !== "boolean" ||
        typeof result.token_generation !== "number" ||
        !Number.isSafeInteger(result.token_generation) ||
        result.token_generation < operation.body.expected_generation ||
        (result.address_state !== "enabled" &&
          result.address_state !== "disabled" &&
          result.address_state !== "not_enabled")
      )
        throw new Error("unknown_calendar_result");
      this.operation = null;
      if (document.visibilityState === "visible")
        void request("auth/renew", this.abort.signal, {}).catch(() => {});
      try {
        await this.load();
      } catch (error) {
        this.state = null;
        this.host.addressChanged(false);
        this.failed(error);
        this.message("操作已完成，但当前状态读取失败，请点「刷新状态」。没有重复发起操作。");
        return;
      }
      this.message(
        operation.action === "disable"
          ? "日历订阅已停用，已同步到日历里的内容不会被删除。"
          : operation.action === "reset"
            ? "已生成新的订阅链接，请把所有日历里的旧链接换成新链接。"
            : "日历订阅地址已创建！复制链接或用日历应用打开即可添加。",
      );
      if (operation.action !== "disable") this.button("copy").focus();
    } catch (error) {
      if (!this.current()) return;
      outdated = errorDetail(error).reason === "preview_outdated";
      // 标准 5xx 可能发生在 CAS 已提交之后；保留原操作键直到核对出结果。
      if (error instanceof CalendarRequestError && error.status < 500) this.operation = null;
      this.failed(error);
      if (this.operation)
        this.message("操作结果暂时不确定。请点「用同一操作核对结果」，不会生成新的链接。");
      try {
        await this.load();
      } catch (readError) {
        this.state = null;
        this.failed(readError);
      }
    } finally {
      this.busy = false;
      this.paint();
    }
    if (outdated && this.current()) await this.prepare();
  }
  /** 复制前重新读取，确认地址仍属于当前代次；地址不长期留在页面里。 */
  private async freshUrl(): Promise<string | null> {
    const view = await readCalendar(this.abort.signal);
    if (!this.current()) return null;
    if (
      view.address_state !== "enabled" ||
      !view.url ||
      view.token_generation !== this.state?.token_generation
    ) {
      this.message("链接状态已变化，请刷新后再试。");
      return null;
    }
    return view.url;
  }
  private async copy(): Promise<void> {
    if (!this.current() || this.button("copy").disabled) return;
    this.busy = true;
    this.paint();
    try {
      const url = await this.freshUrl();
      if (!url) return;
      if (await copyText(url)) {
        this.el("manual").hidden = true;
        (this.el("manual-input") as HTMLInputElement).value = "";
        toast("订阅链接已复制");
        this.message("链接已复制。粘贴到日历应用的「订阅日历」中即可。请勿公开分享。");
      } else {
        const input = this.el("manual-input") as HTMLInputElement;
        input.value = url;
        this.el("manual").hidden = false;
        input.focus();
        this.message("无法自动复制，请手动复制下面的链接。");
      }
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy = false;
      this.paint();
    }
  }
  private async openInApp(): Promise<void> {
    if (!this.current() || this.button("webcal").disabled) return;
    this.busy = true;
    this.paint();
    try {
      const url = await this.freshUrl();
      if (!url) return;
      this.message("正在打开日历应用…如果没有反应，请改用「复制订阅链接」。");
      window.location.href = url.replace(/^https?:/, "webcal:");
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy = false;
      this.paint();
    }
  }
  // 订阅保存状态机负责回执校验和一次续期。
  private async disableAlarms(): Promise<void> {
    if (!this.current() || this.button("alarms").disabled) return;
    if (
      !window.confirm(
        "关闭日历提醒并保存当前设置？日历仍会显示活动，链接和邮件设置不变；其他未保存的修改也会一起保存。",
      )
    )
      return;
    this.busy = true;
    this.clearPreview();
    this.paint();
    try {
      await this.host.disableAlarms();
      await this.load();
      this.message(
        this.host.phase() === "saved"
          ? "日历提醒已关闭，链接保持不变；日历应用会在下次刷新时更新。"
          : "还没有保存成功，请处理订阅的保存状态。",
      );
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy = false;
      this.paint();
    }
  }
}
