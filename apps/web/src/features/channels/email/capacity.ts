import type { EmailChannelActionAvailability } from "@hoyo/contracts";
import { el, icon } from "../../../lib/dom";
import type { EmailView } from "./api";

/** 只呈现 contracts 已有的判定；不另设名额或授权规则。 */
export function paintCapacityNotice(
  root: HTMLElement,
  state: EmailView | null,
  seat: EmailChannelActionAvailability | null,
  routine: EmailChannelActionAvailability | null,
): void {
  const seatFull = seat && !seat.allowed && seat.reason === "capacity_full";
  const routineFull = routine && !routine.allowed && routine.reason === "capacity_full";
  root.replaceChildren();
  root.hidden = !state || (!seatFull && !routineFull);
  if (root.hidden || !state) return;

  root.className = "email-capacity callout callout--warning";
  root.append(
    icon("alert-triangle"),
    el(
      "div",
      { class: "callout-body" },
      el("h4", { class: "callout-title" }, seatFull ? "邮件提醒席位已满" : "常规提醒子名额已满"),
      el("p", {}, "这是内测期的预算限制，不是账号有问题。"),
      el(
        "div",
        { class: "capacity-alt" },
        el("strong", {}, "个人日历 + 日历提醒：不占邮件名额"),
        el(
          "p",
          {},
          "这是默认的提醒方案，大多数提醒需求它都能满足。需要你在下方确认启用，并在日历应用里订阅；不会因为邮件名额不足而自动开启。",
        ),
        el("a", { href: "#calendar-channel", class: "button button--sm" }, "去启用日历提醒"),
      ),
      el(
        "p",
        {},
        seatFull
          ? "没有邮件席位时，你将无法收到取消/改期的主动邮件通知，也缺少晚收录的补充邮件。日历内容更新不能完全替代这些主动通知。"
          : state.enabled
            ? "已开启的邮件席位保留：取消、重要更正和晚收录的邮件资格不受影响；只是常规提前提醒和新活动邮件暂时无法开启。"
            : "席位尚未开启，仍需你单独同意；常规子名额满不妨碍申请席位。",
      ),
      el(
        "p",
        { class: "text-aux" },
        "暂不提供候补，也不会自动登记或通知。名额可能随释放和预算安排变化，不承诺具体开放时间；可以稍后刷新邮件状态。",
      ),
    ),
  );
}
