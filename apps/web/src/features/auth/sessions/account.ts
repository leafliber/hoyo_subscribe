import {
  type AccountSummary,
  AccountSummarySchema,
  AUTH_COMPLETION_TTL,
  canonicalizeEmail,
  deriveAccountActions,
  isApiErrorBody,
  isSessionExpiryNotice,
  RECENT_AUTH_TTL,
  type RecentAuthAction,
  type RecentAuthRole,
  recentAuthTurnstileAction,
  SESSION_PENDING_TTL,
  SESSION_RENEW_INTERVAL,
} from "@hoyo/contracts";
import { closeDialog } from "../../../components/dialog";
import { announce } from "../../../components/status";
import { feedbackForFailure } from "../../../lib/errors/feedback";
import { publishDraftIdentity, readDraftIdentityEvent } from "../../../lib/storage/identity";
import { AccountPushSection, pauseThisBrowserBeforeLogout } from "../../channels/push/account";
import { csrfToken, object, request, type Session, sessions } from "../api";
import { type DeliveredCode, deliveredCode } from "../recovery/model";
import { Turnstile } from "../turnstile";
import { revokeSession } from "./api";

const el = (id: string) => document.getElementById(id) as HTMLElement;
const button = (id: string) => el(id) as HTMLButtonElement;
const input = (id: string) => el(id) as HTMLInputElement;
const stamp = (time: number) =>
  new Date(time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
let summary: AccountSummary | null = null;
let rows: Session[] = [];
let sessionReady = false;
let busy = false;
let epoch = 0;
let clockAnchor = { server: 0, local: 0 };
let proofId: string | undefined;
let proofFeedback = "";
let deletionUncertain = false;
let channel: BroadcastChannel | null = null;
let publishingIdentity = false;
const now = () => clockAnchor.server + (performance.now() - clockAnchor.local);
// F5-01：浏览器通知分区（登录会话与 Push 绑定分组展示，前端 §10.1）。
const pushSection = new AccountPushSection(
  {
    section: document.getElementById("account-push") as HTMLElement,
    list: document.getElementById("account-push-list") as HTMLElement,
    status: document.getElementById("account-push-status") as HTMLElement,
    permission: document.getElementById("account-push-permission") as HTMLElement,
    enableLink: document.getElementById("account-push-enable") as HTMLAnchorElement,
  },
  () => renderActions(),
);

function message(text: string): void {
  el("account-result").textContent = text;
  announce(text);
}
function explanation(error: unknown): string {
  if (
    isApiErrorBody(error) &&
    error.error.details?.code === "validation" &&
    error.error.details.fields?.some(
      (field) => field.path === "turnstile_token" && field.reason === "verification_failed",
    )
  )
    return "人机验证失败或已过期，请完成新的验证后重试原申请。";
  const feedback = feedbackForFailure(error);
  return `${feedback.title}。${feedback.nextStep}`;
}
function noSession(error: unknown): boolean {
  return (
    isApiErrorBody(error) &&
    error.error.details?.code === "unauthorized" &&
    (error.error.details.reason === "no_session" ||
      error.error.details.reason === "session_expired")
  );
}
function clearRejectedIdentity(error: unknown): boolean {
  if (!noSession(error)) return false;
  invalidate();
  proofId = undefined;
  proofFeedback = "";
  closeDialog(false);
  message("当前会话已失效，已清除本页证明和输入。请重新登录后核对账号状态。");
  return true;
}
function clearPrivate(): void {
  summary = null;
  rows = [];
  sessionReady = false;
  for (const field of ["email", "expiry", "lease", "reclaim"]) {
    el(`account-${field}`).textContent = "未知";
  }
  showRow("lease", false);
  showRow("reclaim", false);
  pushSection.clear();
  el("account-sessions").replaceChildren();
  el("account-recovery").textContent = "恢复码状态未知。";
  el("account-recovery").className = "recovery-state";
  el("account-lag").textContent = "设备列表尚未确认，请刷新。";
}
/** 账号信息里不适用的行整行隐藏（前端 §10.1「适用的」提示），不显示「未知」占位。 */
function showRow(name: string, visible: boolean): void {
  for (const item of document.querySelectorAll<HTMLElement>(`[data-account-row="${name}"]`))
    item.hidden = !visible;
}
function invalidate(): void {
  // Must precede logout, current-session revocation and deletion requests.
  publishingIdentity = true;
  publishDraftIdentity({ status: "unknown" });
  publishingIdentity = false;
  channel?.postMessage("invalidate");
  epoch += 1;
  clearPrivate();
  clearMaintenance();
}
function renderActions(): void {
  const actions = summary ? deriveAccountActions(summary, now()) : null;
  const ready = summary !== null && sessionReady;
  el("account-login").hidden = summary !== null;
  renderMaintenance(ready);
  button("account-refresh").disabled = busy;
  button("account-logout").disabled = busy || !ready;
  button("logout-only").disabled = busy || !ready;
  // 只有本浏览器有本账号的、可暂停的通知时才提供组合动作（前端 §10.2）。
  button("logout-pause").hidden = !pushSection.thisBrowserPausable();
  button("logout-pause").disabled = busy || !ready;
  button("account-export").disabled = busy || !ready || !actions?.export_data.allowed;
  button("account-delete-open").disabled = busy || !ready || deletionUncertain;
  button("delete-prove").disabled =
    busy || !ready || summary?.session.recovery_code_required === true;
  // A proof's ID is delivered only by the dedicated operation, never by /me.
  // Reloading the page requires another verification unless the contracts recovery exception applies.
  const hasDeleteCredential =
    proofId !== undefined || summary?.session.recovery_code_required === true;
  button("delete-confirm").disabled =
    busy || !ready || !actions?.account_delete.allowed || !hasDeleteCredential || deletionUncertain;
  const reason = !summary
    ? "读取账号后才能确认删除条件。"
    : !actions?.account_delete.allowed
      ? "删除需要本次用途的最近认证；请先验证。"
      : !hasDeleteCredential
        ? "本页尚未取得删除用途证明，请在删除确认框内重新验证。"
        : "删除条件已满足，仍需明确确认。";
  el("account-delete-reason").textContent = reason;
  el("delete-proof-status").textContent = `${reason} ${proofFeedback}`;
  el("delete-proof-form").hidden = summary?.session.recovery_code_required === true;
  // 恢复会话的删除例外不需要用途证明：整块验证说明与入口一起隐藏，改为直接说明可删除。
  el("delete-proofs").hidden = summary?.session.recovery_code_required === true;
  el("delete-restricted-note").hidden = summary?.session.recovery_code_required !== true;
  for (const item of el("account-sessions").querySelectorAll<HTMLButtonElement>("button")) {
    item.disabled = busy || !ready;
  }
  renderRecovery(ready);
  if (summary) {
    const expiry = Math.min(summary.session.expires_at, summary.session.absolute_expires_at);
    el("account-expiry").textContent = `${stamp(expiry)} 前有效${
      isSessionExpiryNotice(expiry, now()) ? "（即将到期，请留意重新登录）" : ""
    }`;
  }
}
function renderSummary(facts: AccountSummary): void {
  el("account-email").textContent = `${facts.email.masked}（已验证）`;
  // 回收提示只在服务端给出回收期限时出现（前端 §10.1「适用的账号回收提示」）。
  showRow("reclaim", facts.reclaim_grace_until !== null);
  el("account-reclaim").textContent =
    facts.reclaim_grace_until === null
      ? "正常使用中"
      : `账号将在 ${stamp(facts.reclaim_grace_until)} 后可能被回收。继续使用（包括日历应用拉取）即可保留。`;
  // ADR-0026：恢复码可选，没有恢复码不是警告状态；只有恢复登录后的受限会话需要先保存新码。
  el("account-recovery").textContent = facts.session.recovery_code_required
    ? "恢复登录后还没有保存新码。在此之前只能查看、导出、保存新码或删除账号。"
    : facts.recovery_code_saved
      ? "已保存恢复码。出于安全考虑，旧码无法再次显示；找不到时可以更换一个新码。"
      : "还没有恢复码。不创建也能正常使用；但邮箱无法使用时，就没有别的办法找回账号。";
  el("account-recovery").className = `recovery-state callout ${
    facts.session.recovery_code_required
      ? "callout--warning"
      : facts.recovery_code_saved
        ? "callout--success"
        : "callout--info"
  }`;
}
function renderSessions(): void {
  el("account-sessions").replaceChildren();
  el("account-lag").textContent =
    `「最近续期」最多滞后 ${SESSION_RENEW_INTERVAL / (24 * 60 * 60)} 天，不代表最后一次使用时间。`;
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = row.is_current ? "is-current" : "";
    const icon = document.createElement("span");
    icon.className = "session-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = row.label.slice(0, 1).toUpperCase();
    const body = document.createElement("div");
    body.className = "session-body";
    const title = document.createElement("h3");
    title.textContent = row.label;
    if (row.is_current) {
      const badge = document.createElement("span");
      badge.className = "badge badge--accent";
      badge.textContent = "当前设备";
      title.append(" ", badge);
    }
    const state = document.createElement("p");
    state.textContent = `${row.state === "active" ? "已激活" : "待激活"} · 创建于 ${stamp(row.created_at)} · 最近续期 ${stamp(row.renewed_at)}`;
    body.append(title, state);
    const revokeButton = document.createElement("button");
    revokeButton.type = "button";
    revokeButton.className = "button button--secondary button--sm";
    revokeButton.textContent = row.is_current ? "撤销当前会话" : `撤销 ${row.label}`;
    revokeButton.addEventListener("click", () => void run(() => revoke(row)));
    // Keep the identifier in the closure, not in a URL, storage or telemetry.
    li.append(icon, body, revokeButton);
    el("account-sessions").append(li);
  }
}

