import { env } from "cloudflare:test";
import {
  EMAIL_CONSENT_VERSION,
  emailChannelEnableAvailability,
  emailSeatLeaseExpiresAt,
  GLOBAL_MUTATIONS_DAY,
  MAIL_ROUTINE_SEATS_MAX,
  MAIL_SEATS_MAX,
  MAIL_USER_BASE_DAY,
  MAIL_USER_URGENT_DAY,
  mutationCounterKeys,
  SECRET_BITS,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeEmail, markAccountDeleting } from "../../accounts/lifecycle/service";
import { saveSubscription } from "../../accounts/subscription/service";
import { mintPreauthCookieValue } from "../../auth/preauth/cookie";
import { proveWithRecoveryCode } from "../../auth/recent-auth/proof";
import { targetForAction } from "../../auth/recent-auth/target";
import { runRecoveryAction } from "../../auth/recovery/action";
import { sessionAuthenticator } from "../../auth/sessions/authenticator";
import { mutateCalendar } from "../../calendar/manage/service";
import worker from "../../index";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, mintCsrfToken } from "../../shell";
import { USER_SESSION_COOKIE_NAME } from "../../shell/domains";
import { fakeExecutionContext, randomBytes, testKeyring } from "../../shell/test-support";
import { encryptField } from "../../storage/crypto/aead";
import { toHex } from "../../storage/crypto/bytes";
import { Keyring } from "../../storage/crypto/keyring";
import { AUDIENCE_SELECT, type AudienceRow } from "../occurrences/eligibility";
import { suppressionAddressKey } from "../suppression";
import { emailLifecycleHook, emailSafetyPauseHook } from "./hooks";
import { renewEmailSeat } from "./lease";
import { makeEmailChannelRoutes } from "./routes";
import { type EmailChannelUpdate, updateEmailChannel } from "./service";
import { channelRow } from "./state";
import { first, migrate, now, run, seed, selectedConfig } from "./test-support";
import { readEmailChannel } from "./view";

