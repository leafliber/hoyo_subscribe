// params:verify CLI（任务卡 P1-03）：执行附录 A.5 / CONTRACTS_BASELINE.md §11 的全部启动等式。
//
// 用法：pnpm params:verify（package.json → tsx scripts/params/verify.ts）
// 行为：全部成立打印逐条结果并退出 0；任一不成立打印**每一条**失败等式（ID + 合同 + 实际值公式）
// 并以非零退出码结束。Worker 启动路径共用同一个 verifyParams()。

import { checkParamEquations, SEMANTIC_INVARIANTS } from "../../packages/contracts/src/index.ts";

const results = checkParamEquations();
const failed = results.filter((r) => !r.ok);

for (const r of results) {
  const mark = r.ok ? "✓" : "✗";
  console.log(`${mark} [${r.id}]（${r.group}）${r.contract}`);
  console.log(`    ${r.formula}`);
}

console.log(
  `\n数值等式 ${results.length} 条：${results.length - failed.length} 条成立，${failed.length} 条不成立。`,
);
for (const s of SEMANTIC_INVARIANTS) {
  console.log(
    `· 语义条款（由实现保证，不在数值校验内）：[${s.id}] ${s.contract} → ${s.enforcedBy}`,
  );
}

if (failed.length > 0) {
  console.error(
    `\n参数等式校验失败：以下 ${failed.length} 条不成立，任一不成立即拒绝启动（附录 A.5 / §11）：`,
  );
  for (const f of failed) {
    console.error(`  ✗ [${f.id}] ${f.contract}`);
    console.error(`    ${f.formula}`);
  }
  process.exitCode = 1;
} else {
  console.log("\n参数等式校验通过（附录 A.5 / CONTRACTS_BASELINE.md §11 全部成立）。");
}