async function readSessions(): Promise<Session[]> {
  const reply = await request("me/sessions");
  const parsed = sessions(reply.body.sessions);
  if (reply.status !== 200 || parsed === null || reply.body.current_session_state !== "active") {
    throw new Error("unknown_session_state");
  }
  return parsed;
}
async function refresh(): Promise<boolean> {
  const turn = ++epoch;
  const previousUser = summary?.user_id;
  const previousSession = rows.find((row) => row.is_current)?.id;
  clearPrivate();
  renderActions();
  try {
    const reply = await request("me");
    if (turn !== epoch) return false;
    if (reply.status !== 200) throw new Error("unknown_summary");
    const parsed = AccountSummarySchema.parse(reply.body);
    if (parsed.session.state !== "active") throw new Error("unknown_session_state");
    if (previousUser !== undefined && previousUser !== parsed.user_id) {
      proofId = undefined;
      clearMaintenance();
    }
    summary = parsed;
    clockAnchor = { server: parsed.server_time, local: performance.now() };
    deletionUncertain = false;
    renderSummary(parsed);
    void pushSection.refresh();
    try {
      const list = await readSessions(); // Issues current session CSRF, without renewal.
      if (turn !== epoch) return false;
      rows = list;
      if (
        previousSession !== undefined &&
        previousSession !== rows.find((row) => row.is_current)?.id
      ) {
        proofId = undefined;
        clearMaintenance();
      }
      sessionReady = rows.some((row) => row.is_current && row.state === "active");
      renderSessions();
    } catch (error) {
      if (turn !== epoch) return false;
      if (noSession(error)) {
        invalidate();
        proofId = undefined;
      }
      el("account-lag").textContent = `设备列表未确认。${explanation(error)}`;
    }
    if (turn !== epoch) return false;
    try {
      const mail = await request("me/email-channel");
      if (turn !== epoch) return false;
      const lease = mail.body.lease;
      if (
        mail.status === 200 &&
        object(lease) &&
        (lease.expires_at === null || Number.isSafeInteger(lease.expires_at))
      ) {
        // 没开启邮件通知就没有名额租期，这一行不适用，整行隐藏。
        showRow("lease", lease.expires_at !== null);
        if (lease.expires_at !== null)
          el("account-lease").textContent =
            `${stamp(lease.expires_at as number)} 前有效；账号有活动（包括日历应用拉取）会自动续期，后台续期的运行状态${lease.background_processing === "unknown" ? "暂未确认" : "尚待核对"}。`;
      }
    } catch {
      /* Secondary facts remain unknown; never infer success. */
    }
  } catch (error) {
    if (turn !== epoch) return false;
    clearPrivate();
    proofId = undefined;
    clearMaintenance();
    message(
      noSession(error)
        ? "你还没有登录，或登录已经过期。"
        : `账号状态暂时无法读取。${explanation(error)}`,
    );
  }
  if (turn === epoch) renderActions();
  return turn === epoch;
}

