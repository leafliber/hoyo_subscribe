#!/usr/bin/env python3
"""F1-03 反向验证：两次真实改坏实现、确认定向 e2e 失败、逐次还原复跑。"""

from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / "apps/web/src/features/schedule/detail.ts"
CONFIG = "tests/e2e/playwright.config.ts"


def run(*command: str, should_pass: bool, failing_test: str = "") -> None:
    print(f"$ {' '.join(command)}", flush=True)
    result = subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    print(result.stdout + result.stderr, flush=True)
    print(f"exit {result.returncode}", flush=True)
    if should_pass and result.returncode != 0:
        raise RuntimeError("预期通过的命令失败")
    if not should_pass and result.returncode == 0:
        raise RuntimeError("变异后测试未失败")
    if failing_test and failing_test not in result.stdout:
        raise RuntimeError("失败并非预期的承重用例")


def mutate(label: str, old: str, new: str, test_name: str) -> None:
    original = SOURCE.read_text()
    if original.count(old) != 1:
        raise RuntimeError(f"{label} 变异锚点出现 {original.count(old)} 次，不是 1 次")
    try:
        SOURCE.write_text(original.replace(old, new, 1))
        count = SOURCE.read_text().count(new)
        print(f"{label}: grep -c 替换后特征 = {count}", flush=True)
        if count != 1:
            raise RuntimeError("变异没有落地")
        run("pnpm", "--filter", "@hoyo/web", "build", should_pass=True)
        run(
            "pnpm",
            "exec",
            "playwright",
            "test",
            "--config",
            CONFIG,
            "tests/e2e/event-detail.spec.ts",
            "--grep",
            test_name,
            should_pass=False,
            failing_test=test_name,
        )
    finally:
        SOURCE.write_text(original)
        print(f"{label}: 源码已还原，特征计数 {SOURCE.read_text().count(new)}", flush=True)
    run("pnpm", "--filter", "@hoyo/web", "build", should_pass=True)
    run(
        "pnpm",
        "exec",
        "playwright",
        "test",
        "--config",
        CONFIG,
        "tests/e2e/event-detail.spec.ts",
        "--grep",
        test_name,
        should_pass=True,
    )


def main() -> None:
    listener = subprocess.run(
        ["lsof", "-nP", "-iTCP:4173", "-sTCP:LISTEN"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if listener.stdout.strip():
        raise RuntimeError(f"4173 被占用，不触碰监听进程：\n{listener.stdout}")
    mutate(
        "证据转义",
        "证据片段：${escapeHtml(node.evidence)}",
        "证据片段：${node.evidence}",
        "公告与证据的 img onerror 只显示文字，不执行",
    )
    mutate(
        "虚构缺失节点",
        "const timelineNodes = event.milestones;",
        'const timelineNodes = event.id === "reward" ? [...event.milestones, { ...important, id: "invented-end", nodeType: "end" as const }] : event.milestones;',
        "只有奖励截止时不补玩法结束",
    )
    print("两项变异均被定向用例检出，且还原后复跑通过。", flush=True)


if __name__ == "__main__":
    main()
