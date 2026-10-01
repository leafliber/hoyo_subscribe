import {
  type AccountSummary,
  AccountSummarySchema,
  deriveAccountActions,
  isApiErrorBody,
  isSessionExpiryNotice,
  SESSION_RENEW_INTERVAL,
} from "@hoyo/contracts";
import { closeDialog } from "../../../components/dialog";
import { announce } from "../../../components/status";
import { feedbackForFailure } from "../../../lib/errors/feedback";
import { publishDraftIdentity } from "../../../lib/storage/identity";
import { csrfToken, object, request, type Session, sessions } from "../api";
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
const now = () => clockAnchor.server + (performance.now() - clockAnchor.local);

function message(text: string): void {
  el("account-result").textContent = text;
  announce(text);
}
function explanation(error: unknown): string {
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
function clearPrivate(): void {
  summary = null;
  rows = [];
  sessionReady = false;
  for (const field of ["email", "expiry", "subscription", "mail", "lease", "reclaim"]) {
    el(`account-${field}`).textContent = "未知";
  }
  el("account-sessions").replaceChildren();
  el("account-recovery").textContent = "恢复码保存状态未知。";
  el("account-lag").textContent = "设备列表尚未确认，请重新读取。";
}
function invalidate(): void {
  // Must precede logout, current-session revocation and deletion requests.
  publishDraftIdentity({ status: "unknown" });
  channel?.postMessage("invalidate");
  epoch += 1;
  clearPrivate();
}
function renderActions(): void {
  const actions = summary ? deriveAccountActions(summary, now()) : null;
  const ready = summary !== null && sessionReady;
  button("account-refresh").disabled = busy;
  button("account-logout").disabled = busy || !ready;
  button("logout-only").disabled = busy || !ready;
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
  for (const item of el("account-sessions").querySelectorAll<HTMLButtonElement>("button")) {
    item.disabled = busy || !ready;
  }
  if (summary) {
    const expiry = Math.min(summary.session.expires_at, summary.session.absolute_expires_at);
    el("account-expiry").textContent = `有效期至 ${stamp(expiry)}。${
      isSessionExpiryNotice(expiry, now()) ? "会话临近到期或已到期，请重新验证邮箱登录。" : ""
    }`;
  }
}
function renderSummary(facts: AccountSummary): void {
  el("account-email").textContent =
    `${facts.email.masked}（已验证，地址版本 ${facts.email.email_version}）`;
  el("account-subscription").textContent =
    facts.subscription.state === "initialized" ? "已保存云端订阅内容" : "尚未保存云端订阅内容";
  el("account-mail").textContent =
    facts.channels.email.state === "unknown"
      ? "未知"
      : facts.channels.email.state === "enabled"
        ? "席位已启用；不代表邮件已送达"
        : "已关闭";
  el("account-reclaim").textContent =
    facts.reclaim_grace_until === null
      ? "服务端未给出回收宽限期限；不据网页登录频率判断账号活动。"
      : `服务端记录的回收宽限期限：${stamp(facts.reclaim_grace_until)}。请及时核对账号使用状态。`;
  el("account-recovery").textContent = facts.session.recovery_code_required
    ? "恢复登录后尚未确认新码：可查看、导出、保存新码和删除账号；启用通道与换邮箱受限。"
    : facts.recovery_code_saved
      ? "当前恢复码已确认保存。"
      : "当前恢复码尚未确认保存；启用长期通道前需先保存。";
}
function renderSessions(): void {
  el("account-sessions").replaceChildren();
  el("account-lag").textContent =
    `最近续期时间最多滞后一个续期间隔（${SESSION_RENEW_INTERVAL / (24 * 60 * 60)} 天），不代表最后一次使用或账号不活跃。`;
  for (const row of rows) {
    const li = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = `${row.label}${row.is_current ? " · 当前会话" : ""}`;
    const state = document.createElement("p");
    state.textContent = `${row.state === "active" ? "已激活" : "待激活"} · 创建于 ${stamp(row.created_at)} · 最近续期 ${stamp(row.renewed_at)}`;
    const revokeButton = document.createElement("button");
    revokeButton.type = "button";
    revokeButton.className = "button button--secondary";
    revokeButton.textContent = row.is_current ? "撤销当前会话" : `撤销 ${row.label}`;
    revokeButton.addEventListener("click", () => void run(() => revoke(row)));
    // Keep the identifier in the closure, not in a URL, storage or telemetry.
    li.append(title, state, revokeButton);
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
    if (previousUser !== undefined && previousUser !== parsed.user_id) proofId = undefined;
    summary = parsed;
    clockAnchor = { server: parsed.server_time, local: performance.now() };
    deletionUncertain = false;
    renderSummary(parsed);
    try {
      const list = await readSessions(); // Issues current session CSRF, without renewal.
      if (turn !== epoch) return false;
      rows = list;
      if (
        previousSession !== undefined &&
        previousSession !== rows.find((row) => row.is_current)?.id
      )
        proofId = undefined;
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
        el("account-lease").textContent =
          lease.expires_at === null
            ? "服务端未记录租期"
            : `到期时间 ${stamp(lease.expires_at as number)}；后台续租状态${lease.background_processing === "unknown" ? "未知" : "尚待核对"}。`;
      }
    } catch {
      /* Secondary facts remain unknown; never infer success. */
    }
  } catch (error) {
    if (turn !== epoch) return false;
    clearPrivate();
    proofId = undefined;
    message(`账号状态尚未确认。${explanation(error)}`);
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
): Promise<void> {
  // Only a confirmed explicit operation reaches here. Never renew another identity
  // when its cookie changes before a cross-tab invalidation message is delivered.
  if (!sameActionIdentity(identity)) return;
  message(completed);
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
    message(`${completed} 会话续期未确认，请核对会话状态；已完成的操作不受影响。`);
  }
}

