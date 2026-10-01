// P3-10 所有者追加授权：管理员发布可绑定已审版本，并在原条件提交中追加审计；钩子同时检查节点字节预算。
// P3-11 获准跨卡改动：仅透传 backfill 入参到通知 outbox，历史导入不得群发。
// P3-04 · 一次条件提交发布事实。只有本模块写事实、修订、投影与快照待更新 outbox。
// P4-01 获准跨卡改动：仅随同一条件提交追加通知发布 outbox，不改变原发布判定和事实写入。
import {
  API_BODY_MAX_BYTES,
  classifyPublicationChange,
  type EventChange,
  type EventStatus,
  type EventType,
  NOTIFICATION_PUBLICATION_TOPIC,
  type NodeType,
  PUBLIC_SNAPSHOT_PENDING_STATE_KEY,
  PUBLISH_ACTOR_PATH,
  PUBLISH_CHANGE_KIND,
  type PublicCalendarProjection,
  type PublicEventFacts,
  type PublicMilestoneFacts,
  type PublishActorPath,
  type PublishChangeKind,
  SNAPSHOT_REBUILD_TOPIC,
  type TimeValue,
  TimeValueSchema,
} from "@hoyo/contracts";
import { loadStoredArticleVersion, validateCandidateAgainstArticle } from "../extraction/article";
import { eventIdentity, milestoneIdentity } from "../extraction/identity";
import { type CandidateProposal, parseCandidateProposal } from "../extraction/schema";
import { conditionalCommit, type GuardedEffect } from "../storage/cas";

interface CandidateRow {
  id: string;
  run_id: string | null;
  event_id: string | null;
  proposal_json: string;
  review_status: string;
  updated_at: number;
  article_version_id: string;
  article_version_count: number;
  extractor: string | null;
  run_status: string | null;
  run_article_version_id: string | null;
}

interface ArticleVersionRow {
  article_id: string;
  version_no: number;
}

interface SnapshotPendingRow {
  updated_at: number;
}

interface EventRow {
  id: string;
  game: string;
  region: string;
  event_type: EventType;
  status: EventStatus;
  title: string;
  summary: string | null;
  official_url: string | null;
  event_revision: number;
  schedule_revision: number;
  human_locked: number;
}

interface MilestoneRow {
  id: string;
  milestone_key: string;
  node_type: NodeType;
  title: string;
  time_exact_ms: number | null;
  time_date: string | null;
  source_timezone: string;
  raw_expression: string;
  time_basis: TimeValue["time_basis"];
  time_precision: TimeValue["precision"];
  public_ical_revision: number;
  human_locked: number;
}

interface PlannedNode {
  id: string;
  old: MilestoneRow | null;
  facts: PublicMilestoneFacts;
  evidenceRef: string | null;
}

interface PlannedEvent {
  id: string;
  old: EventRow | null;
  facts: PublicEventFacts;
  nodes: PlannedNode[];
  change: EventChange;
  actor: PublishActorPath;
  association: boolean;
  reason: string | null;
  typeEvidenceRef: string;
  statusEvidenceRef: string | null;
}

export type PublishOutcome =
  | { readonly outcome: "published"; readonly event_ids: readonly string[] }
  | { readonly outcome: "unchanged" | "stale" | "locked" | "condition_missed" };

/** 准备阶段只校验并返回效果；不得在这里提前写库。原有调用者不传此选项。 */
export interface PublishHooks {
  readonly expectedUpdatedAt?: number;
  readonly prepareEffects?: (
    projections: readonly PublicCalendarProjection[],
  ) => Promise<readonly GuardedEffect[]>;
}

interface ManualAction {
  readonly reason: string;
  readonly targetEventId?: string;
  readonly retract?: boolean;
}

function requireReason(reason: string): void {
  if (reason.trim().length === 0 || reason.length > API_BODY_MAX_BYTES) {
    throw new Error("人工操作必须提供长度受限的非空理由");
  }
}

function eventFacts(row: EventRow): PublicEventFacts {
  return {
    event_type: row.event_type,
    status: row.status,
    title: row.title,
    summary: row.summary,
    official_url: row.official_url,
    human_locked: row.human_locked === 1,
  };
}

