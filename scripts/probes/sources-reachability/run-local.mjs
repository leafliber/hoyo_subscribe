// P0-01 探针：sources-reachability（本地模式）
// 用途：从【本机网络】逐个探测四个官方来源线索 URL 的可达性、状态码、响应大小、
//       是否出现鉴权/验证码/访问限制信号，并写入 docs/evidence/p0/。
// 重要：本文件产出的是 run_environment.type=local-node 的证据，属于本机观测，
//       不能替代"目标 Cloudflare 环境"的 G-P0 证据（后者按 OWNER_CHECKLIST 用 worker/ 目录跑）。
// 运行：node scripts/probes/sources-reachability/run-local.mjs [--label 自定义环境标注]

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildEnvelope, writeEvidenceFile } from "../lib/evidence.mjs";
import { probeSources } from "./probe-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const labelIndex = argv.indexOf("--label");
  const label = labelIndex >= 0 ? argv[labelIndex + 1] : undefined;
  return { label };
}

async function main() {
  const { label } = parseArgs(process.argv.slice(2));
  const leadFile = JSON.parse(await readFile(path.join(HERE, "sources.lead.json"), "utf8"));

  const results = await probeSources(leadFile.sources);
  for (const entry of results.sources) {
    const status = entry.http ? `HTTP ${entry.http.status}` : (entry.error?.code ?? "");
    process.stdout.write(`${entry.id} · ${entry.outcome}${status ? ` · ${status}` : ""}\n`);
  }

  const envelope = buildEnvelope({
    probe: "sources-reachability",
    runEnvironment: {
      type: "local-node",
      label: label ?? "local",
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      user_agent_sent: "见 lib/guard-core.mjs PROBE_USER_AGENT（诚实探针 UA，无浏览器伪装）",
      evidence_grading:
        "本机网络观测（E2 类），不是目标 Cloudflare 环境证据；G-P0 放行需 worker 模式在目标环境的运行结果",
    },
    results,
    notes: [
      "每来源仅一次 GET，不重试；出现受限信号即放弃该来源并记录（主方案 §3.1）。",
      "URL 为 §3.1 线索（verification_state=lead-unverified），正式来源注册在 P0-02。",
      "证据不含完整响应正文，仅大小、hash、顶层信封与结构键名。",
    ],
  });

  const file = await writeEvidenceFile(envelope);
  process.stdout.write(`证据已写入：${file}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