type Fixture = Awaited<ReturnType<typeof seed>>;
const deps = async () => ({
  db: env.DB,
  keys: await testKeyring,
  sendingAvailable: async () => true,
});
async function ready() {
  const f = await seed();
  await saveSubscription(env.DB, f.userId, 0, selectedConfig, now);
  return f;
}
async function input(f: Fixture, extra: EmailChannelUpdate = {}): Promise<EmailChannelUpdate> {
  const view = await readEmailChannel(await deps(), f.session, now);
  return {
    enabled: true,
    expected_revision: view.channel_revision,
    email_version: view.email.email_version,
    subscription_revision: view.subscription.revision,
    seat_consent_version: EMAIL_CONSENT_VERSION,
    routine_consent_version: EMAIL_CONSENT_VERSION,
    ...extra,
  };
}
async function enable(f: Fixture, extra: EmailChannelUpdate = {}, at = now) {
  return updateEmailChannel(await deps(), f.session, await input(f, extra), at);
}
async function audit(f: Fixture) {
  return (
    await env.DB.prepare(
      "SELECT layer,action,consent_version,created_at FROM consent_events WHERE user_id=? ORDER BY rowid",
    )
      .bind(f.userId)
      .all()
  ).results;
}
let filler = 0;
async function fillSeats(count: number, routine: boolean) {
  const prefix = `synthetic-fill-${++filler}-`;
  await run(
    `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at)
    SELECT ?||i,-(?+i),'active',?||i,?||i,X'00',1,?,? FROM n`,
    count,
    prefix,
    filler * MAIL_SEATS_MAX,
    prefix,
    prefix,
    now,
    now,
  );
  await run(
    `INSERT INTO email_channels(user_id,enabled,routine_enabled,address_version,lease_expires_at,created_at,updated_at)
    SELECT id,1,?,1,?,?,? FROM users WHERE id LIKE ?`,
    Number(routine),
    emailSeatLeaseExpiresAt(now),
    now,
    now,
    `${prefix}%`,
  );
}
async function http(
  f: Fixture,
  method: "GET" | "PUT",
  body?: unknown,
  headersOverride?: Record<string, string>,
) {
  const keys = await testKeyring;
  const csrf = await mintCsrfToken(
    keys.csrf(),
    f.session.sessionTokenHash,
    randomBytes(SECRET_BITS / 8),
  );
  const api = createApiShell({
    authenticator: sessionAuthenticator(env.DB, () => now),
    csrfKey: async () => keys.csrf(),
    routes: makeEmailChannelRoutes({ keys: () => testKeyring, now: () => now }),
  });
  return api.fetch(
    new Request("https://app.test/api/v2/me/email-channel", {
      method,
      headers: {
        origin: "https://app.test",
        "content-type": "application/json",
        cookie: `${USER_SESSION_COOKIE_NAME}=${f.token}; ${CSRF_COOKIE_NAME}=${csrf}`,
        [CSRF_HEADER_NAME]: csrf,
        ...headersOverride,
      },
      ...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    fakeExecutionContext,
  );
}
async function recovery(
  f: Fixture,
  action: "emergency_stop" | "recover_login",
  beforeCommit?: () => Promise<void>,
) {
  const keys = await testKeyring;
  const minted = await mintPreauthCookieValue(keys.preauthCookie(), now);
  return runRecoveryAction(
    {
      db: env.DB,
      keys,
      sourceGate: { charge: async () => true },
      now: () => now,
      pauseHooks: [emailSafetyPauseHook],
      beforeCommit,
    },
    {
      action,
      recoveryId: f.recoveryId,
      secret: f.recoverySecret,
      request: new Request("https://app.test/api/v2/auth/recovery", {
        method: "POST",
        headers: {
          cookie: `__Host-preauth=${minted.value}`,
          "idempotency-key": crypto.randomUUID(),
          "cf-connecting-ip": "192.0.2.12",
        },
      }),
    },
  );
}
beforeAll(migrate, 180_000);
beforeEach(async () => {
  await run("UPDATE email_channels SET enabled=0,routine_enabled=0");
  await run("DELETE FROM capacity_state");
});
describe("A-P4-CONSENT 两层同意 API", () => {
  it("登录与导入偏好不构成同意；GET 只给事实、脱敏、no-store 与精确名额", async () => {
    const f = await seed();
    const before = await readEmailChannel(await deps(), f.session, now);
    expect(before.enabled).toBe(false);
    expect(before.subscription.state).toBe("uninitialized");
    await saveSubscription(env.DB, f.userId, 0, selectedConfig, now);
    const response = await http(f, "GET");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const view = await response.json<typeof before>();
    expect(view).toMatchObject({
      server_time: now,
      enabled: false,
      routine_enabled: false,
      remaining: { seat: MAIL_SEATS_MAX, routine: MAIL_ROUTINE_SEATS_MAX },
      disclosure: { daily_limits: { seat: MAIL_USER_URGENT_DAY, routine: MAIL_USER_BASE_DAY } },
    });
    expect(view.subscription.config?.notifications.rule_ids).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(f.email);
    expect(view).not.toHaveProperty("actions");
    expect(await channelRow(env.DB, f.userId)).toBeNull();
    expect(await audit(f)).toEqual([]);
  });
  it("首次启用需确认保存恢复码；推导函数与写接口同原因", async () => {
    const f = await ready();
    await run("UPDATE recovery_credentials SET saved_confirmed_at=NULL WHERE user_id=?", f.userId);
    const view = await readEmailChannel(await deps(), f.session, now);
    expect(emailChannelEnableAvailability(view, "seat")).toEqual({
      allowed: false,
      reason: "recovery_code_not_saved",
    });
    await expect(enable(f)).rejects.toMatchObject({
      code: "unauthorized",
      details: { reason: "recovery_code_not_saved" },
    });
    const rejected = await http(f, "PUT", await input(f));
    expect(await rejected.json()).toMatchObject({
      blocked_reason: "recovery_code_not_saved",
      error: { code: "unauthorized" },
    });
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect(await channelRow(env.DB, f.userId)).toBeNull();
  });
  it("两层分别明确同意；默认不开常规层，空规则也能启用席位", async () => {
    const f = await ready();
    const seat = await enable(f);
    expect(seat.state).toMatchObject({ enabled: true, routine_enabled: false });
    expect(await audit(f)).toEqual([
      { layer: "seat", action: "enable", consent_version: EMAIL_CONSENT_VERSION, created_at: now },
    ]);
    const both = await enable(f, { routine_enabled: true }, now + 1);
    expect(both.state).toMatchObject({ enabled: true, routine_enabled: true });
    expect(both.state.consent.seat.enabled_at).toBe(now);
    expect(both.state.consent.routine.enabled_at).toBe(now + 1);
    await updateEmailChannel(await deps(), f.session, { routine_enabled: false }, now + 2);
    expect((await channelRow(env.DB, f.userId))?.enabled).toBe(1);
    await enable(f, { routine_enabled: true }, now + 3);
    expect((await audit(f)).map((e) => [e.layer, e.action])).toEqual([
      ["seat", "enable"],
      ["routine", "enable"],
      ["routine", "disable"],
      ["routine", "enable"],
    ]);
  });
  it("未单独确认第二层或未保存内容时不写任何同意", async () => {
    const f = await ready();
    await expect(
      enable(f, { routine_enabled: true, routine_consent_version: undefined }),
    ).rejects.toMatchObject({ code: "validation" });
    const fresh = await seed();
    const view = await readEmailChannel(await deps(), fresh.session, now);
    expect(emailChannelEnableAvailability(view, "seat")).toEqual({
      allowed: false,
      reason: "subscription_uninitialized",
    });
    await expect(enable(fresh)).rejects.toMatchObject({
      code: "validation",
      details: { fields: [{ reason: "subscription_uninitialized" }] },
    });
    expect(await audit(f)).toEqual([]);
    expect(await audit(fresh)).toEqual([]);
  });
  it("子名额满只拒绝第二层；新席位部分完成，已有席位保持不变", async () => {
    await fillSeats(MAIL_ROUTINE_SEATS_MAX, true);
    const f = await ready();
    const result = await enable(f, { routine_enabled: true });
    expect(result).toMatchObject({
      result: "partial",
      routine_error: { code: "capacity_reached", capability: "email_routine" },
      state: {
        enabled: true,
        routine_enabled: false,
        remaining: { seat: MAIL_SEATS_MAX - MAIL_ROUTINE_SEATS_MAX - 1, routine: 0 },
      },
    });
    expect((await audit(f)).length).toBe(1);
    await expect(enable(f, { routine_enabled: true })).rejects.toMatchObject({
      code: "capacity_reached",
      details: { capability: "email_routine" },
    });
    expect((await channelRow(env.DB, f.userId))?.enabled).toBe(1);
  });
  it("最后一个席位真实并发争用只成功一次，失败者没有同意事件", async () => {
    await fillSeats(MAIL_SEATS_MAX - 1, false);
    const a = await ready(),
      b = await ready();
    const results = await Promise.allSettled([enable(a), enable(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected");
    expect(failed).toMatchObject({ reason: { code: "capacity_reached" } });
    expect((await audit(a)).length + (await audit(b)).length).toBe(1);
  });
  it("最后一个子名额真实并发争用：两个席位都开，仅一个常规层成功", async () => {
    await fillSeats(MAIL_ROUTINE_SEATS_MAX - 1, true);
    const a = await ready(),
      b = await ready();
    const results = await Promise.all([
      enable(a, { routine_enabled: true }),
      enable(b, { routine_enabled: true }),
    ]);
    expect(results.map((r) => r.result).sort()).toEqual(["completed", "partial"]);
    expect(results.every((r) => r.state.enabled)).toBe(true);
    expect(results.filter((r) => r.state.routine_enabled)).toHaveLength(1);
  });
  it("HTTP 拒绝任意收件地址/未知字段；同源、CSRF、pending 与受限恢复会话守卫", async () => {
    const f = await ready();
    for (const extra of [
      { recipient: "else@example.test" },
      { email: "else@example.test" },
      { user_id: "someone" },
    ])
      expect((await http(f, "PUT", { ...(await input(f)), ...extra })).status).toBe(400);
    expect((await http(f, "PUT", await input(f), { origin: "https://else.test" })).status).toBe(
      401,
    );
    expect((await http(f, "PUT", await input(f), { [CSRF_HEADER_NAME]: "wrong" })).status).toBe(
      401,
    );
    await run("UPDATE sessions SET state='pending' WHERE id=?", f.session.sessionId);
    expect((await http(f, "PUT", await input(f))).status).toBe(401);
    await run(
      "UPDATE sessions SET state='active',recovery_code_required=1 WHERE id=?",
      f.session.sessionId,
    );
    expect((await http(f, "PUT", await input(f))).status).toBe(401);
    expect(await audit(f)).toEqual([]);
  });
  it("确认后地址、订阅或通道版本变化拒绝旧请求，不能误同意", async () => {
    const f = await ready();
    const request = await input(f);
    await saveSubscription(
      env.DB,
      f.userId,
      1,
      {
        ...selectedConfig,
        notifications: { ...selectedConfig.notifications, important_change: false },
      },
      now + 1,
    );
    await expect(
      updateEmailChannel(await deps(), f.session, request, now + 1),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(enable(f, { email_version: 0 })).rejects.toMatchObject({ code: "conflict" });
    await enable(f);
    await expect(updateEmailChannel(await deps(), f.session, request, now)).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("精确地址抑制跨绑定仍拒绝勾选，且不自动解除抑制", async () => {
    const f = await ready();
    const addressKey = await suppressionAddressKey((await testKeyring).emailLookup(), f.email);
    await run(
      "INSERT INTO suppressions(id,address_key,email_binding_id,kind,read_only,created_at) VALUES (?,?,'old-binding','complaint',1,?)",
      crypto.randomUUID(),
      addressKey,
      now,
    );
    const view = await readEmailChannel(await deps(), f.session, now);
    expect(view.deliverability).toBe("suppressed");
    expect(emailChannelEnableAvailability(view, "seat")).toEqual({
      allowed: false,
      reason: "address_suppressed",
    });
    await expect(enable(f)).rejects.toMatchObject({
      code: "quota_paused",
      details: { scope: "address_suppressed" },
    });
    expect(
      (
        await first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM suppressions WHERE address_key=?",
          addressKey,
        )
      )?.n,
    ).toBe(1);
  });
  it("关闭两层不受普通日额度阻断，重复关闭不写库；重新开启追加事件", async () => {
    const f = await ready();
    await enable(f, { routine_enabled: true });
    const { userKey, globalKey } = mutationCounterKeys(f.userId, utcDayPeriod(now).key);
    await run("UPDATE capacity_state SET value=? WHERE key=?", USER_MUTATIONS_DAY, userKey);
    await run("UPDATE capacity_state SET value=? WHERE key=?", GLOBAL_MUTATIONS_DAY, globalKey);
    await updateEmailChannel(await deps(), f.session, { enabled: false }, now + 1);
    const before = await channelRow(env.DB, f.userId);
    await updateEmailChannel(await deps(), f.session, { enabled: false }, now + 2);
    expect(await channelRow(env.DB, f.userId)).toEqual(before);
    expect(await audit(f)).toHaveLength(4);
    await expect(enable(f)).rejects.toMatchObject({ code: "quota_paused" });
    await run("DELETE FROM capacity_state");
    const opened = await enable(f, {}, now + 3);
    expect(opened.state.consent.seat.enabled_at).toBe(now + 3);
    expect(opened.state.routine_enabled).toBe(false);
  });
  it("条件未命中不落效果；SQL 失败回滚开关、额度与审计", async () => {
    const f = await ready();
    await run(
      `CREATE TRIGGER synthetic_consent_failure BEFORE INSERT ON consent_events WHEN NEW.user_id='${f.userId}' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END`,
    );
    try {
      await expect(enable(f, { routine_enabled: true })).rejects.toThrow("synthetic_failure");
    } finally {
      await env.DB.exec("DROP TRIGGER synthetic_consent_failure");
    }
    expect(await channelRow(env.DB, f.userId)).toBeNull();
    expect(await audit(f)).toEqual([]);
  });
  it("P4-01 只读开启事件：关闭/版本更新不推迟生效时间，再开才推进", async () => {
    const f = await ready();
    await enable(f, { routine_enabled: true });
    const binding = (
      await first<{ email_binding_id: string }>(
        "SELECT email_binding_id FROM users WHERE id=?",
        f.userId,
      )
    )?.email_binding_id;
    for (const layer of ["seat", "routine"])
      for (const action of ["disable", "version_update"])
        await run(
          "INSERT INTO consent_events(id,user_id,email_binding_id,layer,action,consent_version,created_at) VALUES (?,?,?,?,?,?,?)",
          crypto.randomUUID(),
          f.userId,
          binding,
          layer,
          action,
          EMAIL_CONSENT_VERSION,
          now + 1,
        );
    const read = () =>
      env.DB.prepare(`${AUDIENCE_SELECT} WHERE u.id=?`).bind(now, f.userId).first<AudienceRow>();
    expect(await read()).toMatchObject({ seat_enabled_at: now, routine_enabled_at: now });
    await updateEmailChannel(await deps(), f.session, { enabled: false }, now + 2);
    await enable(f, { routine_enabled: true }, now + 3);
    expect(await read()).toMatchObject({ seat_enabled_at: now + 3, routine_enabled_at: now + 3 });
  });
  it("不回网页也按 Feed/Push/交互活动续租；发过邮件与 delivered 都不算", async () => {
    const f = await ready();
    await enable(f);
    const initial = await channelRow(env.DB, f.userId);
    // 发送/反馈事实落 outbox，不进入账号三水位；就算 updated_at 变化也不能续租。
    await run("UPDATE users SET updated_at=? WHERE id=?", now + 10, f.userId);
    for (const status of ["accepted", "delivered"]) {
      await run(
        `INSERT INTO mail_outbox(id,recipient_user_id,address_version,purpose,period_key,status,payload_kind,payload_ref,priority,created_at,updated_at)
        VALUES (?,?,1,'urgent_business',?,'accepted','business','synthetic',1,?,?)`,
        crypto.randomUUID(),
        f.userId,
        utcDayPeriod(now).key,
        now,
        now,
      );
      if (status === "delivered")
        await run(
          "INSERT INTO mail_feedback(id,provider_event_id,kind,feedback_at,created_at) VALUES (?,?,'delivered',?,?)",
          crypto.randomUUID(),
          crypto.randomUUID(),
          now + 10,
          now + 10,
        );
      expect(await renewEmailSeat(env.DB, f.userId, now + 10)).toBe(false);
    }
    expect(await channelRow(env.DB, f.userId)).toEqual(initial);
    for (const [index, field] of [
      "last_feed_poll_at",
      "last_push_processed_at",
      "last_interactive_at",
    ].entries()) {
      const at = now + index + 11;
      await run(`UPDATE users SET ${field}=? WHERE id=?`, at, f.userId);
      expect(await renewEmailSeat(env.DB, f.userId, at)).toBe(true);
      expect(await channelRow(env.DB, f.userId)).toMatchObject({
        lease_expires_at: emailSeatLeaseExpiresAt(at),
        last_renewed_reason: field,
      });
    }
    await updateEmailChannel(await deps(), f.session, { enabled: false }, now + 20);
    await run("UPDATE users SET last_feed_poll_at=? WHERE id=?", now + 30, f.userId);
    expect(await renewEmailSeat(env.DB, f.userId, now + 30)).toBe(false);
  });
  it.each(["emergency_stop", "recover_login"] as const)(
    "P2-05 %s 同批关闭两层、发送资格立即无效；恢复登录不恢复同意",
    async (action) => {
      const f = await ready();
      await enable(f, { routine_enabled: true });
      expect((await recovery(f, action)).status).toBe(200);
      expect(await channelRow(env.DB, f.userId)).toMatchObject({
        enabled: 0,
        routine_enabled: 0,
        lease_expires_at: null,
      });
      expect(
        await env.DB.prepare(`${AUDIENCE_SELECT} WHERE u.id=?`).bind(now, f.userId).first(),
      ).toMatchObject({ channel_enabled: 0, routine_enabled: 0 });
      const credential = await first<{ consumed_at: number | null }>(
        "SELECT consumed_at FROM recovery_credentials WHERE id=?",
        f.recoveryId,
      );
      expect(credential?.consumed_at).toBe(action === "emergency_stop" ? null : now);
      expect((await http(f, "GET")).status).toBe(401);
    },
  );
  it("紧急停用在尚无通道行时与首次启用竞争，也能关闭新通道", async () => {
    const f = await ready();
    await recovery(f, "emergency_stop", async () => {
      await enable(f, { routine_enabled: true });
    });
    expect(await channelRow(env.DB, f.userId)).toMatchObject({ enabled: 0, routine_enabled: 0 });
  });
  it("删除账号关闭两层并保留必要同意历史", async () => {
    const f = await ready();
    await enable(f, { routine_enabled: true });
    const proof = await proveWithRecoveryCode(
      env.DB,
      f.session,
      "account_delete",
      undefined,
      f.recoveryId,
      f.recoverySecret,
      now,
    );
    await markAccountDeleting(env.DB, f.session, proof, now, [emailLifecycleHook]);
    expect(await channelRow(env.DB, f.userId)).toMatchObject({ enabled: 0, routine_enabled: 0 });
    expect((await audit(f)).map((e) => e.action)).toEqual([
      "enable",
      "enable",
      "disable",
      "disable",
    ]);
  });
  it("换邮箱关闭两层，旧同意不归新绑定，重新确认才能开启", async () => {
    const f = await ready();
    await enable(f, { routine_enabled: true });
    const targetEmail = `New${crypto.randomUUID()}@example.test`;
    const currentProof = await proveWithRecoveryCode(
      env.DB,
      f.session,
      "email_change",
      targetEmail,
      f.recoveryId,
      f.recoverySecret,
      now,
    );
    const newProof = crypto.randomUUID();
    const target = await targetForAction("email_change", targetEmail);
    await run(
      `INSERT INTO recent_auth_proofs(id,user_id,session_id,action,role,method,target_digest,expires_at,created_at)
      VALUES (?,?,?,'email_change','new_address','otp',?,?,?)`,
      newProof,
      f.userId,
      f.session.sessionId,
      target.digest,
      now + 1,
      now,
    );
    const changed = await changeEmail(
      env.DB,
      await testKeyring,
      f.session,
      targetEmail,
      currentProof,
      newProof,
      now,
      [emailLifecycleHook],
    );
    expect(await channelRow(env.DB, f.userId)).toMatchObject({ enabled: 0, routine_enabled: 0 });
    await run(
      "UPDATE sessions SET state='active',activated_at=? WHERE id=?",
      now,
      changed.pendingSession.id,
    );
    const session = {
      userId: f.userId,
      sessionId: changed.pendingSession.id,
      sessionTokenHash: changed.pendingSession.tokenHash,
    };
    const view = await readEmailChannel(await deps(), session, now);
    expect(view.consent.seat.version).toBeNull();
    expect(view.consent.routine.version).toBeNull();
    expect(view.lease.last_renewed_at).toBeNull();
    expect(view.lease.last_renewed_reason).toBeNull();
    expect(view).toMatchObject({ enabled: false, routine_enabled: false });
    const updated = await updateEmailChannel(
      await deps(),
      session,
      {
        enabled: true,
        expected_revision: view.channel_revision,
        email_version: view.email.email_version,
        subscription_revision: view.subscription.revision,
        seat_consent_version: EMAIL_CONSENT_VERSION,
      },
      now + 1,
    );
    expect(updated.state).toMatchObject({ enabled: true, routine_enabled: false });
    expect(updated.state.consent.seat.enabled_at).toBe(now + 1);
  });
  it("D3 容量与抑制读失败显式 unknown，不能伪装可投递或名额为零", async () => {
    const f = await ready();
    const prepare = env.DB.prepare.bind(env.DB);
    const mock = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("SUM(enabled=1)") || sql.includes("SELECT kind FROM suppressions"))
        throw new Error("synthetic_unavailable");
      return prepare(sql);
    });
    try {
      const view = await readEmailChannel(await deps(), f.session, now);
      expect(view.remaining).toEqual({ seat: "unknown", routine: "unknown" });
      expect(view.deliverability).toBe("unknown");
      await expect(enable(f)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    } finally {
      mock.mockRestore();
    }
  });
  it("读取后恢复码被消费或会话被撤销，提交守卫拒绝且不落同意", async () => {
    for (const sql of [
      "UPDATE recovery_credentials SET consumed_at=? WHERE user_id=?",
      "UPDATE sessions SET state='revoked',updated_at=? WHERE user_id=?",
    ]) {
      const f = await ready();
      const request = await input(f);
      const original = env.DB.batch.bind(env.DB);
      const mock = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
        await run(sql, now, f.userId);
        return original(statements);
      });
      try {
        await expect(
          updateEmailChannel(await deps(), f.session, request, now),
        ).rejects.toMatchObject({ code: "unauthorized" });
      } finally {
        mock.mockRestore();
      }
      expect(await audit(f)).toEqual([]);
      expect(await channelRow(env.DB, f.userId)).toBeNull();
    }
  });
  it("读取后地址被加入抑制，提交守卫拒绝开启且不写同意", async () => {
    const f = await ready();
    const request = await input(f);
    const addressKey = await suppressionAddressKey((await testKeyring).emailLookup(), f.email);
    const original = env.DB.batch.bind(env.DB);
    const mock = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await run(
        "INSERT INTO suppressions(id,address_key,email_binding_id,kind,read_only,created_at) VALUES (?,?,'synthetic-binding','complaint',1,?)",
        crypto.randomUUID(),
        addressKey,
        now,
      );
      return original(statements);
    });
    try {
      const response = await http(f, "PUT", request);
      expect(mock).toHaveBeenCalledOnce();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        blocked_reason: "address_suppressed",
        error: { code: "quota_paused", details: { scope: "address_suppressed" } },
      });
    } finally {
      mock.mockRestore();
    }
    expect(await channelRow(env.DB, f.userId)).toBeNull();
    expect(await audit(f)).toEqual([]);
  });
  it.each([undefined, EMAIL_CONSENT_VERSION + 1])(
    "席位同意版本缺失或错误（%s）拒绝开启且不写同意",
    async (version) => {
      const f = await ready();
      const response = await http(f, "PUT", await input(f, { seat_consent_version: version }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: "validation",
          details: {
            fields: [{ path: "seat_consent_version", reason: "explicit_consent_required" }],
          },
        },
      });
      expect(await channelRow(env.DB, f.userId)).toBeNull();
      expect(await audit(f)).toEqual([]);
    },
  );
  it("GET 后通道在别处改过，旧 expected_revision 开启返回 409 且不生效", async () => {
    const f = await ready();
    const get = await http(f, "GET");
    expect(get.status).toBe(200);
    const view = await get.json<Awaited<ReturnType<typeof readEmailChannel>>>();
    const request = {
      enabled: true,
      expected_revision: view.channel_revision,
      email_version: view.email.email_version,
      subscription_revision: view.subscription.revision,
      seat_consent_version: EMAIL_CONSENT_VERSION,
    };
    await enable(f);
    await updateEmailChannel(await deps(), f.session, { enabled: false }, now + 1);
    const before = await channelRow(env.DB, f.userId);
    const events = await audit(f);
    expect(before?.channel_revision).toBeGreaterThan(view.channel_revision);
    expect(before?.enabled).toBe(0);
    const response = await http(f, "PUT", request);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "conflict" } });
    expect(await channelRow(env.DB, f.userId)).toEqual(before);
    expect(await audit(f)).toEqual(events);
  });
  it("Worker index 实际挂载 GET/PUT 与紧急停用 hooks", async () => {
    const f = await ready();
    const master = randomBytes(SECRET_BITS / 8),
      pepper = randomBytes(SECRET_BITS / 8);
    const keys = await Keyring.create({
      masterSecret: master,
      otpPepper: pepper,
      unsubscribeMacCurrentKeyId: "synthetic",
    });
    const ciphertext = await encryptField(
      keys.fieldEncryption(),
      { type: "delivery-email-address", id: f.userId },
      f.email,
    );
    await run("UPDATE users SET email_ciphertext=? WHERE id=?", ciphertext, f.userId);
    const runtime = {
      ...env,
      CRYPTO_MASTER_SECRET: toHex(master),
      CRYPTO_OTP_PEPPER: toHex(pepper),
      CRYPTO_UNSUBSCRIBE_KEY_ID: "synthetic",
    };
    const calendar = await mutateCalendar(
      env.DB,
      keys,
      f.session,
      "enable",
      0,
      crypto.randomUUID(),
      now,
    );
    expect(calendar.address_state).toBe("enabled");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const csrf = await mintCsrfToken(
        keys.csrf(),
        f.session.sessionTokenHash,
        randomBytes(SECRET_BITS / 8),
      );
      const headers = {
        origin: "https://app.test",
        "content-type": "application/json",
        cookie: `${USER_SESSION_COOKIE_NAME}=${f.token}; ${CSRF_COOKIE_NAME}=${csrf}`,
        [CSRF_HEADER_NAME]: csrf,
      };
      const get = await worker.fetch(
        new Request("https://app.test/api/v2/me/email-channel", { headers }),
        runtime,
        fakeExecutionContext,
      );
      expect(get.status).toBe(200);
      const view = await get.json<{
        channel_revision: number;
        email: { email_version: number };
        subscription: { revision: number };
      }>();
      const put = await worker.fetch(
        new Request("https://app.test/api/v2/me/email-channel", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            enabled: true,
            routine_enabled: true,
            expected_revision: view.channel_revision,
            email_version: view.email.email_version,
            subscription_revision: view.subscription.revision,
            seat_consent_version: EMAIL_CONSENT_VERSION,
            routine_consent_version: EMAIL_CONSENT_VERSION,
          }),
        }),
        runtime,
        fakeExecutionContext,
      );
      expect(put.status).toBe(200);
      expect(await channelRow(env.DB, f.userId)).toMatchObject({ enabled: 1, routine_enabled: 1 });
      const preauth = await mintPreauthCookieValue(keys.preauthCookie(), now);
      const preCsrf = await mintCsrfToken(
        keys.csrf(),
        preauth.context.preauthId,
        randomBytes(SECRET_BITS / 8),
      );
      const stopped = await worker.fetch(
        new Request("https://app.test/api/v2/auth/recovery", {
          method: "POST",
          headers: {
            origin: "https://app.test",
            "content-type": "application/json",
            cookie: `__Host-preauth=${preauth.value}; ${CSRF_COOKIE_NAME}=${preCsrf}`,
            [CSRF_HEADER_NAME]: preCsrf,
            "cf-connecting-ip": "192.0.2.14",
          },
          body: JSON.stringify({
            action: "emergency_stop",
            recovery_id: f.recoveryId,
            secret: f.recoverySecret,
          }),
        }),
        runtime,
        fakeExecutionContext,
      );
      expect(stopped.status).toBe(200);
      expect(
        await first<{ state: string; token_generation: number }>(
          "SELECT state,token_generation FROM calendar_feeds WHERE user_id=?",
          f.userId,
        ),
      ).toEqual({ state: "disabled", token_generation: calendar.token_generation + 1 });
      expect(await channelRow(env.DB, f.userId)).toMatchObject({ enabled: 0, routine_enabled: 0 });
    } finally {
      clock.mockRestore();
    }
  });
  it("只用外部日历且网页登录已过期：后台续租不要求网页请求，也不释放到期席位", async () => {
    const f = await ready();
    await enable(f);
    const at = emailSeatLeaseExpiresAt(now) + 1;
    await run("UPDATE sessions SET expires_at=? WHERE user_id=?", now, f.userId);
    await run("UPDATE users SET last_feed_poll_at=? WHERE id=?", at, f.userId);
    expect(await renewEmailSeat(env.DB, f.userId, at)).toBe(true);
    expect(await channelRow(env.DB, f.userId)).toMatchObject({
      enabled: 1,
      lease_expires_at: emailSeatLeaseExpiresAt(at),
      last_renewed_at: at,
      last_renewed_reason: "last_feed_poll_at",
    });
    expect(await audit(f)).toHaveLength(1);
  });
});
