// 异常请求日志采样（任务卡 P1-08 交付物五；主方案 §8.3、ENGINEERING.md §5.5）。
//
// 合同原文（§8.3）："近似 IP/边缘限速只挡突发……异常请求日志采样，不能把每次攻击
// 变成一条持久审计记录。"
//
// 机制：对异常事件按稳定指纹做确定性采样——同一指纹永远得到同一决定（重放攻击不会
// 因重复而多记），不同指纹均匀散布，约 1/ANOMALY_LOG_SAMPLING 的事件落盘。
//
// 关于常量位置（实现推断，交付报告中单列）：附录 A 没有日志采样条目，而任务卡 P1-08
// 把 contracts 侧改动范围限定在 src/errors/**。本文件因此与错误模型放在一起，作为
// §8.3 安全日志合同的一部分**只定义一次**；若验收方认为应进参数注册表，移动是
// 一行改动（ANOMALY_LOG_SAMPLING → params/registry.ts），不产生第二份值。

/** 采样分母：约每 ANOMALY_LOG_SAMPLING 个异常事件落盘一条（§8.3）。 */
export const ANOMALY_LOG_SAMPLING = 16 as const;

/**
 * FNV-1a 32 位哈希（纯函数、无依赖、跨运行时稳定）。只用于采样分桶，不作安全用途。
 */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 指纹的确定性采样桶（0 ≤ bucket < ANOMALY_LOG_SAMPLING）。 */
export function anomalySampleBucket(fingerprint: string): number {
  return fnv1a32(fingerprint) % ANOMALY_LOG_SAMPLING;
}

/**
 * 该异常事件是否落盘：桶 0 落盘，其余不落盘。确定性——同一指纹恒定同判；
 * 指纹本身（可能含 IP/UA）绝不写入日志内容，只参与本决定（§8.3：IP 不是授权，
 * 也不是要持久化的对象）。
 */
export function shouldSampleAnomaly(fingerprint: string): boolean {
  return anomalySampleBucket(fingerprint) === 0;
}
