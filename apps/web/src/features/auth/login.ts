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
    "完成并激活当前浏览器后，将返回站内原任务；设置仍需明确保存。";
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
function message(text: string): void {
  el("auth-result").textContent = text;
  announce(text, "info");
}
function render(): void {
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
  el("resend").textContent = left > 0 ? `重新发送验证码（${left} 秒后）` : "重新发送验证码";
  el<HTMLButtonElement>("activate").disabled =
    busy ||
    !!retry ||
    needsRestart ||
    (selectionRequired && !root.querySelector("input[name=revoke]:checked"));
  if (challengeStart !== null)
    el("challenge-time").textContent =
      `如果验证码已发出，按最初提交时刻估算有效至 ${stamp(challengeStart + OTP_TTL * 1000)}（北京时间）。实际结果以服务端校验为准。`;
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
    message("结果未知：请求可能已执行。请核对结果，不要重复创建新的操作。");
    return;
  }
  const detail = error.error.details;
  if (detail?.code === "unauthorized") {
    if (detail.reason === "pending_activation") {
      phase = "pending";
      setRetry(loadSessions, "读取待激活会话");
      message("还需完成激活，当前并非登录失败。");
      return;
    }
    retry = null;
    needsRestart = true;
    message(
      detail.reason === "session_expired"
        ? "会话已失效，请重新建立登录流程。这不是设备名额问题。"
        : "认证上下文已丢失或过期，请重新建立登录流程。这不表示验证码错误。",
    );
    return;
  }
  if (detail?.code === "validation") {
    const field = detail.fields?.[0];
    const reasons: Record<string, string> = {
      mismatch: "验证码不匹配，请核对输入。错误尝试累计计算，重发不会重置。",
      malformed_code: `请输入完整的 ${OTP_DIGITS} 位数字验证码。`,
      no_open_challenge: "没有可用的验证码挑战，可能已过期或结束，请重新建立登录流程。",
      attempts_exhausted: "本次验证码的错误尝试已用尽，请重新建立登录流程。",
      login_required: "认证状态已变化，请重新走登录流程收取验证码；这不是验证码错误。",
      verification_failed: "人机验证失败或已过期，请完成新的验证后重试原申请。",
      canonicalization_failed: "请检查邮箱格式，首版支持 ASCII 邮箱。",
    };
    message(reasons[field?.reason ?? ""] ?? "请检查填写内容，输入已保留。");
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
      "挑战在处理期间已变化，或全站当日注册完成名额已满；这不表示验证码错误。请稍后重新建立登录流程。",
    );
    return;
  }
  const feedback = feedbackForApiError(error, { affectedOperation: "验证码邮件服务" });
  message(`${feedback.title}。${feedback.explanation} ${feedback.nextStep}`);
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
    const registration =
      body.registration_open === true
        ? "当前开放注册。"
        : body.registration_open === false
          ? "全站暂停注册，已有账号仍可登录。"
          : "注册状态未知。";
    el("auth-service").textContent =
      registration +
      (mailAvailable === false
        ? "验证码邮件服务全局不可用，可使用恢复入口或稍后重试。"
        : mailAvailable === true
          ? "邮件发送服务当前可用，不代表邮件已送达。"
          : "邮件发送状态未知。");
  } catch {
    mailAvailable = null;
    el("auth-service").textContent = "全局注册与邮件状态未知，可查看服务状态后重试。";
  }
  render();
}
async function send(resend: boolean): Promise<void> {
  const targetEmail = email.value.trim();
  if (!canonicalizeEmail(targetEmail).ok) {
    message("请检查邮箱格式，首版支持 ASCII 邮箱。");
    email.focus();
    return;
  }
  if (mailAvailable === false) {
    message("验证码邮件服务全局不可用，请稍后查看服务状态或使用恢复入口。");
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
        message("请先完成人机验证，再重试申请。");
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
      message(AUTH_INTENT_PUBLIC_BODY.message);
      render();
      focusAfter = code;
    } finally {
      if (!resend) captcha.reset();
    }
  };
  setRetry(attempt, "重试原申请（不新增发送意图）");
  await run(attempt, "正在申请验证码…");
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
    message(`请输入完整的 ${OTP_DIGITS} 位数字验证码。`);
    code.focus();
    return;
  }
  operationKey = crypto.randomUUID();
  completionStart = Date.now();
  await run(async () => {
    setRetry(complete, "通过完成回执核对登录");
    try {
      const body = { email: email.value.trim(), code: value };
      let result = await request("auth/challenges/verify", body, operationKey, abort?.signal);
      if (
        result.status === 409 &&
        result.body.preauth_renewal_required === true &&
        result.body.verified === false
      ) {
        message("正在续接认证上下文，并用同一码重试一次…");
        result = await request("auth/challenges/verify", body, operationKey, abort?.signal);
        if (result.status === 409 && result.body.preauth_renewal_required === true) {
          retry = null;
          needsRestart = true;
          message("认证上下文仍无法续接，请重新建立登录流程；这不是验证码错误。");
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
      message("验证结果未知，正在通过完成回执核对…");
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
      `请尽量在 ${stamp(completionStart + Math.min(AUTH_COMPLETION_TTL, SESSION_PENDING_TTL) * 1000)}（北京时间）前完成登录。此时间按提交时刻估算；以服务端会话状态为准。`;
  setRetry(loadSessions, "重新读取待激活会话");
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
    result.body.current_needs_reverification === true
      ? "当前会话即将到期，请及时重新验证。"
      : result.body.current_needs_reverification === false
        ? "设备信息已读取，等待你确认激活。"
        : "会话临期状态未知。";
  message("正在完成登录：请确认激活当前浏览器。");
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
      ? `最近活动最多滞后 ${body.renewed_at_max_lag_ms / 1000 / 60} 分钟，不代表实时在线。以下时间均为北京时间。`
      : "最近活动的滞后精度未知，不代表实时在线。以下时间均为北京时间。";
  el("session-list").replaceChildren();
  for (const row of rows.filter((row) => row.state === "active" && !row.is_current)) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "revoke";
    input.value = row.id;
    const text = document.createElement("span");
    text.textContent = `${row.label} · 创建：${stamp(row.created_at)} · 最近活动：${stamp(row.renewed_at)}`;
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
      message("请选择要撤销的旧会话后，再确认激活。");
      return;
    }
    if (result.status !== 200 || result.body.activated !== true)
      throw new Error("unknown_activation");
    done();
  };
  setRetry(attempt, "重试并核对激活结果");
  await run(attempt, "正在完成登录…");
}
function done(): void {
  phase = "done";
  retry = null;
  code.value = "";
  email.value = "";
  operationKey = "";
  invalidateIdentity();
  message("登录已完成。仅恢复账号身份，订阅设置尚未因此保存，日历及邮件等通道也未因此开启。");
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
  message("已重新建立登录页面。请确认邮箱并完成人机验证，再申请新验证码。");
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
      message("检测到待激活会话，请确认后完成登录。");
      render();
    }
  })
  .catch(() => {
    /* No session is normal on the public login page. */
  });
window.setInterval(render, 1000); // Presentation clock only; no heartbeat requests.
render();
