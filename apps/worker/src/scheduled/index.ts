// P4-03 获准跨卡：仅向默认分发列表注册 Delivery watchdog。
// P3-11：scheduled 分发框架；P4-03 可注册 Delivery watchdog，本卡不调用邮件执行器。
import { WATCHDOG_INTERVAL } from "@hoyo/contracts";
import { logEvent } from "../shell/logger";
// Wrangler 的声明式 Cron 无法 import TS；测试校验唯一参数派生式，防止第二份配置漂移。
export const WATCHDOG_CRON = `*/${WATCHDOG_INTERVAL / 60} * * * *`;
export type Watchdog = (env: Env) => Promise<void>;
export const pipelineWatchdog: Watchdog = async (env) => {
  const response = await env.PIPELINE_DO.get(env.PIPELINE_DO.idFromName("main")).fetch(
    "https://pipeline.internal/watchdog",
    { method: "POST" },
  );
  if (!response.ok) throw new Error("pipeline_watchdog_failed");
};
export const deliveryWatchdog: Watchdog = async (env) => {
  const response = await env.DELIVERY_DO.get(env.DELIVERY_DO.idFromName("main")).fetch(
    "https://delivery.internal/watchdog",
    { method: "POST" },
  );
  if (!response.ok) throw new Error("delivery_watchdog_failed");
};
export async function dispatchScheduled(
  env: Env,
  watchdogs: readonly Watchdog[] = [pipelineWatchdog, deliveryWatchdog],
): Promise<void> {
  for (const watchdog of watchdogs) {
    try {
      await watchdog(env);
    } catch {
      logEvent("error", "watchdog_failed", { reason_code: "executor_watchdog" });
    }
  }
}
export async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  await dispatchScheduled(env);
}
