// P3-06 · §6.6：授权→当前完整代次→来源水位→组装→最终 CAS→守卫→HEAD/ETag。
import {
  buildApiErrorBody,
  FEED_DIAGNOSTICS,
  FEED_RESPONSE_MAX_BYTES,
  type FeedDiagnostic,
  feedIdentity,
  feedNeedsShrinkEvidence,
  feedNodeLimit,
  feedShrinkBlocked,
  feedSourcesFresh,
  personalCalendarNodes,
} from "@hoyo/contracts";
import { logEvent } from "../../shell/logger";
import type { RouteContext } from "../../shell/router";
import { toHex } from "../../storage/crypto/bytes";
import { serializeCalendar } from "./ical";
import {
  FeedPublicCache,
  readFeedSourceWatermarks,
  readShrinkEvidence,
  requiredFeedSources,
} from "./public-read";
import {
  type FeedState,
  feedConfig,
  hashFeedToken,
  readFeedState,
  recordFeedOutput,
} from "./store";

export interface FeedHandlerDeps {
  readonly now?: () => number;
  readonly cache?: FeedPublicCache;
  readonly metric?: (name: string) => void;
}
function failure(request: Request, status: number, diagnostic?: FeedDiagnostic): Response {
  const code =
    status === 404 || status === 405
      ? "validation"
      : status === 429
        ? "rate_limited"
        : "temporarily_unavailable";
  const body =
    diagnostic === undefined
      ? buildApiErrorBody(code)
      : {
          ...buildApiErrorBody(code),
          calendar: {
            reason: diagnostic,
            message: FEED_DIAGNOSTICS[diagnostic],
            settings_path: "/subscription",
          },
        };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      ...(status === 405 ? { allow: "GET, HEAD" } : {}),
    },
  });
}
function baseline(state: FeedState) {
  return {
    count: state.last_served_node_count,
    view_revision: state.last_served_view_revision,
    generation: state.last_served_generation,
    served_at: state.last_served_at,
  };
}
export function makeFeedHandler(
  deps: FeedHandlerDeps = {},
): (context: RouteContext) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? new FeedPublicCache();
  // 单令牌的组装互斥：不按共享出口 IP 限制不同订阅；无计时阈值或持久请求记录。
  const assembling = new Set<string>();
  const metric = deps.metric ?? ((name: string) => logEvent("error", name, { count: 1 }));
  return async (context) => {
    const { request, env } = context;
    if (request.method !== "GET" && request.method !== "HEAD") return failure(request, 405);
    const hash = await hashFeedToken(context.params.token ?? "");
    if (hash === null) return failure(request, 404);
    let locked = false;
    try {
      const initial = await readFeedState(env.DB, hash);
      if (initial === null) return failure(request, 404);
      if (assembling.has(hash)) return failure(request, 429);
      assembling.add(hash);
      locked = true;
      // 有界重新读取：一次初始尝试、一次状态变化后的重新尝试；不用不相关模块的重试参数。
      const attempt = async (state: FeedState): Promise<Response | null> => {
        const at = now();
        const config = feedConfig(state);
        const snapshot = await cache.read(env.DB, at);
        if (snapshot === null) return failure(request, 503, "snapshot_unavailable");
        const sourceIds = requiredFeedSources(config);
        const diagnose = async (reason: FeedDiagnostic): Promise<Response | null> => {
          if (
            !(await recordFeedOutput(
              env.DB,
              hash,
              state,
              snapshot.generation,
              0,
              at,
              reason === "shrink_guard",
              reason,
            ))
          )
            return null;
          metric(`feed_${reason}`);
          return failure(request, 503, reason);
        };
        if (!feedSourcesFresh(await readFeedSourceWatermarks(env.DB, sourceIds), at))
          return diagnose("source_stale");
        const nodes = personalCalendarNodes(config, snapshot.nodes, at);
        const limit = feedNodeLimit(nodes);
        if (limit !== null) return diagnose(limit);
        let body: string;
        try {
          body = serializeCalendar(
            nodes.map((item) => {
              const changedAt = (item.node as typeof item.node & { public_changed_at?: number })
                .public_changed_at;
              if (!Number.isSafeInteger(changedAt)) throw new Error("missing_public_change_time");
              return {
                ...feedIdentity(
                  state.namespace,
                  item.node.projection.milestone_id,
                  item.node.public_ical_revision,
                  state.view_revision,
                ),
                modifiedAt: Math.max(changedAt as number, state.changed_at),
                time: item.time,
                summary: `${item.node.projection.event.title} · ${item.node.projection.milestone.title}`,
                description: [item.node.projection.event.summary, item.node.patch?.fact_reason]
                  .filter(Boolean)
                  .join("\n"),
                url: item.node.projection.event.official_url,
                cancelled: item.cancelled,
                alarmSeconds: item.alarm_seconds,
              };
            }),
          );
        } catch (error) {
          if (error instanceof Error && error.message === "feed_sequence_migration_required")
            return diagnose("sequence_migration");
          return diagnose("snapshot_unavailable");
        }
        const bytes = new TextEncoder().encode(body);
        if (bytes.length > FEED_RESPONSE_MAX_BYTES) return diagnose("response_byte_limit");
        const etag = `"${toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}"`;
        const old = baseline(state);
        if (feedNeedsShrinkEvidence(old, nodes.length, state.view_revision)) {
          const previous =
            old.generation === snapshot.generation
              ? snapshot.nodes
              : old.generation === null
                ? null
                : await readShrinkEvidence(env.DB, old.generation);
          if (
            feedShrinkBlocked({
              baseline: old,
              view_revision: state.view_revision,
              config,
              current: snapshot.nodes,
              previous,
              now: at,
            })
          )
            return diagnose("shrink_guard");
        }
        // 最终 CAS 同时核验授权、配置、公共代次、来源水位与上次成功基线；任何变化重新组装。
        if (
          !(await recordFeedOutput(
            env.DB,
            hash,
            state,
            snapshot.generation,
            nodes.length,
            now(),
            false,
            null,
            sourceIds,
          ))
        )
          return null;
        const headers = new Headers({
          "content-type": "text/calendar; charset=utf-8",
          "cache-control": "private, no-store",
          etag,
        });
        const matches = (request.headers.get("if-none-match") ?? "")
          .split(",")
          .map((value) => value.trim().replace(/^W\//, ""));
        if (matches.includes(etag) || matches.includes("*"))
          return new Response(null, { status: 304, headers });
        return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
      };
      const first = await attempt(initial);
      if (first !== null) return first;
      const refreshed = await readFeedState(env.DB, hash);
      if (refreshed === null) return failure(request, 404);
      return (await attempt(refreshed)) ?? failure(request, 503, "changed_during_read");
    } catch {
      metric("feed_read_unavailable");
      return failure(request, 503, "snapshot_unavailable");
    } finally {
      if (locked) assembling.delete(hash);
    }
  };
}
