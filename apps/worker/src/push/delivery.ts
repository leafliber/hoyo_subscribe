// P6-02 · 业务通知的 Push 展开与后台外发（主方案 §7.1、§7.3、§7.4、§7.8、§9.1；ADR-0025）。
//
// - 展开：发生项到期并冻结受众 order 上界后（邮件起步时写入 occurrences.audience_upper_order），
//   为它补建一条 `occurrence:{id}:push` 待办，按同一上界 keyset 分页；目标是 binding_id（§7.1）。
//   去重族 (node, schedule_revision, rule/kind, 'push', binding_id) 与邮件同一规范串、同一唯一键。
//   每页 Delivery（"通知谁"）、push_messages（"实际哪一条"）与游标同一条件提交。
// - 资格：兴趣匹配与邮件共用 matchesSubscriptionInterest；Push 另要求绑定 active、租期有效、
//   且在 due_at 前已激活（"通道在 due_at 前已生效"，§7.1）。外发前再次复核。
// - 预算：PUSH_SEND_DAY 含业务、激活、测试与重试；非关键外发不能动用 PUSH_CRITICAL_RESERVED_DAY。
//   预算在领取外发的同一条件提交里记账；用尽时非关键消息推到下一 UTC 日（仍受自身有效期约束）。
// - 顺序：按优先级、创建时间、随机 ID；不按注册顺序，后注册用户不会被永久排在后面（§7.3）。
// - 不发静默心跳：只有业务、激活、测试三种可见通知（§7.8）。
import {
  EXECUTOR_BATCH_WALL_LIMIT,
  isCriticalPushKind,
  MATCH_PAGE,
  pushCounterKeys,
  pushSendDayLimit,
  SEND_CONCURRENCY,
  utcDayPeriod,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { classifyPipelineFailure, PipelineDataError } from "../executors/pipeline/failure";
import {
  loadInterests,
  matchesSubscriptionInterest,
  OCCURRENCE_SELECT,
  type OccurrenceMatch,
  occurrenceDeliveryKind,
  occurrencePriority,
  occurrenceRuleId,
} from "../mail/occurrences/eligibility";
import { logEvent } from "../shell/logger";
import { controlPredicate, controlsAllow } from "../shell/observability/controls";
import { recordMetric } from "../shell/observability/metrics";
import { conditionalCommit, type GuardedEffect } from "../storage/cas";
import type { Keyring } from "../storage/crypto/keyring";
import type { PushTransport } from "./client";
import type { PushConfig } from "./config";
import { type BusinessNode, businessPayload, sendPushMessage } from "./outbound";
import { openBindingSecrets, type PushBindingRow } from "./store";

export const PUSH_EXPANSION_JOB_KIND = "occurrence_push_expansion";
export function pushExpansionJobId(occurrenceId: string): string {
  return `occurrence:${occurrenceId}:push`;
}

export interface PushSendDeps {
  readonly db: D1Database;
  readonly keys: () => Promise<Keyring>;
  readonly config: () => Promise<PushConfig | null>;
  readonly transport: PushTransport;
}

/**
 * 已冻结受众上界、仍有效的发生项补建 Push 展开待办；没有任何 active 绑定时不建
 * （此后才激活的绑定晚于 due_at，本来就不在受众里）。幂等：待办 ID 唯一。
 */
export async function startPushExpansions(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO jobs(id,kind,payload_json,due_at,status,created_at,updated_at)
    SELECT 'occurrence:'||o.id||':push', ?, json_object('occurrence_id',o.id,'cursor',-1,'upper',o.audience_upper_order),
      ?, 'pending', ?, ?
    FROM occurrences o INDEXED BY idx_occurrences_expiry
    WHERE o.expires_at>? AND o.audience_upper_order IS NOT NULL AND o.invalidated_at IS NULL AND o.due_at<=?
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id='occurrence:'||o.id||':push')
      AND EXISTS (SELECT 1 FROM push_bindings WHERE state='active')
    ORDER BY o.due_at, o.id LIMIT ?
    ON CONFLICT(id) DO NOTHING`)
    .bind(PUSH_EXPANSION_JOB_KIND, now, now, now, now, now, MATCH_PAGE)
    .run();
  return result.meta.changes ?? 0;
}

interface PushAudienceRow {
  id: string;
  user_order: number;
  status: string;
  subscription_state: string | null;
  subscription_revision: number | null;
  scope_json: string | null;
  calendar_json: string | null;
  notifications_json: string | null;
}
const PUSH_AUDIENCE_SELECT = `SELECT u.id, u."order" AS user_order, u.status, s.state AS subscription_state,
  s.revision AS subscription_revision, s.scope_json, s.calendar_json, s.notifications_json
  FROM users u LEFT JOIN user_subscriptions s ON s.user_id = u.id`;

interface ActiveBinding {
  id: string;
  activated_at: number | null;
  lease_expires_at: number | null;
}
/** 绑定在发生项到期前已激活、租期仍有效（"通道在 due_at 前已生效"）。 */
function bindingEligible(
  binding: ActiveBinding,
  occurrence: OccurrenceMatch,
  now: number,
): boolean {
  return (
    binding.activated_at !== null &&
    binding.activated_at <= occurrence.due_at &&
    binding.lease_expires_at !== null &&
    binding.lease_expires_at > now
  );
}
function occurrenceValid(occurrence: OccurrenceMatch, now: number): boolean {
  return (
    occurrence.invalidated_at === null &&
    occurrence.current_schedule_revision === occurrence.schedule_revision &&
    occurrence.expires_at > now
  );
}

interface PushJob {
  id: string;
  payload_json: string;
  lease_version: number;
  attempts: number;
}

/** 推进一页 Push 展开；返回是否做了工作。单个待办失败只停它自己，下一个 watchdog 周期重试。 */
export async function expandPushPage(db: D1Database, now: number): Promise<boolean> {
  const job = await db
    .prepare(`SELECT id,payload_json,lease_version,attempts FROM jobs WHERE kind=? AND status='pending' AND due_at<=?
    ORDER BY due_at,id LIMIT 1`)
    .bind(PUSH_EXPANSION_JOB_KIND, now)
    .first<PushJob>();
  if (job === null) return false;
  try {
    await expandPushJob(db, job, now);
  } catch (error) {
    const failure = classifyPipelineFailure(error);
    await db
      .prepare(`UPDATE jobs SET status=?,due_at=?,lease_version=lease_version+1,attempts=attempts+1,last_error=?,updated_at=?
      WHERE id=? AND status='pending' AND lease_version=?`)
      .bind(
        failure.terminal ? "failed" : "pending",
        now + WATCHDOG_INTERVAL * 1000,
        failure.reason,
        now,
        job.id,
        job.lease_version,
      )
      .run();
    logEvent("error", "push_expansion_failed", {
      reason_code: failure.reason,
      count: job.attempts + 1,
    });
  }
  return true;
}

async function expandPushJob(db: D1Database, job: PushJob, now: number): Promise<void> {
  const payload = JSON.parse(job.payload_json) as {
    occurrence_id?: unknown;
    cursor?: unknown;
    upper?: unknown;
  };
  if (
    typeof payload.occurrence_id !== "string" ||
    typeof payload.cursor !== "number" ||
    typeof payload.upper !== "number"
  )
    throw new PipelineDataError("push_job_shape");
  const occurrence = await db
    .prepare(`${OCCURRENCE_SELECT} WHERE o.id=?`)
    .bind(payload.occurrence_id)
    .first<OccurrenceMatch>();
  if (occurrence === null) throw new PipelineDataError("occurrence_missing");
  const stale = !occurrenceValid(occurrence, now);
  const users = stale
    ? []
    : (
        await db
          .prepare(`${PUSH_AUDIENCE_SELECT}
      WHERE u."order">? AND u."order"<=? AND EXISTS (SELECT 1 FROM push_bindings b WHERE b.user_id=u.id AND b.state='active')
      ORDER BY u."order" LIMIT ?`)
          .bind(payload.cursor, payload.upper, MATCH_PAGE)
          .all<PushAudienceRow>()
      ).results;
  const last = users.at(-1)?.user_order ?? payload.upper;
  const done = stale || users.length < MATCH_PAGE || last >= payload.upper;
  const kind = occurrenceDeliveryKind(occurrence.kind);
  const ruleId = occurrenceRuleId(occurrence.kind);
  const priority = occurrencePriority(occurrence.kind);
  const critical = Number(isCriticalPushKind(kind));
  const targets: { userId: string; bindingId: string; family: string }[] = [];
  for (const user of users) {
    if (user.status !== "active") continue;
    const interests = await loadInterests(db, user.id, occurrence.game, occurrence.region);
    if (!matchesSubscriptionInterest(occurrence, user, interests)) continue;
    const bindings = (
      await db
        .prepare(
          "SELECT id,activated_at,lease_expires_at FROM push_bindings WHERE user_id=? AND state='active' ORDER BY id",
        )
        .bind(user.id)
        .all<ActiveBinding>()
    ).results;
    for (const binding of bindings)
      if (bindingEligible(binding, occurrence, now))
        targets.push({
          userId: user.id,
          bindingId: binding.id,
          family: JSON.stringify([
            occurrence.milestone_id,
            occurrence.schedule_revision,
            ruleId ?? kind,
            "push",
            binding.id,
          ]),
        });
  }
  const existing = new Set(
    targets.length === 0
      ? []
      : (
          await db
            .prepare(
              "SELECT d.dedupe_family FROM json_each(?) k JOIN deliveries d ON d.dedupe_family=k.value",
            )
            .bind(JSON.stringify(targets.map((target) => target.family)))
            .all<{ dedupe_family: string }>()
        ).results.map((row) => row.dedupe_family),
  );
  const effects: GuardedEffect[] = [];
  for (const target of targets) {
    if (existing.has(target.family)) continue;
    const deliveryId = crypto.randomUUID();
    effects.push(
      {
        kind: "insert",
        table: "deliveries",
        columns: [
          "id",
          "occurrence_id",
          "user_id",
          "channel",
          "target_ref",
          "milestone_id",
          "schedule_revision",
          "rule_id",
          "kind",
          "priority",
          "dedupe_family",
          "status",
          "expires_at",
          "created_at",
          "updated_at",
        ],
        rows: [
          [
            deliveryId,
            occurrence.id,
            target.userId,
            "push",
            target.bindingId,
            occurrence.milestone_id,
            occurrence.schedule_revision,
            ruleId,
            kind,
            priority,
            target.family,
            "pending",
            occurrence.expires_at,
            now,
            now,
          ],
        ],
      },
      {
        kind: "insert",
        table: "push_messages",
        columns: [
          "id",
          "binding_id",
          "user_id",
          "purpose",
          "critical",
          "priority",
          "delivery_id",
          "status",
          "expires_at",
          "created_at",
          "updated_at",
        ],
        rows: [
          [
            crypto.randomUUID(),
            target.bindingId,
            target.userId,
            "business",
            critical,
            priority,
            deliveryId,
            "pending",
            occurrence.expires_at,
            now,
            now,
          ],
        ],
      },
    );
  }
  const next = JSON.stringify({
    occurrence_id: occurrence.id,
    cursor: last,
    upper: payload.upper,
  });
  await conditionalCommit(db, {
    guard: {
      sql: `UPDATE jobs SET payload_json=?, status=?, lease_version=lease_version+1, updated_at=?, completed_at=?
        WHERE id=? AND status='pending' AND lease_version=? AND payload_json=?
        ${
          stale
            ? ""
            : `AND EXISTS (SELECT 1 FROM occurrences o JOIN events e ON e.id=o.event_id
          WHERE o.id=? AND o.invalidated_at IS NULL AND o.expires_at>? AND e.schedule_revision=o.schedule_revision)`
        }`,
      params: [
        next,
        done ? "done" : "pending",
        now,
        done ? now : null,
        job.id,
        job.lease_version,
        job.payload_json,
        ...(stale ? [] : [occurrence.id, now]),
      ],
    },
    effects,
  });
}

/**
 * 维护：租约过期仍在 calling_provider 的转 unknown（崩溃后不盲目重发）；
 * 过期未发的转 expired。Delivery 与消息在同一批次里按同一选择同步。
 */
export async function maintainPushMessages(db: D1Database, now: number): Promise<number> {
  const stale = `SELECT id FROM push_messages WHERE status='calling_provider' AND lease_expires_at<=?
    ORDER BY lease_expires_at,id LIMIT ?`;
  const expired = `SELECT id FROM push_messages WHERE status IN ('pending','retry_wait') AND expires_at<=?
    ORDER BY expires_at,id LIMIT ?`;
  const results = await db.batch([
    db
      .prepare(`UPDATE deliveries SET status='unknown', updated_at=? WHERE status='calling_provider'
      AND id IN (SELECT delivery_id FROM push_messages WHERE id IN (${stale}))`)
      .bind(now, now, MATCH_PAGE),
    db
      .prepare(`UPDATE push_messages SET status='unknown', reason='lease_expired', lease_expires_at=NULL, updated_at=?
      WHERE id IN (${stale})`)
      .bind(now, now, MATCH_PAGE),
    db
      .prepare(`UPDATE deliveries SET status='expired', skip_reason='notification_expired', updated_at=?
      WHERE status IN ('pending','retry_wait') AND id IN (SELECT delivery_id FROM push_messages WHERE id IN (${expired}))`)
      .bind(now, now, MATCH_PAGE),
    db
      .prepare(`UPDATE push_messages SET status='expired', reason='notification_expired', updated_at=?
      WHERE id IN (${expired})`)
      .bind(now, now, MATCH_PAGE),
  ]);
  return (results[1]?.meta.changes ?? 0) + (results[3]?.meta.changes ?? 0);
}

interface ClaimCandidate {
  id: string;
  binding_id: string;
  user_id: string;
  critical: number;
  delivery_id: string;
  status: "pending" | "retry_wait";
  attempts: number;
  lease_version: number;
  expires_at: number;
}

type Review = "eligible" | "skipped" | "superseded" | "expired";
/** 外发前即时复核（§7.1"发送前再次检查用户状态、最新兴趣、通道、节点计划版本及有效期"）。 */
async function reviewBusinessMessage(
  db: D1Database,
  message: ClaimCandidate,
  now: number,
): Promise<Review> {
  const delivery = await db
    .prepare(
      "SELECT occurrence_id,channel,target_ref,user_id,schedule_revision,status,expires_at FROM deliveries WHERE id=?",
    )
    .bind(message.delivery_id)
    .first<{
      occurrence_id: string;
      channel: string;
      target_ref: string;
      user_id: string;
      schedule_revision: number;
      status: string;
      expires_at: number;
    }>();
  if (delivery === null) return "skipped";
  if (delivery.status === "superseded") return "superseded";
  if (delivery.status !== "pending" && delivery.status !== "retry_wait") return "skipped";
  if (
    delivery.channel !== "push" ||
    delivery.target_ref !== message.binding_id ||
    delivery.user_id !== message.user_id
  )
    return "skipped";
  const occurrence = await db
    .prepare(`${OCCURRENCE_SELECT} WHERE o.id=?`)
    .bind(delivery.occurrence_id)
    .first<OccurrenceMatch>();
  if (occurrence === null) return "skipped";
  if (
    occurrence.invalidated_at !== null ||
    occurrence.current_schedule_revision !== occurrence.schedule_revision ||
    delivery.schedule_revision !== occurrence.schedule_revision
  )
    return "superseded";
  if (Math.min(delivery.expires_at, occurrence.expires_at, message.expires_at) <= now)
    return "expired";
  const binding = await db
    .prepare(
      "SELECT id,activated_at,lease_expires_at FROM push_bindings WHERE id=? AND user_id=? AND state='active'",
    )
    .bind(message.binding_id, message.user_id)
    .first<ActiveBinding>();
  if (binding === null || !bindingEligible(binding, occurrence, now)) return "skipped";
  const audience = await db
    .prepare(`${PUSH_AUDIENCE_SELECT} WHERE u.id=?`)
    .bind(message.user_id)
    .first<PushAudienceRow>();
  if (audience === null || audience.status !== "active") return "skipped";
  const interests = await loadInterests(db, audience.id, occurrence.game, occurrence.region);
  return matchesSubscriptionInterest(occurrence, audience, interests) ? "eligible" : "skipped";
}

async function closeMessage(
  db: D1Database,
  message: ClaimCandidate,
  status: Exclude<Review, "eligible">,
  reason: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(`UPDATE deliveries SET status=?, skip_reason=?, updated_at=?
      WHERE id=? AND status IN ('pending','retry_wait')`)
      .bind(status, reason, now, message.delivery_id),
    db
      .prepare(`UPDATE push_messages SET status=?, reason=?, updated_at=?
      WHERE id=? AND status=? AND lease_version=?`)
      .bind(status, reason, now, message.id, message.status, message.lease_version),
  ]);
}

/** 外发一条到期的业务通知；没有可发的返回 false。 */
export async function sendNextBusinessPush(
  deps: PushSendDeps,
  config: PushConfig,
  now: number,
  deadline: number,
): Promise<boolean> {
  const { db } = deps;
  const message = await db
    .prepare(`SELECT id,binding_id,user_id,critical,delivery_id,status,attempts,lease_version,expires_at
    FROM push_messages INDEXED BY idx_push_messages_due
    WHERE status IN ('pending','retry_wait') AND COALESCE(next_attempt_at,0)<=? AND purpose='business' AND expires_at>?
    ORDER BY priority, created_at, id LIMIT 1`)
    .bind(now, now)
    .first<ClaimCandidate>();
  if (message === null) return false;
  const review = await reviewBusinessMessage(db, message, now);
  if (review !== "eligible") {
    await closeMessage(db, message, review, `preflight_${review}`, now);
    return true;
  }
  const day = utcDayPeriod(now);
  const sendKey = pushCounterKeys(day.key).send;
  const limit = pushSendDayLimit(message.critical === 1);
  const leaseVersion = message.lease_version + 1;
  const claimed = await conditionalCommit(db, {
    preamble: [
      {
        sql: "INSERT INTO capacity_state(key,value,version,updated_at) VALUES (?,0,0,?) ON CONFLICT(key) DO NOTHING",
        params: [sendKey, now],
      },
    ],
    guard: {
      sql: `UPDATE push_messages SET status='calling_provider', attempts=attempts+1, period_key=?,
          lease_version=?, lease_expires_at=?, next_attempt_at=NULL, updated_at=?
        WHERE id=? AND status=? AND lease_version=?
          AND COALESCE((SELECT value FROM capacity_state WHERE key=?),0)<?
          AND EXISTS (SELECT 1 FROM push_bindings b WHERE b.id=? AND b.state='active' AND b.lease_expires_at>?)
          AND EXISTS (SELECT 1 FROM deliveries d WHERE d.id=? AND d.status IN ('pending','retry_wait'))
          AND ${controlPredicate("push_enabled")} AND ${controlPredicate("outbound_enabled")}`,
      params: [
        day.key,
        leaseVersion,
        now + EXECUTOR_BATCH_WALL_LIMIT * 1000,
        now,
        message.id,
        message.status,
        message.lease_version,
        sendKey,
        limit,
        message.binding_id,
        now,
        message.delivery_id,
      ],
    },
    effects: [
      {
        kind: "update",
        table: "capacity_state",
        set: { value: { sql: "value+1" }, version: { sql: "version+1" }, updated_at: now },
        where: { sql: "key=?", params: [sendKey] },
      },
      {
        kind: "update",
        table: "deliveries",
        set: { status: "calling_provider", updated_at: now },
        where: { sql: "id=?", params: [message.delivery_id] },
      },
    ],
  });
  if (claimed.outcome !== "committed") {
    const used =
      (
        await db
          .prepare("SELECT value FROM capacity_state WHERE key=?")
          .bind(sendKey)
          .first<{ value: number }>()
      )?.value ?? 0;
    if (used < limit) return true; // 其他条件变了（暂停、删除、开关）：下一轮重新复核。
    // 当日预算用尽：推到下一 UTC 日；到不了就留下原因，不跨日追发已过期的提醒。
    if (day.endMsExclusive < message.expires_at) {
      await db
        .prepare(
          "UPDATE push_messages SET next_attempt_at=?, updated_at=? WHERE id=? AND status=? AND lease_version=?",
        )
        .bind(day.endMsExclusive, now, message.id, message.status, message.lease_version)
        .run();
    } else {
      await closeMessage(db, message, "skipped", "push_budget_exhausted", now);
    }
    await recordMetric(db, "push_budget_skipped", now);
    return true;
  }
  let node: BusinessNode | null = null;
  let binding: PushBindingRow | null = null;
  try {
    node = await db
      .prepare(`SELECT e.title AS event_title, m.title AS node_title, m.node_type, d.kind AS delivery_kind,
        m.id AS milestone_id, m.time_exact_ms, m.time_date, m.time_precision, e.detail_path
      FROM deliveries d JOIN milestones m ON m.id=d.milestone_id JOIN events e ON e.id=m.event_id WHERE d.id=?`)
      .bind(message.delivery_id)
      .first<BusinessNode>();
    binding = await db
      .prepare("SELECT * FROM push_bindings WHERE id=?")
      .bind(message.binding_id)
      .first<PushBindingRow>();
    if (node === null || binding === null) throw new PipelineDataError("push_message_reference");
    const secrets = await openBindingSecrets(await deps.keys(), binding);
    await sendPushMessage(
      { db, config, transport: deps.transport },
      {
        messageId: message.id,
        bindingId: message.binding_id,
        purpose: "business",
        endpoint: secrets.endpoint,
        keys: secrets.keys,
        payload: businessPayload(message.binding_id, message.id, node),
        expiresAt: message.expires_at,
        urgency: message.critical === 1 ? "high" : "normal",
        leaseVersion,
        attempts: message.attempts + 1,
        deliveryId: message.delivery_id,
      },
      now,
      deadline,
    );
  } catch (error) {
    // 外调之前的数据错误：确定没有发出，该条终止为 failed；不影响其他消息与邮件。
    logEvent("error", "push_business_prepare_failed", {
      reason_code: error instanceof Error ? error.name : "non_error_throw",
    });
    await db.batch([
      db
        .prepare(`UPDATE push_messages SET status='failed', reason='invalid_data', lease_expires_at=NULL, updated_at=?
        WHERE id=? AND status='calling_provider' AND lease_version=?`)
        .bind(now, message.id, leaseVersion),
      db
        .prepare(`UPDATE deliveries SET status='failed', skip_reason='invalid_data', updated_at=?
        WHERE id=? AND status='calling_provider'`)
        .bind(now, message.delivery_id),
    ]);
  }
  return true;
}

/** 一次有界的 Push 工作单元：维护、补建展开、推进至多 SEND_CONCURRENCY 页展开、按预算外发至多 MATCH_PAGE 条。 */
export async function runPushPass(
  deps: PushSendDeps,
  now: () => number,
  deadline: number,
): Promise<void> {
  const { db } = deps;
  await maintainPushMessages(db, now());
  await startPushExpansions(db, now());
  // 与邮件展开同一节奏：每轮至多 SEND_CONCURRENCY 页，余下的由下一次 alarm 继续。
  for (let page = 0; page < SEND_CONCURRENCY && now() < deadline; page++)
    if (!(await expandPushPage(db, now()))) break;
  const config = await deps.config();
  if (config === null || !(await controlsAllow(db, "push_enabled", "outbound_enabled"))) return;
  for (let sent = 0; sent < MATCH_PAGE && now() < deadline; sent++)
    if (!(await sendNextBusinessPush(deps, config, now(), deadline))) break;
}

/** 下一次需要唤醒 DeliveryDO 的时刻；外发不可用时不为待发消息排 alarm（由 Cron 维护）。 */
export async function nextPushAlarm(deps: PushSendDeps, now: number): Promise<number | null> {
  const { db } = deps;
  const due: number[] = [];
  const job = await db
    .prepare("SELECT MIN(due_at) AS due FROM jobs WHERE kind=? AND status='pending'")
    .bind(PUSH_EXPANSION_JOB_KIND)
    .first<{ due: number | null }>();
  if (job?.due != null) due.push(job.due);
  const start = await db
    .prepare(`SELECT 1 AS ready FROM occurrences o INDEXED BY idx_occurrences_expiry
    WHERE o.expires_at>? AND o.audience_upper_order IS NOT NULL AND o.invalidated_at IS NULL AND o.due_at<=?
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id='occurrence:'||o.id||':push')
      AND EXISTS (SELECT 1 FROM push_bindings WHERE state='active') LIMIT 1`)
    .bind(now, now)
    .first<{ ready: number }>();
  if (start) due.push(now);
  const lease = await db
    .prepare(
      "SELECT MIN(lease_expires_at) AS due FROM push_messages WHERE status='calling_provider'",
    )
    .first<{ due: number | null }>();
  if (lease?.due != null) due.push(lease.due);
  if (
    (await deps.config()) !== null &&
    (await controlsAllow(db, "push_enabled", "outbound_enabled"))
  ) {
    const message = await db
      .prepare(`SELECT MIN(COALESCE(next_attempt_at,0)) AS due FROM push_messages INDEXED BY idx_push_messages_due
      WHERE status IN ('pending','retry_wait') AND purpose='business' AND expires_at>?`)
      .bind(now)
      .first<{ due: number | null }>();
    if (message?.due != null) due.push(message.due);
  }
  return due.length ? Math.max(now, Math.min(...due)) : null;
}