async function logout(pause: boolean): Promise<void> {
  closeDialog(false);
  invalidate();
  proofId = undefined;
  const turn = epoch;
  const pauseResult = pause
    ? "\n本浏览器通知：暂停未执行（能力尚未接入），不能确认已暂停。"
    : "\n本浏览器通知：未请求暂停。";
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
  const turn = epoch;
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
    if (turn !== epoch) return;
    if (reply.status !== 200 || typeof reply.body.proof_id !== "string" || !reply.body.proof_id)
      throw new Error("unknown_proof");
    proofId = reply.body.proof_id;
  } catch (error) {
    if (turn !== epoch) return;
    proofId = undefined;
    result = `删除用途验证未确认。${explanation(error)}`;
  }
  if (!(await refresh())) return;
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

button("account-refresh").addEventListener(
  "click",
  () =>
    void run(async () => {
      message("正在重新读取账号状态。");
      await refresh();
      if (summary) message("已重新读取账号事实；通道未知项仍待确认。");
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

function connect(): void {
  if (typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel("hoyo-draft-identity");
  channel.onmessage = () => {
    epoch += 1;
    proofId = undefined;
    proofFeedback = "";
    el("account-deletion").textContent = "";
    clearPrivate();
    closeDialog(false);
    input("delete-recovery-id").value = "";
    input("delete-recovery-secret").value = "";
    renderActions();
    message("身份已变化，请重新读取账号状态。旧请求结果已丢弃。");
  };
}
window.addEventListener("pagehide", () => {
  epoch += 1;
  proofId = undefined;
  proofFeedback = "";
  el("account-deletion").textContent = "";
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
el("account-push-permission").textContent =
  typeof Notification === "undefined"
    ? "此浏览器不支持通知"
    : ({ default: "尚未授权", denied: "已拒绝", granted: "允许（不代表已绑定）" } as const)[
        Notification.permission
      ];
connect();
// Render time-dependent hints only. No passive session renewal or network polling.
window.setInterval(renderActions, 1_000);
void run(async () => {
  await refresh();
  if (summary) message("已读取账号事实；通道未知项仍待确认。");
});