async function run(operation: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  renderActions();
  try {
    await operation();
  } finally {
    busy = false;
    renderActions();
  }
}

function actionIdentity() {
  return {
    epoch,
    userId: summary?.user_id,
    sessionId: rows.find((row) => row.is_current)?.id,
    csrf: csrfToken(),
  };
}
function sameActionIdentity(identity: ReturnType<typeof actionIdentity>): boolean {
  return (
    identity.epoch === epoch &&
    identity.userId !== undefined &&
    identity.userId === summary?.user_id &&
    identity.sessionId !== undefined &&
    rows.some((row) => row.is_current && row.state === "active" && row.id === identity.sessionId) &&
    identity.csrf !== "" &&
    identity.csrf === csrfToken()
  );
}
async function renewAfterAction(
  identity: ReturnType<typeof actionIdentity>,
  completed: string,
  report: (text: string) => void = message,
): Promise<void> {
  // Only a confirmed explicit operation reaches here. Never renew another identity
  // when its cookie changes before a cross-tab invalidation message is delivered.
  if (!sameActionIdentity(identity)) return;
  report(completed);
  try {
    const reply = await request("auth/renew", {});
    if (
      reply.status !== 200 ||
      typeof reply.body.renewed !== "boolean" ||
      !Number.isSafeInteger(reply.body.expires_at)
    )
      throw new Error("unknown_renewal");
    // renewed=false is normal: the server alone decides the renewal interval.
  } catch {
    if (!sameActionIdentity(identity)) return;
    // Re-read rejected/unknown writes, but do not turn the completed operation into a failure.
    if (!(await refresh())) return;
    if (
      summary &&
      (summary.user_id !== identity.userId ||
        rows.find((row) => row.is_current)?.id !== identity.sessionId)
    )
      return;
    report(`${completed} 会话续期未确认，请核对会话状态；已完成的操作不受影响。`);
  }
}

async function logout(pause: boolean): Promise<void> {
  closeDialog(false);
  // 组合动作逐项执行：暂停要用当前会话，必须在退出、失去凭证之前完成（前端 §10.2；D3 §2.9）。
  let pauseResult = "\n本浏览器通知：未请求暂停。";
  if (pause) {
    message("正在暂停本浏览器通知…");
    pauseResult = `\n本浏览器通知：${await pauseThisBrowserBeforeLogout()}`;
  }
  invalidate();
  proofId = undefined;
  const turn = epoch;
  message(`正在退出当前账号。${pauseResult}`);
  let result: string;
  try {
    const reply = await request("auth/logout", {});
    if (reply.status !== 200 || reply.body.logged_out !== true) throw new Error("unknown_result");
    if (turn !== epoch) return;
    result = "当前账号：退出已确认。";
  } catch (error) {
    if (turn !== epoch) return;
    result = `当前账号：${isApiErrorBody(error) ? "退出未执行" : "退出结果未知"}。${explanation(error)}`;
    try {
      await readSessions();
      result += " 当前登录会话仍有效。";
    } catch (checkError) {
      if (noSession(checkError)) result = "当前账号：核对确认当前会话已失效。";
    }
    if (turn !== epoch) return;
    if (!(await refresh())) return; // Rejected writes require fresh /me facts.
  }
  message(`${result}${pauseResult}\n邮件和外部日历：未请求关闭。`);
  el("account-result").focus();
}

