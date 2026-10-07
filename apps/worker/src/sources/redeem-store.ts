// ADR-0030 · 「有效兑换码」条的数据：采集写入、管理员登记的活动 ID、公开读取。
// 兑换码照官方原样保存，不经审核；是否显示只按 contracts redeemCodeVisible。日历事件另走文章与发布流程。
import {
  type PublicRedeemCode,
  REDEEM_LIVE_TRACK_DAYS,
  REDEEM_LIVE_TRACK_MAX,
  redeemCodeHiddenAt,
  redeemCodeVisible,
} from "@hoyo/contracts";
import type { RedeemUpdate } from "../executors/pipeline/collect-live";
import { eventIdentity } from "../extraction/identity";
import { liveOfficialUrl } from "./adapters/miyolive";
import { isLiveEntry, type MiyoliveSourceEntry, SOURCE_REGISTRY } from "./registry";

// 单位换算，非业务参数。
const DAY = 86_400_000;
/** 兑换码事件在规则模板里的 event_key（extraction/rules.ts miyoliveRedeemCodes）。 */
export const REDEEM_EVENT_KEY = "redeem_codes";

/** 管理员登记的直播活动 ID 存在 system_state 的这个键下（每个来源一份）。 */
export function redeemHintKey(sourceId: string): string {
  return `redeem_live_hints:${sourceId}`;
}

export interface RedeemHint {
  readonly act_id: string;
  readonly added_at: number;
}

function parseHints(raw: string | null | undefined): RedeemHint[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is RedeemHint =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as RedeemHint).act_id === "string" &&
        Number.isSafeInteger((item as RedeemHint).added_at),
    );
  } catch {
    return [];
  }
}

/** 仍在跟踪期内的登记，最新的在前，至多 REDEEM_LIVE_TRACK_MAX 个。 */
export async function readRedeemHints(
  db: D1Database,
  sourceId: string,
  now: number,
): Promise<RedeemHint[]> {
  const row = await db
    .prepare("SELECT value_json FROM system_state WHERE key = ?")
    .bind(redeemHintKey(sourceId))
    .first<{ value_json: string }>();
  return parseHints(row?.value_json)
    .filter((hint) => hint.added_at >= now - REDEEM_LIVE_TRACK_DAYS * DAY)
    .sort((a, b) => b.added_at - a.added_at)
    .slice(0, REDEEM_LIVE_TRACK_MAX);
}

/** 新登记放在最前；同一 ID 只保留最新一次；连同旧登记一起按跟踪期与上限裁剪。 */
export function mergeRedeemHints(
  previousJson: string | null,
  actId: string,
  now: number,
): RedeemHint[] {
  return [
    { act_id: actId, added_at: now },
    ...parseHints(previousJson).filter((hint) => hint.act_id !== actId),
  ]
    .filter((hint) => hint.added_at >= now - REDEEM_LIVE_TRACK_DAYS * DAY)
    .slice(0, REDEEM_LIVE_TRACK_MAX);
}

/** 采集结果写入：新码插入、已有的更新说明与有效期；官方"活动已结束"的活动记下时刻（只记第一次）。 */
export async function persistRedeemUpdate(
  db: D1Database,
  entry: MiyoliveSourceEntry,
  update: RedeemUpdate,
  now: number,
): Promise<void> {
  const statements = [
    ...update.rows.map((row) =>
      db
        .prepare(
          `INSERT INTO redeem_codes (source_id, act_id, code, game, live_title, reward, revealed_at,
             expires_at, expiry_text, live_closed_at, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT (source_id, act_id, code) DO UPDATE SET
             live_title = excluded.live_title, reward = excluded.reward,
             revealed_at = excluded.revealed_at, expires_at = excluded.expires_at,
             expiry_text = excluded.expiry_text, updated_at = excluded.updated_at`,
        )
        .bind(
          entry.sourceId,
          row.actId,
          row.code,
          entry.game,
          row.liveTitle,
          row.reward,
          row.revealedAt,
          row.expiresAt,
          row.expiryText,
          now,
          now,
        ),
    ),
    ...update.closed.map((actId) =>
      db
        .prepare(
          `UPDATE redeem_codes SET live_closed_at = ?, updated_at = ?
            WHERE source_id = ? AND act_id = ? AND live_closed_at IS NULL`,
        )
        .bind(now, now, entry.sourceId, actId),
    ),
  ];
  if (statements.length > 0) await db.batch(statements);
}

interface RedeemCodeDbRow {
  source_id: string;
  act_id: string;
  code: string;
  game: string;
  live_title: string;
  reward: string;
  revealed_at: number;
  expires_at: number | null;
  expiry_text: string | null;
  live_closed_at: number | null;
}

/**
 * 当前在条里的兑换码：SQL 先按发放时刻取跟踪期内的行（有界），再逐条用 contracts redeemCodeVisible 判定。
 * 只取注册表里的直播来源；事件已发布时带上事件 ID（按规则模板的事件身份计算后核对存在）。
 */
export async function readVisibleRedeemCodes(
  db: D1Database,
  now: number,
): Promise<PublicRedeemCode[]> {
  const entries = SOURCE_REGISTRY.filter(isLiveEntry);
  const rows = (
    await db
      .prepare(
        `SELECT source_id, act_id, code, game, live_title, reward, revealed_at, expires_at,
                expiry_text, live_closed_at
           FROM redeem_codes
          WHERE revealed_at <= ? AND revealed_at >= ?
            AND source_id IN (SELECT value FROM json_each(?))
          ORDER BY revealed_at, source_id, act_id, code`,
      )
      .bind(
        now,
        now - REDEEM_LIVE_TRACK_DAYS * DAY,
        JSON.stringify(entries.map((entry) => entry.sourceId)),
      )
      .all<RedeemCodeDbRow>()
  ).results.filter((row) =>
    redeemCodeVisible(
      { revealedAt: row.revealed_at, expiresAt: row.expires_at, liveClosedAt: row.live_closed_at },
      now,
    ),
  );
  if (rows.length === 0) return [];
  const eventIds = new Map<string, string>();
  for (const row of rows) {
    const key = `${row.source_id}\n${row.act_id}`;
    if (!eventIds.has(key))
      eventIds.set(key, await eventIdentity(row.source_id, row.act_id, REDEEM_EVENT_KEY));
  }
  const published = new Set(
    (
      await db
        .prepare("SELECT id FROM events WHERE id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify([...eventIds.values()]))
        .all<{ id: string }>()
    ).results.map((row) => row.id),
  );
  return rows.flatMap((row) => {
    const entry = entries.find((candidate) => candidate.sourceId === row.source_id);
    if (entry === undefined) return [];
    const eventId = eventIds.get(`${row.source_id}\n${row.act_id}`) ?? null;
    return [
      {
        game: entry.game,
        code: row.code,
        reward: row.reward,
        liveTitle: row.live_title,
        revealedAt: row.revealed_at,
        expiresAt: row.expires_at,
        expiryText: row.expiry_text,
        hiddenAt: redeemCodeHiddenAt({
          revealedAt: row.revealed_at,
          expiresAt: row.expires_at,
          liveClosedAt: row.live_closed_at,
        }),
        officialUrl: liveOfficialUrl(entry, row.act_id),
        eventId: eventId !== null && published.has(eventId) ? eventId : null,
      },
    ];
  });
}
