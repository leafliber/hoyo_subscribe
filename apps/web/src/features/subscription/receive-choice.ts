// ADR-0029：登录后的第 2 步「选择接收方式」——浏览器通知、日历订阅、邮件通知任选一种，前两项标推荐。
// 这里只呈现入口与公开能力：点击只跳到「接收方式」里对应的卡片，不开启任何通道、不申请浏览器权限
// （前端 §7.1"邮件与 Push 不附带开启"、§9.3"用户主动点击前不申请系统权限"）。
import { iosNeedsHomeScreen, pushSupported } from "../channels/push/browser";

export type ReceiveChannel = "push" | "calendar" | "mail";
type Capability = "open" | "closed" | "unknown";
export type ReceiveCapabilities = Record<ReceiveChannel, Capability>;

const UNKNOWN: ReceiveCapabilities = { push: "unknown", calendar: "unknown", mail: "unknown" };

/** 公开能力（`/api/v2/status`）；读取失败一律 unknown，不据此说"不可用"。 */
export async function readReceiveCapabilities(): Promise<ReceiveCapabilities> {
  try {
    const response = await fetch("/api/v2/status", { credentials: "omit" });
    if (!response.ok) return UNKNOWN;
    const body = (await response.json()) as { capabilities?: Record<string, unknown> };
    const read = (value: unknown): Capability =>
      value === "open" || value === "closed" ? value : "unknown";
    return {
      push: read(body.capabilities?.push),
      calendar: read(body.capabilities?.calendar),
      // 新开邮件通知看"邮件新席位"；已开启的人不会走到这一步。
      mail: read(body.capabilities?.email_seats),
    };
  } catch {
    return UNKNOWN;
  }
}

interface OptionState {
  /** Push 未开放不占主流程（前端 §9 开头、§9.3 第一段）；其余两项总是列出。 */
  shown: boolean;
  available: boolean;
  note: string;
}

export function receiveOptionStates(
  capabilities: ReceiveCapabilities | null,
): Record<ReceiveChannel, OptionState> {
  const caps = capabilities ?? UNKNOWN;
  const push: OptionState = !pushSupported()
    ? { shown: caps.push === "open", available: false, note: "当前浏览器不支持通知。" }
    : {
        shown: caps.push === "open",
        available: true,
        note: iosNeedsHomeScreen() ? "iPhone、iPad 需先把本站添加到主屏幕，再从主屏幕打开。" : "",
      };
  return {
    push,
    calendar:
      caps.calendar === "closed"
        ? { shown: true, available: false, note: "暂未开放。" }
        : { shown: true, available: true, note: "" },
    mail:
      caps.mail === "closed"
        ? { shown: true, available: false, note: "暂未开放新的邮件名额。" }
        : { shown: true, available: true, note: "" },
  };
}

/** 按能力更新静态入口（页面 `#receive-choice`）：不可用的入口去掉链接并写明原因。 */
export function paintReceiveChoice(root: HTMLElement, capabilities: ReceiveCapabilities | null) {
  const states = receiveOptionStates(capabilities);
  for (const [channel, state] of Object.entries(states) as [ReceiveChannel, OptionState][]) {
    const item = root.querySelector<HTMLElement>(`[data-receive-item="${channel}"]`);
    const link = item?.querySelector<HTMLAnchorElement>("[data-receive]");
    const note = item?.querySelector<HTMLElement>("[data-receive-note]");
    if (!item || !link || !note) continue;
    item.hidden = !state.shown;
    if (state.available) {
      link.href = link.dataset.href ?? "";
      link.removeAttribute("role");
      link.removeAttribute("aria-disabled");
    } else {
      link.removeAttribute("href");
      link.setAttribute("role", "link");
      link.setAttribute("aria-disabled", "true");
    }
    note.textContent = state.note;
    note.hidden = state.note === "";
  }
}
