import {
  type EmailChannelBlockReason,
  SUBSCRIPTION_CHANGE_COPY,
  SUBSCRIPTION_EVENT_TYPE_LABELS,
  SUBSCRIPTION_GAME_LABELS,
  SUBSCRIPTION_RULE_COPY,
  type SubscriptionConfig,
} from "@hoyo/contracts";

export const BLOCK_COPY: Record<EmailChannelBlockReason, string> = {
  pending_activation: "请先完成当前浏览器的登录激活。",
  recovery_code_unconfirmed: "请先保存并确认恢复登录后生成的新恢复码。",
  recovery_code_not_saved: "请先保存并确认当前恢复码，再开启邮件提醒。",
  subscription_uninitialized: "先保存一次订阅内容。",
  address_suppressed:
    "当前邮箱已被抑制，不能通过重新勾选解除。请到账号页进行受控处理或验证新邮箱。",
  deliverability_unknown: "当前邮箱可投递性未知，请重新读取状态。",
  seat_required: "请先开启邮件提醒席位，再单独同意常规提醒邮件。",
  capacity_full: "当前名额已满，暂不能开启这一层。",
  capacity_unknown: "当前名额余量未知，请重新读取状态。",
};
export function blockedCopy(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(BLOCK_COPY, value)
    ? BLOCK_COPY[value as EmailChannelBlockReason]
    : null;
}
export function savedSummary(config: SubscriptionConfig | null): string {
  if (!config) return "尚无已保存订阅。";
  return [
    `游戏：${config.scope.games.map((game) => SUBSCRIPTION_GAME_LABELS[game]).join("、")}（${config.scope.regions.join("、")}）`,
    `显示事件：${config.calendar.event_types.map((type) => SUBSCRIPTION_EVENT_TYPE_LABELS[type]).join("、")}`,
    `提前提醒：${config.notifications.rule_ids.map((id) => SUBSCRIPTION_RULE_COPY.find((rule) => rule.rule_id === id)?.label ?? id).join("、") || "未选择"}`,
    `变更消息：${
      SUBSCRIPTION_CHANGE_COPY.filter((item) => config.notifications[item.key])
        .map((item) => item.label)
        .join("、") || "全部关闭"
    }`,
    "变更范围使用共同规则：日历里看得见的、或设了提醒的事件。",
  ].join("；");
}
export function dateText(value: number | null): string {
  return value === null
    ? "未知 / 暂无记录"
    : `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(value)}（北京时间 UTC+8）`;
}
