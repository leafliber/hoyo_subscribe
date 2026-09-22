// 结构化日志与脱敏（任务卡 P1-08 交付物五；主方案 §8.3、ENGINEERING.md §5.5）。
//
// 直接消费 P1-06 已交付的 redaction 模块（@hoyo/contracts 导出）：
//   sanitizeForLog —— 白名单序列化（非白名单键静默丢弃）+ 值级脱敏（完整邮箱、
//                     带 token 的 Feed/退订路径替换占位符）；
//   assertNoLogLeaks —— 禁止字段/禁止值自动检查（黑名单，宁可误报不可漏报）。
// 本模块**不另写**任何脱敏规则，只规定日志的形状与发射路径：
//   logEvent  —— 组装 {ts, level, event, ...fields} → sanitizeForLog → 防御性
//                assertNoLogLeaks → console.log（Workers 结构化日志通道）。
//   防御性断言失败时整条丢弃，只留固定占位行（宁可少记，绝不带病落盘）。
//   logAnomalySampled —— §8.3"异常请求日志采样"：确定性 1/ANOMALY_LOG_SAMPLING，
//                指纹只参与采样决定、绝不落盘（IP/UA 不是授权也不是要保存的对象）。
import { assertNoLogLeaks, sanitizeForLog, shouldSampleAnomaly } from "@hoyo/contracts";

/** 日志级别。 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * 发射一条**已脱敏**的日志行；防御性断言仍命中禁止项时整条丢弃并留固定占位。
 * 独立导出以便测试直接构造"脱敏后仍带毒"的记录验证丢弃路径。
 */
export function emitSanitizedLogLine(sanitizedRecord: unknown): void {
  try {
    assertNoLogLeaks(sanitizedRecord);
  } catch {
    console.log(
      JSON.stringify({ ts: Date.now(), level: "error", event: "log_line_dropped_by_redaction" }),
    );
    return;
  }
  console.log(JSON.stringify(sanitizedRecord));
}

/**
 * 记一条结构化事件：字段经白名单序列化与值级脱敏后发射。
 * 注意：调用方不得把用户可控字符串放进 fields——白名单只保证键安全与值脱敏，
 * 不保证语义（错误消息一律只记 error.name，见 router 的 handler_error）。
 */
export function logEvent(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const record: Record<string, unknown> = { ts: Date.now(), level, event };
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      record[key] = value;
    }
  }
  emitSanitizedLogLine(sanitizeForLog(record));
}

/**
 * 异常请求采样日志（§8.3）：同指纹恒同判（重放不放大日志量），命中才落一条
 * 只含 kind 与 route 的记录；fingerprint（可能含 Origin/IP/UA）绝不写入日志内容。
 * 返回是否落盘，供调用方决定是否连带跳过其他动作。
 */
export function logAnomalySampled(kind: string, route: string, fingerprint: string): boolean {
  if (!shouldSampleAnomaly(`${kind}\n${route}\n${fingerprint}`)) {
    return false;
  }
  logEvent("warn", "request_anomaly", { reason_code: kind, route });
  return true;
}
