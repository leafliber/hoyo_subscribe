import { readFeedState } from "../../calendar/feed/store";
import { makeUnsubscribeRoutes } from "../../mail/unsubscribe/routes";
import { closeBusinessMail } from "../../mail/unsubscribe/service";
import { unsubscribeLinks } from "../../mail/unsubscribe/token";
import { createApiShell } from "../../shell";
import { fakeExecutionContext, testKeyring } from "../../shell/test-support";
import { observeDatabase } from "./test-observer";
import "../../admin/test-support";
import { env } from "cloudflare:test";
import {
  ACCOUNT_GRACE_DAYS,
  ACCOUNT_IDLE_DAYS,
  ACCOUNT_MAX_STORED,
  CONSENT_AUDIT_AFTER_CLOSE,
  EXPIRED_SESSION_METADATA,
  GLOBAL_MUTATIONS_DAY,
  MATCH_PAGE,
  mutationCounterKeys,
  RECLAIM_QUERY_BUDGET,
  RECLAIM_TELEMETRY_STALE_HOURS,
  SYSTEM_AUDIT_TTL,
  USER_MUTATIONS_DAY,
  utcDayPeriod,
} from "@hoyo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarLifecycle } from "../../calendar/manage/hooks";
import { emailLifecycleHook } from "../../mail/channel/hooks";
import { maintainReclaim } from "../../scheduled/reclaim";
import { readMetric } from "../../shell/observability/metrics";
import { readReclaimGate, recordActivityFailure } from "../activity/telemetry";
import { cleanupDeletedAccountPage } from "../lifecycle/cleanup";
import { maintainSystemAuditPage } from "./audit";
import { cleanupRetentionPage } from "./retention";
import { confirmReclaim, listReclaimCandidates, scanAccountPage } from "./service";

const T = 1900000000000,
  DAY = 86400000;
const hooks = [calendarLifecycle, emailLifecycleHook];
async function set(key: string, value: boolean) {
  await env.DB.prepare(
    "INSERT INTO system_state(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
  )
    .bind(key, JSON.stringify(value), T)
    .run();
}
async function gate() {
  for (const k of ["account_reclaim_enabled", "seat_reclaim_enabled"]) await set(k, true);
  await set("reclaim_paused", false);
  await env.DB.prepare(
    "INSERT INTO activity_write_failures(metric,utc_day,failures,last_success_at,updated_at) VALUES('feed_poll_merge',?,0,?,?)",
  )
    .bind(utcDayPeriod(T).key, T, T)
    .run();
}
async function user(
  id = "synthetic-user",
  order = 1,
  activity = T - (ACCOUNT_IDLE_DAYS + ACCOUNT_GRACE_DAYS) * DAY,
) {
  await env.DB.prepare(
    `INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,last_interactive_at,created_at,updated_at) VALUES(?,?,'active',?,?,X'01',1,?,?,?)`,
  )
    .bind(id, order, `key:${id}`, `binding:${id}`, activity, activity, activity)
    .run();
  return id;
}
async function seat(id: string) {
  await env.DB.prepare(
    "INSERT INTO email_channels(user_id,enabled,routine_enabled,address_version,lease_expires_at,last_renewed_at,consent_version,created_at,updated_at) VALUES(?,1,1,1,?,?,1,?,?)",
  )
    .bind(id, T - 1, T - (ACCOUNT_IDLE_DAYS + ACCOUNT_GRACE_DAYS) * DAY, T - DAY, T - DAY)
    .run();
}
async function candidate(id: string, kind: "account" | "seat" = "account") {
  const row = await env.DB.prepare(
    `SELECT MAX(COALESCE(last_interactive_at,created_at),COALESCE(last_feed_poll_at,created_at),COALESCE(last_push_processed_at,created_at)) AS activity_at,reclaim_grace_until AS grace_until,COALESCE((SELECT channel_revision FROM email_channels WHERE user_id=users.id),0) AS channel_revision FROM users WHERE id=?`,
  )
    .bind(id)
    .first<{ activity_at: number; grace_until: number; channel_revision: number }>();
  if (!row) throw new Error("missing fixture");
  return { ...row, user_id: id, kind, reason: "synthetic review" };
}
async function ready(id: string) {
  await env.DB.prepare("UPDATE users SET reclaim_grace_until=? WHERE id=?").bind(T, id).run();
}
beforeEach(async () => {
  await env.DB.exec(
    `DELETE FROM recovery_rotations; DELETE FROM recent_auth_proofs; DELETE FROM recent_auth_challenges; DELETE FROM auth_challenges; DELETE FROM recovery_credentials; DELETE FROM sessions; DELETE FROM calendar_feeds; DELETE FROM push_bindings; DELETE FROM consent_events; DELETE FROM email_channels; DELETE FROM usage_periods; DELETE FROM mail_feedback; DELETE FROM mail_outbox; DELETE FROM subscription_interests; DELETE FROM user_subscriptions; DELETE FROM users; DELETE FROM capacity_state; DELETE FROM audit_log; DELETE FROM system_state; DELETE FROM activity_write_failures;`,
  );
});

