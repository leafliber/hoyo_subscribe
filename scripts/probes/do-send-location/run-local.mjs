// P0-01 探针：do-send-location（本地模式）
// 流程：启动 wrangler dev（本地 miniflare，真实 workerd + 本地 DO）→
//   1) /probe/observation 记录前台 Worker 与 DO 各自看到的 colo/ray；
//   2) /probe/alarm 设一个 2s 的 alarm，等待其触发（期间不发任何 DO 请求）；
//   3) /probe/serialization 跑「读-等-写」与「紧凑读写」两种并发模式；
//   4) /probe/report 汇总 → 套证据信封写入 docs/evidence/p0/ → 停掉 wrangler。
// 重要：本地 miniflare 观测 = run_environment.type=wrangler-dev-local（E2 类），
//       真实 colo 与边缘 alarm 行为需目标环境（remote）复跑。
// 运行：node scripts/probes/do-send-location/run-local.mjs [--label 自定义环境标注]

import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { buildEnvelope, writeEvidenceFile } from "../lib/evidence.mjs";
import { fetchJson, startWranglerDev } from "../lib/spawn-wrangler.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8792;

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
    process.stdout.write("1/4 采集 colo/ray 观测 ...\n");
    const observation = await fetchJson(`${baseUrl}/probe/observation`);

    process.stdout.write("2/4 设置 alarm（2s）并等待触发 ...\n");
    const alarmSet = await fetchJson(`${baseUrl}/probe/alarm?delay_ms=2000`);
    await sleep(4500); // 等待 alarm 触发；期间不对 DO 发任何请求

    process.stdout.write("3/4 并发序列化测试（slow / compact）...\n");
    const serialization = await fetchJson(`${baseUrl}/probe/serialization?n=8&delay_ms=150`);

    process.stdout.write("4/4 汇总报告 ...\n");
    const report = await fetchJson(`${baseUrl}/probe/report`);

    const envelope = buildEnvelope({
      probe: "do-send-location",
      runEnvironment: {
        type: "wrangler-dev-local",
        label: label ?? "miniflare-local-do",
        wrangler_command: "npx --yes wrangler@4 dev（本地 miniflare，未登录账户）",
        evidence_grading:
          "本地 miniflare 的 DO 观测（E2 类）；真实 colo 与边缘 alarm 行为需目标环境（remote）复跑",
      },
      results: {
        observation,
        alarm_set: alarmSet,
        alarm_waited_ms: 4500,
        serialization,
        report,
      },
      notes: [
        "alarm_log 非空 = alarm 在无外部请求时自行触发；skew_ms 为触发时刻与计划时刻的偏差。",
        "serialization.slow_interleaved.lost_updates > 0 说明『读-等-写』窗口内输入门禁放行并发；compact.lost_updates = 0 说明存储操作期间串行化。",
        "cf.colo 字段以实际观测为准（本地 dev 可能为占位值）；目标环境结论以 remote 复跑为准。",
        `wrangler dev 日志尾部（排查用）：${logs.slice(-3).join(" | ")}`,
      ],
    });

    const file = await writeEvidenceFile(envelope);
    const alarmLog = report?.durable_object?.alarm_log ?? [];
    process.stdout.write(
      `完成。alarm_log 条数 = ${alarmLog.length}（${alarmLog.length > 0 ? "已自行触发" : "未见触发，检查 dev server 是否保持运行"}）\n` +
        `slow 丢失更新 = ${serialization?.slow_interleaved?.lost_updates}，compact 丢失更新 = ${serialization?.compact?.lost_updates}\n`,
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
