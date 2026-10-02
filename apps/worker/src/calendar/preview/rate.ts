import {
  CALENDAR_PREVIEW_RATE_LIMIT,
  CALENDAR_PREVIEW_RATE_WINDOW,
  RATE_WINDOWS_MAX,
} from "@hoyo/contracts";

/** ADR-0006：每个路由实例（生产为 isolate 内复用的 shell）独立持有，不写持久账本。
 * 保存最近窗口内受理的时间；同步检查并占用，任何 await 前完成，并发不能超卖。
 * 单键最多 RATE_LIMIT 个时间，键数受 RATE_WINDOWS_MAX 约束；满额只回收已过期键。
 */
export class CalendarPreviewRateGate {
  readonly #windows = new Map<string, number[]>();

  /** 返回 0 表示已受理；否则返回可公开的等待毫秒数。失败的后续读取不退次数。 */
  take(sessionId: string, now: number): number {
    const windowMs = CALENDAR_PREVIEW_RATE_WINDOW * 1000;
    const cutoff = now - windowMs;
    const active = (this.#windows.get(sessionId) ?? []).filter((time) => time > cutoff);
    if (active.length >= CALENDAR_PREVIEW_RATE_LIMIT) return Math.min(...active) + windowMs - now;
    if (!this.#windows.has(sessionId) && this.#windows.size >= RATE_WINDOWS_MAX) {
      for (const [key, times] of this.#windows)
        if (times.every((time) => time <= cutoff)) this.#windows.delete(key);
      // 不驱逐仍有效的桶，避免新会话挤掉旧计数；拒绝时不分配新键。
      if (this.#windows.size >= RATE_WINDOWS_MAX) return windowMs;
    }
    this.#windows.set(sessionId, [...active, now]);
    return 0;
  }
}
