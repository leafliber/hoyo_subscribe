// F5-01 · 账号页「浏览器通知」分区与「退出并暂停本浏览器通知」（前端 §10.1、§10.2；D3 §2.8、§2.9）。
//
// - 登录会话与 Push 绑定分组展示，不把"设备"当万能对象；撤销会话不会顺带撤销 Push。
// - 本浏览器按本机保存的绑定 ID 认出，不按 endpoint 认领。
// - 组合动作（暂停后退出）逐项请求、逐项报告：暂停必须在退出、失去会话凭证之前完成。
import {
  derivePushActions,
  isApiErrorBody,
  isPushBlockReason,
  type PushBindingView,
  type PushChannelView,
} from "@hoyo/contracts";
import { badge, el, icon } from "../../../lib/dom";
import { feedbackForFailure } from "../../../lib/errors/feedback";
import {
  activatePush,
  deletePush,
  PushRequestError,
  pausePush,
  pushCapability,
  readPush,
  renewPush,
  testPush,
} from "./api";
import {
  browserPermission,
  clearLocalBinding,
  type LocalBinding,
  readLocalBinding,
  unsubscribeBrowser,
} from "./browser";
import {
  OUTCOME_COPY,
  PERMISSION_COPY,
  PUSH_REASON_COPY,
  serviceLabel,
  stateText,
  time,
} from "./copy";

function explain(error: unknown): string {
  const body = error instanceof PushRequestError ? error.body : error;
  if (
    typeof body === "object" &&
    body !== null &&
    "blocked_reason" in body &&
    typeof body.blocked_reason === "string" &&
    isPushBlockReason(body.blocked_reason)
  )
    return PUSH_REASON_COPY[body.blocked_reason];
  const feedback = feedbackForFailure(body);
  return `${feedback.title}。${feedback.nextStep}`;
}
function known(error: unknown): boolean {
  return error instanceof PushRequestError || isApiErrorBody(error);
}

/** 退出前暂停本浏览器的本账号通知；返回一行如实结果（已暂停 / 无需暂停 / 未执行 / 结果未知）。 */
export async function pauseThisBrowserBeforeLogout(): Promise<string> {
  const local = await readLocalBinding();
  if (!local) return "本浏览器没有通知绑定，无需暂停。";
  let view: PushChannelView;
  try {
    view = await readPush();
  } catch (error) {
    return known(error)
      ? `暂停未执行：${explain(error)}`
      : "结果未知：无法读取通知状态，暂停没有执行。";
  }
  const binding = view.bindings.find((item) => item.id === local.binding_id);
  if (!binding) return "本浏览器的通知不属于当前账号，未作改动。";
  if (binding.state !== "pending" && binding.state !== "active")
    return "本浏览器通知已处于暂停或失效状态，无需再暂停。";
  try {
    const result = await pausePush(binding.id, binding.binding_version);
    const fresh = result.state.bindings.find((item) => item.id === binding.id);
    return fresh?.state === "paused" ? "已暂停。" : "已提交暂停，但状态未确认，请登录后核对。";
  } catch (error) {
    if (known(error)) return `暂停未执行：${explain(error)}`;
    try {
      const fresh = (await readPush()).bindings.find((item) => item.id === binding.id);
      return fresh?.state === "paused"
        ? "核对确认已暂停。"
        : "结果未知：暂停可能没有生效，请登录后在账号页核对。";
    } catch {
      return "结果未知：暂停可能没有生效，请登录后在账号页核对。";
    }
  }
}

/** 账号页分区：列出本账号全部浏览器绑定，按 contracts 推导置灰。 */
export class AccountPushSection {
  private view: PushChannelView | null = null;
  private local: LocalBinding | null = null;
  private capability: "open" | "closed" | "unknown" = "unknown";
  private busy = false;
  private clockAnchor = { server: 0, local: 0 };
  /** clear() 推进世代；迟到的读取或操作结果属于旧身份时丢弃，不画回页面。 */
  private generation = 0;

  constructor(
    private readonly elements: {
      section: HTMLElement;
      list: HTMLElement;
      status: HTMLElement;
      permission: HTMLElement;
      enableLink: HTMLAnchorElement;
    },
    private readonly onChange: () => void = () => {},
  ) {
    elements.permission.textContent = PERMISSION_COPY[browserPermission()];
  }

  private now(): number {
    return this.clockAnchor.server + (performance.now() - this.clockAnchor.local);
  }
  /** 只接受仍属于当前世代的视图；clear() 之后迟到的结果丢弃。 */
  private accept(view: PushChannelView, generation: number): void {
    if (generation !== this.generation) return;
    this.view = view;
    this.clockAnchor = { server: view.server_time, local: performance.now() };
  }

  /** 本浏览器是否有本账号的、可以暂停的通知（决定是否显示"退出并暂停本浏览器通知"）。 */
  thisBrowserPausable(): boolean {
    const binding = this.view?.bindings.find((item) => item.id === this.local?.binding_id);
    return binding?.state === "pending" || binding?.state === "active";
  }

  clear(): void {
    this.generation += 1;
    this.busy = false;
    this.view = null;
    this.local = null;
    this.elements.list.replaceChildren();
    this.elements.status.textContent = "浏览器通知状态未知，请刷新。";
    this.elements.section.hidden = false;
  }

