import {
  AUTH_COMPLETION_TTL,
  AUTH_INTENT_PUBLIC_BODY,
  AUTH_INTENT_PUBLIC_STATUS,
  canonicalizeEmail,
  isApiErrorBody,
  LOGIN_TURNSTILE_ACTION,
  OTP_COOLDOWN,
  OTP_DIGITS,
  OTP_TTL,
  SESSION_PENDING_TTL,
} from "@hoyo/contracts";
import { announce } from "../../components/status";
import { feedbackForApiError } from "../../lib/errors/feedback";
import { publishDraftIdentity } from "../../lib/storage/identity";
import { type Json, request, sessions } from "./api";
import { loginReturnPath } from "./return-path";
import { Turnstile } from "./turnstile";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const email = el<HTMLInputElement>("login-email");
const code = el<HTMLInputElement>("login-code");
const root = el("login");
const requestedReturn = new URLSearchParams(window.location.search).get("returnTo");
const returnPath = loginReturnPath(requestedReturn);
el<HTMLAnchorElement>("continue-login").href = returnPath;
if (requestedReturn !== null) {
  el("login-return-notice").hidden = false;
  el("login-return-notice").textContent =
    "登录完成后会回到刚才的页面，未保存的设置仍需你手动保存。";
}
// F3-01 permits a modest presentation limit for the optional device label.
el<HTMLInputElement>("device-label").maxLength = 80;
const captcha = new Turnstile(el("turnstile-status"));
let phase: "email" | "code" | "pending" | "done" = "email";
let busy = false;
let needsRestart = false;
let focusAfter: HTMLElement | null = null;
let abort: AbortController | undefined;
let retry: (() => Promise<void>) | null = null;
let challengeStart: number | null = null;
let cooldownUntil = 0;
let completionStart: number | null = null;
let operationKey = "";
let selectionRequired = false;
let mailAvailable: boolean | null = null;
const stamp = (time: number) =>
  new Date(time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
function invalidateIdentity(): void {
  publishDraftIdentity({ status: "unknown" });
  // The subscription controller is not mounted on /login; send its existing invalidation protocol too.
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("hoyo-draft-identity");
    channel.postMessage("invalidate");
    channel.close();
  }
}
type Tone = "info" | "success" | "warning" | "danger";
function message(text: string, tone: Tone = "info"): void {
  el("auth-result").textContent = text;
  el("auth-result").className = `callout callout--${tone} result-message`;
  announce(text, tone === "danger" ? "error" : tone === "warning" ? "warning" : "info");
}
function renderProgress(): void {
  const order = ["email", "code", "pending"];
  const index = phase === "done" ? order.length : order.indexOf(phase);
  for (const item of document.querySelectorAll<HTMLElement>("[data-auth-step]")) {
    const position = order.indexOf(item.dataset.authStep ?? "");
    item.dataset.state = position < index ? "done" : position === index ? "current" : "todo";
    if (position === index) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
}
function render(): void {
  renderProgress();
  el("email-form").hidden = phase !== "email";
  el("code-section").hidden = phase !== "code";
  el("pending-section").hidden = phase !== "pending";
  el("login-done").hidden = phase !== "done";
  el("restart-auth").hidden =
    phase === "done" || (phase === "email" && !el("auth-result").textContent);
  el("auth-help").hidden = phase === "email" && !el("auth-result").textContent;
  el("retry-auth").hidden = !retry || busy;
  el("cancel-wait").hidden = !busy;
  root.setAttribute("aria-busy", String(busy));
  el<HTMLInputElement>("device-label").disabled = busy;
  for (const input of root.querySelectorAll<HTMLInputElement>("input[name=revoke]"))
    input.disabled = busy;
  for (const button of root.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
  el<HTMLButtonElement>("cancel-wait").disabled = false;
  email.disabled = busy || !!retry;
  el<HTMLButtonElement>("login-request-otp").disabled = busy || !!retry;
  code.disabled = busy || !!retry;
  el<HTMLButtonElement>("verify").disabled = busy || !!retry || needsRestart;
  const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  el<HTMLButtonElement>("resend").disabled =
    busy || !!retry || needsRestart || left > 0 || mailAvailable === false;
  el("resend").textContent = left > 0 ? `重新发送验证码（${left} 秒后可用）` : "重新发送验证码";
  el<HTMLButtonElement>("activate").disabled =
    busy ||
    !!retry ||
    needsRestart ||
    (selectionRequired && !root.querySelector("input[name=revoke]:checked"));
  if (challengeStart !== null)
    el("challenge-time").textContent =
      `验证码约在 ${stamp(challengeStart + OTP_TTL * 1000)}（北京时间）前有效。`;
}
async function run(work: () => Promise<void>, waiting: string): Promise<void> {
  if (busy) return;
  busy = true;
  abort = new AbortController();
  message(waiting);
  render();
  try {
    await work();
  } catch (error) {
    failure(error);
  } finally {
    busy = false;
    abort = undefined;
    render();
    focusAfter?.focus();
    focusAfter = null;
  }
}
function setRetry(work: () => Promise<void>, label: string): void {
  retry = work;
  el("retry-auth").textContent = label;
}
function failure(error: unknown): void {
  if (!isApiErrorBody(error)) {
    message(
      "暂时无法确认结果，请求可能已经完成。请点「核对结果」，不要重复发起新的操作。",
      "warning",
    );
    return;
  }
  const detail = error.error.details;
  if (detail?.code === "unauthorized") {
    if (detail.reason === "pending_activation") {
      phase = "pending";
      setRetry(loadSessions, "读取待确认的登录");
      message("还差最后一步：确认在这台设备登录。");
      return;
    }
    retry = null;
    needsRestart = true;
    message(
      detail.reason === "session_expired"
        ? "登录已过期，请点「重新开始」再登录一次。"
        : "登录流程已过期，请点「重新开始」。这不是验证码错误。",
      "warning",
    );
    return;
  }
  if (detail?.code === "validation") {
    const field = detail.fields?.[0];
    const reasons: Record<string, string> = {
      mismatch: "验证码不正确，请核对后重试。输错次数会累计，重新发送不会清零。",
      malformed_code: `请输入完整的 ${OTP_DIGITS} 位数字验证码。`,
      no_open_challenge: "没有可用的验证码，可能已经过期，请点「重新开始」。",
      attempts_exhausted: "这个验证码输错次数太多，已失效。请点「重新开始」获取新验证码。",
      login_required: "登录状态有变化，请重新开始获取验证码。这不是验证码错误。",
      verification_failed: "人机验证失败或已过期，请重新完成验证后再试。",
      canonicalization_failed: "请检查邮箱格式，首版支持 ASCII 邮箱。",
    };
    message(reasons[field?.reason ?? ""] ?? "请检查填写内容，输入已保留。", "danger");
    if (
      ["no_open_challenge", "attempts_exhausted", "login_required"].includes(field?.reason ?? "")
    ) {
      needsRestart = true;
      retry = null;
    }
    if (field?.path === "code") focusAfter = code;
    else if (field?.path === "email") focusAfter = email;
    return;
  }
  if (error.error.code === "conflict") {
    needsRestart = true;
    retry = null;
    message(
      "验证码在处理期间发生了变化，或今日新用户注册名额已满（这不是验证码错误）。请稍后重新开始。",
      "warning",
    );
    return;
  }
  const feedback = feedbackForApiError(error, { affectedOperation: "验证码邮件服务" });
  message(`${feedback.title}。${feedback.explanation} ${feedback.nextStep}`, "warning");
  if (
    (detail?.code === "rate_limited" || detail?.code === "temporarily_unavailable") &&
    typeof detail.retry_after_ms === "number" &&
    Number.isFinite(detail.retry_after_ms)
  )
    cooldownUntil = Math.max(cooldownUntil, Date.now() + detail.retry_after_ms);
}
async function status(): Promise<void> {
  try {
    const { status: http, body } = await request("status");
    if (http !== 200) throw new Error("status_unknown");
    mailAvailable =
      typeof body.mail_sending_available === "boolean" ? body.mail_sending_available : null;
    const service = el("auth-service");
    if (mailAvailable === false) {
      service.className = "auth-service callout callout--warning";
      service.textContent =
        body.registration_open === false
          ? "验证码邮件暂时无法发送，新用户注册也已暂停。请稍后再试，或用恢复码找回账号。"
          : "验证码邮件暂时无法发送，请稍后再试，或用恢复码找回账号。";
    } else if (body.registration_open === false) {
      service.className = "auth-service callout callout--info";
      service.textContent = "目前暂停新用户注册，已有账号可以正常登录。";
    } else if (mailAvailable === null || body.registration_open !== true) {
      service.className = "auth-service callout callout--info";
      service.textContent = "暂时无法确认注册与邮件服务状态，可以先尝试发送验证码。";
    } else {
      service.className = "auth-service";
      service.textContent = "";
    }
  } catch {
    mailAvailable = null;
    el("auth-service").className = "auth-service callout callout--info";
    el("auth-service").textContent = "暂时无法确认注册与邮件服务状态，可以查看服务状态后再试。";
  }
  render();
}
async function send(resend: boolean): Promise<void> {
  const targetEmail = email.value.trim();
  if (!canonicalizeEmail(targetEmail).ok) {
    message("请检查邮箱格式，首版支持 ASCII 邮箱。", "danger");
    email.focus();
    return;
  }
  if (mailAvailable === false) {
    message("验证码邮件暂时无法发送，请稍后再试，或用恢复码找回账号。", "warning");
    render();
    return;
  }
  invalidateIdentity();
  const key = crypto.randomUUID();
  let submittedAt: number | null = null;
  let preauthReady = resend;
  const attempt = async () => {
    if (!preauthReady) {
      const preauth = await request("auth/preauth", {}, undefined, abort?.signal);
      if (preauth.status !== 200 || typeof preauth.body.csrf_token !== "string")
        throw new Error("unknown_preauth");
      preauthReady = true;
    }
    const body: Json = { email: targetEmail, idempotency_key: key };
    if (!resend) {
      const token = captcha.take();
      if (!token) {
        message("请先完成人机验证，再点发送。", "warning");
        captcha.reset();
        return;
      }
      body.turnstile_token = token;
    }
    submittedAt ??= Date.now();
    try {
      const result = await request(
        `auth/challenges${resend ? "/resend" : ""}`,
        body,
        undefined,
        abort?.signal,
      );
      if (
        result.status !== AUTH_INTENT_PUBLIC_STATUS ||
        result.body.message !== AUTH_INTENT_PUBLIC_BODY.message
      )
        throw new Error("unknown_intent");
      if (!resend) challengeStart = submittedAt;
      cooldownUntil = Math.max(cooldownUntil, submittedAt + OTP_COOLDOWN * 1000);
      phase = "code";
      retry = null;
      message(
        resend
          ? "已重新发送（如果这个邮箱符合条件）。请查看最新的一封邮件。"
          : "如果这个邮箱可以登录或注册，验证码已经发出。",
        "success",
      );
      render();
      focusAfter = code;
    } finally {
      if (!resend) captcha.reset();
    }
  };
  setRetry(attempt, "重试发送（不会重复发信）");
  await run(attempt, "正在发送验证码…");
}
async function complete(): Promise<void> {
  const result = await request("auth/complete", {}, operationKey, abort?.signal);
  if (
    result.status !== 200 ||
    result.body.completed !== true ||
    typeof result.body.pending_session_id !== "string"
  )
    throw new Error("unknown_completion");
  await pending();
}
async function verify(): Promise<void> {
  const value = code.value.trim();
  if (!new RegExp(`^\\d{${OTP_DIGITS}}$`).test(value)) {
    message(`请输入完整的 ${OTP_DIGITS} 位数字验证码。`, "danger");
    code.focus();
    return;
  }
  operationKey = crypto.randomUUID();
  completionStart = Date.now();
  await run(async () => {
    setRetry(complete, "核对登录结果");
    try {
      const body = { email: email.value.trim(), code: value };
      let result = await request("auth/challenges/verify", body, operationKey, abort?.signal);
      if (
        result.status === 409 &&
        result.body.preauth_renewal_required === true &&
        result.body.verified === false
      ) {
        message("正在续接登录流程，并用同一个验证码重试一次…");
        result = await request("auth/challenges/verify", body, operationKey, abort?.signal);
        if (result.status === 409 && result.body.preauth_renewal_required === true) {
          retry = null;
          needsRestart = true;
          message("登录流程无法续接，请点「重新开始」。这不是验证码错误。", "warning");
          return;
        }
      }
      if (
        result.status !== 200 ||
        result.body.verified !== true ||
        typeof result.body.pending_session_id !== "string"
      )
        throw new Error("unknown_verify");
    } catch (error) {
      if (isApiErrorBody(error)) {
        retry = null;
        throw error;
      }
      message("暂时没收到验证结果，正在核对…");
      // Cancellation also follows the receipt path, but only after explicit retry.
      if (abort?.signal.aborted) throw error;
      await complete();
      return;
    }
    await pending();
  }, "正在验证验证码…");
}
async function pending(): Promise<void> {
  phase = "pending";
  code.value = "";
  invalidateIdentity();
  if (completionStart !== null)
    el("completion-time").textContent =
      `请在 ${stamp(completionStart + Math.min(AUTH_COMPLETION_TTL, SESSION_PENDING_TTL) * 1000)}（北京时间）前完成确认。`;
  setRetry(loadSessions, "重新读取待确认的登录");
  render();
  await loadSessions();
}
async function loadSessions(): Promise<void> {
  const result = await request("me/sessions", undefined, undefined, abort?.signal);
  if (
    result.status !== 200 ||
    !sessions(result.body.sessions) ||
    typeof result.body.csrf_token !== "string"
  )
    throw new Error("unknown_sessions");
  if (result.body.current_session_state === "active") {
    done();
    return;
  }
  if (result.body.current_session_state !== "pending") throw new Error("unknown_session_state");
  phase = "pending";
  retry = null;
  el("session-notice").textContent =
    result.body.current_needs_reverification === true ? "这次登录即将过期，请尽快确认。" : "";
  message("验证通过！请确认在这台设备登录。", "success");
  render();
  focusAfter = el("activate");
}
function deviceList(body: Json): void {
  const rows = sessions(body.sessions);
  if (!rows) throw new Error("unknown_sessions");
  selectionRequired = true;
  el("device-selection").hidden = false;
  el("session-lag").textContent =
    typeof body.renewed_at_max_lag_ms === "number" &&
    Number.isFinite(body.renewed_at_max_lag_ms) &&
    body.renewed_at_max_lag_ms >= 0
      ? `「最近活动」最多滞后 ${body.renewed_at_max_lag_ms / 1000 / 60} 分钟，不代表实时在线。时间均为北京时间。`
      : "「最近活动」有一定滞后，不代表实时在线。时间均为北京时间。";
  el("session-list").replaceChildren();
  for (const row of rows.filter((row) => row.state === "active" && !row.is_current)) {
    const label = document.createElement("label");
    label.className = "check check--bordered device-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "revoke";
    input.value = row.id;
    const text = document.createElement("span");
    text.className = "check-text";
    const name = document.createElement("span");
    name.className = "check-title";
    name.textContent = row.label;
    const meta = document.createElement("span");
    meta.className = "check-desc";
    meta.textContent = `创建：${stamp(row.created_at)} · 最近活动：${stamp(row.renewed_at)}`;
    text.append(name, meta);
    label.append(input, text);
    el("session-list").append(label);
  }
}
async function activate(): Promise<void> {
  const ids = [...root.querySelectorAll<HTMLInputElement>("input[name=revoke]:checked")].map(
    (item) => item.value,
  );
  const label = el<HTMLInputElement>("device-label").value.trim();
  const body: Json = {
    ...(label ? { label } : {}),
    ...(ids.length ? { revoke_session_ids: ids.join(",") } : {}),
  };
  const attempt = async () => {
    // GET rotates the session CSRF. request() then reads the current Cookie, including other-tab changes.
    const current = await request("me/sessions", undefined, undefined, abort?.signal);
    if (current.status !== 200 || typeof current.body.csrf_token !== "string")
      throw new Error("unknown_sessions");
    const result = await request("auth/activate", body, undefined, abort?.signal);
    if (result.status === 409 && result.body.selection_required === true) {
      deviceList(result.body);
      retry = null;
      message("登录设备已满，请选择要退出的旧设备，再确认登录。", "warning");
      return;
    }
    if (result.status !== 200 || result.body.activated !== true)
      throw new Error("unknown_activation");
    done();
  };
  setRetry(attempt, "核对登录结果");
  await run(attempt, "正在完成登录…");
}
function done(): void {
  phase = "done";
  retry = null;
  code.value = "";
  email.value = "";
  operationKey = "";
  invalidateIdentity();
  message(
    requestedReturn !== null
      ? "登录成功，正在返回…"
      : "登录成功！订阅设置和通知不会因登录自动改变。",
    "success",
  );
  if (requestedReturn !== null) window.location.assign(returnPath);
}
el<HTMLFormElement>("email-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!busy && !retry) void send(false);
});
el<HTMLFormElement>("code-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!busy && !retry && !needsRestart) void verify();
});
el("resend").addEventListener("click", () => void send(true));
el("activate").addEventListener("click", () => void activate());
el("device-selection").addEventListener("change", render);
el("retry-auth").addEventListener("click", () => {
  if (retry) void run(retry, phase === "pending" ? "正在完成登录…" : "正在核对原操作结果…");
});
el("cancel-wait").addEventListener("click", () => abort?.abort());
el("restart-auth").addEventListener("click", () => {
  if (busy) return;
  invalidateIdentity();
  phase = "email";
  needsRestart = false;
  retry = null;
  challengeStart = null;
  completionStart = null;
  selectionRequired = false;
  operationKey = "";
  code.value = "";
  el("device-selection").hidden = true;
  el("session-list").replaceChildren();
  captcha.reset();
  message("已重新开始。请确认邮箱并完成人机验证，再发送验证码。");
  render();
  email.focus();
  void status();
});
void captcha.load(root.dataset.sitekey ?? "", el("turnstile"), LOGIN_TURNSTILE_ACTION);
void status();
// Restore a delivered pending Cookie after navigation; never renew or activate on page load.
void request("me/sessions")
  .then((result) => {
    if (busy || phase !== "email" || retry) return;
    if (
      result.status === 200 &&
      result.body.current_session_state === "pending" &&
      sessions(result.body.sessions)
    ) {
      phase = "pending";
      message("你有一次未完成的登录，请确认在这台设备登录。");
      render();
    }
  })
  .catch(() => {
    /* No session is normal on the public login page. */
  });
window.setInterval(render, 1000); // Presentation clock only; no heartbeat requests.
render();
