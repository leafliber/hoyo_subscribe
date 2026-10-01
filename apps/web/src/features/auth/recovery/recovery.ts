import { AccountSummarySchema, isApiErrorBody, subscriptionConfigSchemaFor } from "@hoyo/contracts";
import { announce } from "../../../components/status";
import { feedbackForFailure } from "../../../lib/errors/feedback";
import {
  DRAFT_IDENTITY_EVENT,
  publishDraftIdentity,
  readDraftIdentityEvent,
} from "../../../lib/storage/identity";
import { request as apiRequest, type Json, object, sessions } from "../api";
import { Turnstile } from "../turnstile";
import {
  AccountFacts,
  type DeliveredCode,
  deliveredCode,
  type Purpose,
  readReceipt,
  saveReceipt,
} from "./model";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const root = el("recovery");
const facts = new AccountFacts();
let phase: "choose" | "credentials" | "pending" | "save" | "stopped" | "deleted" = "choose";
let purpose: Purpose | null = null;
let busy = false;
let abort: AbortController | undefined;
let retry: (() => Promise<void>) | null = null;
let code: DeliveredCode | null = null;
let selectionRequired = false;
let operationKey = "";
let proofId = "";
let challengeId = "";
let rotationKey = "";
let generationBefore: number | null = null;
let captcha: Turnstile | null = null;
let captchaReady = false;

