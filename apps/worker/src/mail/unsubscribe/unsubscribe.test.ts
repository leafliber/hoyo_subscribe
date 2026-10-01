import { createExecutionContext, env } from "cloudflare:test";
import { EMAIL_CONSENT_VERSION, SECRET_BITS } from "@hoyo/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSubscription } from "../../accounts/subscription/service";
import worker from "../../index";
import { createApiShell } from "../../shell/router";
import { randomBytes, testKeyring } from "../../shell/test-support";
import { encryptField } from "../../storage/crypto/aead";
import { fromHex, toHex } from "../../storage/crypto/bytes";
import { Keyring } from "../../storage/crypto/keyring";
import { updateEmailChannel } from "../channel/service";
import { first, migrate, now, run, seed, selectedConfig } from "../channel/test-support";
import { readEmailChannel } from "../channel/view";
import { environmentUnsubscribe, unsubscribeAvailable, unsubscribeKeys } from "./environment";
import { makeUnsubscribeRoutes } from "./routes";
import { closeBusinessMail } from "./service";
import { issueUnsubscribeToken, resolveUnsubscribeToken, unsubscribeLinks } from "./token";

beforeAll(migrate);
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (const table of [
    "consent_events",
    "email_channels",
    "subscription_interests",
    "user_subscriptions",
    "sessions",
    "recovery_credentials",
    "users",
    "capacity_state",
    "system_state",
  ])
    await env.DB.exec(`DELETE FROM ${table}`);
});
const keySource = async () => (await testKeyring).unsubscribeMac();
const channelDeps = async () => ({
  db: env.DB,
  keys: await testKeyring,
  sendingAvailable: async () => true,
});
async function enable(f: Awaited<ReturnType<typeof seed>>, at = now) {
  const deps = await channelDeps(),
    view = await readEmailChannel(deps, f.session, at);
  return updateEmailChannel(
    deps,
    f.session,
    {
      enabled: true,
      routine_enabled: true,
      expected_revision: view.channel_revision,
      email_version: view.email.email_version,
      subscription_revision: view.subscription.revision,
      seat_consent_version: EMAIL_CONSENT_VERSION,
      routine_consent_version: EMAIL_CONSENT_VERSION,
    },
    at,
  );
}
async function fixture() {
  const f = await seed();
  await saveSubscription(env.DB, f.userId, 0, selectedConfig, now);
  await enable(f);
  const binding = await first<{ email_binding_id: string }>(
    "SELECT email_binding_id FROM users WHERE id=?",
    f.userId,
  );
  if (!binding) throw new Error("fixture_missing");
  return {
    ...f,
    binding: binding.email_binding_id,
    links: await unsubscribeLinks(
      await keySource(),
      "https://synthetic.example",
      binding.email_binding_id,
    ),
  };
}
const state = (id: string) => first("SELECT * FROM email_channels WHERE user_id=?", id);
function shell(keys = keySource, database = env.DB) {
  const authenticate = vi.fn(async () => {
    throw new Error("must_not_authenticate");
  });
  const api = createApiShell({
    authenticator: { authenticate },
    routes: makeUnsubscribeRoutes({ keys, now: () => now }),
  });
  return {
    authenticate,
    fetch: (request: Request) =>
      api.fetch(request, { ...env, DB: database }, createExecutionContext()),
  };
}
function post(url: string, oneClick = true, multipart = false) {
  const body = multipart ? new FormData() : new URLSearchParams();
  body.set(oneClick ? "List-Unsubscribe" : "confirm", oneClick ? "One-Click" : "unsubscribe");
  return new Request(url, { method: "POST", body });
}

// 仅观察真实 D1 batch 的元数据；不替换执行、事务或写入结果。
function measuredDatabase() {
  const writes: number[][] = [];
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          writes.push(results.map((result) => result.meta.rows_written));
          return results;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, writes };
}