describe("A-P5-RECLAIM 回收保护及自动续租", () => {
  it("缺持久暂停记录，即使两个开关和新鲜水位齐全仍全局暂停", async () => {
    await gate();
    await env.DB.prepare("DELETE FROM system_state WHERE key='reclaim_paused'").run();
    const id = await user();
    await seat(id);
    await ready(id);
    expect(await readReclaimGate(env.DB, T)).toMatchObject({
      accounts_paused: true,
      seats_paused: true,
    });
    await expect(confirmReclaim(env.DB, await candidate(id), "owner", T, hooks)).rejects.toThrow();
    await expect(
      confirmReclaim(env.DB, await candidate(id, "seat"), "owner", T, hooks),
    ).rejects.toThrow();
    expect(await env.DB.prepare("SELECT enabled FROM email_channels").first("enabled")).toBe(1);
  });
  it.each(["missing", "stale", "failure"] as const)(
    "遥测 %s 时不进入宽限且不释放席位",
    async (mode) => {
      await gate();
      if (mode === "missing") await env.DB.exec("DELETE FROM activity_write_failures");
      if (mode === "stale")
        await env.DB.prepare("UPDATE activity_write_failures SET last_success_at=?")
          .bind(T - RECLAIM_TELEMETRY_STALE_HOURS * 3600000 - 1)
          .run();
      if (mode === "failure") await recordActivityFailure(env.DB, T);
      const id = await user();
      await seat(id);
      await scanAccountPage(env.DB, T, 0);
      expect(
        await env.DB.prepare("SELECT reclaim_grace_until FROM users").first("reclaim_grace_until"),
      ).toBeNull();
      expect(await readMetric(env.DB, "seat_released", T)).toBeNull();
    },
  );
  it("Feed 使用但不访网页：后台分页自动续租、解除宽限，不写交互水位", async () => {
    await gate();
    const id = await user();
    await seat(id);
    await ready(id);
    await env.DB.prepare(
      `INSERT INTO user_subscriptions(user_id,state,schema_version,scope_json,calendar_json,notifications_json,created_at,updated_at) VALUES(?,'initialized',3,'{"games":["genshin"]}','{"event_types":["activity"]}','{}',?,?)`,
    )
      .bind(id, T - DAY, T - DAY)
      .run();
    await env.DB.prepare(
      `INSERT INTO calendar_feeds(user_id,namespace,state,token_hash,token_ciphertext,recovery_epoch,changed_at,created_at,updated_at) VALUES(?,'synthetic-ns','enabled','synthetic-hash',X'01',0,?,?,?)`,
    )
      .bind(id, T - DAY, T - DAY, T - DAY)
      .run();
    expect(await readFeedState(env.DB, "synthetic-hash", T)).not.toBeNull();
    expect(await readFeedState(env.DB, "synthetic-hash", T + 1)).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT last_feed_poll_at FROM users").first("last_feed_poll_at"),
    ).toBe(T);
    const before = await env.DB.prepare("SELECT last_interactive_at FROM users").first(
      "last_interactive_at",
    );
    await scanAccountPage(env.DB, T, 0);
    expect(
      await env.DB.prepare("SELECT reclaim_grace_until FROM users").first("reclaim_grace_until"),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT last_interactive_at FROM users").first("last_interactive_at"),
    ).toBe(before);
    expect(
      await env.DB.prepare(
        "SELECT last_renewed_reason,lease_expires_at FROM email_channels",
      ).first(),
    ).toMatchObject({
      last_renewed_reason: "last_feed_poll_at",
      lease_expires_at: expect.any(Number),
    });
    expect((await readMetric(env.DB, "seat_renewed", T))?.count).toBe(1);
    expect((await listReclaimCandidates(env.DB, T)).candidates).toEqual([]);
  });
  it("只有沉睡进入宽限，无人确认或尚在宽限均不清理", async () => {
    await gate();
    const id = await user();
    await seat(id);
    await scanAccountPage(env.DB, T, 0);
    expect((await listReclaimCandidates(env.DB, T)).candidates[0]).toMatchObject({
      id,
      reclaim_grace_until: T + ACCOUNT_GRACE_DAYS * DAY,
    });
    await expect(confirmReclaim(env.DB, await candidate(id), "owner", T, hooks)).rejects.toThrow();
    await maintainReclaim(env.DB, () => T);
    expect(await env.DB.prepare("SELECT status FROM users").first("status")).toBe("active");
    expect(await env.DB.prepare("SELECT enabled FROM email_channels").first("enabled")).toBe(1);
  });
  it("账号/席位开关独立；删除开启席位的账号也必须通过席位门", async () => {
    await gate();
    const id = await user();
    await seat(id);
    await ready(id);
    await set("seat_reclaim_enabled", false);
    expect(await readReclaimGate(env.DB, T)).toMatchObject({
      accounts_paused: false,
      seats_paused: true,
    });
    await expect(confirmReclaim(env.DB, await candidate(id), "owner", T, hooks)).rejects.toThrow();
    await set("seat_reclaim_enabled", true);
    await set("account_reclaim_enabled", false);
    await confirmReclaim(env.DB, await candidate(id, "seat"), "owner", T, hooks);
    expect(await env.DB.prepare("SELECT status FROM users").first("status")).toBe("active");
    expect((await readMetric(env.DB, "seat_released", T))?.count).toBe(1);
  });
  it("活动、通道版本更新使旧清单失效；失败不计 seat_released", async () => {
    await gate();
    const id = await user();
    await seat(id);
    await ready(id);
    const old = await candidate(id);
    await env.DB.prepare("UPDATE users SET last_feed_poll_at=?").bind(T).run();
    await expect(confirmReclaim(env.DB, old, "owner", T, hooks)).rejects.toThrow();
    expect(await readMetric(env.DB, "seat_released", T)).toBeNull();
  });
  it("并发确认只释放一次；不退日额度；所有页清完才释放账号存量", async () => {
    await gate();
    const id = await user();
    await seat(id);
    await ready(id);
    await env.DB.batch(
      ["accounts_total", "registrations:synthetic", "mutations:user:synthetic"].map((key) =>
        env.DB.prepare(
          "INSERT INTO capacity_state(key,value,version,updated_at) VALUES(?,1,0,?)",
        ).bind(key, T),
      ),
    );
    const mutationKeys = mutationCounterKeys(id, utcDayPeriod(T).key);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO capacity_state(key,value,version,updated_at) VALUES(?,?,0,?)",
      ).bind(mutationKeys.userKey, USER_MUTATIONS_DAY, T),
      env.DB.prepare(
        "INSERT INTO capacity_state(key,value,version,updated_at) VALUES(?,?,0,?)",
      ).bind(mutationKeys.globalKey, GLOBAL_MUTATIONS_DAY, T),
      env.DB.prepare(
        "INSERT INTO usage_periods(id,pool,period_kind,period_key,user_id,settled,reserved,uncertain,period_start,period_end,created_at,updated_at) VALUES('synthetic-ledger','base_business','utc_day',?,?,1,0,0,?,?,?,?)",
      ).bind(
        utcDayPeriod(T).key,
        id,
        utcDayPeriod(T).startMs,
        utcDayPeriod(T).endMsExclusive,
        T,
        T,
      ),
    ]);
    const countersBefore = (
      await env.DB.prepare(
        "SELECT * FROM capacity_state WHERE key<>'accounts_total' ORDER BY key",
      ).all()
    ).results;
    const ledgerBefore = await env.DB.prepare(
      "SELECT * FROM usage_periods WHERE id='synthetic-ledger'",
    ).first();
    const input = await candidate(id);
    const result = await Promise.allSettled([
      confirmReclaim(env.DB, input, "owner", T, hooks),
      confirmReclaim(env.DB, input, "owner", T, hooks),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await readMetric(env.DB, "seat_released", T))?.count).toBe(1);
    expect(
      await env.DB.prepare("SELECT value FROM capacity_state WHERE key='accounts_total'").first(
        "value",
      ),
    ).toBe(1);
    for (let n = 0; n < 30; n++) {
      if ((await cleanupDeletedAccountPage(env.DB, id, MATCH_PAGE, T)).state === "complete") break;
    }
    expect(
      await env.DB.prepare("SELECT value FROM capacity_state WHERE key='accounts_total'").first(
        "value",
      ),
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT * FROM capacity_state WHERE key<>'accounts_total' ORDER BY key",
        ).all()
      ).results,
    ).toEqual(countersBefore);
    expect(
      await env.DB.prepare("SELECT * FROM usage_periods WHERE id='synthetic-ledger'").first(),
    ).toEqual(ledgerBefore);
    expect(
      await env.DB.prepare("SELECT email_ciphertext,deletion_completed_at FROM users").first(
        "deletion_completed_at",
      ),
    ).toBe(T);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM consent_events").first("n")).toBe(2);
  });
  it("最终 batch 前关门：拒绝回收且不写审计和释放指标", async () => {
    await gate();
    const id = await user();
    await seat(id);
    await ready(id);
    const input = await candidate(id, "seat");
    const batch = env.DB.batch.bind(env.DB);
    let intercepted = 0;
    const spy = vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      intercepted++;
      await set("seat_reclaim_enabled", false);
      return batch(statements);
    });
    try {
      await expect(confirmReclaim(env.DB, input, "owner", T, hooks)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(intercepted).toBe(1);
    expect(await env.DB.prepare("SELECT enabled FROM email_channels").first("enabled")).toBe(1);
    expect(await readMetric(env.DB, "seat_released", T)).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM audit_log").first("n")).toBe(0);
  });
  it("超过一页的扫描有持久进度，满负载调用不超过 SQL 预算", async () => {
    await gate();
    const activity = T - (ACCOUNT_IDLE_DAYS + ACCOUNT_GRACE_DAYS) * DAY;
    await env.DB.prepare(`INSERT INTO users(id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,last_interactive_at,created_at,updated_at)
      SELECT 'synthetic-'||value,value,'active','synthetic-key-'||value,'synthetic-binding-'||value,X'01',1,?,?,? FROM json_each(?)`)
      .bind(
        activity,
        activity,
        activity,
        JSON.stringify(Array.from({ length: ACCOUNT_MAX_STORED }, (_, i) => i + 1)),
      )
      .run();
    const results = [];
    for (let n = 0; n < Math.ceil(ACCOUNT_MAX_STORED / MATCH_PAGE); n++) {
      const measured = observeDatabase(env.DB);
      const result = await maintainReclaim(measured.db, () => T);
      expect(measured.stats.queries).toBeLessThanOrEqual(result.queries);
      results.push({ ...result, actual: measured.stats });
      if (result.completed) break;
    }
    expect(results.some((r) => !r.completed)).toBe(true);
    expect(results.every((r) => r.queries <= RECLAIM_QUERY_BUDGET)).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM users WHERE reclaim_grace_until IS NOT NULL",
      ).first("n"),
    ).toBe(ACCOUNT_MAX_STORED);
    console.log("synthetic reclaim query bounds", JSON.stringify(results));
  });
});

