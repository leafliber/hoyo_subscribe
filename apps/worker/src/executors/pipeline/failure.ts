// P3-11 返工：确定性输入/SQL 上限停止；未知、网络和 D1 暂时故障延至下一 watchdog。
// 原始异常可能含 SQL 参数与正文，绝不写入日志或 last_error，只输出固定原因码。
import { PUBLISH_CHANGE_KIND } from "@hoyo/contracts";

export class PipelineDataError extends Error {}
export interface PipelineFailure {
  readonly terminal: boolean;
  readonly reason:
    | "sql_binding_limit"
    | "sql_statement_limit"
    | "sql_value_limit"
    | "invalid_data"
    | "transient_or_unknown";
}
export function classifyPipelineFailure(error: unknown): PipelineFailure {
  const visited = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (/SQLITE_TOOBIG|string or blob too big/i.test(current.message))
      return { terminal: true, reason: "sql_value_limit" };
    if (/too many SQL variables|too many (?:bound|bind(?:ing)?) parameters/i.test(current.message))
      return { terminal: true, reason: "sql_binding_limit" };
    if (
      /too many (?:SQL )?(?:statements|queries)|(?:exceeded|maximum|max)[^\n]*(?:number of queries|queries per|statements per)/i.test(
        current.message,
      )
    )
      return { terminal: true, reason: "sql_statement_limit" };
    if (
      current instanceof PipelineDataError ||
      current instanceof SyntaxError ||
      current.name === "ZodError" ||
      /D1_TYPE_ERROR|SQLITE_CONSTRAINT|候选.*(?:Schema|校验)|保存的候选未通过|只有已批准候选可发布|发布信号所指事件不存在|ArticleVersion .*?(?:无效|不存在)|来源存储与已核验注册项不一致|来源已下线/.test(
        current.message,
      )
    )
      return { terminal: true, reason: "invalid_data" };
    current = current.cause;
  }
  return { terminal: false, reason: "transient_or_unknown" };
}
export function parseJobObject(raw: string): Record<string, unknown> {
  const data: unknown = JSON.parse(raw);
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw new PipelineDataError("job_shape");
  return data as Record<string, unknown>;
}

/** 仅校验已有通知入口的载荷形状；枚举与通知语义仍由 contracts / P4-01 定义。 */
export function validatePublicationSignal(raw: string): void {
  const data = parseJobObject(raw);
  const strings = (value: unknown) =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (
    typeof data.event_id !== "string" ||
    !Number.isSafeInteger(data.event_revision) ||
    !Number.isSafeInteger(data.schedule_revision) ||
    !Object.values(PUBLISH_CHANGE_KIND).some((kind) => kind === data.change_kind) ||
    !strings(data.changed_node_ids) ||
    !strings(data.newly_exact_node_ids) ||
    (data.backfill !== undefined && typeof data.backfill !== "boolean")
  )
    throw new PipelineDataError("publication_signal_shape");
}
