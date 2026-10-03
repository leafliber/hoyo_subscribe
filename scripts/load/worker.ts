// TEST ONLY entry. The production wrangler config never references this file.
import worker from "../../apps/worker/src/index";

export { DeliveryDO, PipelineDO } from "../../apps/worker/src/index";

import { observeDatabase } from "../../apps/worker/src/accounts/reclaim/test-observer";
import { splitSqlStatements } from "../../apps/worker/src/storage/split-sql";
import { fixture } from "./fixture";

const observed = new WeakMap<Env, ReturnType<typeof observeDatabase> & { env: Env }>();
export default {
  async fetch(request: Request, env: Env & { LOAD_LOCAL_ONLY?: string }, ctx: ExecutionContext) {
    if (!env.LOAD_LOCAL_ONLY || request.headers.get("x-load-local") !== env.LOAD_LOCAL_ONLY)
      return new Response(null, { status: 403 });
    let state = observed.get(env);
    if (!state) {
      const meter = observeDatabase(env.DB);
      state = { ...meter, env: { ...env, DB: meter.db } };
      observed.set(env, state);
    }
    const url = new URL(request.url);
    if (url.pathname === "/api/__load") {
      try {
        const input = (await request.json()) as { action: string; sql?: string; offset?: number };
        if (input.action === "migrate") {
          await env.DB.batch(splitSqlStatements(input.sql ?? "").map((s) => env.DB.prepare(s)));
          return Response.json({ migrated: true });
        }
        if (input.action === "cold") {
          state.env = { ...state.env };
          return Response.json({ cold: true });
        }
        if (input.action === "metrics") return Response.json(state.stats);
        if (input.action === "reset") {
          Object.assign(state.stats, { queries: 0, rows_read: 0, rows_written: 0 });
          return Response.json({ reset: true });
        }
        return Response.json(await fixture(state.db, input.action, input.offset));
      } catch {
        return Response.json({ error: "local_fixture_failed" }, { status: 500 });
      }
    }
    return worker.fetch(request, state.env, ctx);
  },
};