  async refresh(): Promise<void> {
    const generation = this.generation;
    this.elements.status.textContent = "正在读取浏览器通知…";
    try {
      const [view, local, capability] = await Promise.all([
        readPush(),
        readLocalBinding(),
        pushCapability(),
      ]);
      if (generation !== this.generation) return;
      this.accept(view, generation);
      this.local = local;
      this.capability = capability;
      this.elements.status.textContent = "";
    } catch (error) {
      if (generation !== this.generation) return;
      this.view = null;
      this.elements.status.textContent = `无法读取浏览器通知。${explain(error)}`;
    }
    this.paint();
  }

  private async run(work: () => Promise<string>): Promise<void> {
    if (this.busy) return;
    const generation = this.generation;
    this.busy = true;
    this.paint();
    try {
      const result = await work();
      if (generation === this.generation) this.elements.status.textContent = result;
    } catch (error) {
      if (generation !== this.generation) return;
      if (known(error)) this.elements.status.textContent = `未执行：${explain(error)}`;
      else {
        this.elements.status.textContent = "结果未知，正在重新读取核对…";
        this.busy = false;
        await this.refresh();
        return;
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.paint();
      }
    }
  }

  private item(binding: PushBindingView): HTMLElement {
    const view = this.view as PushChannelView;
    const generation = this.generation;
    const now = this.now();
    const actions = derivePushActions(view, binding, now);
    const mine = binding.id === this.local?.binding_id;
    const facts = [
      `登记于 ${time(binding.created_at)}`,
      binding.activated_at !== null ? `验证通过于 ${time(binding.activated_at)}` : null,
      binding.state === "active" ? `服务租期到 ${time(binding.lease_expires_at)}` : null,
      binding.last_test
        ? `最近测试 ${time(binding.last_test.sent_at)}：${binding.last_test.outcome ? OUTCOME_COPY[binding.last_test.outcome] : "结果未知"}${binding.last_test.received_at ? "，该浏览器已收到" : ""}`
        : null,
    ].filter((line): line is string => line !== null);
    const buttons: HTMLButtonElement[] = [];
    const reasons: string[] = [];
    const add = (
      label: string,
      availability: (typeof actions)[keyof typeof actions],
      work: () => Promise<string>,
    ) => {
      const button = el(
        "button",
        { type: "button", class: "button button--secondary button--sm" },
        label,
      );
      button.disabled = this.busy || !availability.allowed;
      if (!availability.allowed && availability.reason !== "state_mismatch")
        reasons.push(`${label}：${PUSH_REASON_COPY[availability.reason]}`);
      button.addEventListener("click", () => void this.run(work));
      buttons.push(button);
    };
    if (binding.state === "active") {
      add("发送测试通知", actions.test, async () => {
        const result = await testPush(binding.id, binding.binding_version);
        this.accept(result.state, generation);
        return `测试通知：${result.outcome ? OUTCOME_COPY[result.outcome] : "结果未知"}。`;
      });
      add("续期", actions.renew, async () => {
        this.accept((await renewPush(binding.id, binding.binding_version)).state, generation);
        return "已续期。";
      });
    }
    if (binding.state === "paused" || binding.state === "pending")
      add(
        binding.state === "paused" ? "恢复（需要重新验证）" : "重新发送验证通知",
        actions.activate,
        async () => {
          const result = await activatePush(binding.id, binding.binding_version);
          this.accept(result.state, generation);
          return `已发出验证通知：${result.outcome ? OUTCOME_COPY[result.outcome] : "结果未知"}。`;
        },
      );
    if (binding.state === "pending" || binding.state === "active")
      add("暂停", actions.pause, async () => {
        this.accept((await pausePush(binding.id, binding.binding_version)).state, generation);
        return "已暂停。恢复时需要重新验证接收。";
      });
    add("删除", actions.delete, async () => {
      this.accept((await deletePush(binding.id)).state, generation);
      if (mine) {
        // 绑定已在服务器删除：本机凭证与浏览器订阅随之清理，不论页面身份是否已变化。
        await clearLocalBinding();
        await unsubscribeBrowser();
        if (generation === this.generation) this.local = null;
      }
      return "已删除。";
    });
    // 与"登录设备"同一列表样式；本浏览器高亮。绑定 ID 只留在闭包里，不进 URL 或存储。
    return el(
      "li",
      { class: mine ? "is-current" : "", "data-push-binding": "" },
      el("span", { class: "session-icon", "aria-hidden": "true" }, icon("bell")),
      el(
        "div",
        { class: "session-body" },
        el(
          "h3",
          {},
          serviceLabel(binding),
          mine ? " " : null,
          mine ? badge("本浏览器", "accent") : null,
        ),
        el("p", {}, stateText(binding, now)),
        ...facts.map((line) => el("p", { class: "field-hint" }, line)),
        ...reasons.map((line) => el("p", { class: "field-hint" }, line)),
      ),
      el("div", { class: "push-binding-actions" }, ...buttons),
    );
  }

  private paint(): void {
    const { list, section, enableLink, permission } = this.elements;
    permission.textContent = PERMISSION_COPY[browserPermission()];
    list.replaceChildren();
    const view = this.view;
    // 能力未开放且没有任何绑定时不占版面；已有绑定时保留状态与暂停/删除入口。
    section.hidden = view !== null && this.capability !== "open" && view.bindings.length === 0;
    enableLink.hidden =
      this.capability !== "open" ||
      (view?.bindings.some((item) => item.id === this.local?.binding_id) ?? false);
    if (!view) return;
    if (view.bindings.length === 0) {
      list.append(el("li", { class: "field-hint" }, "还没有在任何浏览器开启通知。"));
    } else for (const binding of view.bindings) list.append(this.item(binding));
    this.onChange();
  }
}