async function revoke(row: Session): Promise<void> {
  const identity = actionIdentity();
  if (row.is_current) {
    invalidate();
    proofId = undefined;
  }
  const turn = epoch;
  message("正在撤销会话；不会自动撤销其 Push 绑定。");
  let result = "会话撤销已确认；未撤销其 Push 绑定。";
  let confirmed = false;
  try {
    await revokeSession(row.id);
    confirmed = true;
  } catch (error) {
    if (turn !== epoch) return;
    result = `撤销${isApiErrorBody(error) ? "未执行" : "结果未知"}。${explanation(error)}`;
    try {
      const list = await readSessions();
      if (!list.some((item) => item.id === row.id))
        result = "核对确认目标会话已不在有效列表；未撤销其 Push 绑定。";
    } catch (checkError) {
      if (row.is_current && noSession(checkError))
        result = "核对确认当前会话已失效；未撤销其 Push 绑定。";
    }
  }
  if (turn !== epoch) return;
  if (confirmed && !row.is_current) await renewAfterAction(identity, result);
  if (turn !== epoch) return;
  if (!(await refresh())) return;
  message(result);
}

async function proveDeletion(): Promise<void> {
  const identity = actionIdentity();
  proofFeedback = "正在验证本次删除用途。";
  el("delete-proof-status").textContent = proofFeedback;
  const body = {
    action: "account_delete",
    recovery_id: input("delete-recovery-id").value,
    secret: input("delete-recovery-secret").value,
  };
  input("delete-recovery-id").value = "";
  input("delete-recovery-secret").value = "";
  let result = "删除用途验证已完成，请核对后明确确认删除。";
  try {
    const reply = await request("me/recent-auth/recovery", body);
    if (!sameActionIdentity(identity)) return;
    if (reply.status !== 200 || typeof reply.body.proof_id !== "string" || !reply.body.proof_id)
      throw new Error("unknown_proof");
    proofId = reply.body.proof_id;
  } catch (error) {
    if (!sameActionIdentity(identity)) return;
    if (clearRejectedIdentity(error)) return;
    proofId = undefined;
    result = `删除用途验证未确认。${explanation(error)}`;
  }
  if (!(await refresh())) return;
  if (
    summary?.user_id !== identity.userId ||
    rows.find((row) => row.is_current)?.id !== identity.sessionId
  )
    return;
  proofFeedback = result;
  el("delete-proof-status").textContent = result;
  message(result);
}

async function deleteAccount(): Promise<void> {
  const body = { confirm: true, ...(proofId ? { proof_id: proofId } : {}) };
  closeDialog(false);
  invalidate();
  proofId = undefined;
  const turn = epoch;
  el("account-deletion").textContent = "正在提交删除。尚未确认权限停止或数据清理完成。";
  try {
    const reply = await request("me/delete", body);
    if (turn !== epoch) return;
    if (reply.status !== 200 || reply.body.state !== "deleting")
      throw new Error("unknown_deletion");
    el("account-deletion").textContent = "权限与发送已停止。数据仍在清理；尚无清理完成的证据。";
  } catch (error) {
    if (turn !== epoch) return;
    deletionUncertain = !isApiErrorBody(error);
    const result = deletionUncertain
      ? "删除结果未知。重新读取账号状态核对，不自动重复删除。即使会话已失效，也不能据此确认数据清理完成。"
      : `删除未执行。${explanation(error)}`;
    if (!(await refresh())) return;
    el("account-deletion").textContent = result;
  }
  message(el("account-deletion").textContent ?? "");
}

