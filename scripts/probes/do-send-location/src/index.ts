// P0-01 探针：do-send-location
// 目的：观测 Durable Object 的「发送/执行位置」（请求两侧看到的 colo 字段）与 alarm 行为：
//   1) 前台 Worker 与 DO 各自看到的 request.cf.colo / cf-ray（字段发现：记录实际出现什么，不预设）；
//   2) alarm 在【无外部请求】的情况下是否自行触发、触发时刻与计划时刻的偏差；
//   3) 「读-等-写」与「紧凑读写」两种模式下并发请求是否丢失更新（DO 输入门禁的观测）。
// 本探针只写 DO 自己 storage 里的探针观测键，不接触任何业务数据。
//
// 运行（本地 miniflare，无需账户）：node scripts/probes/do-send-location/run-local.mjs
// 运行（目标环境，需所有者）：见 docs/evidence/p0/OWNER_CHECKLIST.md §B-4
// ⚠ 仅供临时运行取证，禁止公开部署。

interface DOStorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(scheduledAtMs: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

interface DOStateLike {
  storage: DOStorageLike;
}

interface DOStubLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DOStubLike;
}

interface Env {
  PROBE_DO: DurableObjectNamespaceLike;
}

interface RequestObservation {
  ts_utc: string;
  path: string;
  cf_colo: string | null;
  cf_ray: string | null;
}

interface AlarmObservation {
  scheduled_for_ms: number | null;
  set_at_ms: number | null;
  fired_at_ms: number;
  fired_at_utc: string;
  skew_ms: number | null;
}

const MAX_LOG = 100;

function nowIso(): string {
  return new Date().toISOString();
}

