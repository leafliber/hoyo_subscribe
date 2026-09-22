// P0-01 探针：d1-conditional-tx（本地模式）
// 流程：启动 wrangler dev（本地 miniflare，真实 workerd + 本地 D1）→ 调 /probe →
//       把实验结果套上证据信封写入 docs/evidence/p0/ → 停掉 wrangler。
// 重要：本地 miniflare 观测 = run_environment.type=wrangler-dev-local（E2 类），
//       不能替代目标环境（remote/生产 D1）的 G-P0 证据。
// 运行：node scripts/probes/d1-conditional-tx/run-local.mjs [--label 自定义环境标注]

import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildEnvelope, writeEvidenceFile } from "../lib/evidence.mjs";
import { fetchJson, startWranglerDev } from "../lib/spawn-wrangler.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8791;

function parseArgs(argv) {
  const labelIndex = argv.indexOf("--label");
  const label = labelIndex >= 0 ? argv[labelIndex + 1] : undefined;
  return { label };
}

async function main() {
  const { label } = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `启动 wrangler dev（本地 miniflare，端口 ${PORT}；首次运行 npx 需下载依赖）...\n`,
  );
  const { baseUrl, stop, logs } = await startWranglerDev({ cwd: HERE, port: PORT });

  try {
    process.stdout.write("执行 /probe 实验 ...\n");
    const payload = await fetchJson(`${baseUrl}/probe`, 120_000);
    if (payload.probe !== "d1-conditional-tx") {
      throw new Error(`探针返回的 probe 字段不符：${String(payload.probe)}`);
    }

    const envelope = buildEnvelope({
      probe: "d1-conditional-tx",
      runEnvironment: {
        type: "wrangler-dev-local",
        label: label ?? "miniflare-local-d1",
        runtime_user_agent: payload.environment_self_report?.runtime_user_agent ?? null,
        wrangler_command: "npx --yes wrangler@4 dev（本地 miniflare，未登录账户）",
        evidence_grading:
          "本地 miniflare 的 D1 观测（E2 类）；G-P0 放行需同一实验在目标环境（remote/生产 D1）复跑",
      },
      results: payload.experiment,
      notes: [
        ...(payload.notes ?? []),
        "探针只写自己的临时表 p0_probe_cas / p0_probe_log 并在结束时 DROP（见 results.cleanup_ok）。",
        `wrangler dev 日志尾部（排查用）：${logs.slice(-3).join(" | ")}`,
      ],
    });

    const file = await writeEvidenceFile(envelope);
    const summary = payload.experiment?.summary ?? {};
    process.stdout.write(
      `实验完成。关键结论（本地观测）：\n` +
        `  batch_rolls_back_on_sql_error = ${summary.batch_rolls_back_on_sql_error}\n` +
        `  cas_zero_rows_batch_threw = ${summary.cas_zero_rows_batch_threw}\n` +
        `  dependent_write_persisted_despite_cas_zero_rows = ${summary.dependent_write_persisted_despite_cas_zero_rows}\n` +
        `  batch_rolls_back_on_cas_zero_rows = ${summary.batch_rolls_back_on_cas_zero_rows}\n` +
        `  changes_guard_blocked_dependent_write_on_miss = ${summary.changes_guard_blocked_dependent_write_on_miss}\n`,
    );
    process.stdout.write(`证据已写入：${file}\n`);
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