async function exportData(): Promise<void> {
  const turn = epoch;
  const identity = actionIdentity();
  const completed = "已生成订阅偏好下载；不含恢复码或通道授权。";
  try {
    const reply = await request("me/export");
    if (!sameActionIdentity(identity)) return;
    if (
      reply.status !== 200 ||
      reply.body.format !== "hoyo-preferences" ||
      !object(reply.body.subscription)
    )
      throw new Error("unknown_export");
    // This dedicated endpoint excludes identity, credentials and channel consents.
    const blob = new Blob(
      [
        JSON.stringify(
          { format: reply.body.format, subscription: reply.body.subscription },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "hoyo-preferences.json";
    link.click();
    URL.revokeObjectURL(url);
    message(completed);
  } catch (error) {
    if (turn !== epoch) return;
    if (!(await refresh())) return;
    message(`导出未确认。${explanation(error)}`);
    return;
  }
  await renewAfterAction(identity, completed);
}

// Proofs and challenge keys stay only in this page's memory, bound to one target and identity.
type ProofSlot = {
  action: RecentAuthAction;
  role: RecentAuthRole;
  widget: Turnstile;
  challenge?: string;
  key?: string;
  proof?: string;
};
const proofSlots: Record<string, ProofSlot> = {};
let emailTarget = "";
let maintenanceGeneration = 0;

function clearMaintenance(): void {
  maintenanceGeneration += 1;
  emailTarget = "";
  for (const [id, slot] of Object.entries(proofSlots)) {
    slot.challenge = undefined;
    slot.key = undefined;
    slot.proof = undefined;
    slot.widget.reset();
    input(`${id}-code`).value = "";
    el(`${id}-status`).textContent = "尚未验证。";
  }
  for (const id of [
    "email-target",
    "email-recovery-id",
    "email-recovery-secret",
    "delete-recovery-id",
    "delete-recovery-secret",
  ])
    input(id).value = "";
  input("email-target").readOnly = false;
  el("email-proofs").hidden = true;
  el("email-change-result").textContent = "";
  el("email-activate").hidden = true;
  forgetRecoveryCode();
}
function canProveEmail(): boolean {
  if (!summary) return false;
  const action = deriveAccountActions(summary, now()).email_change;
  return action.allowed || action.reason === "recent_auth_required";
}
function renderMaintenance(ready: boolean): void {
  const emailReady = ready && canProveEmail();
  button("email-start").disabled = busy || !emailReady || emailTarget !== "";
  button("email-recovery-prove").disabled = busy || !emailReady || !emailTarget;
  button("email-confirm").disabled =
    busy ||
    !emailReady ||
    !emailTarget ||
    !proofSlots["email-current"]?.proof ||
    !proofSlots["email-new"]?.proof ||
    !summary ||
    !deriveAccountActions(summary, now()).email_change.allowed;
  el("delete-otp").hidden = summary?.session.recovery_code_required === true;
  for (const [id, slot] of Object.entries(proofSlots)) {
    const allowed =
      slot.action === "email_change"
        ? emailReady && !!emailTarget
        : ready && summary?.session.recovery_code_required !== true;
    button(`${id}-send`).disabled = busy || !allowed || !!slot.proof;
    button(`${id}-verify`).disabled = busy || !allowed || !slot.challenge || !!slot.proof;
  }
}
function proofIdentity() {
  const identity = actionIdentity();
  const generation = maintenanceGeneration;
  return () => generation === maintenanceGeneration && sameActionIdentity(identity);
}
async function sendProof(id: string): Promise<void> {
  const slot = proofSlots[id];
  const valid = proofIdentity();
  const token = slot.widget.take();
  if (!token) {
    el(`${id}-status`).textContent = "请先完成人机验证，再申请验证码。";
    return;
  }
  slot.challenge = undefined;
  input(`${id}-code`).value = "";
  slot.key ??= crypto.randomUUID();
  el(`${id}-status`).textContent = "正在申请验证码；尚未确认发送。";
  try {
    const reply = await request("me/recent-auth/challenges", {
      action: slot.action,
      role: slot.role,
      ...(slot.action === "email_change" ? { target_email: emailTarget } : {}),
      idempotency_key: slot.key,
      turnstile_token: token,
    });
    if (!valid()) return;
    if (
      reply.status !== 202 ||
      typeof reply.body.challenge_id !== "string" ||
      !reply.body.challenge_id
    )
      throw new Error("unknown_challenge");
    slot.challenge = reply.body.challenge_id;
    slot.key = undefined;
    el(`${id}-status`).textContent = "验证码申请已受理，不代表已送达；请查看对应邮箱。";
  } catch (error) {
    if (!valid()) return;
    if (clearRejectedIdentity(error)) return;
    // For an unknown request keep the same key; an explicit later click can reconcile it.
    if (isApiErrorBody(error)) slot.key = undefined;
    el(`${id}-status`).textContent =
      `验证码申请${isApiErrorBody(error) ? "未执行" : "结果未知，可重新完成人机验证后核对原申请"}。${explanation(error)}`;
  } finally {
    if (valid()) slot.widget.reset();
  }
}
async function verifyProof(id: string): Promise<void> {
  const slot = proofSlots[id];
  if (!slot.challenge) return;
  const valid = proofIdentity();
  const generation = maintenanceGeneration;
  const code = input(`${id}-code`).value;
  input(`${id}-code`).value = "";
  try {
    const reply = await request("me/recent-auth/challenges/verify", {
      challenge_id: slot.challenge,
      code,
    });
    if (!valid()) return;
    if (reply.status !== 200 || typeof reply.body.proof_id !== "string" || !reply.body.proof_id)
      throw new Error("unknown_proof");
    slot.proof = reply.body.proof_id;
    slot.challenge = undefined;
    if (slot.action === "account_delete") proofId = slot.proof;
    if (!(await refresh()) || generation !== maintenanceGeneration) return;
    el(`${id}-status`).textContent = "本次用途验证已完成。";
    // 恢复码的邮箱验证通过后直接继续用户原本要做的创建或更换。
    if (id === "recovery-current") await continueRecovery();
  } catch (error) {
    if (!valid()) return;
    if (clearRejectedIdentity(error)) return;
    slot.proof = undefined;
    // Verification cannot be replayed after an unknown response.
    if (!isApiErrorBody(error)) slot.challenge = undefined;
    el(`${id}-status`).textContent = `验证未确认；不会自动重复消费。${explanation(error)}`;
  }
}
async function proveEmailRecovery(): Promise<void> {
  const valid = proofIdentity();
  const generation = maintenanceGeneration;
  const body = {
    action: "email_change",
    target_email: emailTarget,
    recovery_id: input("email-recovery-id").value,
    secret: input("email-recovery-secret").value,
  };
  input("email-recovery-id").value = "";
  input("email-recovery-secret").value = "";
  try {
    const reply = await request("me/recent-auth/recovery", body);
    if (!valid()) return;
    if (reply.status !== 200 || typeof reply.body.proof_id !== "string" || !reply.body.proof_id)
      throw new Error("unknown_proof");
    proofSlots["email-current"].proof = reply.body.proof_id;
    if (!(await refresh()) || generation !== maintenanceGeneration) return;
    el("email-current-status").textContent = "当前账号的换邮箱用途证明已取得；仍需验证新邮箱。";
  } catch (error) {
    if (!valid()) return;
    if (clearRejectedIdentity(error)) return;
    proofSlots["email-current"].proof = undefined;
    el("email-current-status").textContent = `当前账号证明未确认。${explanation(error)}`;
  }
}
async function changeEmail(): Promise<void> {
  const oldVersion = summary?.email.email_version;
  const body = {
    target_email: emailTarget,
    current_proof_id: proofSlots["email-current"].proof,
    new_proof_id: proofSlots["email-new"].proof,
  };
  invalidate(); // Clear this page and other tabs before the identity-changing write.
  proofId = undefined;
  const turn = epoch;
  el("email-change-result").textContent = "正在提交换邮箱；结果尚未确认。";
  try {
    const reply = await request("me/email-change", body);
    if (turn !== epoch) return;
    if (
      reply.status !== 200 ||
      typeof reply.body.pending_session_id !== "string" ||
      !reply.body.pending_session_id ||
      !Number.isSafeInteger(reply.body.email_version) ||
      oldVersion === undefined ||
      (reply.body.email_version as number) <= oldVersion
    )
      throw new Error("unknown_email_change");
    // The new session is pending: the user confirms it on /login without another code.
    // Its window is the shorter of the completion receipt and the pending session lifetime.
    el("email-change-result").textContent =
      `邮箱已更换。其他设备和旧会话都已退出；这个浏览器有一个待确认的新会话，请在约 ${Math.min(AUTH_COMPLETION_TTL, SESSION_PENDING_TTL) / 60} 分钟内点「继续激活新会话」到登录页确认，不需要再收验证码。订阅设置保留在原账号；新邮箱的邮件通知需要重新开启。`;
    el("email-activate").hidden = false;
  } catch (error) {
    if (turn !== epoch) return;
    const result = isApiErrorBody(error)
      ? `换邮箱未执行。${explanation(error)} 请重新读取账号并重新验证。`
      : "换邮箱结果未知；不会自动重试或复用证明。已重新读取账号核对，会话失效或待激活不单独证明换邮箱成功；请登录核对当前邮箱。";
    if (!(await refresh())) return;
    el("email-change-result").textContent = result;
  }
  message(el("email-change-result").textContent ?? "");
}
for (const [id, action, role] of [
  ["email-current", "email_change", "current"],
  ["email-new", "email_change", "new_address"],
  ["delete-current", "account_delete", "current"],
  ["recovery-current", "recovery_code_rotate", "current"],
] as const) {
  proofSlots[id] = { action, role, widget: new Turnstile(el(`${id}-turnstile-status`)) };
  button(`${id}-send`).addEventListener("click", () => void run(() => sendProof(id)));
  el(`${id}-form`).addEventListener("submit", (event) => {
    event.preventDefault();
    if (!button(`${id}-verify`).disabled) void run(() => verifyProof(id));
  });
}
// ---- 恢复码（ADR-0026）：可选，在账号设置里首次创建或更换 ----
// 交付的明文只留在本页内存，不进存储、URL 或日志；身份变化、离开页面即清除。
// 登录超过最近认证时限后，创建与更换都要先用当前邮箱验证码取得本次用途证明。
let delivered: DeliveredCode | null = null;
let recoveryIntent: "create" | "rotate" | null = null;
let rotationKey = "";
const recoveryOutput = () => el("recovery-output") as HTMLTextAreaElement;

function recoveryMessage(text: string): void {
  el("recovery-result").textContent = text;
  announce(text);
}
function forgetRecoveryCode(): void {
  delivered = null;
  recoveryIntent = null;
  rotationKey = "";
  recoveryOutput().value = "";
  input("recovery-saved-check").checked = false;
  el("recovery-result").textContent = "";
}
function renderRecovery(ready: boolean): void {
  const restricted = summary?.session.recovery_code_required === true;
  const saved = summary?.recovery_code_saved === true;
  const idle = summary !== null && !restricted && delivered === null && recoveryIntent === null;
  el("recovery-create").hidden = !idle || saved;
  el("recovery-rotate").hidden = !idle || !saved;
  button("recovery-create").disabled = busy || !ready;
  button("recovery-rotate").disabled = busy || !ready;
  // 恢复登录后的受限会话仍在恢复页保存新码（§7.4 准入条件不变）。
  el("recovery-restricted-link").hidden = !restricted;
  el("recovery-verify").hidden = recoveryIntent === null || delivered !== null || restricted;
  button("recovery-verify-cancel").disabled = busy;
  el("recovery-delivered").hidden = delivered === null;
  button("recovery-copy").disabled = busy || delivered === null;
  button("recovery-download").disabled = busy || delivered === null;
  button("recovery-confirm").disabled =
    busy || !ready || delivered === null || !input("recovery-saved-check").checked;
}
function recentAuthRequired(error: unknown): boolean {
  return (
    isApiErrorBody(error) &&
    error.error.details?.code === "unauthorized" &&
    error.error.details.reason === "recent_auth_required"
  );
}
function resetRecoveryProof(): void {
  const slot = proofSlots["recovery-current"];
  slot.proof = undefined;
  slot.challenge = undefined;
  slot.key = undefined;
  input("recovery-current-code").value = "";
  el("recovery-current-status").textContent = "尚未验证。";
}
function askRecoveryVerification(intent: "create" | "rotate", text: string): void {
  resetRecoveryProof();
  recoveryIntent = intent;
  el("recovery-verify-hint").textContent = text;
  loadProofWidgets();
  recoveryMessage(text);
}
function showDeliveredCode(value: Record<string, unknown>): void {
  delivered = deliveredCode(value);
  recoveryIntent = null;
  // 证明已随本次交付消费，不再复用。
  resetRecoveryProof();
  recoveryOutput().value = `${delivered.recovery_id}\n${delivered.secret}`;
  input("recovery-saved-check").checked = false;
  recoveryMessage("恢复码已生成。请复制或下载保存，然后勾选并点「确认已保存」。");
}
async function createRecoveryCode(): Promise<void> {
  const identity = actionIdentity();
  const proof = proofSlots["recovery-current"].proof;
  recoveryMessage("正在创建恢复码…");
  try {
    const reply = await request("auth/recovery/code", {
      action: "generate",
      ...(proof ? { proof_id: proof } : {}),
    });
    if (!sameActionIdentity(identity)) return;
    if (reply.status !== 200) throw new Error("unknown_generation");
    showDeliveredCode(reply.body);
  } catch (error) {
    if (!sameActionIdentity(identity)) return;
    if (clearRejectedIdentity(error)) return;
    if (recentAuthRequired(error)) {
      askRecoveryVerification(
        "create",
        `登录超过 ${RECENT_AUTH_TTL / 60} 分钟后，创建恢复码前需要先验证当前邮箱。验证通过后会自动继续创建。`,
      );
      return;
    }
    if (isApiErrorBody(error) && error.error.code === "conflict") {
      if (!(await refresh())) return;
      recoveryMessage("账号已经有已保存的恢复码。需要新码请用「更换恢复码」。");
      return;
    }
    recoveryMessage(
      `恢复码${isApiErrorBody(error) ? "未创建" : "创建结果未知；可以重新创建，未确认的码会作废"}。${explanation(error)}`,
    );
  }
}
async function rotateRecoveryCode(): Promise<void> {
  const proof = proofSlots["recovery-current"].proof;
  if (!proof) {
    askRecoveryVerification(
      "rotate",
      "更换恢复码前需要先验证当前邮箱。新码确认保存之前，旧码仍然有效。",
    );
    return;
  }
  const identity = actionIdentity();
  rotationKey ||= crypto.randomUUID();
  recoveryMessage("正在生成新的恢复码…");
  try {
    const reply = await request("me/recovery-code", {
      action: "start",
      proof_id: proof,
      operation_key: rotationKey,
    });
    if (!sameActionIdentity(identity)) return;
    if (reply.status !== 200 || typeof reply.body.rotation_id !== "string")
      throw new Error("unknown_rotation");
    showDeliveredCode(reply.body);
  } catch (error) {
    if (!sameActionIdentity(identity)) return;
    if (clearRejectedIdentity(error)) return;
    if (recentAuthRequired(error)) {
      rotationKey = "";
      askRecoveryVerification(
        "rotate",
        "邮箱验证已过期或已用过，请重新验证当前邮箱后再更换。旧码仍然有效。",
      );
      return;
    }
    // 结果未知时保留同一操作键与证明：再点一次「更换恢复码」会核对并重新交付同一次轮换的新码。
    if (isApiErrorBody(error)) rotationKey = "";
    recoveryIntent = null;
    recoveryMessage(
      `新恢复码${isApiErrorBody(error) ? "未生成" : "生成结果未知，可以再点一次「更换恢复码」核对"}。旧码仍然有效。${explanation(error)}`,
    );
  }
}
async function continueRecovery(): Promise<void> {
  if (recoveryIntent === "create") await createRecoveryCode();
  else if (recoveryIntent === "rotate") await rotateRecoveryCode();
}
async function confirmRecoveryCode(): Promise<void> {
  const code = delivered;
  if (!code || !input("recovery-saved-check").checked) return;
  let identity = actionIdentity();
  const generationBefore = summary?.recovery_code_generation ?? null;
  recoveryMessage("正在确认恢复码保存…");
  try {
    const reply = await request(
      code.rotation_id ? "me/recovery-code" : "auth/recovery/code",
      code.rotation_id
        ? { action: "confirm", rotation_id: code.rotation_id, secret: code.secret }
        : { action: "confirm", recovery_id: code.recovery_id, secret: code.secret },
    );
    if (!sameActionIdentity(identity)) return;
    if (reply.status !== 200 || reply.body.saved_confirmed !== true)
      throw new Error("unknown_confirmation");
  } catch (error) {
    if (!sameActionIdentity(identity)) return;
    if (clearRejectedIdentity(error)) return;
    // 响应丢失时读取摘要核对：已保存且（轮换时）代次已变才算完成，不重复生成。
    if (!(await refresh())) return;
    const confirmed =
      summary?.recovery_code_saved === true &&
      (!code.rotation_id || summary.recovery_code_generation !== generationBefore);
    if (!confirmed) {
      recoveryMessage(`保存确认未完成，这份码仍在上方，可以再点一次确认。${explanation(error)}`);
      return;
    }
    identity = actionIdentity();
  }
  forgetRecoveryCode();
  const completed = "恢复码已确认保存。邮箱无法使用时，可以在登录页用它找回账号。";
  // 轮换是显式账号管理（主方案 §4.5），先续期一次再刷新事实；首次创建沿用恢复页的做法不续期。
  if (code.rotation_id) await renewAfterAction(identity, completed, recoveryMessage);
  if (!(await refresh())) return;
  if (!code.rotation_id) recoveryMessage(completed);
}
button("recovery-create").addEventListener("click", () => void run(createRecoveryCode));
button("recovery-rotate").addEventListener("click", () => void run(rotateRecoveryCode));
button("recovery-confirm").addEventListener("click", () => {
  if (!button("recovery-confirm").disabled) void run(confirmRecoveryCode);
});
button("recovery-verify-cancel").addEventListener("click", () => {
  resetRecoveryProof();
  recoveryIntent = null;
  rotationKey = "";
  recoveryMessage("已取消，没有生成新的恢复码。");
  renderActions();
});
input("recovery-saved-check").addEventListener("change", () => renderActions());
button("recovery-copy").addEventListener("click", async () => {
  if (!delivered || busy) return;
  const identity = actionIdentity();
  try {
    await navigator.clipboard.writeText(recoveryOutput().value);
    if (!sameActionIdentity(identity)) return;
    recoveryMessage("恢复码已复制。请粘贴到安全的地方保存，然后勾选确认。");
  } catch {
    if (!sameActionIdentity(identity)) return;
    recoveryMessage("复制失败，请手动选择恢复码复制，或下载保存。");
  }
});
button("recovery-download").addEventListener("click", () => {
  if (!delivered || busy) return;
  const url = URL.createObjectURL(
    new Blob([recoveryOutput().value], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "hoyo-recovery-code.txt";
  link.click();
  URL.revokeObjectURL(url);
  recoveryMessage("已请求下载恢复码，请确认文件已保存后勾选确认。");
});
let widgetsLoaded = false;
function loadProofWidgets(): void {
  if (widgetsLoaded) return;
  widgetsLoaded = true;
  for (const [id, slot] of Object.entries(proofSlots))
    void slot.widget.load(
      el("account-page").dataset.sitekey ?? "",
      el(`${id}-turnstile`),
      recentAuthTurnstileAction(slot.action, slot.role),
    );
}
el("email-maintenance").addEventListener("toggle", () => {
  if ((el("email-maintenance") as HTMLDetailsElement).open) loadProofWidgets();
});
button("account-delete-open").addEventListener("click", loadProofWidgets);
el("email-target-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (button("email-start").disabled) return;
  const address = canonicalizeEmail(input("email-target").value);
  if (!address.ok) {
    el("email-change-result").textContent = "请输入有效的 ASCII 邮箱地址。";
    return;
  }
  emailTarget = input("email-target").value;
  input("email-target").readOnly = true;
  el("email-proofs").hidden = false;
  el("email-change-result").textContent = "新地址已选定，请完成两份证明。";
  renderActions();
});
button("email-cancel").addEventListener("click", () => {
  // Cancellation also fences a late proof response without interrupting other account work.
  clearMaintenance();
  el("email-change-result").textContent = "已清除本次验证；未提交换邮箱。";
  renderActions();
});
el("email-recovery-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!button("email-recovery-prove").disabled) void run(proveEmailRecovery);
});
button("email-confirm").addEventListener("click", () => {
  if (!button("email-confirm").disabled) void run(changeEmail);
});

button("account-refresh").addEventListener(
  "click",
  () =>
    void run(async () => {
      message("正在刷新账号状态…");
      await refresh();
      if (summary) message("已刷新账号状态。");
    }),
);
button("logout-only").addEventListener("click", () => void run(() => logout(false)));
button("logout-pause").addEventListener("click", () => void run(() => logout(true)));
button("account-export").addEventListener("click", () => void run(exportData));
button("delete-confirm").addEventListener("click", () => {
  // Capture eligibility before run() disables every write control.
  if (!button("delete-confirm").disabled) void run(deleteAccount);
});
el("delete-proof-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(proveDeletion);
});

function externalIdentityChanged(): void {
  epoch += 1;
  proofId = undefined;
  proofFeedback = "";
  el("account-deletion").textContent = "";
  clearMaintenance();
  clearPrivate();
  closeDialog(false);
  renderActions();
  message("身份已变化，请重新读取账号状态。旧请求结果已丢弃。");
}
function connect(): void {
  if (typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel("hoyo-draft-identity");
  channel.onmessage = externalIdentityChanged;
}
document.addEventListener("hoyo:draft-identity", (event) => {
  const identity = readDraftIdentityEvent(event);
  if (
    !publishingIdentity &&
    identity &&
    (identity.status !== "confirmed" || identity.userId !== summary?.user_id)
  )
    externalIdentityChanged();
});
window.addEventListener("pagehide", () => {
  epoch += 1;
  proofId = undefined;
  proofFeedback = "";
  el("account-deletion").textContent = "";
  clearMaintenance();
  clearPrivate();
  input("delete-recovery-id").value = "";
  input("delete-recovery-secret").value = "";
  channel?.close();
  channel = null;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    connect();
    void run(async () => {
      await refresh();
    });
  }
});
connect();
// Render time-dependent hints only. No passive session renewal or network polling.
window.setInterval(renderActions, 1_000);
void run(async () => {
  await refresh();
  if (summary) message("");
});
