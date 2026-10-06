// A-P6-BIND / A-P6-SEND · Push 绑定、可见激活、receipt 窄能力与请求内外发（主方案 §7.8、§8.2、§9.5；ADR-0025）。
// 合成身份、合成订阅与推送服务替身；无真实推送服务、网络或收费资源。
import { env } from "cloudflare:test";
import {
  derivePushActions,
  GLOBAL_MUTATIONS_DAY,
  mutationCounterKeys,
  PUSH_ACTIVATION_ATTEMPTS,
  PUSH_ACTIVATION_TTL,
  PUSH_ACTIVE_MAX,
  PUSH_LEASE,
  PUSH_NEW_DAY,
  PUSH_PENDING_MAX,
  PUSH_TEST_COOLDOWN,
  PUSH_TEST_DAY,
  PUSH_USER_MAX,
  type PushChannelView,
  PushChannelViewSchema,
  pushCounterKeys,
  pushSendDayLimit,
  SECRET_BITS,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupDeletedAccountPage } from "../accounts/lifecycle/cleanup";
import { markAccountDeleting } from "../accounts/lifecycle/service";
import { readAccountSummary } from "../accounts/lifecycle/views";
import { cleanupRetentionPage } from "../accounts/reclaim/retention";
import { saveSubscription } from "../accounts/subscription/service";
import { mintPreauthCookieValue } from "../auth/preauth/cookie";
import { proveWithRecoveryCode } from "../auth/recent-auth/proof";
import { runRecoveryAction } from "../auth/recovery/action";
import { sessionAuthenticator } from "../auth/sessions/authenticator";
import { first, migrate, now, run, seed, selectedConfig } from "../mail/channel/test-support";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, createApiShell, mintCsrfToken } from "../shell";
import { USER_SESSION_COOKIE_NAME } from "../shell/domains";
import { fakeExecutionContext, randomBytes, testKeyring } from "../shell/test-support";
import type { PushConfig } from "./config";
import { pushLifecycleHook, pushSafetyPauseHook } from "./hooks";
import { makePushRoutes } from "./routes";
import { readPushChannel } from "./service";
import { sealBindingSecrets } from "./store";
import {
  FakePushService,
  openPush,
  openPushControls,
  pushDeps,
  SITE,
  type SyntheticSubscription,
  subscription,
  testPushConfig,
} from "./test-support";

type Fixture = Awaited<ReturnType<typeof seed>>;
const DAY = 86_400_000;
let clock = now;
let config: PushConfig;
let fake: FakePushService;

