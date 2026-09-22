#!/usr/bin/env node
// migrate:check（任务卡 P1-04，验收 ID A-P1-DB）。
// 做两件事：
//  1. 静态检查迁移链：NNNN_ 命名、编号从 1 起连续只增（只进不退的机器检查）、
//     不含 AGENTS.md 禁止清单对象（feed_retirements / calendar_change_no / removal_change_no）。
//  2. 空库顺序重放全部迁移 → 校验 schema 与索引 → 输出真实 rows_read 基准：
//     委托 @hoyo/worker 的 A-P1-DB 用例，在真实 workerd + miniflare D1 上执行（与部署引擎一致）。
// 任一步失败即非零退出。
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = join(repoRoot, "migrations");

function fail(message) {
  console.error(`migrate:check: ${message}`);
  process.exit(1);
}

// 1) 迁移链静态检查
const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();
if (files.length === 0) {
  fail("migrations/ 目录为空");
}
const forbidden = [/feed_retirements/i, /calendar_change_no/i, /removal_change_no/i];
let previous = 0;
for (const file of files) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
  if (!match) {
    fail(`迁移文件命名不符合 NNNN_<简述>.sql：${file}`);
  }
  const number = Number.parseInt(match[1], 10);
  if (number !== previous + 1) {
    fail(`迁移编号必须从 1 起连续只增（ENGINEERING.md §6）：${file}（上一个编号 ${previous}）`);
  }
  previous = number;
  // 只扫代码标识符，先剥注释：迁移注释会引用禁止对象名来说明"不建"，
  // 注释里出现不算命中；真实对象由 A-P1-DB 测试对 sqlite_master 逐项核查。
  const sql = readFileSync(join(migrationsDir, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  for (const pattern of forbidden) {
    if (pattern.test(sql)) {
      fail(`${file} 命中 AGENTS.md 禁止清单对象：${pattern.source}`);
    }
  }
}
console.log(
  `静态检查通过：${files.length} 个迁移（0001–${String(previous).padStart(4, "0")}），无禁止对象`,
);

// 2) 空库重放 + schema/索引校验 + rows_read 基准（真实 D1）
const vitest = spawnSync(
  "pnpm",
  ["--filter", "@hoyo/worker", "exec", "vitest", "run", "src/storage/schema.test.ts"],
  { cwd: repoRoot, stdio: "inherit" },
);
if (vitest.error) {
  fail(`无法启动 vitest：${vitest.error.message}`);
}
if (vitest.status !== 0) {
  fail("空库重放 / schema / 索引 / rows_read 校验失败（见上方 vitest 输出）");
}
console.log(
  "migrate:check 通过：空库顺序重放全部迁移，schema 与索引符合预期，rows_read 基准见上方输出",
);
