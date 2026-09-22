"""F1-02 反向验证：真实注入纯日期补午夜，确认测试失败，再无条件恢复实现。"""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
source = root / "packages/contracts/src/schedule-browse.ts"
original = source.read_text()
needle = 'if (node.time.precision === "date") day.dateOnly.push(node);'
mutation = '''if (node.time.precision === "date") {
      // F1_02_DATE_MUTATION: 故意破坏合同，给纯日期补午夜并参加精确排序。
      day.timed.push({ ...node, time: { ...node.time, precision: "datetime",
        utc_ms: Date.parse(node.time.date + "T00:00:00+08:00") } });
    }'''
if original.count(needle) != 1:
    raise SystemExit("变异目标不是恰好一处，停止，不运行虚假反向验证")
command = ["pnpm", "--filter", "@hoyo/contracts", "exec", "vitest", "run", "src/schedule-browse.test.ts"]
try:
    source.write_text(original.replace(needle, mutation))
    print("落地验证：grep -c F1_02_DATE_MUTATION packages/contracts/src/schedule-browse.ts", flush=True)
    count = subprocess.run(["grep", "-c", "F1_02_DATE_MUTATION", str(source)], capture_output=True, text=True, check=True)
    print(count.stdout, end="", flush=True)
    if int(count.stdout.strip()) == 0:
        raise RuntimeError("变异未落地，禁止继续")
    failed = subprocess.run(command, cwd=root)
    print(f"变异测试 exit={failed.returncode}（必须非零）", flush=True)
    if failed.returncode == 0:
        raise RuntimeError("测试未能拦截纯日期补午夜")
finally:
    source.write_text(original)
print("已恢复原实现，复跑同一测试", flush=True)
subprocess.run(command, cwd=root, check=True)
