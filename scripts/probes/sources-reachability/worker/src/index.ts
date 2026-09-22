// P0-01 探针：sources-reachability（Worker 版，用于目标 Cloudflare 环境）
// 用途：在 Cloudflare 边缘（wrangler dev --remote 或临时部署）运行同一份受限探测逻辑，
//       GET /probe 返回结构化 JSON；由所有者按 OWNER_CHECKLIST 用 save-from-url.mjs 落盘证据。
// 约束与本地版一致（lib/guard-core.mjs）：只读 GET、域名白名单、不跟随重定向、超时、
// 大小上限、诚实 UA、无凭据、不重试；出现受限信号记录并放弃该来源。
// ⚠ 本探针仅供临时运行取证，禁止公开部署。

// @ts-expect-error — esbuild 原生支持打包 .mjs；此处无需类型信息
import { probeSources } from "../../probe-core.mjs";
import leadSources from "../../sources.lead.json";

interface LeadSource {
  id: string;
  label: string;
  url: string;
  host: string;
  contract_ref: string;
  verification_state: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, probe: "sources-reachability" });
    }
    if (url.pathname !== "/probe" || request.method !== "GET") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    const startedAt = Date.now();
    const results = await probeSources((leadSources as { sources: LeadSource[] }).sources);
    return json({
      probe: "sources-reachability",
      schema_version: 1,
      generated_at_utc: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
      environment_self_report: {
        runtime_user_agent: navigator.userAgent,
        note: "run_environment 由 save-from-url.mjs 落盘时标注；remote 模式才代表目标环境",
      },
      results,
      notes: [
        "在 Cloudflare 边缘执行的受限只读探测；探测目标为 §3.1 线索 URL（lead-unverified）。",
        "出现受限信号即放弃该来源并记录，不实施绕过（主方案 §3.1）。",
      ],
    });
  },
};