describe("A-P5-RECLAIM 保留与历史审计校正", () => {
  it("系统旧行先按 created_at 校正，未到期保留、到期删除、管理员不改", async () => {
    const records = [
      ["recent", "system", T - DAY, T - DAY],
      ["old", "system", T - SYSTEM_AUDIT_TTL * 1000 - 1, T + DAY],
      ["admin", "admin", T - DAY, T - DAY],
    ];
    for (const [id, type, created, expires] of records)
      await env.DB.prepare(
        "INSERT INTO audit_log(id,actor_type,actor_id,action,target_type,created_at,expires_at) VALUES(?,?,'synthetic','fixture','fixture',?,?)",
      )
        .bind(id, type, created, expires)
        .run();
    await maintainSystemAuditPage(env.DB, T);
    expect(
      await env.DB.prepare("SELECT expires_at FROM audit_log WHERE id='recent'").first(
        "expires_at",
      ),
    ).toBe(T - DAY + SYSTEM_AUDIT_TTL * 1000);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE id='old'").first("n")).toBe(
      1,
    );
    await maintainSystemAuditPage(env.DB, T);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE id='old'").first("n")).toBe(
      0,
    );
    expect(
      await env.DB.prepare("SELECT expires_at FROM audit_log WHERE id='admin'").first("expires_at"),
    ).toBe(T - DAY);
  });
  it("正式会话按自身到期撤销，不影响活跃 Feed 账号；元数据过保留期清 token", async () => {
    const id = await user();
    await env.DB.prepare("UPDATE users SET last_feed_poll_at=?").bind(T).run();
    await env.DB.prepare(
      `INSERT INTO sessions(id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,expires_at,renewed_at,auth_epoch,recovery_epoch,created_at,updated_at) VALUES('session',?,'synthetic-token','active','synthetic','unknown',0,?,?,0,0,0,0,0)`,
    )
      .bind(id, T, T - 1)
      .run();
    await cleanupRetentionPage(env.DB, T);
    expect(await env.DB.prepare("SELECT state FROM sessions").first("state")).toBe("revoked");
    await cleanupRetentionPage(env.DB, T + EXPIRED_SESSION_METADATA * 1000);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM sessions").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT status FROM users").first("status")).toBe("active");
  });
  it("关闭同意历史在保留期后清理，账号邮箱绑定及抑制不删除", async () => {
    const id = await user();
    await seat(id);
    await env.DB.prepare(
      "INSERT INTO consent_events(id,user_id,email_binding_id,layer,action,consent_version,created_at) VALUES('consent',?,?,'seat','disable',1,?)",
    )
      .bind(id, `binding:${id}`, T - CONSENT_AUDIT_AFTER_CLOSE * 1000 - 1)
      .run();
    await cleanupRetentionPage(env.DB, T);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM consent_events").first("n")).toBe(1);
    await env.DB.prepare("UPDATE email_channels SET enabled=0,routine_enabled=0,updated_at=?")
      .bind(T - CONSENT_AUDIT_AFTER_CLOSE * 1000 - 1)
      .run();
    await cleanupRetentionPage(env.DB, T);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM consent_events").first("n")).toBe(0);
    expect(
      await env.DB.prepare("SELECT email_binding_id FROM users").first("email_binding_id"),
    ).toBe(`binding:${id}`);
  });
});

