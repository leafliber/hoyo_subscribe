// 本地复核工具：逐条验证原用例通过、变异落盘、断言击杀、原文件恢复。
// 不与其他测试/编辑同时运行。输出仅为合成测试与源码 hash，不接触外部服务。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const output = resolve(process.argv[2] ?? "/tmp/p3-14-r2-mutations");
mkdirSync(output, { recursive: true });
const contract = "packages/contracts/src/public-api.ts";
const reader = "apps/worker/src/public/read.ts";
const workerTest = ["@hoyo/worker", "src/public/read.test.ts"];
const cases = [
  [
    "window-end",
    contract,
    "time.utc_ms < end",
    "time.utc_ms <= end",
    ...workerTest,
    "窗口终点恰好 end",
  ],
  [
    "exact-limit",
    reader,
    "changes.length > LIMITS.recentChanges",
    "changes.length >= LIMITS.recentChanges",
    ...workerTest,
    "近期变更恰好上限",
  ],
  [
    "evidence-time",
    contract,
    "JSON.stringify(m.time) === JSON.stringify(TimeValueSchema.parse(p.milestone.time))",
    "true",
    "@hoyo/contracts",
    "src/public-api.test.ts",
    "证据时间不匹配本代",
  ],
  [
    "detail-tombstone",
    reader,
    "n !== null && !n.tombstone",
    "n !== null",
    ...workerTest,
    "详情排除仍在保留期",
  ],
  [
    "candidate-mismatch",
    reader,
    "publishedAt: evidence === null ? null : row.official_published_at",
    "publishedAt: row.official_published_at",
    ...workerTest,
    "投影绑定成立但候选字段不匹配",
  ],
];
const hash = (text) => createHash("sha256").update(text).digest("hex");
for (const [name, file, before, after, pkg, test, title] of cases) {
  const path = resolve(root, file);
  const original = readFileSync(path, "utf8");
  assert.equal(original.split(before).length - 1, 1, `${name}: replacement must be unique`);
  const args = ["--filter", pkg, "exec", "vitest", "run", test, "-t", title, "--reporter=verbose"];
  const run = (phase) => {
    const result = spawnSync("pnpm", args, { cwd: root, encoding: "utf8", timeout: 120000 });
    const log = (result.stdout ?? "") + (result.stderr ?? "");
    writeFileSync(resolve(output, `${name}-${phase}.log`), log);
    return { result, log };
  };
  const baseline = run("baseline");
  assert.equal(baseline.result.status, 0, `${name}: baseline must pass`);
  assert.match(baseline.log, /1 passed/);
  try {
    const mutant = original.replace(before, after);
    writeFileSync(path, mutant);
    assert.equal(readFileSync(path, "utf8"), mutant);
    assert.notEqual(hash(mutant), hash(original));
    console.log(
      JSON.stringify({
        name,
        phase: "landed",
        file,
        before,
        after,
        originalSha256: hash(original),
        mutantSha256: hash(mutant),
        command: ["pnpm", ...args],
      }),
    );
    const killed = run("mutant");
    assert.equal(killed.result.status, 1, `${name}: mutant must fail`);
    assert.match(killed.log, /AssertionError/);
    assert.match(killed.log, /1 failed/);
    console.log(JSON.stringify({ name, phase: "killed", exitCode: killed.result.status }));
  } finally {
    writeFileSync(path, original);
    assert.equal(hash(readFileSync(path, "utf8")), hash(original));
    console.log(JSON.stringify({ name, phase: "restored", sha256: hash(original) }));
  }
}
