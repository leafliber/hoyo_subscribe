// P4-03 · 每轮有限外发和展开；不调用 P4-02 的选择/批准入口。
import {
  BUDGET_PERIOD_KIND,
  EXECUTOR_BATCH_WALL_LIMIT,
  MATCH_PAGE,
  SEND_CONCURRENCY,
  utcDayPeriod,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import { NEXT_OCCURRENCE_ALARM_SQL } from "../../mail/occurrences/expand";
import { type SendDeps, sendOneMail } from "../../mail/outbox/send";
import { MAIL_CLAIM_CANDIDATE_SQL, repairMailPage } from "../../mail/outbox/state";
import { MAIL_AVAILABILITY_KEY } from "../../mail/provider/availability";
import { logEvent } from "../../shell/logger";
import { classifyPipelineFailure } from "../pipeline/failure";
import { runOccurrencePass } from "./occurrences";
export class DeliveryRuntime {
  private now: () => number;
  constructor(private readonly deps: SendDeps) {
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
    if (occurrenceBackoff) return;
    try {
      // 业务阶段独立退避；失败不改变认证发送的闸门或下一轮发送资格。
      for (let unit = 0; unit < SEND_CONCURRENCY && this.now() < deadline; unit++) {
        const pass = await runOccurrencePass(this.deps.db, this.now(), {
          signalLimit: 0,
          occurrenceLimit: 1,
          pageLimit: 1,
        });
        if (pass.started === 0 && pass.pages === 0) break;
      }
    } catch (error) {
      await this.recordFailure(error, "occurrences");
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
  private async recordFailure(
    error: unknown,
    scope: "executor" | "occurrences" = "executor",
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
          scope === "executor" ? "delivery:backoff" : "delivery:occurrence-backoff",
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
    try {
      for (let page = 0; page < SEND_CONCURRENCY && this.now() < deadline; page++) {
        if ((await repairMailPage(this.deps.db, this.now())) < MATCH_PAGE) break;
      }
    } catch (error) {
      await this.recordFailure(error);
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