function nodeTime(row: MilestoneRow): TimeValue {
  const common = {
    source_timezone: row.source_timezone,
    raw_expression: row.raw_expression,
    time_basis: row.time_basis,
  };
  if (row.time_precision === "datetime")
    return TimeValueSchema.parse({ ...common, precision: "datetime", utc_ms: row.time_exact_ms });
  if (row.time_precision === "date")
    return TimeValueSchema.parse({ ...common, precision: "date", date: row.time_date });
  return TimeValueSchema.parse({ ...common, precision: "unknown" });
}

function nodeFacts(row: MilestoneRow): PublicMilestoneFacts {
  return {
    milestone_key: row.milestone_key,
    node_type: row.node_type,
    title: row.title,
    time: nodeTime(row),
    human_locked: row.human_locked === 1,
  };
}

function insert(
  table: string,
  columns: readonly string[],
  row: readonly (string | number | null)[],
): GuardedEffect {
  return { kind: "insert", table, columns, rows: [row] };
}

function timeColumns(time: TimeValue): { exact: number | null; date: string | null } {
  return {
    exact: time.precision === "datetime" ? time.utc_ms : null,
    date: time.precision === "date" ? time.date : null,
  };
}

function changeKind(event: PlannedEvent): PublishChangeKind {
  if (event.old === null) return PUBLISH_CHANGE_KIND.CREATED;
  if (event.association) return PUBLISH_CHANGE_KIND.ASSOCIATED;
  if (event.facts.status === "retracted") return PUBLISH_CHANGE_KIND.RETRACTED;
  if (event.actor === PUBLISH_ACTOR_PATH.MANUAL) return PUBLISH_CHANGE_KIND.MANUAL_CORRECTED;
  if (event.old.status !== event.facts.status) return PUBLISH_CHANGE_KIND.STATUS_UPDATED;
  if (event.change.schedule_revision) return PUBLISH_CHANGE_KIND.SCHEDULE_UPDATED;
  return PUBLISH_CHANGE_KIND.CONTENT_UPDATED;
}

async function loadCandidate(db: D1Database, candidateId: string): Promise<CandidateRow> {
  const row = await db
    .prepare(
      `SELECT c.id, c.run_id, c.event_id, c.proposal_json, c.review_status, c.updated_at,
            (SELECT MIN(e.article_version_id) FROM evidence e WHERE e.candidate_id = c.id) AS article_version_id,
            (SELECT COUNT(DISTINCT e.article_version_id) FROM evidence e WHERE e.candidate_id = c.id) AS article_version_count,
            er.extractor, er.status AS run_status, er.article_version_id AS run_article_version_id
       FROM candidates c LEFT JOIN extraction_runs er ON er.id = c.run_id WHERE c.id = ?`,
    )
    .bind(candidateId)
    .first<CandidateRow>();
  if (row === null || row.article_version_count !== 1 || row.article_version_id === null)
    throw new Error("候选不存在或 ArticleVersion 证据不唯一");
  return row;
}

async function alreadyLinked(db: D1Database, candidateId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM evidence WHERE candidate_id = ? AND event_id IS NOT NULL LIMIT 1")
    .bind(candidateId)
    .first<{ id: string }>();
  return row !== null;
}

async function loadEvent(
  db: D1Database,
  eventId: string,
): Promise<{ event: EventRow | null; nodes: MilestoneRow[] }> {
  const event = await db
    .prepare("SELECT * FROM events WHERE id = ?")
    .bind(eventId)
    .first<EventRow>();
  if (event === null) return { event: null, nodes: [] };
  const nodes =
    (
      await db
        .prepare("SELECT * FROM milestones WHERE event_id = ? ORDER BY milestone_key")
        .bind(eventId)
        .all<MilestoneRow>()
    ).results ?? [];
  return { event, nodes };
}

/** 常规发布只消费已批准候选；跨公告关联与受保护字段修改必须调用显式人工操作。 */
export async function publishApprovedCandidate(
  db: D1Database,
  candidateId: string,
  nowMs: number,
  backfill = false,
  hooks: PublishHooks = {},
): Promise<PublishOutcome> {
  return publishCandidate(db, candidateId, nowMs, null, backfill, hooks);
}

