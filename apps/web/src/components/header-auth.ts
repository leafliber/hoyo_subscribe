/**
 * 页头账号入口：有 CSRF Cookie 线索时用一次只读 GET /api/v2/me 核对，再显示「账号」。
 * 被动 GET 不续期会话；没有线索的游客不发请求。核对失败保持「登录」。
 * 之后只跟随页面发布的身份事件，不再额外读取（紧急停用等流程要求不读私人摘要）。
 *
 * ADR-0032：服务端确认过之后，本标签页记一个"刚确认过"的时间（sessionStorage，不含账号标识或任何凭证），
 * 站内切换页面时先照这个提示显示「账号」，不再先闪一下「登录」；提示在 CLIENT_RECHECK_INTERVAL 内不重复读 /me，
 * 过了（或用户按了刷新）再在后台核对。Cookie 线索不在、核对得到非 200、或页面发布了非 confirmed 的身份事件时立即清掉提示。
 * 提示只决定页头文字，不授予任何权限；账号页、订阅页照旧自己向服务端确认身份。
 */
import { loginReturnPath } from "../features/auth/return-path";
import { pageReloaded } from "../lib/public-api/store";
import { DRAFT_IDENTITY_EVENT, readDraftIdentityEvent } from "../lib/storage/identity";

const HINT_KEY = "hoyo:account-hint:v1";

/**
 * CLIENT_RECHECK_INTERVAL（秒）：由 `_Layout.astro` 在构建时从 contracts 写进页头属性。
 * 页头脚本在每一页都运行，不为一个常量把整个 contracts 打进每一页；读不到时按 0（每页都核对）。
 */
function recheckSeconds(): number {
  const value = Number(entry?.dataset.recheckSeconds);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function readHint(): number | null {
  try {
    const value = Number(sessionStorage.getItem(HINT_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeHint(confirmed: boolean): void {
  try {
    if (confirmed) sessionStorage.setItem(HINT_KEY, String(Date.now()));
    else sessionStorage.removeItem(HINT_KEY);
  } catch {
    // 存储不可用时每页照旧核对。
  }
}

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
    writeHint(false);
    showGuest();
    return;
  }
  const confirmedAt = readHint();
  if (confirmedAt !== null) {
    showAccount();
    // 用户按了刷新时照旧核对（与公开数据一致：刷新是主动要求的那一种按需刷新）。
    if (!pageReloaded && Date.now() - confirmedAt < recheckSeconds() * 1000) return;
  } else showGuest();
  try {
    const response = await fetch("/api/v2/me", { credentials: "same-origin", cache: "no-store" });
    if (started !== generation) return;
    writeHint(response.ok);
    if (response.ok) showAccount();
    else showGuest();
  } catch {
    // 网络失败：没有提示时保持「登录」；有提示时先照提示显示，下一页再核对。
    if (started === generation && confirmedAt === null) showGuest();
  }
}

if (entry && label) {
  void verify();
  // 退出、换账号或会话失效时页面会发布身份事件：只有服务端确认过的身份才显示「账号」。
  document.addEventListener(DRAFT_IDENTITY_EVENT, (event) => {
    generation += 1;
    const confirmed = readDraftIdentityEvent(event)?.status === "confirmed";
    writeHint(confirmed);
    if (confirmed) showAccount();
    else showGuest();
  });
}
