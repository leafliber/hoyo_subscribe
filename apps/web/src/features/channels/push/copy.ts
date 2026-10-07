// F5-01 · 浏览器通知的界面文案（前端 §9.3、§9.4、§11.3）。数值只取 contracts 的注册表。
import {
  PUSH_DISCLOSURE,
  PUSH_SERVICE_LABELS,
  type PushBindingView,
  type PushBlockReason,
  type PushSendOutcome,
} from "@hoyo/contracts";
import type { BrowserPermission } from "./browser";

export const ENABLE_LABEL = "在当前浏览器开启通知";

/** 受阻原因的说明（与写接口返回的 blocked_reason 同一闭合枚举）。 */
export const PUSH_REASON_COPY: Readonly<Record<PushBlockReason, string>> = {
  pending_activation: "请先在登录页完成本设备的登录确认。",
  recovery_code_unconfirmed: "请先保存并确认恢复登录后的新恢复码。",
  subscription_uninitialized: "先保存一次订阅内容，再开启浏览器通知。",
  recent_auth_required: "需要重新验证身份。",
  capacity_full: "浏览器通知名额已满（内测预算限制，不是账号问题）。日历订阅和邮件不受影响。",
  quota_paused: "今天的浏览器通知额度已用完，明天再试；日历订阅和邮件不受影响。",
  feature_closed: "浏览器通知暂未开放或暂停中。",
  state_mismatch: "状态已变化，请刷新后再操作。",
  activation_expired: "验证已超过有效期，请重新开启。",
  attempts_exhausted: `本轮验证通知已发满 ${PUSH_DISCLOSURE.activation_attempts} 次，请稍后重新开启。`,
  cooldown: "刚刚发过通知，请稍后再试。",
};

export const PERMISSION_COPY: Readonly<Record<BrowserPermission, string>> = {
  unsupported: "此浏览器不支持网页通知",
  default: "尚未授权",
  denied: "已拒绝",
  granted: "已允许",
};

export const PAUSE_COPY: Readonly<Record<NonNullable<PushBindingView["paused_reason"]>, string>> = {
  user: "你已暂停",
  safety: "紧急停用、恢复登录或删除账号时自动暂停",
  lease_expired: `超过 ${PUSH_DISCLOSURE.lease_days} 天没有确认接收，已自动暂停`,
  restore: "服务恢复后默认暂停",
};

export const OUTCOME_COPY: Readonly<Record<PushSendOutcome, string>> = {
  accepted: "推送服务已接受（不代表已经显示）",
  gone: "推送服务表示这个浏览器订阅已失效",
  auth_rejected: "推送服务拒绝了本站的发送身份，浏览器通知已暂停等待维护者核对",
  retry_later: "推送服务暂时繁忙",
  rejected: "推送服务拒绝了这条通知",
  unknown: "结果未知（可能已送达，也可能没有）",
};

export function serviceLabel(binding: PushBindingView): string {
  return PUSH_SERVICE_LABELS[binding.service];
}

export const time = (value: number | null) =>
  value === null
    ? "无记录"
    : `${new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）`;

export function stateText(binding: PushBindingView, now: number): string {
  switch (binding.state) {
    case "pending":
      return binding.activation === null || binding.activation.deadline <= now
        ? "验证未完成（已超过有效期）"
        : "正在验证本浏览器接收能力";
    case "active":
      return "本浏览器接收验证通过";
    case "paused":
      return `已暂停：${binding.paused_reason ? PAUSE_COPY[binding.paused_reason] : "原因未知"}`;
    case "gone":
      return "已失效：推送服务注销了这个浏览器订阅";
  }
}

export const CROSS_CHANNEL_NOTE =
  "日历、邮件和浏览器通知相互独立，同一件事可能各提醒一次；没有自动故障转移，本站也无法控制日历应用的去重。关闭其中一个，其他照常。";
export const NO_GUARANTEE_NOTE =
  "验证通过只说明本浏览器此刻能收到通知，不承诺以后每条都送达：浏览器关闭、系统省电或网络限制都可能让通知延迟或丢失。";