/** 带理由的人工修订，可修改 human_locked 对象；修订后锁定相关对象。 */
export async function publishManualCorrection(
  db: D1Database,
  candidateId: string,
  reason: string,
  nowMs: number,
  hooks: PublishHooks = {},
): Promise<PublishOutcome> {
  requireReason(reason);
  return publishCandidate(db, candidateId, nowMs, { reason }, false, hooks);
}

/** 显式建立跨公告业务关联；标题相似永远不会调用此路径。 */
export async function associateApprovedCandidate(
  db: D1Database,
  candidateId: string,
  targetEventId: string,
  reason: string,
  nowMs: number,
  hooks: PublishHooks = {},
): Promise<PublishOutcome> {
  requireReason(reason);
  if (!targetEventId) throw new Error("关联目标不能为空");
  return publishCandidate(db, candidateId, nowMs, { reason, targetEventId }, false, hooks);
}

/** 本站纠错撤回独立于官方取消；理由保存在不可变修订里。 */
export async function retractWithApprovedCandidate(
  db: D1Database,
  candidateId: string,
  reason: string,
  nowMs: number,
  hooks: PublishHooks = {},
): Promise<PublishOutcome> {
  requireReason(reason);
  return publishCandidate(db, candidateId, nowMs, { reason, retract: true }, false, hooks);
}