describe("A-P4-UNSUB 当前绑定稳定退订", () => {
  it.each([false, true])(
    "重复停止零写入：one-click=%s，真实 D1 每句 rows_written 均为零",
    async (oneClick) => {
      const f = await fixture(),
        measured = measuredDatabase(),
        api = shell(keySource, measured.db);
      const url = oneClick ? f.links.oneClick : f.links.page;
      const status = oneClick ? 204 : 200;
      expect((await api.fetch(post(url, oneClick))).status).toBe(status);
      expect(measured.writes).toHaveLength(1);
      expect(measured.writes[0].reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
      const closed = await state(f.userId);
      expect((await api.fetch(post(url, oneClick))).status).toBe(status);
      expect(measured.writes).toHaveLength(2);
      expect(measured.writes[1]).toEqual([0, 0, 0]);
      expect(await state(f.userId)).toEqual(closed);
      await enable(f, now + 1);
      expect((await api.fetch(post(url, oneClick))).status).toBe(status);
      expect(measured.writes).toHaveLength(3);
      expect(measured.writes[2].reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
      expect(await state(f.userId)).toMatchObject({
        enabled: 0,
        routine_enabled: 0,
        lease_expires_at: null,
      });
      expect((await api.fetch(post(url, oneClick))).status).toBe(status);
      expect(measured.writes).toHaveLength(4);
      expect(measured.writes[3]).toEqual([0, 0, 0]);
    },
  );

  it("GET 扫描不写任何状态；HTML 不回显地址或 token，有同源表单和 no-store", async () => {
    const f = await fixture(),
      before = await state(f.userId);
    const writes = await first<{ n: number }>("SELECT COUNT(*) n FROM consent_events");
    const api = shell();
    const response = await api.fetch(new Request(f.links.page));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('method="post"');
    expect(html).not.toContain(f.email);
    expect(html).not.toContain(new URL(f.links.page).pathname);
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await state(f.userId)).toEqual(before);
    expect(await first("SELECT COUNT(*) n FROM consent_events")).toEqual(writes);
    expect(api.authenticate).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "one-click multipart=%s 关闭两层；同 token 跨真实重新同意仍关闭当前业务，重复幂等",
    async (multipart) => {
      const f = await fixture(),
        api = shell();
      const original = f.links.oneClick;
      expect((await api.fetch(post(original, true, multipart))).status).toBe(204);
      expect(await state(f.userId)).toMatchObject({
        enabled: 0,
        routine_enabled: 0,
        lease_expires_at: null,
      });
      const closed = await state(f.userId),
        count = await first("SELECT COUNT(*) n FROM consent_events");
      expect((await api.fetch(post(original))).status).toBe(204);
      expect(await state(f.userId)).toEqual(closed);
      expect(await first("SELECT COUNT(*) n FROM consent_events")).toEqual(count);
      await enable(f, now + 1);
      expect(await state(f.userId)).toMatchObject({ enabled: 1, routine_enabled: 1 });
      expect((await api.fetch(post(original))).status).toBe(204);
      expect(await state(f.userId)).toMatchObject({ enabled: 0, routine_enabled: 0 });
      expect(await first("SELECT COUNT(*) n FROM suppressions")).toEqual({ n: 0 });
      expect(
        await first("SELECT consumed_at FROM recovery_credentials WHERE id=?", f.recoveryId),
      ).toEqual({ consumed_at: null });
    },
  );
  it("正文确认 POST 也实际关闭业务且成功页不设置 Cookie/重定向", async () => {
    const f = await fixture();
    const res = await shell().fetch(post(f.links.page, false));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("当前业务邮件已关闭");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
    expect(await state(f.userId)).toMatchObject({ enabled: 0, routine_enabled: 0 });
  });
  it("错误 one-click 值拒绝，GET one-click 不退订", async () => {
    const f = await fixture(),
      api = shell(),
      before = await state(f.userId);
    expect((await api.fetch(new Request(f.links.oneClick))).status).toBe(405);
    expect(
      (
        await api.fetch(
          new Request(f.links.oneClick, {
            method: "POST",
            body: new URLSearchParams({ "List-Unsubscribe": "other" }),
          }),
        )
      ).status,
    ).toBe(400);
    expect(await state(f.userId)).toEqual(before);
  });
  it("旧绑定换邮箱后明确失效，不影响新地址；删除/注销绑定亦失效", async () => {
    const f = await fixture(),
      api = shell();
    await run(
      "UPDATE users SET email_binding_id=?,email_version=email_version+1 WHERE id=?",
      crypto.randomUUID(),
      f.userId,
    );
    await run("UPDATE email_channels SET enabled=1,routine_enabled=1 WHERE user_id=?", f.userId);
    const before = await state(f.userId);
    for (const req of [
      new Request(f.links.page),
      post(f.links.page, false),
      post(f.links.oneClick),
    ]) {
      const response = await api.fetch(req);
      expect(response.status).toBe(410);
      expect(await response.text()).toContain("旧绑定已失效");
    }
    expect(await state(f.userId)).toEqual(before);
    const g = await fixture();
    await run("UPDATE users SET status='deleting' WHERE id=?", g.userId);
    expect((await api.fetch(post(g.links.oneClick))).status).toBe(410);
  });
  it("读取后换绑的竞态在提交时拒绝，其他用户 Cookie 不改变目标", async () => {
    const f = await fixture(),
      g = await fixture();
    const database = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await run(
              "UPDATE users SET email_binding_id=?,email_version=email_version+1 WHERE id=?",
              crypto.randomUUID(),
              f.userId,
            );
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const request = post(f.links.oneClick);
    request.headers.set("cookie", `__Host-session=${g.token}`);
    expect((await shell(keySource, database).fetch(request)).status).toBe(410);
    expect(await state(g.userId)).toMatchObject({ enabled: 1, routine_enabled: 1 });
  });
  it("已关闭通道在提交前重新同意，旧 token 仍关闭事务中的当前业务", async () => {
    const f = await fixture();
    expect(await closeBusinessMail(env.DB, f.binding, now)).toBe(true);
    let reenables = 0;
    const database = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await enable(f, now + 1);
            reenables++;
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect((await shell(keySource, database).fetch(post(f.links.oneClick))).status).toBe(204);
    expect(reenables).toBe(1);
    expect(await state(f.userId)).toMatchObject({
      enabled: 0,
      routine_enabled: 0,
      lease_expires_at: null,
    });
  });
  it("两个并发 POST 幂等，审计只记一次关闭；数据库报错整批回滚", async () => {
    const f = await fixture(),
      measured = measuredDatabase(),
      api = shell(keySource, measured.db);
    const results = await Promise.all([
      api.fetch(post(f.links.oneClick)),
      api.fetch(post(f.links.oneClick)),
    ]);
    expect(results.map((r) => r.status)).toEqual([204, 204]);
    expect(measured.writes).toHaveLength(2);
    const totals = measured.writes
      .map((batch) => batch.reduce((sum, n) => sum + n, 0))
      .sort((a, b) => a - b);
    expect(totals[0]).toBe(0);
    expect(totals[1]).toBeGreaterThan(0);
    expect(await first("SELECT COUNT(*) n FROM consent_events WHERE action='disable'")).toEqual({
      n: 2,
    });
    await enable(f, now + 1);
    const before = await state(f.userId);
    await run(
      "CREATE TRIGGER synthetic_unsubscribe_failure BEFORE INSERT ON consent_events BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    try {
      expect((await api.fetch(post(f.links.oneClick))).status).toBe(503);
    } finally {
      await env.DB.exec("DROP TRIGGER synthetic_unsubscribe_failure");
    }
    expect(await state(f.userId)).toEqual(before);
  });
  it("当前绑定没有通道行时成功且幂等；缺失绑定不新增通道", async () => {
    const f = await seed();
    const row = await first<{ email_binding_id: string }>(
      "SELECT email_binding_id FROM users WHERE id=?",
      f.userId,
    );
    const measured = measuredDatabase();
    expect(await closeBusinessMail(measured.db, row?.email_binding_id ?? "", now)).toBe(true);
    expect(await state(f.userId)).toBeNull();
    expect(await closeBusinessMail(measured.db, row?.email_binding_id ?? "", now)).toBe(true);
    expect(await state(f.userId)).toBeNull();
    expect(await closeBusinessMail(measured.db, "nonexistent", now)).toBe(false);
    expect(measured.writes).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });
  it("退订热查询不随无关用户历史增长", async () => {
    const f = await fixture();
    const query = () =>
      env.DB.prepare("SELECT id FROM users WHERE email_binding_id=? AND status='active'")
        .bind(f.binding)
        .all();
    const before = (await query()).meta.rows_read;
    await run(
      `INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at)
      SELECT 'history-'||value,-value-1,'active','history-'||value,'history-'||value,X'00',1,?,? FROM json_each(?)`,
      now,
      now,
      JSON.stringify(Array.from({ length: 2000 }, (_, i) => i)),
    );
    expect((await query()).meta.rows_read).toBe(before);
    expect(await closeBusinessMail(env.DB, f.binding, now)).toBe(true);
  });
});

describe("A-P4-UNSUB 密钥轮换、失败关闭及 Worker 接线", () => {
  it("token 绑定不可变 ID/list_scope、无明文邮箱、不逐邮件存行；MAC/版本/scope 损坏明确失效", async () => {
    const f = await fixture(),
      keys = await keySource(),
      token = await issueUnsubscribeToken(keys, f.binding);
    expect(await issueUnsubscribeToken(keys, f.binding)).toBe(token);
    expect(token).not.toContain(f.email);
    expect(await resolveUnsubscribeToken(keys, token)).toBe(f.binding);
    const variants = [
      token.replace(".business.", ".auth."),
      token.replace(".v1.", ".v2."),
      token.slice(0, -1),
      `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`,
      "unsupported",
    ];
    for (const invalid of variants)
      expect(
        (await shell().fetch(post(`https://synthetic.example/email/one-click/${invalid}`))).status,
      ).toBe(410);
    expect(await state(f.userId)).toMatchObject({ enabled: 1 });
  });
  it("部署 accepted key IDs 保留旧邮件验证能力；灾难撤销与错误配置分别 410/503", async () => {
    const f = await fixture();
    const config = {
      CRYPTO_MASTER_SECRET: toHex(randomBytes(SECRET_BITS / 8)),
      CRYPTO_OTP_PEPPER: toHex(randomBytes(SECRET_BITS / 8)),
      CRYPTO_UNSUBSCRIBE_KEY_ID: "old",
      SITE_ORIGIN: "https://synthetic.example",
    };
    const old = await environmentUnsubscribe(config)(f.binding);
    const rotated = {
      ...config,
      CRYPTO_UNSUBSCRIBE_KEY_ID: "new",
      CRYPTO_UNSUBSCRIBE_ACCEPTED_KEY_IDS: JSON.stringify(["old", "new"]),
    };
    expect(await unsubscribeAvailable(rotated)).toBe(true);
    expect((await shell(() => unsubscribeKeys(rotated)).fetch(post(old.oneClick))).status).toBe(
      204,
    );
    await enable(f, now + 1);
    const revoked = { ...rotated, CRYPTO_UNSUBSCRIBE_ACCEPTED_KEY_IDS: '["new"]' };
    expect((await shell(() => unsubscribeKeys(revoked)).fetch(post(old.oneClick))).status).toBe(
      410,
    );
    expect(await state(f.userId)).toMatchObject({ enabled: 1 });
    const invalid = { ...rotated, CRYPTO_UNSUBSCRIBE_ACCEPTED_KEY_IDS: '["old"]' };
    expect(await unsubscribeAvailable(invalid)).toBe(false);
    expect((await shell(() => unsubscribeKeys(invalid)).fetch(post(old.oneClick))).status).toBe(
      503,
    );
  });
  it("真实 Worker 挂三个入口，并且发送状态同时依赖配置、开关与退订密钥", async () => {
    const f = await fixture();
    const config = {
      ...env,
      CRYPTO_MASTER_SECRET: toHex(randomBytes(SECRET_BITS / 8)),
      CRYPTO_OTP_PEPPER: toHex(randomBytes(SECRET_BITS / 8)),
      CRYPTO_UNSUBSCRIBE_KEY_ID: "worker",
      SITE_ORIGIN: "https://synthetic.example",
      AUTH_MAIL_FROM: "auth@synthetic.example",
      BIZ_MAIL_FROM: "mail@synthetic.example",
    };
    const links = await environmentUnsubscribe(config)(f.binding);
    expect(
      (await worker.fetch(new Request(links.page), config, createExecutionContext())).status,
    ).toBe(200);
    expect(
      (await worker.fetch(post(links.page, false), config, createExecutionContext())).status,
    ).toBe(200);
    await enable(f, now + 1);
    expect(
      (await worker.fetch(post(links.oneClick), config, createExecutionContext())).status,
    ).toBe(204);
    const master = fromHex(config.CRYPTO_MASTER_SECRET),
      pepper = fromHex(config.CRYPTO_OTP_PEPPER);
    if (!master || !pepper) throw new Error("invalid_fixture_keys");
    const ring = await Keyring.create({
      masterSecret: master,
      otpPepper: pepper,
      unsubscribeMacCurrentKeyId: config.CRYPTO_UNSUBSCRIBE_KEY_ID,
    });
    await run(
      "UPDATE users SET email_ciphertext=? WHERE id=?",
      await encryptField(
        ring.fieldEncryption(),
        { type: "delivery-email-address", id: f.userId },
        f.email,
      ),
      f.userId,
    );
    const getView = async (e: typeof config) => {
      const r = await worker.fetch(
        new Request("https://synthetic.example/api/v2/me/email-channel", {
          headers: { cookie: `__Host-session=${f.token}` },
        }),
        e,
        createExecutionContext(),
      );
      expect(r.status).toBe(200);
      return ((await r.json()) as { service: { sending_available: boolean } }).service;
    };
    // 此用例只读取固定夹具的有效会话；不使用真实账号。
    await run(
      "INSERT INTO system_state(key,value_json,updated_at) VALUES ('mail_sending_available','true',?)",
      now,
    );
    expect(await getView(config)).toMatchObject({ sending_available: true });
    expect(await getView({ ...config, BIZ_MAIL_FROM: "" })).toMatchObject({
      sending_available: false,
    });
    expect(
      await getView({ ...config, SITE_ORIGIN: "https://synthetic.example/path" }),
    ).toMatchObject({ sending_available: false });
    await run("UPDATE system_state SET value_json='false' WHERE key='mail_sending_available'");
    expect(await getView(config)).toMatchObject({ sending_available: false });
  });
});