it("A-P5-RECLAIM 发信接受、投递成功及有效退订页扫描均不续租；退订不计自动释放", async () => {
  await gate();
  const id = await user();
  await seat(id);
  await env.DB.prepare(
    "INSERT INTO mail_outbox(id,purpose,priority,period_key,recipient_user_id,address_version,payload_kind,status,message_id,sent_at,created_at,updated_at) VALUES('sent','base_business',4,'synthetic',?,1,'synthetic','accepted','synthetic-message',?,?,?)",
  )
    .bind(id, T, T, T)
    .run();
  await env.DB.prepare(
    "INSERT INTO mail_feedback(id,provider_event_id,message_id,mail_outbox_id,kind,feedback_at,created_at) VALUES('feedback','synthetic','synthetic-message','sent','delivered',?,?)",
  )
    .bind(T, T)
    .run();
  const keys = async () => (await testKeyring).unsubscribeMac();
  const links = await unsubscribeLinks(await keys(), "https://app.test", `binding:${id}`);
  const shell = createApiShell({
    authenticator: {
      authenticate: async () => {
        throw new Error("capability must not authenticate");
      },
    },
    routes: makeUnsubscribeRoutes({ keys, now: () => T }),
  });
  const res = await shell.fetch(new Request(links.page), env, fakeExecutionContext);
  expect(res.status).toBe(200);
  await scanAccountPage(env.DB, T, 0);
  expect(
    await env.DB.prepare("SELECT reclaim_grace_until FROM users").first("reclaim_grace_until"),
  ).toBe(T + ACCOUNT_GRACE_DAYS * DAY);
  expect(await readMetric(env.DB, "seat_renewed", T)).toBeNull();
  await closeBusinessMail(env.DB, `binding:${id}`, T);
  expect(await readMetric(env.DB, "seat_released", T)).toBeNull();
});
it("A-P5-RECLAIM 审计 SQL 失败整批回滚，Feed/会话/席位与释放指标不变", async () => {
  await gate();
  const id = await user();
  await seat(id);
  await ready(id);
  await env.DB.exec(
    "CREATE TRIGGER synthetic_reclaim_audit_failure BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;",
  );
  try {
    await expect(confirmReclaim(env.DB, await candidate(id), "owner", T, hooks)).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER synthetic_reclaim_audit_failure");
  }
  expect(await env.DB.prepare("SELECT status FROM users").first("status")).toBe("active");
  expect(await env.DB.prepare("SELECT enabled FROM email_channels").first("enabled")).toBe(1);
  expect(await readMetric(env.DB, "seat_released", T)).toBeNull();
});