// Cancellation alone cannot stop a response that has already arrived. Every async
// continuation belongs to this in-memory identity generation, including failures.
let identityGeneration = 0;
let knownUserId: string | null = null;
let publishingOwnIdentity = false;
const identityChannel =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("hoyo-draft-identity");
class StaleIdentityError extends Error {}
function assertIdentity(generation: number): void {
  if (generation !== identityGeneration) throw new StaleIdentityError();
}
async function request(...args: Parameters<typeof apiRequest>) {
  const generation = identityGeneration;
  try {
    const result = await apiRequest(...args);
    assertIdentity(generation);
    return result;
  } catch (error) {
    assertIdentity(generation);
    throw error;
  }
}
function invalidate(): void {
  // This workflow itself announces pending/activation/deletion. Its own synchronous
  // document event and BroadcastChannel sender must not discard its completion receipt.
  publishingOwnIdentity = true;
  try {
    publishDraftIdentity({ status: "unknown" });
    identityChannel?.postMessage("invalidate");
  } finally {
    publishingOwnIdentity = false;
  }
}
function clearIdentity(preserveReceipt = false): void {
  identityGeneration++;
  abort?.abort();
  abort = undefined;
  busy = false;
  forgetCode();
  clearCredentials();
  facts.clear();
  knownUserId = null;
  proofId = "";
  challengeId = "";
  rotationKey = "";
  generationBefore = null;
  retry = null;
  selectionRequired = false;
  phase = "choose";
  purpose = null;
  if (!preserveReceipt) receipt("");
  input("delete-check").checked = false;
  el("device-selection").hidden = true;
  el("session-list").replaceChildren();
  el("session-lag").textContent = "";
  el("rotation-form").hidden = true;
  el("reauth-link").hidden = true;
  el("use-recovery").hidden = true;
  // Detach the widget's old DOM references as well as its token. A late widget
  // callback may update only those detached nodes, never this identity's UI.
  for (const id of ["rotation-captcha", "captcha-status"]) {
    const previous = el(id);
    previous.replaceWith(previous.cloneNode(false));
  }
  captcha = null;
  captchaReady = false;
  el("code-state").textContent = "恢复码与账号状态未知，请重新读取后操作。";
  message("身份已变化，已清除本页恢复码与验证信息。请重新读取当前状态后操作。");
  render();
}
function message(text: string): void {
  el("recovery-result").textContent = text;
  announce(text, "info");
}
function forgetCode(): void {
  code = null;
  el<HTMLTextAreaElement>("code-output").value = "";
  input("saved-check").checked = false;
}
function clearCredentials(): void {
  input("recovery-id").value = "";
  input("recovery-secret").value = "";
  input("rotation-otp").value = "";
}
function receipt(key: string): boolean {
  operationKey = key;
  try {
    saveReceipt(localStorage, key, Date.now());
    return true;
  } catch {
    return false;
  }
}
function setRetry(work: () => Promise<void>, label: string): void {
  retry = work;
  el("retry-recovery").textContent = label;
}
function render(): void {
  el("purpose-section").hidden = phase !== "choose";
  el("credential-section").hidden = phase !== "credentials";
  el("pending-section").hidden = phase !== "pending";
  el("save-section").hidden = phase !== "save";
  el("delivered-code").hidden = !code;
  el("retry-recovery").hidden = !retry || busy;
  el("cancel-recovery").hidden = !busy;
  el("refresh-recovery").hidden = phase === "stopped" || phase === "deleted";
  root.setAttribute("aria-busy", String(busy));
  for (const button of root.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
  for (const field of root.querySelectorAll<HTMLInputElement>("input")) field.disabled = busy;
  el<HTMLButtonElement>("cancel-recovery").disabled = false;
  el<HTMLButtonElement>("submit-recovery").disabled = busy || !!retry;
  el<HTMLButtonElement>("change-purpose").disabled = busy || !!retry;
  const summary = facts.summary;
  const actions = facts.actions;
  const restricted =
    actions?.email_change.allowed === false &&
    actions.email_change.reason === "recovery_code_unconfirmed";
  el("restricted-actions").hidden = !restricted;
  for (const button of el("restricted-actions").querySelectorAll<HTMLButtonElement>("button"))
    button.disabled = true;
  el("confirmed-next").hidden = !summary?.recovery_code_saved || restricted;
  el("recovery-pause").hidden = summary?.session.recovery_login_at == null;
  el("generate-code").hidden = !!code || summary?.recovery_code_saved === true;
  el<HTMLButtonElement>("generate-code").disabled = busy || !!retry || !summary;
  el<HTMLButtonElement>("confirm-code").disabled = busy || !code || !input("saved-check").checked;
  el("rotation-section").hidden = !summary?.recovery_code_saved || restricted || !!code;
  el<HTMLButtonElement>("rotate-code").disabled =
    busy || !!retry || !proofId || !actions?.recovery_code_rotate.allowed;
  el("rotation-reason").textContent = actions?.recovery_code_rotate.allowed
    ? "本次轮换证明仍有效，交付前服务端会再次核对。"
    : "轮换需要本次操作的最近认证；请先验证当前邮箱。";
  el<HTMLButtonElement>("delete-account").disabled =
    busy || !actions?.account_delete.allowed || !input("delete-check").checked;
  el("delete-reason").textContent = actions?.account_delete.allowed
    ? "当前可申请删除，提交时由服务端再次校验。"
    : "删除需要用途限定的最近认证。可到账号与设备页处理。";
  el<HTMLButtonElement>("activate-recovery").disabled =
    busy || !!retry || (selectionRequired && !root.querySelector("input[name=revoke]:checked"));
}
async function readFacts(): Promise<void> {
  try {
    const reply = await request("me", undefined, undefined, abort?.signal);
    if (reply.status !== 200) throw new Error("unknown_summary");
    const summary = AccountSummarySchema.parse(reply.body);
    if (knownUserId !== null && knownUserId !== summary.user_id) {
      clearIdentity();
      throw new StaleIdentityError();
    }
    facts.accept(summary);
    knownUserId = summary.user_id;
    const saved = facts.summary?.recovery_code_saved;
    el("code-state").textContent = saved
      ? "当前恢复码已确认保存；服务器无法重新显示旧码。"
      : "尚未确认保存。若刷新、离开或响应丢失导致新码不再显示，请重新生成并保存；未确认的上一份码会作废。";
  } catch (error) {
    if (error instanceof StaleIdentityError) throw error;
    facts.clear();
    el("code-state").textContent = "恢复码与账号状态未知，请重新读取后操作。";
    throw error;
  }
}
async function sessionCsrf(): Promise<Json> {
  const result = await request("me/sessions", undefined, undefined, abort?.signal);
  if (
    result.status !== 200 ||
    typeof result.body.csrf_token !== "string" ||
    !sessions(result.body.sessions)
  )
    throw new Error("unknown_sessions");
  return result.body;
}
async function run(work: () => Promise<void>, waiting: string): Promise<void> {
  if (busy) return;
  const generation = identityGeneration;
  busy = true;
  abort = new AbortController();
  message(waiting);
  render();
  try {
    await work();
  } catch (error) {
    if (generation !== identityGeneration || error instanceof StaleIdentityError) return;
    if (phase === "save") {
      // Write refusal is authoritative. Discard stale permissions even when re-reading fails.
      try {
        await readFacts();
      } catch {
        if (generation !== identityGeneration) return;
        facts.clear();
      }
    }
    if (generation !== identityGeneration) return;
    const feedback = feedbackForFailure(error);
    const detail = isApiErrorBody(error) ? error.error.details : undefined;
    if (detail?.code === "unauthorized" && detail.reason === "recent_auth_required")
      el("reauth-link").hidden = false;
    message(`${feedback.title}。${feedback.explanation} ${feedback.nextStep}`);
  } finally {
    if (generation === identityGeneration) {
      busy = false;
      abort = undefined;
      render();
    }
  }
}
async function refresh(): Promise<void> {
  if (phase === "stopped" || phase === "deleted") return;
  if (operationKey && phase !== "save" && phase !== "pending") {
    setRetry(complete, "用原操作的完成回执核对恢复登录");
    await complete();
    return;
  }
  const current = await sessionCsrf();
  if (current.current_session_state === "pending") {
    receipt("");
    phase = "pending";
    retry = null;
    message("检测到待激活会话，请确认激活。尚未开启任何通道。");
  } else if (current.current_session_state === "active") {
    receipt("");
    phase = "save";
    await readFacts();
    // Never regenerate on a read/refresh: users may have a usable delivered code in another tab.
    if (!code && !rotationKey) retry = null;
    el("use-recovery").hidden = facts.summary?.session.recovery_code_required !== false;
    message("已读取当前状态。请保存恢复码；查看页面不会自动开启通道。");
  } else throw new Error("unknown_session_state");
}
function choose(value: Purpose): void {
  if (busy || retry) return;
  purpose = value;
  phase = "credentials";
  clearCredentials();
  el("purpose-consequence").textContent =
    value === "emergency_stop"
      ? "紧急停用不消耗恢复码：撤销所有会话和日历地址，关闭业务邮件、暂停 Push；之后仍可用此码恢复登录。"
      : "恢复登录会消耗当前恢复码：先撤销所有会话和日历地址，关闭业务邮件、暂停 Push；激活后必须保存并确认新码。";
  el("submit-recovery").textContent =
    value === "emergency_stop" ? "确认紧急停用（不消耗恢复码）" : "确认恢复登录（消耗当前恢复码）";
  render();
  input("recovery-id").focus();
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
async function pending(): Promise<void> {
  phase = "pending";
  receipt("");
  clearCredentials();
  retry = null;
  invalidate();
  await sessionCsrf();
  message(
    "恢复登录已建立待激活会话。原日历地址已失效，邮件与 Push 已暂停，订阅内容保留。请激活并保存新码。",
  );
}
async function recover(): Promise<void> {
  if (!purpose || retry) return;
  const action = purpose;
  const body = {
    action,
    recovery_id: input("recovery-id").value.trim(),
    secret: input("recovery-secret").value.trim(),
  };
  if (!body.recovery_id || !body.secret) {
    message("请填写恢复码 ID 与秘密。");
    return;
  }
  invalidate();
  await run(async () => {
    const context = await request("auth/preauth", {}, undefined, abort?.signal);
    if (context.status !== 200 || typeof context.body.csrf_token !== "string")
      throw new Error("unknown_preauth");
    if (action === "recover_login" && !receipt(crypto.randomUUID())) {
      operationKey = "";
      message(
        "此浏览器无法保留短期恢复上下文，恢复登录尚未提交。请允许本站存储后重试；紧急停用仍可使用。",
      );
      return;
    }
    const attempt = async () => {
      try {
        let result = await request("auth/recovery", body, operationKey || undefined, abort?.signal);
        if (result.status === 409 && result.body.preauth_renewal_required === true) {
          result = await request("auth/recovery", body, operationKey, abort?.signal);
          if (result.status === 409 && result.body.preauth_renewal_required === true) {
            receipt("");
            retry = null;
            message("预认证上下文无法续接，请重新提交以建立认证流程；恢复码尚未因此消费。");
            return;
          }
        }
        if (action === "emergency_stop") {
          if (result.status !== 200 || result.body.stopped !== true)
            throw new Error("unknown_stop");
          phase = "stopped";
          retry = null;
          clearCredentials();
          forgetCode();
          facts.clear();
          receipt("");
          message(
            "紧急停用已完成。所有会话和原日历地址已撤销，业务邮件已关闭、Push 已暂停。恢复码仍然有效，之后仍可用它恢复登录。订阅内容未丢失。",
          );
        } else {
          if (
            result.status !== 200 ||
            result.body.completed !== true ||
            typeof result.body.pending_session_id !== "string"
          )
            throw new Error("unknown_recovery");
          await pending();
        }
      } catch (error) {
        if (error instanceof StaleIdentityError) throw error;
        if (action === "recover_login") {
          if (isApiErrorBody(error)) {
            receipt("");
            retry = null;
          } else setRetry(complete, "用原操作的完成回执核对恢复登录");
        }
        if (isApiErrorBody(error) && error.error.details?.code === "unauthorized") {
          message(
            "无法确认恢复凭证或认证上下文。请核对 ID 与秘密后重新提交；不会区分不存在、错误或已消费的恢复码。",
          );
          if (action === "emergency_stop") retry = null;
          return;
        }
        throw error;
      }
    };
    if (action === "emergency_stop") setRetry(attempt, "重试紧急停用（不消耗恢复码）");
    else setRetry(complete, "用原操作的完成回执核对恢复登录");
    await attempt();
  }, "正在提交恢复操作…");
}
async function activate(): Promise<void> {
  const ids = [...root.querySelectorAll<HTMLInputElement>("input[name=revoke]:checked")].map(
    (row) => row.value,
  );
  await sessionCsrf();
  setRetry(activate, "重试并核对激活结果");
  const result = await request(
    "auth/activate",
    ids.length ? { revoke_session_ids: ids.join(",") } : {},
    undefined,
    abort?.signal,
  );
  if (result.status === 409 && result.body.selection_required === true) {
    const rows = sessions(result.body.sessions);
    if (!rows) throw new Error("unknown_selection");
    selectionRequired = true;
    retry = null;
    el("device-selection").hidden = false;
    el("session-list").replaceChildren();
    const lag = result.body.renewed_at_max_lag_ms;
    el("session-lag").textContent =
      typeof lag === "number"
        ? `最近活动最多滞后 ${lag / 1000 / 60} 分钟，不代表实时在线。时间为北京时间。`
        : "最近活动精度未知。";
    for (const row of rows.filter((row) => row.state === "active" && !row.is_current)) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "revoke";
      checkbox.value = row.id;
      const stamp = (time: number) =>
        new Date(time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      label.append(
        checkbox,
        `${row.label} · 创建 ${stamp(row.created_at)} · 最近活动 ${stamp(row.renewed_at)}`,
      );
      el("session-list").append(label);
    }
    message("名额已满或选择已变化，请自行选择要撤销的旧会话。");
    return;
  }
  if (result.status !== 200 || result.body.activated !== true)
    throw new Error("unknown_activation");
  phase = "save";
  retry = null;
  invalidate();
  await readFacts();
  if (facts.summary?.session.recovery_code_required) await generate();
  else message("会话已激活，请保存恢复码后继续。");
}
function showCode(value: Json): void {
  code = deliveredCode(value);
  el<HTMLTextAreaElement>("code-output").value = `${code.recovery_id}\n${code.secret}`;
  input("saved-check").checked = false;
  retry = null;
  message("新恢复码已交付。请单独复制或下载，然后明确确认已保存。");
  render();
  el("save-title").focus();
}
async function generate(): Promise<void> {
  await sessionCsrf();
  setRetry(refresh, "重新读取恢复码状态");
  forgetCode();
  const result = await request(
    "auth/recovery/code",
    { action: "generate" },
    undefined,
    abort?.signal,
  );
  if (result.status !== 200) throw new Error("unknown_generation");
  showCode(result.body);
}
async function confirm(): Promise<void> {
  if (!code || !input("saved-check").checked) return;
  const delivered = code;
  const attempt = async () => {
    await sessionCsrf();
    const result = await request(
      delivered.rotation_id ? "me/recovery-code" : "auth/recovery/code",
      delivered.rotation_id
        ? { action: "confirm", rotation_id: delivered.rotation_id, secret: delivered.secret }
        : { action: "confirm", recovery_id: delivered.recovery_id, secret: delivered.secret },
      undefined,
      abort?.signal,
    );
    if (result.status !== 200 || result.body.saved_confirmed !== true)
      throw new Error("unknown_confirmation");
    forgetCode();
    retry = null;
    proofId = "";
    rotationKey = "";
    await readFacts();
    if (delivered.rotation_id && document.visibilityState === "visible") {
      try {
        await request("auth/renew", {}, undefined, abort?.signal);
      } catch (error) {
        if (error instanceof StaleIdentityError) throw error;
        /* Saved state remains authoritative. */
      }
    }
    message("当前恢复码已确认保存。外部备份可靠性仍由你自行核对；通道没有自动开启。");
  };
  setRetry(async () => {
    await readFacts();
    if (
      facts.summary?.recovery_code_saved &&
      !facts.summary.session.recovery_code_required &&
      (!delivered.rotation_id || facts.summary.recovery_code_generation !== generationBefore)
    ) {
      forgetCode();
      retry = null;
      message("已核对：当前恢复码已确认保存，通道没有自动开启。");
    } else await attempt();
  }, "核对恢复码保存结果");
  await attempt();
}
async function requestRotation(): Promise<void> {
  const generation = identityGeneration;
  if (!captchaReady) {
    captcha ??= new Turnstile(el("captcha-status"));
    await captcha.load(root.dataset.sitekey ?? "", el("rotation-captcha"));
    assertIdentity(generation);
    captchaReady = true;
    message("请完成人机验证后，再申请本次轮换的邮箱验证码。");
    return;
  }
  const key = crypto.randomUUID();
  const attempt = async () => {
    const token = captcha?.take();
    if (!token) {
      message("请先完成人机验证。");
      return;
    }
    await sessionCsrf();
    try {
      const result = await request(
        "me/recent-auth/challenges",
        {
          action: "recovery_code_rotate",
          role: "current",
          idempotency_key: key,
          turnstile_token: token,
        },
        undefined,
        abort?.signal,
      );
      if (result.status !== 202 || typeof result.body.challenge_id !== "string")
        throw new Error("unknown_challenge");
      challengeId = result.body.challenge_id;
      retry = null;
      el("rotation-form").hidden = false;
      message("本次轮换的验证请求已受理，不代表邮件已送达。请核对当前邮箱收到的验证码。");
    } finally {
      if (generation === identityGeneration) captcha?.reset();
    }
  };
  setRetry(attempt, "重试原轮换验证申请");
  await attempt();
}
async function verifyRotation(): Promise<void> {
  await sessionCsrf();
  const result = await request(
    "me/recent-auth/challenges/verify",
    { challenge_id: challengeId, code: input("rotation-otp").value.trim() },
    undefined,
    abort?.signal,
  );
  if (result.status !== 200 || typeof result.body.proof_id !== "string")
    throw new Error("unknown_proof");
  proofId = result.body.proof_id;
  input("rotation-otp").value = "";
  await readFacts();
  message("本次轮换的邮箱验证已完成，请明确交付新码。");
}
async function rotate(): Promise<void> {
  if (!facts.actions?.recovery_code_rotate.allowed || !proofId) return;
  generationBefore = facts.summary?.recovery_code_generation ?? null;
  rotationKey ||= crypto.randomUUID();
  const attempt = async () => {
    await sessionCsrf();
    const result = await request(
      "me/recovery-code",
      { action: "start", proof_id: proofId, operation_key: rotationKey },
      undefined,
      abort?.signal,
    );
    if (result.status !== 200 || typeof result.body.rotation_id !== "string")
      throw new Error("unknown_rotation");
    showCode(result.body);
  };
  setRetry(async () => {
    await readFacts();
    await attempt();
  }, "核对并重新交付本次轮换新码");
  await attempt();
}
async function deleteAccount(): Promise<void> {
  if (!facts.actions?.account_delete.allowed || !input("delete-check").checked) return;
  await sessionCsrf();
  invalidate();
  setRetry(async () => {
    try {
      await readFacts();
      message("账号仍可读取，请到账号页核对删除状态后再操作。");
    } catch (error) {
      if (error instanceof StaleIdentityError) throw error;
      message("当前账号已无法读取，删除结果待核对；无法据此确认数据清理完成。");
    }
  }, "核对删除状态");
  const result = await request("me/delete", { confirm: true }, undefined, abort?.signal);
  if (result.status !== 200 || result.body.state !== "deleting") throw new Error("unknown_delete");
  phase = "deleted";
  retry = null;
  forgetCode();
  facts.clear();
  clearCredentials();
  message("删除已开始，本站权限与通道已停止。数据仍在清理，尚不能确认清理完成。");
}
function download(text: string, filename = "hoyo-recovery-code.txt"): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
el("export-preferences").addEventListener("click", (event) => {
  event.preventDefault();
  void run(async () => {
    const result = await request("me/export", undefined, undefined, abort?.signal);
    const value = result.body.subscription;
    if (
      result.status !== 200 ||
      result.body.format !== "hoyo-preferences" ||
      !object(value) ||
      (value.state !== "initialized" && value.state !== "uninitialized")
    )
      throw new Error("unknown_export");
    const config =
      value.state === "uninitialized" && value.config === null
        ? null
        : subscriptionConfigSchemaFor(value.state).parse(value.config);
    // Select the preferences fields; never serialize page state or a recovery delivery.
    download(
      JSON.stringify(
        { format: "hoyo-preferences", subscription: { state: value.state, config } },
        null,
        2,
      ),
      "hoyo-preferences.json",
    );
    if (document.visibilityState === "visible") {
      try {
        await sessionCsrf();
        await request("auth/renew", {}, undefined, abort?.signal);
      } catch (error) {
        if (error instanceof StaleIdentityError) throw error;
        /* Export has completed independently of renewal. */
      }
    }
    message("已请求下载偏好，请核对文件。普通偏好导出不包含恢复码。");
  }, "正在导出偏好…");
});
el("use-recovery").addEventListener("click", () => {
  if (busy || retry) return;
  clearIdentity();
  message("请选择目的后再输入恢复码。");
});
el("choose-stop").addEventListener("click", () => choose("emergency_stop"));
el("choose-login").addEventListener("click", () => choose("recover_login"));
el("change-purpose").addEventListener("click", () => {
  phase = "choose";
  purpose = null;
  clearCredentials();
  render();
});
el("recovery-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!busy) void recover();
});
el("activate-recovery").addEventListener(
  "click",
  () => void run(activate, "正在激活并交付恢复码…"),
);
el("generate-code").addEventListener("click", () => void run(generate, "正在交付新恢复码…"));
el("confirm-code").addEventListener("click", () => void run(confirm, "正在确认恢复码保存…"));
el("copy-code").addEventListener("click", async () => {
  if (!code || busy) return;
  const generation = identityGeneration;
  try {
    await navigator.clipboard.writeText(el<HTMLTextAreaElement>("code-output").value);
    if (generation !== identityGeneration) return;
    message("恢复码已复制，请保存到安全位置后勾选确认。");
  } catch {
    if (generation !== identityGeneration) return;
    message("复制失败，请手动选择恢复码复制，或单独下载。");
  }
});
el("download-code").addEventListener("click", () => {
  if (code && !busy) {
    download(el<HTMLTextAreaElement>("code-output").value);
    message("已请求下载恢复码，请确认文件已保存后勾选确认。");
  }
});
el("request-rotation").addEventListener(
  "click",
  () => void run(requestRotation, "正在准备本次轮换验证…"),
);
el("rotation-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(verifyRotation, "正在验证本次轮换…");
});
el("rotate-code").addEventListener("click", () => void run(rotate, "正在交付轮换新码…"));
el("delete-account").addEventListener("click", () => void run(deleteAccount, "正在申请删除账号…"));
el("retry-recovery").addEventListener("click", () => {
  if (retry) void run(retry, "正在核对原操作结果…");
});
el("refresh-recovery").addEventListener("click", () => void run(refresh, "正在读取当前状态…"));
el("cancel-recovery").addEventListener("click", () => abort?.abort());
el("open-save").addEventListener("click", () => void run(refresh, "正在读取账号状态…"));
root.addEventListener("change", render);
identityChannel?.addEventListener("message", (event) => {
  if (event.data === "invalidate") clearIdentity();
});
document.addEventListener(DRAFT_IDENTITY_EVENT, (event) => {
  if (publishingOwnIdentity) return;
  const identity = readDraftIdentityEvent(event);
  if (identity && (identity.status !== "confirmed" || identity.userId !== knownUserId))
    clearIdentity();
});
window.addEventListener("pagehide", () => clearIdentity(true));
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void run(refresh, "正在重新核对账号状态…");
});
window.setInterval(render, 1000); // Display only; never renew sessions or issue background requests.
try {
  operationKey = readReceipt(localStorage, Date.now());
} catch {
  /* Storage optional. */
}
render();
// Restore the delivered cookie or receipt; no activation, generation or channel writes on load.
void run(async () => {
  try {
    await refresh();
  } catch (error) {
    if (
      !operationKey &&
      location.hash !== "#save" &&
      isApiErrorBody(error) &&
      error.error.code === "unauthorized"
    ) {
      message("请选择目的后再输入恢复码。");
    } else throw error;
  }
}, "正在检查当前浏览器的恢复状态…");
