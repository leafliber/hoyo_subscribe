import { env } from "cloudflare:test";
import { SECRET_BITS, utcDayPeriod } from "@hoyo/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryRuntime } from "../../executors/delivery/runtime";
import { randomBytes, testKeyring } from "../../shell/test-support";
import { toHex } from "../../storage/crypto/bytes";
import { readMailDayLedger } from "../../storage/ledger/mail-ledger";
import { splitSqlStatements } from "../../storage/split-sql";
import { batch, fact, migrations, rows, run, T, user } from "../budget/test-support";
import { mailDependencies } from "../provider/environment";
import { NativeMailProvider } from "../provider/native";
import { authTemplate, type DigestNode, digestTemplate } from "../provider/templates";
import type { NativeMailBinding } from "../provider/types";
import { unsubscribeKeys } from "./environment";
import { resolveUnsubscribeToken } from "./token";

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await env.DB.batch(
      splitSqlStatements(migrations[path] ?? "").map((sql) => env.DB.prepare(sql)),
    );
});
beforeEach(async () => {
  for (const table of [
    "system_state",
    "deliveries",
    "mail_outbox",
    "usage_periods",
    "dispatch_cursors",
    "jobs",
    "occurrences",
    "milestones",
    "events",
    "consent_events",
    "email_channels",
    "subscription_interests",
    "user_subscriptions",
    "users",
  ])
    await env.DB.exec(`DELETE FROM ${table}`);
});

describe("A-P4-UNSUB 业务依赖注入与邮件内容", () => {
  it("注入真实退订依赖后业务批次开始运行，真实 provider 适配器通过替身发信并带两个退订头", async () => {
    const uid = await user(1);
    await fact("cancelled_or_retracted");
    await batch();
    await run(
      "INSERT INTO system_state(key,value_json,updated_at) VALUES ('mail_sending_available','true',?)",
      T,
    );
    const nativeSend = vi.fn<NativeMailBinding["send"]>(async () => ({
      messageId: "synthetic-message",
    }));
    const config = {
      ...env,
      CRYPTO_MASTER_SECRET: toHex(randomBytes(SECRET_BITS / 8)),
      CRYPTO_OTP_PEPPER: toHex(randomBytes(SECRET_BITS / 8)),
      CRYPTO_UNSUBSCRIBE_KEY_ID: "integration",
      SITE_ORIGIN: "https://synthetic.example",
      AUTH_MAIL_FROM: "auth@synthetic.example",
      BIZ_MAIL_FROM: "mail@synthetic.example",
      BIZ_MAILER: { send: nativeSend } as unknown as Env["BIZ_MAILER"],
    };
    const actual = mailDependencies(config);
    // 原有 fixture 的地址密文使用 testKeyring；保留真实 environment 退订函数和 provider 适配器。
    const deps = {
      ...actual,
      now: () => T,
      fieldKey: async () => (await testKeyring).fieldEncryption(),
    };
    await new DeliveryRuntime({ ...deps, unsubscribe: undefined }).tick();
    expect(await rows("SELECT id FROM mail_outbox")).toHaveLength(0);
    expect(await rows("SELECT pool FROM usage_periods")).toHaveLength(0);
    expect(nativeSend).not.toHaveBeenCalled();
    const runtime = new DeliveryRuntime(deps);
    for (let pass = 0; pass < 8; pass++) await runtime.tick();
    expect(nativeSend).toHaveBeenCalledOnce();
    expect(await rows("SELECT status FROM mail_outbox")).toEqual([{ status: "accepted" }]);
    expect(
      (await readMailDayLedger(env.DB, utcDayPeriod(T).key, uid)).pools.urgent_business,
    ).toEqual({ reserved: 0, uncertain: 0, settled: 1 });
    const message = nativeSend.mock.calls[0][0];
    expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const header = message.headers?.["List-Unsubscribe"] ?? "";
    expect(header.startsWith("<https://synthetic.example/email/one-click/")).toBe(true);
    const token = new URL(header.slice(1, -1)).pathname.split("/").pop() ?? "";
    const binding = await resolveUnsubscribeToken(await unsubscribeKeys(config), token);
    expect(await rows("SELECT id FROM users WHERE email_binding_id=?", binding)).toEqual([
      { id: uid },
    ]);
    expect(message.text).toContain("https://synthetic.example/unsubscribe/");
    expect(message.text).toContain("取消或撤回");
    expect(message.text).not.toContain("cancelled_or_retracted");
  });
  it("认证信始终没有退订头；合并信中文标签、北京时间与转义正确，纯日期不补午夜", async () => {
    const send = vi.fn<NativeMailBinding["send"]>(async () => ({ messageId: "synthetic" }));
    const provider = new NativeMailProvider({
      auth: { send },
      business: { send },
      authSender: "auth@synthetic.example",
      businessSender: "mail@synthetic.example",
    });
    const auth = authTemplate(
      "synthetic@example.test",
      "synthetic-code",
      Date.parse("2026-10-01T23:00:00Z"),
    );
    await provider.send({
      ...auth,
      unsubscribe: {
        page: "https://synthetic.example/unsubscribe/synthetic",
        oneClick: "https://synthetic.example/email/one-click/synthetic",
      },
    });
    expect(send.mock.calls[0][0].headers).toBeUndefined();
    expect(auth.text).not.toContain("退订");
    const node: DigestNode = {
      event_title: '<img src="x">',
      node_title: "合成节点",
      node_type: "start",
      kind: "late_discovery",
      time_exact_ms: Date.parse("2026-10-01T23:00:00Z"),
      time_date: null,
      time_precision: "datetime",
      source_timezone: "Asia/Shanghai",
      time_basis: "official_explicit",
      raw_expression: "合成原文",
      reason: null,
      official_url: "https://official.example/event",
      detail_path: "/events/synthetic",
    };
    const links = {
      page: "https://synthetic.example/unsubscribe/synthetic",
      oneClick: "https://synthetic.example/email/one-click/synthetic",
    };
    const mail = digestTemplate(
      "synthetic@example.test",
      [
        node,
        {
          ...node,
          node_type: "reward_deadline",
          time_exact_ms: null,
          time_precision: "date",
          time_date: "2026-10-03",
          time_basis: "official_estimate",
          kind: "rule",
        },
      ],
      "https://synthetic.example",
      links,
    );
    expect(mail.text).toContain("2026/10/02 07:00:00（北京时间 UTC+8）");
    expect(mail.text).toContain("开始");
    expect(mail.text).toContain("奖励领取截止");
    expect(mail.text).toContain("官方明确时间");
    expect(mail.text).toContain("官方预计时间");
    expect(mail.text).toContain("常规提前提醒");
    expect(mail.text).toContain("时间：2026-10-03\n");
    expect(mail.text).not.toContain("2026-10-03T00");
    expect(mail.text).toContain("不代表活动正在进行或尚未结束");
    for (const raw of [
      "official_explicit",
      "official_estimate",
      "late_discovery",
      "reward_deadline",
    ])
      expect(mail.text).not.toContain(raw);
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img");
  });
});
