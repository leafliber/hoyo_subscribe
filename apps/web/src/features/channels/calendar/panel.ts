import "./style.css";
import {
  type AccountSummary,
  AccountSummarySchema,
  type CalendarPreviewResponse,
  type CalendarView,
  deriveCalendarActions,
  FEED_DIAGNOSTICS,
  isApiErrorBody,
} from "@hoyo/contracts";
import { feedbackForFailure } from "../../../lib/errors/feedback";
import { publishDraftIdentity } from "../../../lib/storage/identity";
import { type EmailSubscriptionHost, hasUnsavedSubscription } from "../email/subscription";
import { CalendarRequestError, errorDetail, type Operation, readCalendar, request } from "./api";
import { renderSavedPreview, savedPreview } from "./preview";

export interface CalendarHost extends EmailSubscriptionHost {
  disableAlarms(): Promise<void>;
  addressChanged(enabled: boolean): void;
  userId(): string | null;
}
export class CalendarPanel {
  private state: CalendarView | null = null;
  private account: AccountSummary | null = null;
  private preview: CalendarPreviewResponse | null = null;
  private operation: Operation | null = null;
  private busy = false;
  private active = true;
  private previewAbort: AbortController | null = null;
  private previewSerial = 0;
  private readonly abort = new AbortController();
  constructor(
    private readonly root: HTMLElement,
    private readonly host: CalendarHost,
  ) {
    root.classList.add("calendar-panel");
    // Static markup only. Private URLs never enter the DOM, preferences, diagnostics or screenshots.
    root.innerHTML = `<h3 id="calendar-channel-heading" tabindex="-1">日历订阅</h3>
      <p data-calendar="message" role="status" aria-live="polite"></p>
      <section aria-label="地址状态"><h4>地址状态</h4><p data-calendar="address">未知</p></section>
      <section aria-label="配置状态"><h4>配置状态</h4><p data-calendar="config">未知</p></section>
      <section aria-label="输出状态"><h4>输出状态</h4><p data-calendar="output">未知</p><p data-calendar="last-output"></p><p data-calendar="polling"></p><a href="https://github.com/leafliber/hoyo_subscribe/issues/new">联系维护者（请勿附上私人地址）</a></section>
      <section aria-label="客户端情况"><h4>客户端情况</h4><p>Apple Calendar / macOS：2026-09-22 实测完整快照删除、重新加入、改期、503 保留旧结果及 VALARM 提醒通过。客户端版本与刷新延迟未记录。</p><p>Google Calendar、Outlook：未测，支持情况未知。外部客户端何时刷新由客户端决定。</p></section>
      <p data-calendar="reason"></p><a data-calendar="recovery" href="/recover#save" hidden>保存并确认恢复码</a>
      <button type="button" data-calendar="begin">启用日历订阅</button>
      <button type="button" data-calendar="copy">复制地址</button>
      <details><summary>查看订阅步骤</summary><p>在目标客户端选择订阅日历，粘贴复制的只读地址，并检查订阅日历的提醒设置。单次下载导入不会持续更新。复制成功不等于客户端已添加。</p></details>
      <details><summary>管理日历地址</summary>
        <p>关闭日历提醒只保存配置，保留基础节点、日历地址及邮件/Push。停用永久撤销当前地址，但不能擦除已经下载的副本。重置后所有客户端都需要替换地址；再次启用会创建新地址，旧地址不会恢复。</p>
        <button type="button" data-calendar="alarms">关闭日历提醒并保存订阅</button>
        <button type="button" data-calendar="disable">停用日历地址</button>
        <button type="button" data-calendar="reset">重置日历地址</button>
      </details>
      <section data-calendar="draft" hidden aria-label="处理日历未保存改动"><h4>有未保存的订阅改动</h4><p>日历仅使用云端已保存设置。草稿不会自动生效。</p><button type="button" data-calendar="save">保存后继续</button><button type="button" data-calendar="saved">使用已保存设置</button></section>
      <section data-calendar="preview" aria-label="启用前服务端预览"></section>
      <section data-calendar="confirmation" hidden><label><input type="checkbox" data-calendar="consent">我已核对完整的已保存预览、客户端限制和只读地址用途</label><button type="button" data-calendar="confirm">确认启用日历订阅</button></section>
      <button type="button" data-calendar="cancel" hidden>取消本次预览</button>
      <button type="button" data-calendar="retry" hidden>用同一操作核对结果</button>
      <button type="button" data-calendar="refresh">重新读取日历状态</button>`;
    const bind = (key: string, fn: () => void | Promise<void>) =>
      this.el(key).addEventListener("click", () => void fn(), { signal: this.abort.signal });
    bind("begin", () => this.begin());
    bind("refresh", () => this.refresh());
    bind("copy", () => this.copy());
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
      this.message("已取消预览，没有提交启用。");
      this.paint();
    });
    this.el("consent").addEventListener("change", () => this.paint(), {
      signal: this.abort.signal,
    });
    this.paint();
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
    this.root.textContent = "身份待确认，已清除日历状态。";
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
    (this.el("consent") as HTMLInputElement).checked = false;
  }
  savedVersionChanged(): void {
    this.clearPreview();
    if (!this.busy && this.state) void this.refresh();
  }
  private paint(): void {
    if (!this.current()) return;
    this.root.setAttribute("aria-busy", String(this.busy));
    const state = this.state;
    const actions = this.account ? deriveCalendarActions(this.account) : null;
    this.el("address").textContent = state
      ? {
          not_enabled: "未启用",
          enabled: "有效 · 日历订阅地址已创建",
          disabled: "已停用 · 旧地址已失效",
        }[state.address_state]
      : "未知";
    this.el("config").textContent = state
      ? `已保存版本 ${state.configuration.revision}；${state.configuration.state === "uninitialized" ? "尚未保存配置" : `日历提醒${state.configuration.alarms_enabled ? "已选择" : "关闭"}`}。不代表客户端已应用。`
      : "未知";
    this.el("output").textContent = state
      ? {
          unknown: "尚无已确认的输出结果",
          normal: "最近一次能生成完整内容；不代表客户端已应用",
          integrity_blocked: "本次输出未通过完整性检查，已暂停更新以保护你现有的日历内容",
          unavailable: "日历输出暂不可用，请查看服务状态或稍后重试",
        }[state.output.state]
      : "未知";
    const time = (ms: number | null) =>
      ms === null
        ? "未知 / 尚无记录"
        : new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    if (
      state?.output.state === "unavailable" &&
      state.output.diagnostic &&
      Object.hasOwn(FEED_DIAGNOSTICS, state.output.diagnostic)
    )
      this.el("output").textContent +=
        `：${FEED_DIAGNOSTICS[state.output.diagnostic as keyof typeof FEED_DIAGNOSTICS]}`;
    this.el("last-output").textContent = state
      ? `上次成功输出：${time(state.output.last_served_at)}（北京时间 UTC+8）；条目数：${state.output.last_served_node_count ?? "未知"}。`
      : "";
    this.el("polling").textContent = state
      ? `客户端曾请求地址：${time(state.polling.last_feed_poll_at)}；按天合并记录，最多滞后 ${state.polling.merge_interval_days} 天。不能证明所有设备已同步或提醒已送达。`
      : "";
    const reason = actions && !actions.enable.allowed ? actions.enable.reason : null;
    this.el("reason").textContent = reason
      ? {
          pending_activation: "请先激活会话。",
          recovery_code_unconfirmed: "请先保存并确认恢复登录后的新恢复码。",
          recovery_code_not_saved: "首次启用前，请保存并确认恢复码。",
          subscription_uninitialized: "请先保存一次订阅内容。",
          recent_auth_required: "请重新验证身份。",
          capacity_full: "名额已满。",
          quota_paused: "额度暂停。",
          feature_closed: "日历启用暂时关闭。",
        }[reason]
      : this.account
        ? ""
        : "账号准入事实未知，请重新读取。";
    this.el("recovery").hidden =
      reason !== "recovery_code_unconfirmed" && reason !== "recovery_code_not_saved";
    const locked = this.busy || this.operation !== null;
    this.button("begin").textContent =
      state?.address_state === "disabled" ? "再次启用日历订阅" : "启用日历订阅";
    this.button("begin").disabled =
      locked || !state || state.address_state === "enabled" || !actions?.enable.allowed;
    this.button("copy").disabled = locked || state?.address_state !== "enabled";
    this.button("disable").disabled = locked || !state || !actions?.disable.allowed;
    this.button("reset").disabled =
      locked || state?.address_state !== "enabled" || !actions?.reset.allowed;
    this.button("alarms").disabled =
      locked ||
      !this.account ||
      this.account.session.recovery_code_required ||
      !state?.configuration.alarms_enabled;
    this.button("confirm").disabled =
      locked || this.preview?.outcome !== "ok" || !(this.el("consent") as HTMLInputElement).checked;
    for (const key of ["save", "saved", "refresh", "retry"]) this.button(key).disabled = this.busy;
    this.el("retry").hidden = !this.operation;
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
    // Keep only non-secret status. Fetch again on the explicit copy action.
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
  async refresh(): Promise<void> {
    if (!this.current() || this.busy) return;
    this.clearPreview();
    this.busy = true;
    this.paint();
    try {
      await this.load();
      this.message(
        this.operation
          ? "已读取当前地址状态；原操作结果仍须用同一操作键核对，未发起新重置。"
          : "已读取当前日历事实，没有提交变更。",
      );
    } catch (error) {
      if (!this.current()) return;
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
      this.el("draft").scrollIntoView({ block: "center" });
    } else await this.prepare();
  }
  private async resolveDraft(save: boolean): Promise<void> {
    if (!this.current() || this.busy) return;
    if (save) {
      this.busy = true;
      this.paint();
      try {
        await this.saveWithRenewal(() => this.host.save());
      } finally {
        this.busy = false;
      }
      if (!this.current()) return;
      if (this.host.phase() !== "saved" || hasUnsavedSubscription(this.host)) {
        this.message("订阅尚未确认保存，请先处理保存结果或冲突。");
        this.paint();
        return;
      }
    }
    await this.prepare();
  }
  private async prepare(restarted = false): Promise<void> {
    this.clearPreview();
    this.busy = true;
    this.paint();
    this.el("cancel").hidden = false;
    const controller = new AbortController();
    this.previewAbort = controller;
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
          ? "请核对完整服务端预览并重新明确确认后启用。"
          : "预览受阻，不能启用；请缩小已保存范围或稍后重试。",
      );
    } catch (error) {
      if (!this.current() || serial !== this.previewSerial) return;
      outdated = errorDetail(error).reason === "preview_outdated";
      this.clearPreview();
      if (outdated)
        this.message(
          restarted
            ? "预览反复过期，已停止自动重取。极大受阻集合可能无法在有效期内取全，请缩小已保存范围后再试。"
            : "预览已变化，丢弃整轮重新读取；需要重新确认。",
        );
      else this.failed(error);
    } finally {
      if (this.current() && (serial === this.previewSerial || !this.previewAbort)) {
        this.busy = false;
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
          ? "停用将永久撤销当前地址，不能擦除已下载副本。再次启用需替换客户端地址。确认停用？"
          : "重置将使旧地址失效，所有客户端都需要替换地址。确认重置？",
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
        this.message(
          "本次管理操作已完成；当前详细状态读取失败，请重新读取日历状态。没有再次发起操作。",
        );
        return;
      }
      this.message(
        operation.action === "disable"
          ? "日历地址已停用，已有下载副本不会被擦除。"
          : "日历订阅地址已创建。请复制地址并在外部客户端订阅；尚不能确认客户端已添加。",
      );
    } catch (error) {
      if (!this.current()) return;
      outdated = errorDetail(error).reason === "preview_outdated";
      if (
        error instanceof CalendarRequestError &&
        (error.status < 500 || isApiErrorBody(error.body))
      )
        this.operation = null;
      this.failed(error);
      if (this.operation)
        this.message(
          "操作结果未知。请先重新读取日历状态，再用同一操作核对结果；不会生成新的重置请求。",
        );
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
  private async copy(): Promise<void> {
    if (!this.current() || this.button("copy").disabled) return;
    this.busy = true;
    this.paint();
    try {
      const view = await readCalendar(this.abort.signal);
      if (!this.current()) return;
      if (
        view.address_state !== "enabled" ||
        !view.url ||
        view.token_generation !== this.state?.token_generation
      ) {
        this.message("地址状态已变化，请重新读取后再复制。");
        return;
      }
      await navigator.clipboard.writeText(view.url);
      this.message("地址已复制；这不等于外部客户端已添加。请勿公开分享。");
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy = false;
      this.paint();
    }
  }
  // F2-03 owns the save; renew only an observed completed revision, including later draft edits.
  private async saveWithRenewal(save: () => Promise<void>): Promise<void> {
    const before = this.host.machine().getSnapshot()?.revision ?? 0;
    await save();
    const after = this.host.machine().getSnapshot()?.revision ?? 0;
    if (
      this.current() &&
      after > before &&
      ["saved", "dirty"].includes(this.host.phase()) &&
      document.visibilityState === "visible"
    )
      void request("auth/renew", this.abort.signal, {}).catch(() => {});
  }
  private async disableAlarms(): Promise<void> {
    if (!this.current() || this.button("alarms").disabled) return;
    if (
      !window.confirm(
        "关闭日历提醒并保存当前订阅草稿？基础节点、地址、邮件和 Push 保留；其他未保存改动也将一起保存。",
      )
    )
      return;
    this.busy = true;
    this.clearPreview();
    this.paint();
    try {
      await this.saveWithRenewal(() => this.host.disableAlarms());
      await this.load();
      this.message(
        this.host.phase() === "saved"
          ? "日历提醒配置已保存，地址保持不变；外部日历更新时间由客户端决定。"
          : "尚未确认保存，请处理订阅保存状态。",
      );
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy = false;
      this.paint();
    }
  }
}
