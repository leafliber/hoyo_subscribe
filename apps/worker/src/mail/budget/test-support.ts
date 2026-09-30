// 合成账户/事实，沿 P4-02 fixture；不包含真实投递地址。

import { env } from "cloudflare:test";
import { CHANGE_TTL, MAIL_SEAT_LEASE, SUBSCRIPTION_SCHEMA_VERSION } from "@hoyo/contracts";
import { DELIVERY_ADDRESS_RECORD_TYPE } from "../../auth/challenges/delivery";
import { testKeyring } from "../../shell/test-support";
import { encryptField } from "../../storage/crypto/aead";
import { expandDispatchBatchPage, startDispatchBatch } from "../dispatch/batch";
import { selectDispatchCandidate } from "../dispatch/dispatch";
import type { DispatchProposal } from "../dispatch/types";
export const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
export const T = Date.parse("2026-09-30T23:59:00Z");
let serial = 0;
const id = () => `synthetic_p404_${++serial}`;
export const run = async (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run();
export const rows = async <A = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...params)
      .all<A>()
  ).results;
export async function user(order: number) {
  const uid = id();
  const binding = id();
  await run(
    `INSERT INTO users (id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,created_at,updated_at)
    VALUES (?,?,'active',?,?,?,1,?,?)`,
    uid,
    order,
    id(),
    binding,
    await encryptField(
      (await testKeyring).fieldEncryption(),
      { type: DELIVERY_ADDRESS_RECORD_TYPE, id: uid },
      "Synthetic.User@example.com",
    ),
    T,
    T,
  );
  await run(
    `INSERT INTO user_subscriptions (user_id,state,schema_version,revision,scope_json,calendar_json,notifications_json,created_at,updated_at)
    VALUES (?,'initialized',?,1,?,?,?,?,?)`,
    uid,
    SUBSCRIPTION_SCHEMA_VERSION,
    JSON.stringify({ games: ["genshin"], regions: ["CN"] }),
    JSON.stringify({ event_types: ["limited_event"], node_types: [], alarms_enabled: false }),
    JSON.stringify({
      rule_ids: ["limited_start_1h"],
      new_event: true,
      important_change: true,
      cancelled_or_retracted: true,
      late_discovery: true,
    }),
    T,
    T,
  );
  await run(
    `INSERT INTO email_channels (user_id,enabled,routine_enabled,consent_version,address_version,lease_expires_at,created_at,updated_at)
    VALUES (?,1,1,1,1,?,?,?)`,
    uid,
    T + MAIL_SEAT_LEASE * 24 * 60 * 60 * 1000,
    T,
    T,
  );
  for (const layer of ["seat", "routine"])
    await run(
      `INSERT INTO consent_events (id,user_id,email_binding_id,layer,action,consent_version,created_at)
    VALUES (?,?,?,?,'enable',1,?)`,
      id(),
      uid,
      binding,
      layer,
      T - 1,
    );
  for (const interest of [
    "limited_start_1h",
    "new_event",
    "important_change",
    "cancelled_or_retracted",
    "late_discovery",
  ])
    await run(
      `INSERT INTO subscription_interests (id,user_id,game,region,interest_kind,interest_id,enabled_at)
    VALUES (?,?,'genshin','CN',?,?,?)`,
      id(),
      uid,
      interest === "limited_start_1h" ? "rule" : "change_switch",
      interest,
      T - 1,
    );
  return uid;
}
interface Fact {
  eid: string;
  nid: string;
  oid: string;
  kind: string;
  due: number;
  expiry: number;
}
export async function fact(kind = "limited_start_1h", due = T, base?: Fact): Promise<Fact> {
  const eid = base?.eid ?? id();
  const nid = base?.nid ?? id();
  const oid = id();
  if (!base) {
    await run(
      `INSERT INTO events (id,game,region,event_type,status,title,event_revision,schedule_revision,created_at,updated_at)
      VALUES (?,'genshin','CN','limited_event','scheduled','合成日程',1,1,?,?)`,
      eid,
      T,
      T,
    );
    await run(
      `INSERT INTO milestones (id,event_id,milestone_key,node_type,title,time_exact_ms,source_timezone,raw_expression,time_basis,time_precision,created_at,updated_at)
      VALUES (?,?,'start','start','合成节点',?,'Asia/Shanghai','合成时刻','official_explicit','datetime',?,?)`,
      nid,
      eid,
      due + CHANGE_TTL * 1000,
      T,
      T,
    );
  }
  const expiry = due + CHANGE_TTL * 1000;
  await run(
    `INSERT INTO occurrences (id,event_id,milestone_id,schedule_revision,kind,due_at,expires_at,created_at)
    VALUES (?,?,?,1,?,?,?,?)`,
    oid,
    eid,
    nid,
    kind,
    due,
    expiry,
    T,
  );
  await run(
    "UPDATE events SET official_url='https://official.example/event',detail_path='/events/synthetic' WHERE id=?",
    eid,
  );
  return { eid, nid, oid, kind, due, expiry };
}
export async function batch(now = T) {
  const b = await startDispatchBatch(env.DB, id(), now);
  for (let i = 0; i < 1000; i++)
    if ((await expandDispatchBatchPage(env.DB, b.id, now)) === "ready") return b;
  throw new Error("合成批次未完成");
}
export async function select(bid: string, now = T): Promise<DispatchProposal> {
  for (let i = 0; i < 1000; i++) {
    const result = await selectDispatchCandidate(env.DB, bid, now);
    if (result.outcome === "advanced") continue;
    if (result.outcome !== "candidate") throw new Error(`需要候选，实际 ${result.outcome}`);
    return result.proposal;
  }
  throw new Error("未取得合成候选");
}
