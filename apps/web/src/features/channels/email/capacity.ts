import type { EmailChannelActionAvailability } from "@hoyo/contracts";
import type { EmailView } from "./api";

/** Present the existing contracts decision; no separate capacity or authorization rules. */
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

  const heading = document.createElement("h4");
  heading.textContent = seatFull ? "邮件提醒席位已满" : "常规提醒子名额已满";
  root.append(heading);
  const paragraph = (text: string) => {
    const p = document.createElement("p");
    p.textContent = text;
    root.append(p);
  };
  paragraph("这是内测期的预算限制，不是账号有问题。");

  const alternative = document.createElement("strong");
  alternative.textContent = "个人日历 + 日历提醒：不占邮件名额";
  root.append(alternative);
  paragraph(
    "这是默认的提醒方案，可满足大多数提醒需求。需要你确认启用，并在外部日历客户端订阅；不会因邮件名额不足而自动开启。",
  );
  const link = document.createElement("a");
  link.href = "#calendar-channel";
  link.textContent = "去启用日历提醒";
  root.append(link);
  paragraph(
    "请在日历区域核对已保存设置的服务端预览并明确确认；不会自动开通。已有订阅不占邮件名额，客户端支持以实测说明为准。",
  );

  paragraph(
    seatFull
      ? "没有邮件席位，你将无法收到取消/改期的主动邮件通知，也缺少晚收录的补充邮件。日历内容更新不能替代这些主动通知。"
      : state.enabled
        ? "已开启的邮件席位保留：取消、重要更正和晚收录的邮件资格不因常规子名额满而丢失；仅常规提前提醒和新活动邮件未开启。实际发送仍受预算与可投递性限制。"
        : "席位尚未开启，仍需你单独同意；常规子名额满不妨碍申请席位。取得席位后可接收取消、重要更正和晚收录的补充邮件，实际发送仍受预算与可投递性限制。",
  );
  paragraph(
    "暂不提供候补，也不会自动登记或通知。名额可能随释放和预算安排变化，不承诺具体开放时间；你可以稍后重新读取邮件状态。",
  );
}