async function publishCandidate(
  db: D1Database,
  candidateId: string,
  nowMs: number,
  manual: ManualAction | null,
  backfill = false,
  hooks: PublishHooks = {},
): Promise<PublishOutcome> {
  const candidate = await loadCandidate(db, candidateId);
  if (hooks.expectedUpdatedAt !== undefined && candidate.updated_at !== hooks.expectedUpdatedAt)
    return { outcome: "condition_missed" };
  if (candidate.review_status !== "approved") throw new Error("只有已批准候选可发布");
  if (await alreadyLinked(db, candidateId)) return { outcome: "unchanged" };
  if (
    candidate.run_id !== null &&
    (candidate.run_status !== "succeeded" ||
      candidate.run_article_version_id !== candidate.article_version_id ||
      (candidate.extractor !== PUBLISH_ACTOR_PATH.RULE &&
        candidate.extractor !== PUBLISH_ACTOR_PATH.MODEL))
  )
    throw new Error("抽取运行不是对应 ArticleVersion 的成功结果");
  if (manual !== null && candidate.run_id !== null) throw new Error("人工操作只能消费人工候选");
  const article = await loadStoredArticleVersion(db, candidate.article_version_id);
  const raw: unknown = JSON.parse(candidate.proposal_json);
  const parsed = parseCandidateProposal(raw);
  const validated = validateCandidateAgainstArticle(raw, article);
  if (
    !parsed.success ||
    !validated.success ||
    article.completeness !== "complete" ||
    validated.data.classification === "uncertain"
  ) {
    throw new Error("候选 Schema、官方证据或正文完整性未通过发布校验");
  }
  const proposal: CandidateProposal = validated.data;
  if (proposal.classification !== "events") return { outcome: "unchanged" };
  if (proposal.events.some((event) => event.status === "retracted") && !manual?.retract)
    throw new Error("本站纠错撤回只能由带理由的撤回操作发布");
  if (manual?.retract && proposal.events.some((event) => event.status !== "retracted"))
    throw new Error("撤回操作要求候选状态为 retracted");
  if (manual?.targetEventId !== undefined && proposal.events.length !== 1)
    throw new Error("显式跨公告关联一次只指向一个事件");
  const version = await db
    .prepare("SELECT article_id, version_no FROM article_versions WHERE id = ?")
    .bind(article.articleVersionId)
    .first<ArticleVersionRow>();
  if (version === null || version.article_id !== article.articleId)
    throw new Error("文章版本关联不一致");
  const newer = await db
    .prepare("SELECT id FROM article_versions WHERE article_id = ? AND version_no > ? LIMIT 1")
    .bind(article.articleId, version.version_no)
    .first<{ id: string }>();
  if (newer !== null) return { outcome: "stale" };

  const planned: PlannedEvent[] = [];
  for (const item of proposal.events) {
    if (item.change_relation !== null && manual === null)
      throw new Error("跨公告关系必须由带理由的显式人工操作建立");
    if (
      manual?.targetEventId !== undefined &&
      item.change_relation !== null &&
      item.change_relation.target_event_id !== manual.targetEventId
    )
      throw new Error("显式关联目标与候选更正关系不一致");
    const eventId =
      manual?.targetEventId ??
      item.change_relation?.target_event_id ??
      (await eventIdentity(article.sourceId, article.externalId, item.event_key));
    const loaded = await loadEvent(db, eventId);
    if (candidate.run_id !== null && loaded.event !== null) {
      const associatedVersion = await db
        .prepare("SELECT id FROM evidence WHERE article_version_id = ? AND event_id = ? LIMIT 1")
        .bind(article.articleVersionId, eventId)
        .first<{ id: string }>();
      if (associatedVersion !== null) return { outcome: "unchanged" };
    }
    if (manual?.targetEventId !== undefined && loaded.event === null)
      throw new Error("显式关联目标不存在");
    if (
      loaded.event !== null &&
      (loaded.event.game !== article.game || loaded.event.region !== article.region)
    )
      throw new Error("目标事件与文章来源区域不一致");
    const oldByKey = new Map(loaded.nodes.map((node) => [node.milestone_key, node]));
    const nodes: PlannedNode[] = [];
    for (const milestone of item.milestones) {
      const old = oldByKey.get(milestone.milestone_key) ?? null;
      const id = await milestoneIdentity(eventId, milestone.milestone_key);
      if (old !== null && old.id !== id) throw new Error("稳定 Milestone 身份与存储不一致");
      nodes.push({
        id,
        old,
        facts: {
          milestone_key: milestone.milestone_key,
          node_type: milestone.node_type,
          title: milestone.title,
          time: milestone.time,
          human_locked: manual !== null || candidate.run_id === null || old?.human_locked === 1,
        },
        evidenceRef: milestone.time_evidence.block_ref,
      });
    }
    // 候选没有提及的旧节点保留。缺失本身不是官方取消证据。
    for (const old of loaded.nodes) {
      if (!nodes.some((node) => node.facts.milestone_key === old.milestone_key))
        nodes.push({ id: old.id, old, facts: nodeFacts(old), evidenceRef: null });
    }
    const facts: PublicEventFacts = {
      event_type: item.event_type,
      status: item.status,
      title: item.title,
      summary: item.summary,
      official_url: article.officialUrl,
      human_locked:
        manual !== null || candidate.run_id === null || loaded.event?.human_locked === 1,
    };
    const change = classifyPublicationChange(
      loaded.event === null ? null : eventFacts(loaded.event),
      facts,
      loaded.nodes.map(nodeFacts),
      nodes.map((node) => node.facts),
    );
    const locked =
      loaded.event?.human_locked === 1 || nodes.some((node) => node.old?.human_locked === 1);
    if (locked && manual === null) return { outcome: "locked" };
    const association = manual?.targetEventId !== undefined;
    planned.push({
      id: eventId,
      old: loaded.event,
      facts,
      nodes,
      change,
      actor:
        candidate.run_id === null
          ? PUBLISH_ACTOR_PATH.MANUAL
          : (candidate.extractor as PublishActorPath),
      association,
      reason: manual?.reason ?? null,
      typeEvidenceRef: item.type_evidence.block_ref,
      statusEvidenceRef: item.status_evidence?.block_ref ?? null,
    });
  }
  if (new Set(planned.map((event) => event.id)).size !== planned.length)
    throw new Error("候选多个事件解析到同一 Event 身份");
  const changed = planned.filter((event) => event.change.event_revision || event.association);
  if (changed.length === 0) return { outcome: "unchanged" };
  const snapshotPending = await db
    .prepare("SELECT updated_at FROM system_state WHERE key = ?")
    .bind(PUBLIC_SNAPSHOT_PENDING_STATE_KEY)
    .first<SnapshotPendingRow>();
  const effects: GuardedEffect[] = [];
  for (const event of changed)
    appendEventEffects(
      effects,
      event,
      candidateId,
      article.articleVersionId,
      article.game,
      article.region,
      nowMs,
      backfill,
    );
  if (snapshotPending === null) {
    effects.push(
      insert(
        "system_state",
        ["key", "value_json", "updated_at"],
        [PUBLIC_SNAPSHOT_PENDING_STATE_KEY, JSON.stringify({ pending: true }), nowMs],
      ),
    );
  } else {
    effects.push({
      kind: "update",
      table: "system_state",
      set: { value_json: JSON.stringify({ pending: true }), updated_at: nowMs },
      where: {
        sql: "key = ? AND updated_at = ?",
        params: [PUBLIC_SNAPSHOT_PENDING_STATE_KEY, snapshotPending.updated_at],
      },
    });
  }
  effects.push(
    insert(
      "outbox",
      [
        "id",
        "topic",
        "dedupe_key",
        "payload_json",
        "dispatch_state",
        "created_at",
        "dispatched_at",
      ],
      [
        crypto.randomUUID(),
        SNAPSHOT_REBUILD_TOPIC,
        `publish:${candidateId}`,
        JSON.stringify({ event_ids: changed.map((event) => event.id), candidate_id: candidateId }),
        "pending",
        nowMs,
        null,
      ],
    ),
  );

  const checks: string[] = [];
  const params: (string | number)[] = [
    candidateId,
    candidate.updated_at,
    candidate.proposal_json,
    candidateId,
    article.articleVersionId,
    version.article_id,
    version.version_no,
  ];
  if (snapshotPending === null) {
    checks.push("NOT EXISTS (SELECT 1 FROM system_state WHERE key = ?)");
    params.push(PUBLIC_SNAPSHOT_PENDING_STATE_KEY);
  } else {
    checks.push("EXISTS (SELECT 1 FROM system_state WHERE key = ? AND updated_at = ?)");
    params.push(PUBLIC_SNAPSHOT_PENDING_STATE_KEY, snapshotPending.updated_at);
  }
  // P3-12：预期状态只占一个 JSON 参数；以“没有任何不匹配项”核对整组，
  // 包括未变化的事件与保留的旧节点。缺行也算不匹配，不能用内连接漏掉。
  // 基础条件至多 9 个参数，JSON 1 个，规则/模型的文章去重 1 个：总计至多 11 个。
  params.push(
    JSON.stringify(
      planned.map((event) => ({
        id: event.id,
        revision: event.old?.event_revision ?? null,
        human_locked: event.old?.human_locked ?? null,
        nodes: event.nodes.map((node) => ({
          id: node.id,
          revision: node.old?.public_ical_revision ?? null,
          human_locked: node.old?.human_locked ?? null,
        })),
      })),
    ),
  );
  const extractionCheck =
    candidate.run_id === null
      ? ""
      : `EXISTS (SELECT 1 FROM evidence
          WHERE article_version_id = ? AND event_id = json_extract(expected.value, '$.id')) OR`;
  if (candidate.run_id !== null) params.push(article.articleVersionId);
  checks.push(`NOT EXISTS (
    SELECT 1 FROM json_each(?) AS expected
    WHERE ${extractionCheck}
      CASE WHEN json_extract(expected.value, '$.revision') IS NULL
        THEN EXISTS (SELECT 1 FROM events WHERE id = json_extract(expected.value, '$.id'))
        ELSE NOT EXISTS (SELECT 1 FROM events
          WHERE id = json_extract(expected.value, '$.id')
            AND event_revision = json_extract(expected.value, '$.revision')
            AND human_locked = json_extract(expected.value, '$.human_locked'))
      END
      OR EXISTS (
        SELECT 1 FROM json_each(expected.value, '$.nodes') AS node
        WHERE CASE WHEN json_extract(node.value, '$.revision') IS NULL
          THEN EXISTS (SELECT 1 FROM milestones WHERE id = json_extract(node.value, '$.id'))
          ELSE NOT EXISTS (SELECT 1 FROM milestones
            WHERE id = json_extract(node.value, '$.id')
              AND public_ical_revision = json_extract(node.value, '$.revision')
              AND human_locked = json_extract(node.value, '$.human_locked'))
            OR NOT EXISTS (SELECT 1 FROM calendar_projections
              WHERE milestone_id = json_extract(node.value, '$.id')
                AND public_ical_revision = json_extract(node.value, '$.revision'))
        END
      )
  )`);
  if (hooks.prepareEffects !== undefined) {
    effects.push(
      ...(await hooks.prepareEffects(
        changed.flatMap((event) =>
          event.nodes.map((node) => ({
            event_id: event.id,
            milestone_id: node.id,
            event: event.facts,
            milestone: node.facts,
          })),
        ),
      )),
    );
  }
  const result = await conditionalCommit(db, {
    guard: {
      sql: `UPDATE candidates SET updated_at = updated_at WHERE id = ? AND updated_at = ?
        AND proposal_json = ? AND review_status = 'approved'
        AND EXISTS (SELECT 1 FROM evidence WHERE candidate_id = ? AND article_version_id = ?)
        AND NOT EXISTS (SELECT 1 FROM evidence WHERE candidate_id = candidates.id AND event_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM article_versions WHERE article_id = ? AND version_no > ?)
        ${checks.map((check) => `AND ${check}`).join(" ")}`,
      params,
    },
    effects,
  });
  return result.outcome === "committed"
    ? { outcome: "published", event_ids: changed.map((event) => event.id) }
    : { outcome: "condition_missed" };
}