function shell(service = fake, pushConfig: PushConfig | null = config) {
  return createApiShell({
    authenticator: sessionAuthenticator(env.DB, () => clock),
    csrfKey: async () => (await testKeyring).csrf(),
    routes: makePushRoutes({
      keys: () => testKeyring,
      config: async () => pushConfig,
      transport: service.transport,
      now: () => clock,
    }),
  });
}
async function api(
  f: Fixture,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path = "",
  body?: unknown,
  pushConfig: PushConfig | null = config,
) {
  const csrf = await mintCsrfToken(
    (await testKeyring).csrf(),
    f.session.sessionTokenHash,
    randomBytes(SECRET_BITS / 8),
  );
  return shell(fake, pushConfig).fetch(
    new Request(`${SITE}/api/v2/me/push-bindings${path}`, {
      method,
      headers: {
        origin: SITE,
        "content-type": "application/json",
        cookie: `${USER_SESSION_COOKIE_NAME}=${f.token}; ${CSRF_COOKIE_NAME}=${csrf}`,
        [CSRF_HEADER_NAME]: csrf,
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    }),
    env,
    fakeExecutionContext,
  );
}
/** Service Worker 的回执：不带 Cookie，只有同源 Origin 与请求体里的窄能力。 */
async function receipt(bindingId: string, action: "activate" | "processed", body: unknown) {
  return shell().fetch(
    new Request(`${SITE}/api/v2/push-bindings/${bindingId}/${action}`, {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    fakeExecutionContext,
  );
}
async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
async function ready(): Promise<Fixture> {
  const f = await seed();
  await saveSubscription(env.DB, f.userId, 0, selectedConfig, now);
  return f;
}
interface Created {
  binding_id: string;
  receipt_token: string;
  result: string;
  state: PushChannelView;
}
async function enable(f: Fixture, sub: SyntheticSubscription) {
  const response = await api(f, "POST", "", { endpoint: sub.endpoint, keys: sub.keys });
  return { response, body: await json<Created>(response) };
}
/** 页面存好凭证之后的第二步：发可见激活通知。 */
async function sendActivation(f: Fixture, created: Created) {
  const version = created.state.bindings.find((b) => b.id === created.binding_id)?.binding_version;
  return api(f, "PATCH", `/${created.binding_id}`, {
    action: "activate",
    expected_version: version,
  });
}
/** 登记并发出第一封激活通知。 */
async function enableAndSend(f: Fixture, sub: SyntheticSubscription) {
  const created = await enable(f, sub);
  expect(created.response.status).toBe(201);
  const sent = await sendActivation(f, created.body);
  expect(sent.status).toBe(200);
  return created;
}
/** 从最后一次外发里解出激活挑战（只有订阅私钥能解开）。 */
async function lastChallenge(sub: SyntheticSubscription): Promise<string> {
  const payload = await openPush(sub, fake.requests.at(-1) as (typeof fake.requests)[number]);
  expect(payload.kind).toBe("activation");
  return payload.challenge as string;
}
async function activate(f: Fixture, sub: SyntheticSubscription) {
  const { body } = await enableAndSend(f, sub);
  const challenge = await lastChallenge(sub);
  const response = await receipt(body.binding_id, "activate", {
    receipt_token: body.receipt_token,
    challenge,
  });
  expect(response.status).toBe(200);
  return body;
}
async function binding(id: string) {
  return first<Record<string, unknown>>("SELECT * FROM push_bindings WHERE id=?", id);
}
async function counter(key: string): Promise<number> {
  return (
    (await first<{ value: number }>("SELECT value FROM capacity_state WHERE key=?", key))?.value ??
    0
  );
}
const daily = () => pushCounterKeys(utcDayPeriod(clock).key);

beforeAll(async () => {
  await migrate();
  config = await testPushConfig();
}, 180_000);
beforeEach(async () => {
  clock = now;
  fake = new FakePushService();
  await run("DELETE FROM push_messages");
  await run("DELETE FROM push_bindings");
  await run("DELETE FROM capacity_state");
  await run("DELETE FROM audit_log");
  await openPushControls(env.DB);
});

describe("A-P6-BIND 本人视图：只给事实", () => {
  it("GET 无端点/密钥/凭证、no-store；未保存订阅时浏览器推导出先保存一次", async () => {
    const f = await seed();
    const response = await api(f, "GET");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const view = PushChannelViewSchema.parse(await json(response));
    expect(view).toMatchObject({
      configured: true,
      application_server_key: config.vapid.publicKey,
      service: "open",
      subscription_state: "uninitialized",
      bindings: [],
    });
    expect(derivePushActions(view, null, clock).enable).toMatchObject({
      reason: "subscription_uninitialized",
    });
    const created = await api(f, "POST", "", {
      endpoint: (await subscription()).endpoint,
      keys: (await subscription()).keys,
    });
    expect(created.status).toBe(400);
    expect(await json(created)).toMatchObject({ blocked_reason: "subscription_uninitialized" });
    expect(fake.requests).toHaveLength(0);
  });

  it("未配置 VAPID 时如实为未配置、能力不开放，登记失败关闭", async () => {
    const f = await ready();
    const view = PushChannelViewSchema.parse(await json(await api(f, "GET", "", undefined, null)));
    expect(view).toMatchObject({
      configured: false,
      application_server_key: null,
      service: "closed",
    });
    const sub = await subscription();
    const refused = await api(f, "POST", "", { endpoint: sub.endpoint, keys: sub.keys }, null);
    expect(refused.status).toBe(503);
    expect(await json(refused)).toMatchObject({ blocked_reason: "feature_closed" });
    expect(await first("SELECT 1 FROM push_bindings")).toBeNull();
  });
});

describe("A-P6-BIND 登记、可见激活与 receipt 窄能力", () => {
  it("登记后为 pending、先交付凭证不外发；再发加密的可见激活通知；receipt + 挑战确认后才 active", async () => {
    const f = await ready();
    const sub = await subscription("mozilla");
    const { response, body } = await enable(f, sub);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.result).toBe("created");
    expect(body.receipt_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.state.bindings[0]).toMatchObject({
      id: body.binding_id,
      state: "pending",
      service: "mozilla",
      activation: { attempts: 0, last_sent_at: null, last_outcome: null },
    });
    // 凭证还没落到本机之前不发：避免激活通知先于凭证到达 Service Worker。
    expect(fake.requests).toHaveLength(0);
    const sent = await sendActivation(f, body);
    expect(sent.status).toBe(200);
    expect(await json(sent)).toMatchObject({
      outcome: "accepted",
      state: {
        bindings: [{ state: "pending", activation: { attempts: 1, last_outcome: "accepted" } }],
      },
    });
    // 外发：只发往登记端点；VAPID aud 为端点 origin；aes128gcm；TTL 不超过激活期限。
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0] as (typeof fake.requests)[number];
    expect(request.url).toBe(sub.endpoint);
    expect(request.headers.get("content-encoding")).toBe("aes128gcm");
    expect(request.headers.get("urgency")).toBe("high");
    expect(Number(request.headers.get("ttl"))).toBeLessThanOrEqual(PUSH_ACTIVATION_TTL);
    expect(request.headers.get("authorization")).toMatch(
      new RegExp(`^vapid t=[^ ]+, k=${config.vapid.publicKey}$`),
    );
    const payload = await openPush(sub, request);
    expect(payload).toMatchObject({ v: 1, kind: "activation", binding_id: body.binding_id });
    // 库里只有 hash 与密文：明文 receipt、挑战、端点都不落库。
    const row = await binding(body.binding_id);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(body.receipt_token);
    expect(stored).not.toContain(payload.challenge as string);
    expect(stored).not.toContain(sub.endpoint);
    expect(stored).not.toContain(sub.keys.p256dh);
    // 平台接受 ≠ 激活：此时仍是 pending。
    expect(row?.state).toBe("pending");
    const activated = await receipt(body.binding_id, "activate", {
      receipt_token: body.receipt_token,
      challenge: payload.challenge,
    });
    expect(activated.status).toBe(200);
    expect(await json(activated)).toEqual({ result: "activated" });
    const view = PushChannelViewSchema.parse(await json(await api(f, "GET")));
    expect(view.bindings[0]).toMatchObject({
      state: "active",
      activated_at: clock,
      lease_expires_at: clock + PUSH_LEASE * DAY,
      activation: null,
    });
    // 重放同一回执：幂等。
    expect(
      await json(
        await receipt(body.binding_id, "activate", {
          receipt_token: body.receipt_token,
          challenge: payload.challenge,
        }),
      ),
    ).toEqual({ result: "already_active" });
  });

  it("receipt 不授权账号：错挑战/错凭证/错绑定一律 404；凭证当会话用无效", async () => {
    const f = await ready();
    const sub = await subscription();
    const { body } = await enableAndSend(f, sub);
    const challenge = await lastChallenge(sub);
    const other = "B".repeat(43);
    for (const [id, token, value] of [
      [body.binding_id, body.receipt_token, other],
      [body.binding_id, other, challenge],
      [crypto.randomUUID(), body.receipt_token, challenge],
    ] as const) {
      const response = await receipt(id, "activate", { receipt_token: token, challenge: value });
      expect(response.status).toBe(404);
      expect(JSON.stringify(await json(response))).not.toMatch(/user|email|binding/i);
    }
    expect((await binding(body.binding_id))?.state).toBe("pending");
    const asSession = await shell().fetch(
      new Request(`${SITE}/api/v2/me/push-bindings`, {
        headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${body.receipt_token}` },
      }),
      env,
      fakeExecutionContext,
    );
    expect(asSession.status).toBe(401);
    // 未知字段、跨源一律拒绝。
    const extra = await receipt(body.binding_id, "activate", {
      receipt_token: body.receipt_token,
      challenge,
      user_id: f.userId,
    });
    expect(extra.status).toBe(400);
    const crossOrigin = await shell().fetch(
      new Request(`${SITE}/api/v2/push-bindings/${body.binding_id}/activate`, {
        method: "POST",
        headers: { origin: "https://evil.test", "content-type": "application/json" },
        body: JSON.stringify({ receipt_token: body.receipt_token, challenge }),
      }),
      env,
      fakeExecutionContext,
    );
    expect(crossOrigin.status).toBe(401);
    expect((await binding(body.binding_id))?.state).toBe("pending");
  });

  it("同 endpoint 同 owner 幂等只轮换 receipt；不同 owner 冲突且不抢占", async () => {
    const f = await ready();
    const sub = await subscription();
    const original = await activate(f, sub);
    const again = await enable(f, sub);
    expect(again.response.status).toBe(200);
    expect(again.body).toMatchObject({ result: "existing", binding_id: original.binding_id });
    expect(again.body.receipt_token).not.toBe(original.receipt_token);
    expect(fake.requests).toHaveLength(1);
    const sent = (await binding(original.binding_id)) as Record<string, unknown>;
    expect(sent.state).toBe("active");
    const g = await ready();
    const conflict = await enable(g, sub);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: { code: "conflict", details: { reason: "push_endpoint_owned_elsewhere" } },
    });
    expect(await binding(original.binding_id)).toMatchObject({
      user_id: f.userId,
      state: "active",
    });
    expect(await first<{ n: number }>("SELECT COUNT(*) AS n FROM push_bindings")).toEqual({ n: 1 });
    expect(fake.requests).toHaveLength(1);
  });

  it("端点与密钥校验：未登记主机、内网、http、错误密钥都在外发前拒绝", async () => {
    const f = await ready();
    const sub = await subscription();
    for (const endpoint of [
      "https://evil.test/push",
      "https://169.254.169.254/latest",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.test/fcm/send/x",
    ]) {
      const response = await api(f, "POST", "", { endpoint, keys: sub.keys });
      expect(response.status).toBe(400);
    }
    const offCurve = `B${"A".repeat(86)}`;
    expect(
      (
        await api(f, "POST", "", {
          endpoint: sub.endpoint,
          keys: { ...sub.keys, p256dh: offCurve },
        })
      ).status,
    ).toBe(400);
    expect(fake.requests).toHaveLength(0);
    expect(await first("SELECT 1 FROM push_bindings")).toBeNull();
  });

  it("恢复受限会话不能登记；待激活会话也不能", async () => {
    const f = await ready();
    await run("UPDATE sessions SET recovery_code_required=1 WHERE id=?", f.session.sessionId);
    const sub = await subscription();
    const response = await api(f, "POST", "", { endpoint: sub.endpoint, keys: sub.keys });
    expect(response.status).toBe(401);
    expect(await json(response)).toMatchObject({
      error: { details: { reason: "recovery_code_unconfirmed" } },
    });
  });
});

describe("A-P6-BIND 名额、日额与激活期限", () => {
  it("每账号 PUSH_USER_MAX；全站 pending 上限；当日新绑定；外发预算", async () => {
    const f = await ready();
    for (let i = 0; i < PUSH_USER_MAX; i++)
      expect((await enable(f, await subscription())).response.status).toBe(201);
    const over = await enable(f, await subscription());
    expect(over.response.status).toBe(503);
    expect(over.body).toMatchObject({ blocked_reason: "capacity_full" });

    const g = await ready();
    const keys = await testKeyring;
    const filler = PUSH_PENDING_MAX - PUSH_USER_MAX;
    for (let i = 0; i < filler; i++) {
      const id = crypto.randomUUID();
      const sealed = await sealBindingSecrets(
        keys,
        id,
        `https://fcm.googleapis.com/fcm/send/fill-${i}`,
        {
          p256dh: "x",
          auth: "y",
        },
      );
      await run(
        `INSERT INTO push_bindings(id,user_id,endpoint_hash,endpoint_ciphertext,keys_ciphertext,state,created_at,updated_at,
          push_service,activation_deadline) VALUES (?,?,?,?,?,'pending',?,?,'fcm',?)`,
        id,
        g.userId,
        `fill-${id}`,
        sealed.endpoint,
        sealed.keys,
        clock,
        clock,
        clock + 1,
      );
    }
    const h = await ready();
    const pendingFull = await enable(h, await subscription());
    expect(pendingFull.response.status).toBe(503);
    expect(pendingFull.body).toMatchObject({ blocked_reason: "capacity_full" });
    await run("DELETE FROM push_bindings WHERE user_id=?", g.userId);

    await run(
      "INSERT INTO capacity_state(key,value,version,updated_at) VALUES (?,?,0,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      daily().created,
      PUSH_NEW_DAY,
      clock,
    );
    const quota = await enable(h, await subscription());
    expect(quota.response.status).toBe(503);
    expect(quota.body).toMatchObject({ blocked_reason: "quota_paused" });
    await run("UPDATE capacity_state SET value=0 WHERE key=?", daily().created);
    await run(
      "INSERT INTO capacity_state(key,value,version,updated_at) VALUES (?,?,0,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      daily().send,
      pushSendDayLimit(false),
      clock,
    );
    expect((await enable(h, await subscription())).body).toMatchObject({
      blocked_reason: "quota_paused",
    });
  });

  it("激活需要全站 active 余量；已满时回执返回 capacity_reached 且保持 pending", async () => {
    const f = await ready();
    const sub = await subscription();
    const { body } = await enableAndSend(f, sub);
    const challenge = await lastChallenge(sub);
    await run(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO push_bindings(id,user_id,endpoint_hash,endpoint_ciphertext,keys_ciphertext,state,created_at,updated_at,push_service)
      SELECT 'fill-'||i,?,'fill-'||i,X'00',X'00','active',?,?,'fcm' FROM n`,
      PUSH_ACTIVE_MAX,
      f.userId,
      clock,
      clock,
    );
    const response = await receipt(body.binding_id, "activate", {
      receipt_token: body.receipt_token,
      challenge,
    });
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({ error: { code: "capacity_reached" } });
    expect((await binding(body.binding_id))?.state).toBe("pending");
  });

  it("重发激活受冷却、次数与期限约束；同一轮的旧挑战仍可确认", async () => {
    const f = await ready();
    const sub = await subscription();
    const { body } = await enableAndSend(f, sub);
    const firstChallenge = await lastChallenge(sub);
    let version = ((await binding(body.binding_id)) as { binding_version: number }).binding_version;
    const early = await api(f, "PATCH", `/${body.binding_id}`, {
      action: "activate",
      expected_version: version,
    });
    expect(early.status).toBe(429);
    expect(await json(early)).toMatchObject({
      blocked_reason: "cooldown",
      error: { details: { retry_after_ms: PUSH_TEST_COOLDOWN * 1000 } },
    });
    for (let attempt = 2; attempt <= PUSH_ACTIVATION_ATTEMPTS; attempt++) {
      clock += PUSH_TEST_COOLDOWN * 1000;
      const resent = await api(f, "PATCH", `/${body.binding_id}`, {
        action: "activate",
        expected_version: version,
      });
      expect(resent.status).toBe(200);
      const state = (await json<{ state: PushChannelView }>(resent)).state;
      version = state.bindings[0]?.binding_version ?? -1;
      expect(state.bindings[0]?.activation?.attempts).toBe(attempt);
    }
    clock += PUSH_TEST_COOLDOWN * 1000;
    const exhausted = await api(f, "PATCH", `/${body.binding_id}`, {
      action: "activate",
      expected_version: version,
    });
    expect(await json(exhausted)).toMatchObject({ blocked_reason: "attempts_exhausted" });
    expect(fake.requests).toHaveLength(PUSH_ACTIVATION_ATTEMPTS);
    // 第一封延迟到达：同一轮发出的挑战都有效。
    expect(
      (
        await receipt(body.binding_id, "activate", {
          receipt_token: body.receipt_token,
          challenge: firstChallenge,
        })
      ).status,
    ).toBe(200);
  });

  it("激活期限过后回执无效；回收清理过期 pending，可在同一端点重新登记", async () => {
    const f = await ready();
    const sub = await subscription();
    const { body } = await enableAndSend(f, sub);
    const challenge = await lastChallenge(sub);
    clock = now + PUSH_ACTIVATION_TTL * 1000;
    expect(
      (await receipt(body.binding_id, "activate", { receipt_token: body.receipt_token, challenge }))
        .status,
    ).toBe(404);
    // 过期 pending 视为已失败：同一端点重新开启在同一事务里替换，不占额外名额。
    const again = await enable(f, sub);
    expect(again.response.status).toBe(201);
    expect(again.body.binding_id).not.toBe(body.binding_id);
    expect(await binding(body.binding_id)).toBeNull();
    clock += PUSH_ACTIVATION_TTL * 1000;
    await cleanupRetentionPage(env.DB, clock);
    expect(await binding(again.body.binding_id)).toBeNull();
  });
});

describe("A-P6-BIND 暂停、恢复、删除与安全暂停", () => {
  it("暂停与删除是终止路径：开关关闭、日额用尽时照样执行；恢复必须重新验证接收", async () => {
    const f = await ready();
    const sub = await subscription();
    const created = await activate(f, sub);
    await run("UPDATE system_state SET value_json='false' WHERE key='push_enabled'");
    const { userKey, globalKey } = mutationCounterKeys(f.userId, utcDayPeriod(clock).key);
    for (const [key, value] of [
      [userKey, USER_MUTATIONS_DAY],
      [globalKey, GLOBAL_MUTATIONS_DAY],
    ] as const)
      await run(
        "INSERT INTO capacity_state(key,value,version,updated_at) VALUES (?,?,0,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key,
        value,
        clock,
      );
    const paused = await api(f, "PATCH", `/${created.binding_id}`, {
      action: "pause",
      expected_version: 999,
    });
    expect(paused.status).toBe(200);
    expect(await binding(created.binding_id)).toMatchObject({
      state: "paused",
      paused_reason: "user",
    });
    expect(
      (await api(f, "PATCH", `/${created.binding_id}`, { action: "pause", expected_version: 0 }))
        .status,
    ).toBe(200);
    await run("UPDATE system_state SET value_json='true' WHERE key='push_enabled'");
    await run("DELETE FROM capacity_state");
    const version = ((await binding(created.binding_id)) as { binding_version: number })
      .binding_version;
    const resumed = await api(f, "PATCH", `/${created.binding_id}`, {
      action: "activate",
      expected_version: version,
    });
    expect(resumed.status).toBe(200);
    expect(await binding(created.binding_id)).toMatchObject({ state: "pending" });
    const challenge = await lastChallenge(sub);
    // 暂停前的 receipt 仍属本浏览器；新一轮挑战确认后恢复 active。
    expect(
      (
        await receipt(created.binding_id, "activate", {
          receipt_token: created.receipt_token,
          challenge,
        })
      ).status,
    ).toBe(200);
    await run("UPDATE system_state SET value_json='false' WHERE key='push_enabled'");
    const deleted = await api(f, "DELETE", `/${created.binding_id}`, {});
    expect(deleted.status).toBe(200);
    expect(await binding(created.binding_id)).toBeNull();
    // 幂等：再次删除仍是完成。
    expect((await api(f, "DELETE", `/${created.binding_id}`, {})).status).toBe(200);
  });

  it("紧急停用立即暂停本账号全部 Push，不消费恢复码，重复停用幂等", async () => {
    const f = await ready();
    const active = await activate(f, await subscription());
    const pending = await enable(f, await subscription());
    const minted = await mintPreauthCookieValue((await testKeyring).preauthCookie(), clock);
    const keys = await testKeyring;
    const response = await runRecoveryAction(
      {
        db: env.DB,
        keys,
        sourceGate: { charge: async () => true },
        now: () => clock,
        pauseHooks: [pushSafetyPauseHook],
      },
      {
        action: "emergency_stop",
        recoveryId: f.recoveryId,
        secret: f.recoverySecret,
        request: new Request(`${SITE}/api/v2/auth/recovery`, {
          method: "POST",
          headers: {
            cookie: `__Host-preauth=${minted.value}`,
            "idempotency-key": crypto.randomUUID(),
            "cf-connecting-ip": "192.0.2.12",
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    for (const id of [active.binding_id, pending.body.binding_id])
      expect(await binding(id)).toMatchObject({ state: "paused", paused_reason: "safety" });
    expect(
      await first("SELECT consumed_at FROM recovery_credentials WHERE id=?", f.recoveryId),
    ).toEqual({ consumed_at: null });
    // 暂停后旧回执不能把绑定拉回 active。
    expect(
      (
        await receipt(pending.body.binding_id, "activate", {
          receipt_token: pending.body.receipt_token,
          challenge: "C".repeat(43),
        })
      ).status,
    ).toBe(404);
  });

  it("删除账号同批暂停 Push，分页清理删除绑定（密文随之清除）", async () => {
    const f = await ready();
    const created = await activate(f, await subscription());
    const proof = await proveWithRecoveryCode(
      env.DB,
      f.session,
      "account_delete",
      undefined,
      f.recoveryId,
      f.recoverySecret,
      clock,
    );
    await markAccountDeleting(env.DB, f.session, proof, clock, [pushLifecycleHook]);
    expect(await binding(created.binding_id)).toMatchObject({ state: "paused" });
    for (let i = 0; i < 40; i++)
      if ((await cleanupDeletedAccountPage(env.DB, f.userId, 20, clock)).state === "complete")
        break;
    expect(await binding(created.binding_id)).toBeNull();
  });
});

describe("A-P6-SEND 请求内外发：测试通知、失效端点与配置拒绝", () => {
  it("测试通知受冷却与全站测试日量约束，计入外发预算；处理回执记下本浏览器已收到", async () => {
    const f = await ready();
    const sub = await subscription("apple");
    const created = await activate(f, sub);
    const sendBefore = await counter(daily().send);
    let version = ((await binding(created.binding_id)) as { binding_version: number })
      .binding_version;
    const tested = await api(f, "POST", `/${created.binding_id}/test`, {
      expected_version: version,
    });
    expect(tested.status).toBe(200);
    expect(await json(tested)).toMatchObject({ outcome: "accepted" });
    expect(await counter(daily().send)).toBe(sendBefore + 1);
    expect(await counter(daily().test)).toBe(1);
    const payload = await openPush(sub, fake.requests.at(-1) as (typeof fake.requests)[number]);
    expect(payload).toMatchObject({ kind: "test", binding_id: created.binding_id });
    const processed = await receipt(created.binding_id, "processed", {
      receipt_token: created.receipt_token,
      message_id: payload.message_id,
    });
    expect(await json(processed)).toEqual({ result: "recorded" });
    const view = PushChannelViewSchema.parse(await json(await api(f, "GET")));
    expect(view.bindings[0]?.last_test).toEqual({
      sent_at: clock,
      outcome: "accepted",
      received_at: clock,
    });
    version = view.bindings[0]?.binding_version ?? -1;
    const cooling = await api(f, "POST", `/${created.binding_id}/test`, {
      expected_version: version,
    });
    expect(cooling.status).toBe(429);
    clock += PUSH_TEST_COOLDOWN * 1000;
    await run("UPDATE capacity_state SET value=? WHERE key=?", PUSH_TEST_DAY, daily().test);
    const capped = await api(f, "POST", `/${created.binding_id}/test`, {
      expected_version: version,
    });
    expect(await json(capped)).toMatchObject({ blocked_reason: "quota_paused" });
  });

  it("404/410 只停用该端点；同账号其他绑定不受影响", async () => {
    const f = await ready();
    const gone = await activate(f, await subscription());
    const kept = await activate(f, await subscription("wns"));
    fake.respond(410);
    const version = ((await binding(gone.binding_id)) as { binding_version: number })
      .binding_version;
    const response = await api(f, "POST", `/${gone.binding_id}/test`, {
      expected_version: version,
    });
    expect(await json(response)).toMatchObject({ outcome: "gone" });
    expect(await binding(gone.binding_id)).toMatchObject({ state: "gone", gone_at: clock });
    expect(await binding(kept.binding_id)).toMatchObject({ state: "active" });
  });

  it("401/403 先查配置：自动关闭 Push 开关并写系统审计，不删除也不改动任何绑定", async () => {
    const f = await ready();
    const a = await activate(f, await subscription());
    const b = await activate(f, await subscription("mozilla"));
    fake.respond(403);
    const version = ((await binding(a.binding_id)) as { binding_version: number }).binding_version;
    const response = await api(f, "POST", `/${a.binding_id}/test`, { expected_version: version });
    expect(await json(response)).toMatchObject({ outcome: "auth_rejected" });
    expect(await first("SELECT value_json FROM system_state WHERE key='push_enabled'")).toEqual({
      value_json: "false",
    });
    expect(
      await first(
        "SELECT actor_type,action,target_id FROM audit_log WHERE target_id='push_enabled'",
      ),
    ).toEqual({ actor_type: "system", action: "control_disable", target_id: "push_enabled" });
    for (const id of [a.binding_id, b.binding_id])
      expect(await binding(id)).toMatchObject({ state: "active" });
    const view = await readPushChannel(await pushDeps(fake, config), f.session, clock);
    expect(view.service).toBe("closed");
  });

  it("账号操作续租；账号摘要按状态计数", async () => {
    const f = await ready();
    const created = await activate(f, await subscription());
    await enable(f, await subscription());
    clock += 10 * DAY;
    const version = ((await binding(created.binding_id)) as { binding_version: number })
      .binding_version;
    expect(
      (await api(f, "POST", `/${created.binding_id}/renew`, { expected_version: version })).status,
    ).toBe(200);
    expect(await binding(created.binding_id)).toMatchObject({
      lease_expires_at: clock + PUSH_LEASE * DAY,
    });
    const summary = await readAccountSummary(
      env.DB,
      await testKeyring,
      {
        kind: "session",
        domain: "user",
        userId: f.userId,
        sessionId: f.session.sessionId,
        sessionState: "active",
        sessionTokenHash: f.session.sessionTokenHash,
        recoveryCodeRequired: false,
      },
      clock,
    );
    expect(summary.channels.push).toEqual({
      state: "active",
      pending: 1,
      active: 1,
      paused: 0,
      gone: 0,
    });
  });
});
