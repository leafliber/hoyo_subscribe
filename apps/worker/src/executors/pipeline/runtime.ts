// P3-11：D1 是待办/进度事实源；DO 串行调度。每次 alarm 只处理一个工作单元。

import {
  EXECUTOR_BATCH_WALL_LIMIT,
  MATCH_PAGE,
  MODEL_NETWORK_RETRIES,
  NOTIFICATION_PUBLICATION_TOPIC,
  RECLAIM_QUERY_BUDGET,
  WATCHDOG_INTERVAL,
} from "@hoyo/contracts";
import {
  buildPublicSnapshot,
  readNoncriticalPublicationPause,
  reclaimSupersededPublicSnapshotPage,
} from "../../calendar/public/snapshot";
import { DRAFT_ELIGIBLE_SQL, type DraftModel, runDraftJob } from "../../extraction/model/draft";
import { approveDraftWithoutReview } from "../../extraction/model/review-skip";
import { DRAFT_PROFILE_REF } from "../../extraction/model/store";
import { staleVersionDerivation } from "../../extraction/versions";
import { generatePublicationOccurrences } from "../../mail/occurrences/generate";
import { publishApprovedCandidate } from "../../publishing/publish";
import { runCleanup } from "../../scheduled/cleanup";
import { logEvent } from "../../shell/logger";
import { readControl } from "../../shell/observability/controls";
import { recordMetric } from "../../shell/observability/metrics";
import { articleRowId, saveArticleVersion } from "../../sources/articles/ingest";
import { getSourceEntry, isRetiredSource, SOURCE_REGISTRY } from "../../sources/registry";
import { boundedDatabase, ReclaimQueryLimit } from "../cron/query-budget";
import { type CollectedPage, collectSource } from "./collect";
import type { PipelineControlReader } from "./controls";
import { isCriticalPublication } from "./critical";
import { extractArticleVersion } from "./extract";
import {
  classifyPipelineFailure,
  PipelineDataError,
  parseJobObject,
  validatePublicationSignal,
} from "./failure";
import {
  INITIAL_SOURCE_POLL_STATE,
  pollIntervalSeconds,
  type SourcePollState,
} from "./source-poll";
export const SOURCE_JOB = "pipeline_source";
export const PUBLICATION_JOB = "pipeline_publication";
export const NOTIFICATION_JOB = "pipeline_notification";
/** ADR-0009：为待审 uncertain 候选生成 AI 草稿；每个 alarm 只调用一次模型。 */
export const DRAFT_JOB = "pipeline_draft";
/** 待人工裁定的发布待办：tick 与 nextAlarm 都不取它，只由 watchdog 在关联候选变化后放回。 */
const AWAITING_REVIEW_STATUS = "awaiting_review";
interface Job {
  id: string;
  kind: string;
  payload_json: string;
  lease_version: number;
  attempts: number;
}
interface SourcePayload {
  sourceId: string;
  page?: CollectedPage;
}
interface PublicationPayload {
  versionId: string;
  backfill: boolean;
}
export interface PipelineDeps {
  db: D1Database;
  readControls: PipelineControlReader;
  now?: () => number;
  fetchFn?: typeof fetch;
  publish?: typeof publishApprovedCandidate;
  notify?: typeof generatePublicationOccurrences;
  reclaim?: typeof reclaimSupersededPublicSnapshotPage;
  /** Workers AI 绑定；未配置时不起草。测试注入固定响应替身。 */
  ai?: DraftModel;
  draft?: typeof runDraftJob;
}
export class PipelineRuntime {
  private readonly now: () => number;
  constructor(private readonly deps: PipelineDeps) {
    this.now = deps.now ?? Date.now;
  }
  private get db() {
    return this.deps.db;
  }
  async watchdog(): Promise<void> {
    const now = this.now();
    const deadline = now + EXECUTOR_BATCH_WALL_LIMIT * 1000;
    // 过期租约只有这里能修复，先做：后面的维护即使失败或用尽预算，也不拖到下一周期。
    await this.db
      .prepare(
        `UPDATE jobs SET status = 'pending', lease_version = lease_version + 1, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE kind IN (?, ?, ?, ?) AND status = 'leased' AND lease_expires_at <= ?`,
      )
      .bind(now, SOURCE_JOB, PUBLICATION_JOB, NOTIFICATION_JOB, DRAFT_JOB, now)
      .run();
    // 关联候选出现新裁定、修订或人工候选（updated_at 晚于停放时所见）才放回重抽。
    await this.db
      .prepare(
        `UPDATE jobs SET status = 'pending', due_at = ?, updated_at = ? WHERE kind = ? AND status = ?
          AND EXISTS (SELECT 1 FROM evidence e JOIN candidates c ON c.id = e.candidate_id
            WHERE e.article_version_id = json_extract(jobs.payload_json, '$.versionId')
              AND c.updated_at > json_extract(jobs.payload_json, '$.seenAt'))`,
      )
      .bind(now, now, PUBLICATION_JOB, AWAITING_REVIEW_STATUS)
      .run();
    // 清理先获得执行机会；旧代回收使用剩余墙钟，不因大积压饿死认证清理。
    try {
      await buildPublicSnapshot(this.db, now);
    } catch {
      await recordMetric(this.db, "snapshot_build_failed", this.now());
      logEvent("error", "pipeline_snapshot_failed", { reason_code: "snapshot_build" });
    }
    // 清理与旧代回收共用回收查询硬预算；来源排程与 rearm 留在预算外，单次调用不越过 D1 上限。
    const maintenance = boundedDatabase(this.db, RECLAIM_QUERY_BUDGET).db;
    await runCleanup(maintenance, now, deadline, this.now);
    try {
      while (this.now() < deadline) {
        const page = await (this.deps.reclaim ?? reclaimSupersededPublicSnapshotPage)(
          maintenance,
          MATCH_PAGE,
        );
        if (page.outcome === "done") break;
      }
    } catch (error) {
      if (error instanceof ReclaimQueryLimit)
        logEvent("warn", "pipeline_snapshot_reclaim_deferred", { reason_code: "query_budget" });
      else logEvent("error", "pipeline_snapshot_failed", { reason_code: "snapshot_reclaim" });
    }
    const controls = await this.deps.readControls();
    if (controls === null) {
      logEvent("warn", "pipeline_controls_unconfigured");
      return;
    }
    for (const entry of SOURCE_REGISTRY) {
      if (!controls.sources[entry.sourceId]?.enabled) continue;
      await this.db
        .prepare(
          `INSERT INTO sources (source_id,game,region,adapter,approved_hosts_json,verified_publishers_json,cursor_json,poll_policy_json,verification_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO NOTHING`,
        )
        .bind(
          entry.sourceId,
          entry.game,
          entry.region,
          entry.adapterId,
          JSON.stringify(entry.approvedHosts),
          JSON.stringify(entry.verifiedPublishers),
          JSON.stringify(INITIAL_SOURCE_POLL_STATE),
          JSON.stringify(entry.pollPolicy),
          entry.verificationState,
          now,
          now,
        )
        .run();
      await this.db
        .prepare(
          `INSERT INTO jobs (id,kind,payload_json,due_at,status,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?) ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          `pipeline:source:${entry.sourceId}`,
          SOURCE_JOB,
          JSON.stringify({ sourceId: entry.sourceId }),
          now,
          now,
          now,
        )
        .run();
    }
    if (controls.model && this.deps.ai !== undefined) await this.enqueueDrafts(now);
  }
  /**
   * 每个周期最多补排 MATCH_PAGE 个草稿待办，新公告优先；当前 profile 已有确定结果（ready/invalid/skipped）
   * 或失败次数用尽的候选不再排，旧 profile 的草稿按新组合重新起草（ADR-0010）。
   * 已完成的待办（如当时开关关着）在仍缺草稿时复活。
   */
  private async enqueueDrafts(now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO jobs (id,kind,payload_json,due_at,status,created_at,updated_at)
         SELECT 'pipeline:draft:' || c.id, ?, json_object('candidateId', c.id), ?, 'pending', ?, ?
           FROM candidates c
          WHERE ${DRAFT_ELIGIBLE_SQL}
            AND NOT EXISTS (SELECT 1 FROM ai_drafts d WHERE d.candidate_id = c.id AND d.profile_ref = ?
                             AND (d.status <> 'failed' OR d.attempts > ?))
            AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = 'pipeline:draft:' || c.id AND j.status <> 'done')
          ORDER BY c.created_at DESC, c.id
          LIMIT ?
         ON CONFLICT(id) DO UPDATE SET status = 'pending', due_at = excluded.due_at,
           updated_at = excluded.updated_at, last_error = NULL
          WHERE jobs.status = 'done'`,
      )
      .bind(DRAFT_JOB, now, now, now, DRAFT_PROFILE_REF, MODEL_NETWORK_RETRIES, MATCH_PAGE)
      .run();
  }
  async nextAlarm(): Promise<number | null> {
    const signal = await this.db
      .prepare(`SELECT o.id FROM outbox o LEFT JOIN jobs j ON j.id = 'pipeline:notification:' || o.id
        WHERE o.topic = ? AND o.dispatch_state = 'pending' AND (j.id IS NULL OR j.status = 'done') LIMIT 1`)
      .bind(NOTIFICATION_PUBLICATION_TOPIC)
      .first();
    if (signal !== null) return this.now();
    // 只为 tick/dispatchOne 能消费的 pending 待办排 alarm。崩溃或部署重启留下的过期租约
    // 只有 Cron watchdog 能修复；为它排 alarm 只会让 DO 空转到下一次 Cron。
    const row = await this.db
      .prepare(`SELECT MIN(due_at) AS due FROM jobs WHERE kind IN (?,?,?,?) AND status = 'pending'`)
      .bind(SOURCE_JOB, PUBLICATION_JOB, NOTIFICATION_JOB, DRAFT_JOB)
      .first<{ due: number | null }>();
    return row?.due === null || row?.due === undefined ? null : Math.max(this.now(), row.due);
  }
  async tick(): Promise<void> {
    const now = this.now();
    const deadline = now + EXECUTOR_BATCH_WALL_LIMIT * 1000;
    const row = await this.db
      .prepare(
        `UPDATE jobs SET status = 'leased', lease_version = lease_version + 1, lease_owner = 'PipelineDO/main', lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = (SELECT id FROM jobs WHERE kind IN (?,?,?) AND status = 'pending' AND due_at <= ? ORDER BY due_at, kind = ?, id LIMIT 1) AND status = 'pending' RETURNING id,kind,payload_json,lease_version,attempts`,
      )
      .bind(deadline, now, SOURCE_JOB, PUBLICATION_JOB, DRAFT_JOB, now, DRAFT_JOB)
      .first<Job>();
    if (row === null) {
      await this.dispatchOne(deadline);
      return;
    }
    try {
      if (row.kind === SOURCE_JOB) await this.source(row, deadline);
      else if (row.kind === DRAFT_JOB) await this.draft(row, deadline);
      else await this.publication(row, deadline);
    } catch (error) {
      await this.recordFailure(row, error);
    }
    if (this.now() < deadline) await this.dispatchOne(deadline);
  }
  private async recordFailure(job: Job, error: unknown, outboxId?: string): Promise<void> {
    const failure = classifyPipelineFailure(error);
    logEvent("error", outboxId === undefined ? "pipeline_job_failed" : "pipeline_outbox_failed", {
      reason_code: failure.reason,
      count: job.attempts,
      kind: job.kind,
    });

    if (failure.terminal && outboxId !== undefined) {
      await this.db
        .prepare(`UPDATE outbox SET dispatch_state = 'failed' WHERE id = ? AND dispatch_state = 'pending'
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'leased' AND lease_version = ? AND lease_owner = 'PipelineDO/main')`)
        .bind(outboxId, job.id, job.lease_version)
        .run();
    }
    await this.finish(
      job,
      failure.terminal ? "failed" : "pending",
      job.payload_json,
      this.now() + WATCHDOG_INTERVAL * 1000,
      failure.reason,
    );
  }
  private async finish(
    job: Job,
    status: string,
    payload: string,
    due: number,
    reason: string | null = null,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE jobs SET status = ?,payload_json = ?,due_at = ?,lease_owner = NULL,lease_expires_at = NULL,last_error = ?,updated_at = ?,completed_at = CASE WHEN ? IN ('done','failed') THEN ? ELSE NULL END WHERE id = ? AND status = 'leased' AND lease_version = ? AND lease_owner = 'PipelineDO/main'`,
      )
      .bind(status, payload, due, reason, this.now(), status, this.now(), job.id, job.lease_version)
      .run();
  }
  private async source(job: Job, deadline: number): Promise<void> {
    const object = parseJobObject(job.payload_json);
    // 已下线来源（ADR-0016）的轮询待办直接结束：不再续排，也不当作数据错误记失败。
    if (typeof object.sourceId === "string" && isRetiredSource(object.sourceId)) {
      await this.finish(job, "done", job.payload_json, this.now(), "source_retired");
      return;
    }
    if (
      typeof object.sourceId !== "string" ||
      !SOURCE_REGISTRY.some((entry) => entry.sourceId === object.sourceId)
    )
      throw new PipelineDataError("source_job_shape");
    if (
      object.page !== undefined &&
      (object.page === null ||
        typeof object.page !== "object" ||
        !Array.isArray((object.page as CollectedPage).plans) ||
        typeof (object.page as CollectedPage).backfill !== "boolean" ||
        !["ok", "incomplete", "maintenance-required"].includes(
          (object.page as CollectedPage).status,
        ) ||
        !(object.page as CollectedPage).nextState)
    )
      throw new PipelineDataError("source_page_shape");
    const data = object as unknown as SourcePayload;
    const entry = getSourceEntry(data.sourceId);
    const controls = await this.deps.readControls();
    const setting = controls?.sources[data.sourceId];
    const source = await this.db
      .prepare("SELECT cursor_json,verification_state FROM sources WHERE source_id = ?")
      .bind(data.sourceId)
      .first<{ cursor_json: string; verification_state: string }>();
    if (source === null) throw new PipelineDataError("source_missing");
    if (source.verification_state === "maintenance-required") {
      await this.finish(job, "failed", job.payload_json, this.now(), "source_maintenance");
      return;
    }
    if (!setting?.enabled) {
      await this.finish(
        job,
        "pending",
        job.payload_json,
        this.now() + WATCHDOG_INTERVAL * 1000,
        "source_switch_unavailable_or_disabled",
      );
      return;
    }
    const nextDue = this.now() + pollIntervalSeconds(entry, setting.mode) * 1000;
    if (data.page === undefined) {
      data.page = await collectSource(
        {
          ...entry,
          requestLimits: {
            ...entry.requestLimits,
            onTruncated: (host) =>
              recordMetric(this.db, "source_response_truncated", this.now(), 1, host),
          },
        },
        JSON.parse(source.cursor_json) as SourcePollState,
        this.now(),
        this.deps.fetchFn ?? fetch,
      );
      if (data.page.status === "maintenance-required") {
        await this.db
          .prepare(
            "UPDATE sources SET verification_state = 'maintenance-required',updated_at = ? WHERE source_id = ?",
          )
          .bind(this.now(), data.sourceId)
          .run();
        logEvent("warn", "pipeline_source_maintenance", { source: data.sourceId });
        await this.finish(job, "failed", JSON.stringify(data), nextDue, "source_maintenance");
        return;
      }
      // 先落持久页，再触碰文章。硬中断只会重放幂等入口。
      await this.finish(job, "pending", JSON.stringify(data), this.now());
      return;
    }
    if (this.now() >= deadline) {
      await this.finish(job, "pending", job.payload_json, this.now());
      return;
    }
    const item = data.page.plans[0];
    if (
      item !== undefined &&
      (item === null ||
        typeof item !== "object" ||
        (item.kind !== "no-write" && item.kind !== "version") ||
        (item.kind === "version" && (item.plan === null || typeof item.plan !== "object")))
    )
      throw new PipelineDataError("source_plan_shape");
    if (item?.kind === "version") {
      await saveArticleVersion(this.db, item.plan);
      const id = await articleRowId(data.sourceId, item.plan.externalId);
      const version = await this.db
        .prepare("SELECT id FROM article_versions WHERE article_id = ? AND content_hash = ?")
        .bind(id, item.plan.contentHash)
        .first<{ id: string }>();
      if (version !== null)
        await this.db
          .prepare(
            `INSERT INTO jobs (id,kind,payload_json,due_at,status,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?) ON CONFLICT(id) DO NOTHING`,
          )
          .bind(
            `pipeline:publication:${version.id}`,
            PUBLICATION_JOB,
            JSON.stringify({ versionId: version.id, backfill: data.page.backfill }),
            this.now(),
            this.now(),
            this.now(),
          )
          .run();
    }
    if (item !== undefined) data.page.plans.shift();
    if (data.page.plans.length > 0) {
      await this.finish(job, "pending", JSON.stringify(data), this.now());
      return;
    }
    // 同一 DO 的 watchdog/alarm 串行；外部不领取 pipeline 租约。进度 CAS 拒绝旧租约。
    await this.db
      .prepare(
        `UPDATE sources SET cursor_json = ?,last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,updated_at = ? WHERE source_id = ? AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND lease_version = ? AND status = 'leased')`,
      )
      .bind(
        JSON.stringify(data.page.nextState),
        Number(data.page.status === "ok"),
        this.now(),
        this.now(),
        data.sourceId,
        job.id,
        job.lease_version,
      )
      .run();
    if (data.page.status !== "ok")
      logEvent("error", "pipeline_job_failed", {
        reason_code: "source_incomplete",
        count: job.attempts,
        kind: job.kind,
      });
    await this.finish(
      job,
      "pending",
      JSON.stringify({ sourceId: data.sourceId }),
      data.page.status === "ok" ? nextDue : this.now() + WATCHDOG_INTERVAL * 1000,
      data.page.status === "ok" ? null : "source_incomplete",
    );
  }
  private async publication(job: Job, deadline: number): Promise<void> {
    const object = parseJobObject(job.payload_json);
    if (typeof object.versionId !== "string" || typeof object.backfill !== "boolean")
      throw new PipelineDataError("publication_job_shape");
    const data = object as unknown as PublicationPayload;
    if ((await readControl(this.db, "read_only")).value === true) {
      await this.finish(
        job,
        "pending",
        job.payload_json,
        this.now() + WATCHDOG_INTERVAL * 1000,
        "read_only",
      );
      return;
    }
    const result = await extractArticleVersion(this.db, data.versionId, this.now());
    const controls = await this.deps.readControls();
    let reason: string | null = null;
    if (result.candidate.reviewStatus === "rejected") {
      await this.finish(job, "done", job.payload_json, this.now(), "candidate_rejected");
      return;
    }
    if (result.candidate.reviewStatus !== "approved") reason = "awaiting_review";
    else if (result.candidate.path === "rule" && controls?.automaticPublication !== true)
      reason = "automatic_publication_unavailable_or_disabled";
    else if (
      (await readNoncriticalPublicationPause(this.db)) &&
      !(await isCriticalPublication(this.db, result.candidate))
    )
      reason = "noncritical_publication_paused";
    if (this.now() >= deadline) reason = "wall_limit";
    // 人工裁定前重抽只会得到同一结果：停放而不是每个周期重排，避免待审积压持续消耗 DO 请求与 D1 查询。
    if (reason === "awaiting_review") {
      await this.finish(
        job,
        AWAITING_REVIEW_STATUS,
        JSON.stringify({ ...data, seenAt: result.candidate.updatedAtMs }),
        this.now(),
        reason,
      );
      return;
    }
    if (reason !== null) {
      await this.finish(
        job,
        "pending",
        job.payload_json,
        this.now() + WATCHDOG_INTERVAL * 1000,
        reason,
      );
      return;
    }
    // ADR-0011：批准后版本时间表被改过或清除时，候选里的推导时间已过期，不发布；管理员需重新确认或修正。
    if (await staleVersionDerivation(this.db, result.candidate)) {
      logEvent("error", "pipeline_job_failed", {
        reason_code: "version_derivation_mismatch",
        kind: job.kind,
      });
      await this.finish(job, "done", job.payload_json, this.now(), "version_derivation_mismatch");
      return;
    }
    const outcome = await (this.deps.publish ?? publishApprovedCandidate)(
      this.db,
      result.candidate.candidateId,
      this.now(),
      data.backfill,
    );
    if (outcome.outcome === "published" && this.now() < deadline)
      await buildPublicSnapshot(this.db, this.now());
    await this.finish(
      job,
      outcome.outcome === "condition_missed" ? "pending" : "done",
      job.payload_json,
      this.now() + WATCHDOG_INTERVAL * 1000,
      outcome.outcome,
    );
  }
  private async draft(job: Job, deadline: number): Promise<void> {
    const object = parseJobObject(job.payload_json);
    if (typeof object.candidateId !== "string" || object.candidateId.length === 0)
      throw new PipelineDataError("draft_job_shape");
    const controls = await this.deps.readControls();
    const outcome = await (this.deps.draft ?? runDraftJob)({
      db: this.db,
      ai: this.deps.ai,
      candidateId: object.candidateId,
      modelEnabled: controls?.model === true,
      deadline,
      now: this.now,
    });
    // P3-25（ADR-0018）：新草稿写好且「跳过审核」开启时由系统批准；发布交给随后被唤醒的发布待办。
    // 批准失败只记日志，候选留在队列里给人工，草稿待办照常完成（已计费的结果不重做）。
    if (outcome.kind === "done" && outcome.reason === null && controls?.reviewSkip === true) {
      try {
        const skipped = await approveDraftWithoutReview(this.db, object.candidateId, this.now());
        logEvent("info", "review_skip", {
          reason_code: skipped.kind === "approved" ? "approved" : skipped.reason,
        });
      } catch {
        logEvent("error", "review_skip_failed", { reason_code: "approve" });
      }
    }
    if (outcome.kind === "done")
      await this.finish(job, "done", job.payload_json, this.now(), outcome.reason);
    else await this.finish(job, "pending", job.payload_json, outcome.dueAt, outcome.reason);
  }
  private async dispatchOne(deadline: number): Promise<void> {
    if (this.now() >= deadline) return;
    const now = this.now();
    const signal = await this.db
      .prepare(`SELECT o.id FROM outbox o LEFT JOIN jobs j ON j.id = 'pipeline:notification:' || o.id
      WHERE o.topic = ? AND ((o.dispatch_state = 'pending' AND (j.id IS NULL OR j.status = 'done'))
        OR (j.status = 'pending' AND j.due_at <= ?))
      ORDER BY o.created_at,o.id LIMIT 1`)
      .bind(NOTIFICATION_PUBLICATION_TOPIC, now)
      .first<{ id: string }>();
    if (signal === null) return;
    // outbox 本身没有重试元数据，沿用 jobs 保存次数、固定原因码、到期时间和租约。
    const id = `pipeline:notification:${signal.id}`;
    await this.db
      .prepare(`INSERT INTO jobs (id,kind,payload_json,due_at,status,created_at,updated_at)
      VALUES (?,?,?,?,'pending',?,?) ON CONFLICT(id) DO UPDATE SET status = 'pending',due_at = excluded.due_at
      WHERE jobs.status = 'done'`)
      .bind(id, NOTIFICATION_JOB, JSON.stringify({ outboxId: signal.id }), now, now, now)
      .run();
    const job = await this.db
      .prepare(`UPDATE jobs SET status = 'leased',lease_version = lease_version + 1,
      lease_owner = 'PipelineDO/main',lease_expires_at = ?,attempts = attempts + 1,updated_at = ?
      WHERE id = ? AND status = 'pending' AND due_at <= ? RETURNING id,kind,payload_json,lease_version,attempts`)
      .bind(deadline, now, id, now)
      .first<Job>();
    if (job === null) return;
    try {
      const state = await this.db
        .prepare("SELECT dispatch_state,payload_json FROM outbox WHERE id = ?")
        .bind(signal.id)
        .first<{ dispatch_state: string; payload_json: string }>();
      if (state?.dispatch_state !== "pending") {
        await this.finish(
          job,
          state?.dispatch_state === "dispatched" ? "done" : "failed",
          job.payload_json,
          this.now(),
          null,
        );
        return;
      }
      validatePublicationSignal(state.payload_json);
      await (this.deps.notify ?? generatePublicationOccurrences)(this.db, signal.id, this.now());
      const dispatched = await this.db
        .prepare("SELECT dispatch_state FROM outbox WHERE id = ?")
        .bind(signal.id)
        .first<{ dispatch_state: string }>();
      await this.finish(
        job,
        dispatched?.dispatch_state === "dispatched" ? "done" : "pending",
        job.payload_json,
        this.now() + WATCHDOG_INTERVAL * 1000,
        dispatched?.dispatch_state === "dispatched" ? null : "notification_condition_missed",
      );
    } catch (error) {
      await this.recordFailure(job, error, signal.id);
    }
  }
}