it("A-P5-RECLAIM 满页同时续租的真实 SQL 成本在参数依赖上界内", async () => {
  await gate();
  for (let n = 1; n <= MATCH_PAGE; n++) {
    const id = await user(`synthetic-renew-${n}`, n);
    await seat(id);
    await env.DB.prepare("UPDATE users SET last_feed_poll_at=? WHERE id=?").bind(T, id).run();
  }
  const measured = observeDatabase(env.DB);
  await scanAccountPage(measured.db, T, 0);
  expect(measured.stats.queries).toBeLessThanOrEqual(9 * MATCH_PAGE + 1);
  expect((await readMetric(env.DB, "seat_renewed", T))?.count).toBe(MATCH_PAGE);
  console.log("A-P5-RECLAIM full renewal page", JSON.stringify(measured.stats));
});

it("A-P5-RECLAIM 保留正式证据引用与未知/未完成发送，合法退订绑定不依赖可清元数据", async () => {
  const id = await user();
  for (const status of ["accepted", "unknown", "pending"])
    await env.DB.prepare(
      "INSERT INTO mail_outbox(id,purpose,priority,period_key,recipient_user_id,address_version,payload_kind,status,created_at,updated_at) VALUES(?,'base_business',4,'synthetic',?,1,'synthetic',?,0,0)",
    )
      .bind(status, id, status)
      .run();
  await env.DB.prepare(
    `INSERT INTO sources(source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,verification_state,created_at,updated_at) VALUES('synthetic-evidence-source','genshin','cn','synthetic','[]','[]','{}','{}','synthetic',0,0)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO articles(id,source_id,external_id,official_url,first_seen_at,last_checked_at,created_at,updated_at) VALUES('synthetic-evidence-article','synthetic-evidence-source','synthetic','https://synthetic.example',0,0,0,0)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO article_versions(id,article_id,version_no,content_hash,body_blocks_json,media_refs_json,completeness,fetched_at,created_at) VALUES('synthetic-evidence-version','synthetic-evidence-article',1,'synthetic','[]','[]','complete',0,0)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO candidates(id,proposal_json,review_status,created_at,updated_at) VALUES('synthetic-evidence-candidate','{}','approved',0,0)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO evidence(id,candidate_id,article_version_id,block_ref,created_at) VALUES('synthetic-evidence','synthetic-evidence-candidate','synthetic-evidence-version','synthetic',0)`,
  ).run();
  await cleanupRetentionPage(env.DB, T);
  expect(
    (
      await env.DB.prepare("SELECT id FROM mail_outbox ORDER BY id").all<{ id: string }>()
    ).results.map((r) => r.id),
  ).toEqual(["pending", "unknown"]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM article_versions WHERE id='synthetic-evidence-version'",
    ).first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM evidence WHERE id='synthetic-evidence'").first(
      "n",
    ),
  ).toBe(1);
  expect(await env.DB.prepare("SELECT email_binding_id FROM users").first("email_binding_id")).toBe(
    `binding:${id}`,
  );
});
