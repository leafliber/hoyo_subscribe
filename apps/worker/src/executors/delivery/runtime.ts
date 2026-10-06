// P4-04 · 保留认证优先外发，追加有预算的业务批次与跨日重排。
import {
  BUDGET_PERIOD_KIND,
  EXECUTOR_BATCH_WALL_LIMIT,
  MATCH_PAGE,
  SEND_CONCURRENCY,
  utcDayPeriod,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { finishRejectedRetryPage, nextRejectedRetryAlarm } from "../../mail/budget/rejected";
import { nextRolloverAlarm, rolloverBudgetPage } from "../../mail/budget/rollover";
import { NEXT_OCCURRENCE_ALARM_SQL } from "../../mail/occurrences/expand";
import { type SendDeps, sendOneMail } from "../../mail/outbox/send";
import { MAIL_CLAIM_CANDIDATE_SQL, repairMailPage } from "../../mail/outbox/state";
import { MAIL_AVAILABILITY_KEY } from "../../mail/provider/availability";
import {
  maintainPushMessages,
  nextPushAlarm,
  type PushSendDeps,
  runPushPass,
} from "../../push/delivery";
import { logEvent } from "../../shell/logger";
import { classifyPipelineFailure } from "../pipeline/failure";
import { nextDispatchAlarm, runDispatchPass } from "./dispatch";
import { runOccurrencePass } from "./occurrences";
export class DeliveryRuntime {
  private now: () => number;
  /** P6（ADR-0025）：Push 依赖可缺省；缺省时本运行时只做邮件，行为与此前一致。 */
  constructor(
    private readonly deps: SendDeps,
    private readonly push?: PushSendDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }
  async tick(): Promise<void> {
    const blocked = await this.deps.db
      .prepare("SELECT id FROM jobs WHERE id='delivery:backoff' AND (status='failed' OR due_at>?)")
      .bind(this.now())
      .first();
    if (blocked) return;
    const deadline = this.now() + EXECUTOR_BATCH_WALL_LIMIT * 1000;
    try {
      for (let i = 0; i < SEND_CONCURRENCY && this.now() < deadline; i++) {
        if (!(await sendOneMail({ ...this.deps, batchDeadline: deadline }, "DeliveryDO/main")))
          break;
      }
    } catch (error) {
      await this.recordFailure(error);
      return;
    }
    const occurrenceBackoff = await this.occurrenceBackoff();
    if (!occurrenceBackoff)
      try {
        // 业务阶段独立退避；失败不改变认证发送的闸门或下一轮发送资格。
        for (let unit = 0; unit < SEND_CONCURRENCY && this.now() < deadline; unit++) {
          const pass = await runOccurrencePass(this.deps.db, this.now(), {
            signalLimit: 0,
            occurrenceLimit: 1,
            pageLimit: 1,
          });
          if (pass.started === 0 && pass.pages === 0) break;
          await this.deps.db
            .prepare("UPDATE jobs SET due_at=? WHERE id='delivery:dispatch' AND status='pending'")
            .bind(this.now())
            .run();
        }
      } catch (error) {
        await this.recordFailure(error, "occurrences");
      }
    // P4-06 尚未提供退订入口时不批准业务邮件，避免生成必然失败的意图。
    if (this.deps.unsubscribe && this.now() < deadline && (await this.deps.available())) {
      if (!(await this.budgetBackoff("dispatch")))
        try {
          await runDispatchPass(this.deps.db, this.now, deadline);
        } catch (error) {
          await this.recordFailure(error, "dispatch");
        }
    }
    // P6：Push 是独立单元，失败只退避 Push 自身，不改变认证与邮件的闸门。
    if (this.push && this.now() < deadline && !(await this.budgetBackoff("push")))
      try {
        await runPushPass(this.push, this.now, deadline);
      } catch (error) {
        await this.recordFailure(error, "push");
      }
  }
  private async occurrenceBackoff() {
    return this.deps.db
      .prepare(
        "SELECT due_at,status FROM jobs WHERE id='delivery:occurrence-backoff' AND (status='failed' OR due_at>?)",
      )
      .bind(this.now())
      .first<{ due_at: number; status: string }>();
  }
  private async budgetBackoff(scope: "budget" | "dispatch" | "push") {
    return this.deps.db
      .prepare("SELECT due_at,status FROM jobs WHERE id=? AND (status='failed' OR due_at>?)")
      .bind(`delivery:${scope}-backoff`, this.now())
      .first<{ due_at: number; status: string }>();
  }
  private async recordFailure(
    error: unknown,
    scope: "executor" | "occurrences" | "budget" | "dispatch" | "push" = "executor",
  ): Promise<void> {
    const failure = classifyPipelineFailure(error);
    logEvent("error", "delivery_tick_failed", { reason_code: failure.reason });
    // DO 的错误退避持久保存；不在当前批次重复执行暂时失败的 SQL。
    const writes = [
      this.deps.db
        .prepare(`INSERT INTO jobs(id,kind,payload_json,due_at,status,attempts,last_error,created_at,updated_at)
        VALUES (?,'delivery_backoff','{}',?,?,1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET due_at=excluded.due_at,status=excluded.status,attempts=jobs.attempts+1,last_error=excluded.last_error,updated_at=excluded.updated_at`)
        .bind(
          scope === "executor"
            ? "delivery:backoff"
            : scope === "occurrences"
              ? "delivery:occurrence-backoff"
              : `delivery:${scope}-backoff`,
          this.now() + WATCHDOG_INTERVAL * 1000,
          failure.terminal ? "failed" : "pending",
          failure.reason,
          this.now(),
          this.now(),
        ),
    ];
    // 执行器核心永久停下时，同一事务关闭生成前开关与公开可用状态。
    if (scope === "executor" && failure.terminal)
      writes.push(
        this.deps.db
          .prepare(`INSERT INTO system_state(key,value_json,updated_at) VALUES (?,'false',?)
        ON CONFLICT(key) DO UPDATE SET value_json='false',updated_at=excluded.updated_at`)
          .bind(MAIL_AVAILABILITY_KEY, this.now()),
      );
    await this.deps.db.batch(writes);
  }

  async watchdog(): Promise<void> {
    const deadline = this.now() + EXECUTOR_BATCH_WALL_LIMIT * 1000;
    // 三类维护共享页槽；业务预算扫描失败不升级为认证发送核心失败。
    let remaining = SEND_CONCURRENCY as number;
    for (const page of [repairMailPage, finishRejectedRetryPage, rolloverBudgetPage]) {
      const budget = page !== repairMailPage;
      if (budget && (await this.budgetBackoff("budget"))) continue;
      try {
        while (remaining > 0 && this.now() < deadline) {
          const count = await page(this.deps.db, this.now());
          if (count > 0) remaining--;
          if (count < MATCH_PAGE) break;
        }
      } catch (error) {
        await this.recordFailure(error, budget ? "budget" : "executor");
        if (!budget) return;
      }
    }
    // P6：Cron 也做 Push 维护（租约过期转 unknown、过期未发转 expired），外发暂停时同样收尾。
    if (this.push && !(await this.budgetBackoff("push")))
      try {
        await maintainPushMessages(this.push.db, this.now());
      } catch (error) {
        await this.recordFailure(error, "push");
      }
  }

  async nextAlarm(): Promise<number | null> {
    const db = this.deps.db,
      now = this.now();
    const backoff = await db
      .prepare(
        "SELECT due_at,status FROM jobs WHERE id='delivery:backoff' AND (due_at > ? OR status='failed')",
      )
      .bind(now)
      .first<{ due_at: number; status: string }>();
    if (backoff) return backoff.status === "failed" ? null : backoff.due_at;
    const due: number[] = [];
    const budgetBackoff = await this.budgetBackoff("budget");
    if (budgetBackoff) {
      if (budgetBackoff.status !== "failed") due.push(budgetBackoff.due_at);
    } else {
      const rejected = await nextRejectedRetryAlarm(db, now);
      if (rejected !== null) due.push(rejected);
      // 暂停时由既有 watchdog 做日界维护，不为待发送行另排 alarm。
      if (await this.deps.available()) {
        const rollover = await nextRolloverAlarm(db, now);
        if (rollover !== null) due.push(rollover);
      }
    }
    if (this.deps.unsubscribe && (await this.deps.available())) {
      const dispatchBackoff = await this.budgetBackoff("dispatch");
      if (dispatchBackoff) {
        if (dispatchBackoff.status !== "failed") due.push(dispatchBackoff.due_at);
      } else {
        const dispatch = await nextDispatchAlarm(db, now);
        if (dispatch !== null) due.push(dispatch);
      }
    }
    if (await this.deps.available()) {
      const mail = await db
        .prepare(MAIL_CLAIM_CANDIDATE_SQL)
        .bind(utcDayPeriod(now).key, null, null, BUDGET_PERIOD_KIND)
        .first();
      if (mail) due.push(now);
    }
    const lease = await db
      .prepare(
        `SELECT MIN(lease_expires_at) AS due FROM mail_outbox WHERE status IN ('leased','calling_provider','retry_wait')`,
      )
      .first<{ due: number | null }>();
    if (lease?.due != null) due.push(lease.due);
    if (this.push) {
      const pushBackoff = await this.budgetBackoff("push");
      if (pushBackoff) {
        if (pushBackoff.status !== "failed") due.push(pushBackoff.due_at);
      } else {
        const push = await nextPushAlarm(this.push, now);
        if (push !== null) due.push(push);
      }
    }
    const occurrenceBackoff = await this.occurrenceBackoff();
    if (occurrenceBackoff) {
      if (occurrenceBackoff.status !== "failed") due.push(occurrenceBackoff.due_at);
    } else {
      const jobs = await db
        .prepare(
          `SELECT MIN(due_at) AS due FROM jobs WHERE kind='occurrence_email_expansion' AND status='pending'`,
        )
        .first<{ due: number | null }>();
      if (jobs?.due != null) due.push(jobs.due);
      const occurrence = await db
        .prepare(NEXT_OCCURRENCE_ALARM_SQL)
        .bind(now)
        .first<{ due: number | null }>();
      if (occurrence?.due != null) due.push(occurrence.due);
    }
    return due.length ? Math.max(now, Math.min(...due)) : null;
  }
}
