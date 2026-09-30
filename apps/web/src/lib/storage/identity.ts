import type { DraftIdentity } from "./drafts";

/**
 * F3 接线点：认证模块在服务端确认 user_id 后发布 confirmed；退出/切换开始先发布 unknown。
 * 此事件不认证用户，不授予 API 权限；不得从 Cookie、邮箱或本机缓存推导 user_id。
 * 订阅页以只读 /me 的成功响应确认身份；F3 负责退出/切换开始的 unknown。
 */
export const DRAFT_IDENTITY_EVENT = "hoyo:draft-identity";
export function publishDraftIdentity(identity: DraftIdentity): void {
  document.dispatchEvent(new CustomEvent(DRAFT_IDENTITY_EVENT, { detail: identity }));
}

export function readDraftIdentityEvent(event: Event): DraftIdentity | null {
  if (!(event instanceof CustomEvent) || !event.detail) return null;
  const value = event.detail;
  if (value.status === "unknown" || value.status === "guest") return { status: value.status };
  if (value.status === "confirmed" && typeof value.userId === "string" && value.userId.trim()) {
    return { status: "confirmed", userId: value.userId };
  }
  return null;
}

/** 只提取分键身份，不留存账号摘要、脱敏邮箱或通道状态；失败不退化为游客。 */
export async function readConfirmedDraftIdentity(): Promise<DraftIdentity> {
  try {
    const response = await fetch("/api/v2/me", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) return { status: "guest" };
    if (response.status !== 200) return { status: "unknown" };
    const summary: unknown = await response.json();
    if (typeof summary !== "object" || summary === null) return { status: "unknown" };
    const userId = (summary as { user_id?: unknown }).user_id;
    return typeof userId === "string" && userId.trim()
      ? { status: "confirmed", userId }
      : { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}
