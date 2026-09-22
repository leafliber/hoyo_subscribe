// P0-01 探针：model-echo
// 目的：向模型 profile 提交一个【固定的合成样本】，记录返回里实际出现哪些 usage/计费字段名与数值。
//      只做字段发现，不做任何质量评估（任务卡 P0-01；质量与计费基线属 P0-03）。
// 样本来自 sample.synthetic.json，必须带 synthetic:true，否则拒绝运行。
//
// 运行（仅目标环境，需所有者登录）：npx wrangler@4 dev --remote --port 8793
//      然后访问 http://127.0.0.1:8793/probe?run=echo-once（或用 save-from-url.mjs 落盘证据）
// ⚠ 每次成功调用都产生真实模型用量/费用；取证一次即止，禁止公开部署。
// 本地 `wrangler dev`（非 remote）没有 Workers AI 代理，会得到明确错误——这是预期行为。

import sample from "../sample.synthetic.json";

interface AiBindingLike {
  run(model: string, params: Record<string, unknown>): Promise<unknown>;
}

interface Env {
  AI: AiBindingLike;
  MODEL_PROFILE_ID?: string;
}

// 主方案 §3.5：候选部署保留为测试对象，不是已批准结论
const DEFAULT_MODEL_PROFILE_ID = "@cf/qwen/qwen3-30b-a3b-fp8";

interface SampleFile {
  synthetic: boolean;
  sample_id: string;
  prompt: string;
  max_tokens_hint: number;
}

const fixedSample = sample as SampleFile;

function nowIso(): string {
  return new Date().toISOString();
}

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function trimError(e: unknown): { name: string; message: string } {
  const err = e as { name?: string; message?: string };
  return {
    name: String(err?.name ?? typeof e),
    message: String(err?.message ?? e).slice(0, 400),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, probe: "model-echo" });
    }
    if (url.pathname !== "/probe" || request.method !== "GET") {
      return json({ ok: false, error: "not_found" }, 404);
    }
    if (url.searchParams.get("run") !== "echo-once") {
      return json(
        {
          ok: false,
          error: "refuse_without_confirm",
          hint: "本探针每次调用都会产生真实模型用量/费用。确认按 OWNER_CHECKLIST §B-5 操作后，加 ?run=echo-once 且仅运行一次。",
        },
        400,
      );
    }
    if (fixedSample.synthetic !== true) {
      return json({ ok: false, error: "sample_not_marked_synthetic" }, 500);
    }
    if (!env.AI) {
      return json(
        {
          ok: false,
          error: "missing_binding",
          hint: "需要 AI 绑定；本地 dev 不支持 Workers AI，请用 wrangler dev --remote",
        },
        500,
      );
    }

    const model = env.MODEL_PROFILE_ID || DEFAULT_MODEL_PROFILE_ID;
    const requestParams = {
      messages: [{ role: "user", content: fixedSample.prompt }],
      max_tokens: fixedSample.max_tokens_hint,
    };

    const startedAt = Date.now();
    try {
      const result = (await env.AI.run(model, requestParams)) as Record<string, unknown> | null;
      const elapsedMs = Date.now() - startedAt;
      const resultObj = result ?? {};
      const usageRaw = "usage" in resultObj ? (resultObj.usage as unknown) : null;
      const responseText =
        typeof (resultObj as { response?: unknown }).response === "string"
          ? (resultObj as { response: string }).response
          : null;

      return json({
        probe: "model-echo",
        schema_version: 1,
        generated_at_utc: nowIso(),
        environment_self_report: {
          runtime_user_agent: navigator.userAgent,
          note: "run_environment 由 save-from-url.mjs 落盘时标注；remote 模式才代表目标环境",
        },
        model_profile_id: model,
        request_params: requestParams,
        sample: {
          synthetic: true,
          sample_id: fixedSample.sample_id,
          file: "scripts/probes/model-echo/sample.synthetic.json",
          sha256: await sha256Hex(JSON.stringify(fixedSample)),
        },
        result: {
          ok: true,
          elapsed_ms: elapsedMs,
          top_level_field_names: Object.keys(resultObj),
          usage_raw: usageRaw,
          usage_field_names:
            usageRaw && typeof usageRaw === "object" && !Array.isArray(usageRaw)
              ? Object.keys(usageRaw)
              : null,
          response_text_sha256: await sha256Hex(responseText ?? JSON.stringify(resultObj)),
          response_text_prefix_200: (responseText ?? JSON.stringify(resultObj)).slice(0, 200),
          note: "只记录 usage/计费相关字段与输出指纹；不做质量评估（P0-01 范围外）",
        },
      });
    } catch (e) {
      return json({
        probe: "model-echo",
        schema_version: 1,
        generated_at_utc: nowIso(),
        model_profile_id: model,
        request_params: requestParams,
        sample: { synthetic: true, sample_id: fixedSample.sample_id },
        result: {
          ok: false,
          elapsed_ms: Date.now() - startedAt,
          error: trimError(e),
          note: "常见原因：未登录（wrangler dev --remote 需要 OAuth）、账户无 Workers AI 权限、模型 ID 不可用。见 OWNER_CHECKLIST §B-5。",
        },
      });
    }
  },
};