function appendEventEffects(
  effects: GuardedEffect[],
  event: PlannedEvent,
  candidateId: string,
  articleVersionId: string,
  game: string,
  region: string,
  nowMs: number,
  backfill: boolean,
): void {
  const old = event.old;
  const revision = (old?.event_revision ?? 0) + 1;
  const scheduleRevision = (old?.schedule_revision ?? 0) + (event.change.schedule_revision ? 1 : 0);
  if (old === null) {
    effects.push(
      insert(
        "events",
        [
          "id",
          "game",
          "region",
          "event_type",
          "status",
          "title",
          "summary",
          "official_url",
          "detail_path",
          "event_revision",
          "schedule_revision",
          "human_locked",
          "first_published_at",
          "created_at",
          "updated_at",
        ],
        [
          event.id,
          game,
          region,
          event.facts.event_type,
          event.facts.status,
          event.facts.title,
          event.facts.summary,
          event.facts.official_url,
          null,
          revision,
          scheduleRevision,
          Number(event.facts.human_locked),
          nowMs,
          nowMs,
          nowMs,
        ],
      ),
    );
  } else {
    effects.push({
      kind: "update",
      table: "events",
      set: {
        event_type: event.facts.event_type,
        status: event.facts.status,
        title: event.facts.title,
        summary: event.facts.summary,
        official_url: event.facts.official_url,
        event_revision: revision,
        schedule_revision: scheduleRevision,
        human_locked: Number(event.facts.human_locked),
        updated_at: nowMs,
      },
      where: { sql: "id = ? AND event_revision = ?", params: [event.id, old.event_revision] },
    });
  }
  for (const node of event.nodes) {
    const nodeChange = event.change.milestones[node.facts.milestone_key];
    if (nodeChange === undefined) throw new Error("节点版本判定缺失");
    const publicRevision =
      (node.old?.public_ical_revision ?? 0) + (nodeChange.public_ical_changed ? 1 : 0);
    const time = timeColumns(node.facts.time);
    if (node.old === null) {
      effects.push(
        insert(
          "milestones",
          [
            "id",
            "event_id",
            "milestone_key",
            "node_type",
            "title",
            "time_exact_ms",
            "time_date",
            "source_timezone",
            "raw_expression",
            "time_basis",
            "time_precision",
            "public_ical_revision",
            "human_locked",
            "created_at",
            "updated_at",
          ],
          [
            node.id,
            event.id,
            node.facts.milestone_key,
            node.facts.node_type,
            node.facts.title,
            time.exact,
            time.date,
            node.facts.time.source_timezone,
            node.facts.time.raw_expression,
            node.facts.time.time_basis,
            node.facts.time.precision,
            publicRevision,
            Number(node.facts.human_locked),
            nowMs,
            nowMs,
          ],
        ),
      );
    } else if (nodeChange.changed || nodeChange.public_ical_changed) {
      effects.push({
        kind: "update",
        table: "milestones",
        set: {
          node_type: node.facts.node_type,
          title: node.facts.title,
          time_exact_ms: time.exact,
          time_date: time.date,
          source_timezone: node.facts.time.source_timezone,
          raw_expression: node.facts.time.raw_expression,
          time_basis: node.facts.time.time_basis,
          time_precision: node.facts.time.precision,
          public_ical_revision: publicRevision,
          human_locked: Number(node.facts.human_locked),
          updated_at: nowMs,
        },
        where: {
          sql: "id = ? AND public_ical_revision = ?",
          params: [node.id, node.old.public_ical_revision],
        },
      });
    }
  }
  const refs: { eventId: string; milestoneId: string | null; ref: string }[] = [
    { eventId: event.id, milestoneId: null, ref: event.typeEvidenceRef },
  ];
  if (event.statusEvidenceRef !== null)
    refs.push({ eventId: event.id, milestoneId: null, ref: event.statusEvidenceRef });
  for (const node of event.nodes) {
    if (node.evidenceRef !== null)
      refs.push({ eventId: event.id, milestoneId: node.id, ref: node.evidenceRef });
  }
  for (const ref of refs)
    effects.push(
      insert(
        "evidence",
        [
          "id",
          "candidate_id",
          "event_id",
          "milestone_id",
          "article_version_id",
          "block_ref",
          "created_at",
        ],
        [
          crypto.randomUUID(),
          candidateId,
          ref.eventId,
          ref.milestoneId,
          articleVersionId,
          ref.ref,
          nowMs,
        ],
      ),
    );
  effects.push(
    insert(
      "event_revisions",
      [
        "id",
        "event_id",
        "revision_no",
        "change_kind",
        "actor_path",
        "reason",
        "diff_json",
        "created_at",
      ],
      [
        crypto.randomUUID(),
        event.id,
        revision,
        changeKind(event),
        event.actor,
        event.reason,
        JSON.stringify({
          before: old === null ? null : eventFacts(old),
          after: event.facts,
          schedule_revision: scheduleRevision,
          public_nodes: event.nodes
            .filter(
              (node) => event.change.milestones[node.facts.milestone_key]?.public_ical_changed,
            )
            .map((node) => node.id),
        }),
        nowMs,
      ],
    ),
  );
  effects.push(
    insert(
      "outbox",
      [
        "id",
        "topic",
        "dedupe_key",
        "payload_json",
        "dispatch_state",
        "created_at",
        "dispatched_at",
      ],
      [
        crypto.randomUUID(),
        NOTIFICATION_PUBLICATION_TOPIC,
        `notification:${event.id}:${revision}`,
        JSON.stringify({
          backfill,
          event_id: event.id,
          event_revision: revision,
          schedule_revision: scheduleRevision,
          change_kind: changeKind(event),
          changed_node_ids: event.nodes
            .filter((node) => event.change.milestones[node.facts.milestone_key]?.schedule_changed)
            .map((node) => node.id),
          newly_exact_node_ids: event.nodes
            .filter(
              (node) =>
                node.facts.time.precision === "datetime" &&
                (node.old === null || node.old.time_precision !== "datetime"),
            )
            .map((node) => node.id),
        }),
        "pending",
        nowMs,
        null,
      ],
    ),
  );
  for (const node of event.nodes) {
    const nodeChange = event.change.milestones[node.facts.milestone_key];
    if (!nodeChange?.public_ical_changed) continue;
    const revisionNo = (node.old?.public_ical_revision ?? 0) + 1;
    const projection = JSON.stringify({
      event_id: event.id,
      milestone_id: node.id,
      event: event.facts,
      milestone: node.facts,
    });
    if (node.old === null)
      effects.push(
        insert(
          "calendar_projections",
          ["milestone_id", "event_id", "public_ical_revision", "projection_json", "updated_at"],
          [node.id, event.id, revisionNo, projection, nowMs],
        ),
      );
    else
      effects.push({
        kind: "update",
        table: "calendar_projections",
        set: {
          public_ical_revision: revisionNo,
          projection_json: projection,
          updated_at: nowMs,
        },
        where: {
          sql: "milestone_id = ? AND public_ical_revision = ?",
          params: [node.id, node.old.public_ical_revision],
        },
      });
  }
}
