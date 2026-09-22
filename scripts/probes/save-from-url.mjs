// P0-01 辅助：从 Worker 探针端点拉取 JSON 输出，套上 run_environment 信封，
// 写入 docs/evidence/p0/<probe>-<时间戳>.json。目标环境（remote）取证由所有者按
// docs/evidence/p0/OWNER_CHECKLIST.md 使用本脚本落盘。
//
// 用法：
//   node scripts/probes/save-from-url.mjs <probe-name> <url> --type remote-worker --label "owner-remote"
//   例：node scripts/probes/save-from-url.mjs d1-conditional-tx "http://127.0.0.1:8791/probe" --type remote-worker
//   （model-echo 记得在 URL 里带 ?run=echo-once）
//
// --type 取值：remote-worker（目标环境，G-P0 可用）/ wrangler-dev-local / owner-manual

import { buildEnvelope, writeEvidenceFile } from "./lib/evidence.mjs";
import { fetchJson } from "./lib/spawn-wrangler.mjs";

function parseArgs(argv) {
  const [probeName, url] = argv;
  const typeIndex = argv.indexOf("--type");
  const labelIndex = argv.indexOf("--label");
  return {
    probeName,
    url,
    type: typeIndex >= 0 ? argv[typeIndex + 1] : "remote-worker",
    label: labelIndex >= 0 ? argv[labelIndex + 1] : undefined,
  };
}

const GRADING_NOTE = {
  "remote-worker": "在 Cloudflare 边缘/目标账户运行（E3 类），可作为 G-P0 证据",
  "wrangler-dev-local": "本地 miniflare 观测（E2 类），不能替代目标环境证据",
  "owner-manual": "所有者手工执行并落盘（按操作方式评定等级）",
};

async function main() {
  const { probeName, url, type, label } = parseArgs(process.argv.slice(2));
  if (!probeName || !url) {
    console.error(
      "用法：node scripts/probes/save-from-url.mjs <probe-name> <url> [--type remote-worker] [--label ...]",
    );
    process.exitCode = 1;
    return;
  }

  const payload = await fetchJson(url, 120_000);
  if (payload.probe !== probeName) {
    throw new Error(`探针返回的 probe 字段（${String(payload.probe)}）与参数（${probeName}）不符`);
  }

  const envelope = buildEnvelope({
    probe: probeName,
    runEnvironment: {
      type,
      label: label ?? type,
      fetched_from: url,
      evidence_grading: GRADING_NOTE[type] ?? "未登记的类型，人工评定等级",
      payload_generated_at_utc: payload.generated_at_utc ?? null,
      payload_environment_self_report: payload.environment_self_report ?? null,
    },
    results: payload.results ?? payload.experiment ?? { raw: payload },
    notes: payload.notes ?? [],
  });

  const file = await writeEvidenceFile(envelope);
  process.stdout.write(`证据已写入：${file}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
