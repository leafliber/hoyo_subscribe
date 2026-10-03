import { type ObsMetric, ObsMetricSchema, utcDayPeriod } from "@hoyo/contracts";
import { SOURCE_REGISTRY } from "../../sources/registry";
import { logEvent } from "../logger";

export interface MetricSlot {
  day: string;
  count: number;
  total: number;
  maximum: number;
  first_at: number;
  last_at: number;
}
export function metricKey(metric: ObsMetric, source?: string): string {
  ObsMetricSchema.parse(metric);
  if (
    source !== undefined &&
    (metric !== "source_response_truncated" ||
      !SOURCE_REGISTRY.some((e) => e.approvedHosts.includes(source)))
  )
    throw new Error("invalid_metric_source");
  return `obs:${metric}${source === undefined ? "" : `:${source}`}`;
}
/** 固定日槽覆盖更新，不按请求/账号/日期扩建键；失败不改变业务结果。 */
export async function recordMetric(
  db: D1Database,
  metric: ObsMetric,
  now: number,
  value = 1,
  source?: string,
): Promise<void> {
  try {
    const key = metricKey(metric, source);
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid_metric_value");
    const slot: MetricSlot = {
      day: utcDayPeriod(now).key,
      count: 1,
      total: value,
      maximum: value,
      first_at: now,
      last_at: now,
    };
    await db
      .prepare(`INSERT INTO system_state(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET
 value_json=CASE WHEN json_extract(system_state.value_json,'$.day')=json_extract(excluded.value_json,'$.day') THEN json_object(
 'day',json_extract(excluded.value_json,'$.day'),'count',json_extract(system_state.value_json,'$.count')+1,
 'total',json_extract(system_state.value_json,'$.total')+json_extract(excluded.value_json,'$.total'),
 'maximum',MAX(json_extract(system_state.value_json,'$.maximum'),json_extract(excluded.value_json,'$.maximum')),
 'first_at',MIN(json_extract(system_state.value_json,'$.first_at'),excluded.updated_at),'last_at',MAX(system_state.updated_at,excluded.updated_at))
 ELSE excluded.value_json END,updated_at=MAX(system_state.updated_at,excluded.updated_at)
 WHERE excluded.updated_at>=system_state.updated_at OR json_extract(system_state.value_json,'$.day')=json_extract(excluded.value_json,'$.day')`)
      .bind(key, JSON.stringify(slot), now)
      .run();
  } catch {
    logEvent("error", "observability_write_failed", { reason_code: "metric_write" });
  }
}
export async function readMetric(
  db: D1Database,
  metric: ObsMetric,
  now: number,
  source?: string,
): Promise<MetricSlot | null> {
  try {
    const row = await db
      .prepare("SELECT value_json FROM system_state WHERE key=?")
      .bind(metricKey(metric, source))
      .first<{ value_json: string }>();
    if (!row) return null;
    const slot = JSON.parse(row.value_json) as MetricSlot;
    return slot.day === utcDayPeriod(now).key &&
      [slot.count, slot.total, slot.maximum, slot.first_at, slot.last_at].every(Number.isFinite)
      ? slot
      : null;
  } catch {
    return null;
  }
}
