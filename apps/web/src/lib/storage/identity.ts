import type { DraftIdentity } from "./drafts";

/**
 * F3 接线点：认证模块在服务端确认 user_id 后发布 confirmed；退出/切换开始先发布 unknown。
 * 此事件不认证用户，不授予 API 权限；不得从 Cookie、邮箱或本机缓存推导 user_id。
 * 当前 /me 不返回 user_id，故当前已登录页面不会自行发布 confirmed。
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
