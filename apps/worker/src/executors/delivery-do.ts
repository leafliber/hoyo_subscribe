import { WATCHDOG_INTERVAL } from "@hoyo/contracts";
// P4-03 获准跨卡：替换占位；唯一 DeliveryDO/main，整个异步工作单元串行化。
import { mailDependencies } from "../mail/provider/environment";
import { logEvent } from "../shell/logger";
import { DeliveryRuntime } from "./delivery/runtime";
export class DeliveryDO {
  private readonly runtime: DeliveryRuntime;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    this.runtime = new DeliveryRuntime(mailDependencies(env));
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/watchdog", "/wake"].includes(path))
      return new Response(null, { status: 404 });
    return this.exclusive(async () => {
      try {
        if (path === "/watchdog") await this.runtime.watchdog();
      } finally {
        await this.rearm();
      }
      return new Response(null, { status: 204 });
    });
  }
  async alarm(): Promise<void> {
    await this.exclusive(async () => {
      try {
        await this.runtime.watchdog();
        await this.runtime.tick();
      } finally {
        await this.rearm();
      }
    });
  }
  private async rearm(): Promise<void> {
    try {
      const due = await this.runtime.nextAlarm();
      if (due !== null) await this.state.storage.setAlarm(due);
      else await this.state.storage.deleteAlarm();
    } catch {
      // D1 连失败原因也写不进去时，用 DO alarm 保留下一 watchdog 的重试时间。
      logEvent("error", "delivery_alarm_read_failed", { reason_code: "next_watchdog" });
      await this.state.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL * 1000);
    }
  }
}
