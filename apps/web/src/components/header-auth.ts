/**
 * 页头账号入口：有 CSRF Cookie 线索时用一次只读 GET /api/v2/me 核对，再显示「账号」。
 * 被动 GET 不续期会话；没有线索的游客不发请求。核对失败保持「登录」。
 * 之后只跟随页面发布的身份事件，不再额外读取（紧急停用等流程要求不读私人摘要）。
 */
import { loginReturnPath } from "../features/auth/return-path";
import { DRAFT_IDENTITY_EVENT, readDraftIdentityEvent } from "../lib/storage/identity";

const entry = document.querySelector<HTMLAnchorElement>("[data-account-entry]");
const label = entry?.querySelector<HTMLElement>("[data-account-label]");

function loginHref(): string {
  const here = `${location.pathname.replace(/\/$/, "") || "/"}${location.hash === "#save" ? "#save" : ""}`;
  const target = loginReturnPath(here);
  return target === here && here !== "/subscription"
    ? `/login?returnTo=${encodeURIComponent(target)}`
    : "/login";
}

function showGuest(): void {
  if (!entry || !label) return;
  label.textContent = "登录";
  entry.href = loginHref();
  entry.removeAttribute("aria-current");
}

function showAccount(): void {
  if (!entry || !label) return;
  label.textContent = "账号";
  entry.href = "/account";
  if (location.pathname.startsWith("/account")) entry.setAttribute("aria-current", "page");
}

// 身份事件比首次核对更新：核对返回前若已有事件，丢弃这次结果。
let generation = 0;

async function verify(): Promise<void> {
  const started = generation;
  const hinted = document.cookie
    .split(";")
    .some((part) => part.trim().startsWith("__Host-hoyo_csrf="));
  if (!hinted || location.pathname.startsWith("/login")) {
    showGuest();
    return;
  }
  try {
    const response = await fetch("/api/v2/me", { credentials: "same-origin", cache: "no-store" });
    if (started !== generation) return;
    if (response.ok) showAccount();
    else showGuest();
  } catch {
    if (started === generation) showGuest();
  }
}

if (entry && label) {
  showGuest();
  void verify();
  // 退出、换账号或会话失效时页面会发布身份事件：只有服务端确认过的身份才显示「账号」。
  document.addEventListener(DRAFT_IDENTITY_EVENT, (event) => {
    generation += 1;
    if (readDraftIdentityEvent(event)?.status === "confirmed") showAccount();
    else showGuest();
  });
}
