// P3-11：唯一 PipelineDO/main；D1 持久待办 + alarm，Cron 修复唤醒。

import { readPipelineControls } from "./pipeline/controls";
import { PipelineRuntime } from "./pipeline/runtime";
export class PipelineDO {
  private readonly runtime: PipelineRuntime;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    this.runtime = new PipelineRuntime({
      db: env.DB,
      readControls: () => readPipelineControls(env.DB),
    });
  }
  // 包含网络 await 的整个工作单元串行化，避免 alarm 与 watchdog 在 await 处交错窃取租约。
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/watchdog")
      return new Response(null, { status: 404 });
    return this.exclusive(async () => {
      try {
        await this.runtime.watchdog();
      } finally {
        await this.rearm();
      }
      return new Response(null, { status: 204 });
    });
  }
  async alarm(): Promise<void> {
    await this.exclusive(async () => {
      try {
        await this.runtime.tick();
      } finally {
        await this.rearm();
      }
    });
  }
  private async rearm(): Promise<void> {
    const due = await this.runtime.nextAlarm();
    if (due !== null) await this.state.storage.setAlarm(due);
  }
}