function cfColoOf(request: Request): string | null {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
  const colo = cf?.colo;
  return typeof colo === "string" ? colo : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class P0ProbeDO {
  constructor(private readonly state: DOStateLike) {}

  private async appendLog(
    key: "req_log" | "alarm_log",
    entry: Record<string, unknown>,
  ): Promise<void> {
    const log = (await this.state.storage.get(key)) as Array<Record<string, unknown>> | undefined;
    const next = [...(log ?? []), entry];
    if (next.length > MAX_LOG) next.splice(0, next.length - MAX_LOG);
    await this.state.storage.put(key, next);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await this.appendLog("req_log", {
      ts_utc: nowIso(),
      path: url.pathname,
      cf_colo: cfColoOf(request),
      cf_ray: request.headers.get("cf-ray"),
    } satisfies RequestObservation);

    if (url.pathname === "/observation") {
      return json({
        ts_utc: nowIso(),
        cf_colo: cfColoOf(request),
        cf_ray: request.headers.get("cf-ray"),
        current_alarm_ms: await this.state.storage.getAlarm(),
      });
    }

    if (url.pathname === "/set-alarm") {
      const delayMs = Math.max(
        0,
        Math.min(Number(url.searchParams.get("delay_ms") ?? 2000), 60_000),
      );
      const setAt = Date.now();
      const scheduledFor = setAt + delayMs;
      await this.state.storage.put("alarm_scheduled", {
        scheduled_for_ms: scheduledFor,
        set_at_ms: setAt,
      });
      await this.state.storage.setAlarm(scheduledFor);
      return json({ set_at_ms: setAt, scheduled_for_ms: scheduledFor, delay_ms: delayMs });
    }

    if (url.pathname === "/counter") {
      return json({ counter: (await this.state.storage.get("counter")) ?? 0 });
    }

    if (url.pathname === "/reset-counter") {
      await this.state.storage.put("counter", 0);
      return json({ counter: 0 });
    }

    if (url.pathname === "/bump") {
      const delayMs = Math.max(0, Math.min(Number(url.searchParams.get("delay_ms") ?? 0), 5_000));
      const current = (await this.state.storage.get("counter")) as number | undefined;
      // slow 模式（delay_ms>0）：读与写之间留出可交错窗口，观测输入门禁是否放行并发
      if (delayMs > 0) await sleep(delayMs);
      await this.state.storage.put("counter", (current ?? 0) + 1);
      return json({ read: current ?? 0, wrote: (current ?? 0) + 1, delayed_ms: delayMs });
    }

    if (url.pathname === "/report") {
      return json({
        ts_utc: nowIso(),
        cf_colo: cfColoOf(request),
        cf_ray: request.headers.get("cf-ray"),
        counter: (await this.state.storage.get("counter")) ?? 0,
        current_alarm_ms: await this.state.storage.getAlarm(),
        req_log: (await this.state.storage.get("req_log")) ?? [],
        alarm_log: (await this.state.storage.get("alarm_log")) ?? [],
        alarm_scheduled: (await this.state.storage.get("alarm_scheduled")) ?? null,
      });
    }

    return json({ ok: false, error: "not_found" }, 404);
  }

  async alarm(): Promise<void> {
    // 关键观测点：alarm 到期时【没有外部请求】也会进入这里；记录触发时刻与偏差
    const scheduled = (await this.state.storage.get("alarm_scheduled")) as
      | { scheduled_for_ms: number; set_at_ms: number }
      | undefined;
    const firedAt = Date.now();
    await this.appendLog("alarm_log", {
      scheduled_for_ms: scheduled?.scheduled_for_ms ?? null,
      set_at_ms: scheduled?.set_at_ms ?? null,
      fired_at_ms: firedAt,
      fired_at_utc: new Date(firedAt).toISOString(),
      skew_ms: scheduled ? firedAt - scheduled.scheduled_for_ms : null,
    } satisfies AlarmObservation);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.PROBE_DO.get(env.PROBE_DO.idFromName("probe-primary"));
    // 该 workerd 的 DO stub.fetch 不接受相对路径字符串，必须绝对 URL（主机名对 DO 无意义）
    const doUrl = (path: string) => `http://do-send-location.probe.internal${path}`;
    const doFetchJson = async (path: string) => {
      const res = await stub.fetch(doUrl(path));
      return (await res.json()) as Record<string, unknown>;
    };

    if (url.pathname === "/health") {
      return json({ ok: true, probe: "do-send-location" });
    }

    if (url.pathname === "/probe/observation") {
      const front = {
        ts_utc: nowIso(),
        cf_colo: cfColoOf(request),
        cf_ray: request.headers.get("cf-ray"),
      };
      const inside = await doFetchJson("/observation");
      return json({ front_worker: front, durable_object: inside });
    }

    if (url.pathname === "/probe/alarm") {
      const delayMs = Math.max(
        0,
        Math.min(Number(url.searchParams.get("delay_ms") ?? 2000), 60_000),
      );
      const resp = await doFetchJson(`/set-alarm?delay_ms=${delayMs}`);
      return json({ requested_delay_ms: delayMs, durable_object: resp });
    }

    if (url.pathname === "/probe/serialization") {
      const n = Math.max(1, Math.min(Number(url.searchParams.get("n") ?? 8), 64));
      const delayMs = Math.max(0, Math.min(Number(url.searchParams.get("delay_ms") ?? 150), 5_000));
      await doFetchJson("/reset-counter");

      // 模式 A（slow）：读-等-写之间有可交错窗口
      const startedA = Date.now();
      await Promise.all(
        Array.from({ length: n }, () => stub.fetch(doUrl(`/bump?delay_ms=${delayMs}`))),
      );
      const wallA = Date.now() - startedA;
      const counterA = (await doFetchJson("/counter")).counter;

      await doFetchJson("/reset-counter");
      // 模式 B（compact）：读写之间无外来 await
      const startedB = Date.now();
      await Promise.all(Array.from({ length: n }, () => stub.fetch(doUrl("/bump?delay_ms=0"))));
      const wallB = Date.now() - startedB;
      const counterB = (await doFetchJson("/counter")).counter;

      return json({
        slow_interleaved: {
          n,
          delay_ms: delayMs,
          wall_ms: wallA,
          final_counter: counterA,
          lost_updates: n - Number(counterA),
          note: "读-等-写之间有 sleep 窗口；丢失更新 > 0 说明门禁在纯等待期间放行并发",
        },
        compact: {
          n,
          delay_ms: 0,
          wall_ms: wallB,
          final_counter: counterB,
          lost_updates: n - Number(counterB),
          note: "读写紧邻无外来 await；丢失更新 = 0 说明存储操作期间输入门禁串行化",
        },
      });
    }

    if (url.pathname === "/probe/report") {
      const front = {
        ts_utc: nowIso(),
        cf_colo: cfColoOf(request),
        cf_ray: request.headers.get("cf-ray"),
      };
      const report = await doFetchJson("/report");
      return json({ front_worker: front, durable_object: report });
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};
