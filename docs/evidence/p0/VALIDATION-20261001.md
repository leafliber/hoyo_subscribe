# P0-06 · 本地验证记录（2026-10-01）

基线：`d0fcfe0a0b5ed17451ce4186c421c35a5d496737`；分支：`p0/P0-06-conclusions`。
环境：macOS arm64，Node `v26.8.1`，pnpm `11.11.0`，独立工作树。
本文件只记录本次本地 E1 检查，外部证据的取得方式、原始时间与缺口见 [CONCLUSIONS.md](CONCLUSIONS.md)。
本次无真实邮件、模型调用、部署或收费资源操作。

## 命令与实际结果

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 退出 0；锁文件未变；新增本地依赖 259 个；`Done in 4.7s using pnpm v11.11.0` |
| `pnpm lint` | 退出 0；`Checked 386 files in 155ms. No fixes applied.` |
| `pnpm typecheck` | 退出 0；contracts / web / worker 及 e2e TypeScript 检查完成 |
| `pnpm params:verify` | 退出 0；数值等式 27 条成立、0 条不成立；语义条款另由实现保证 |
| `pnpm migrate:check` | 退出 0；22 个迁移（0001–0022），无禁止对象；1 个测试文件、11 条通过；空库重放 / 索引 / rows_read 检查通过 |
| `CI=1 WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/P0-06-test-wrangler.log pnpm test > /tmp/P0-06-test.log 2>&1` | 退出 0；contracts 27 文件 / 220 条通过；worker 55 文件 / 762 条通过 |
| `pnpm test:e2e > /tmp/P0-06-e2e.log 2>&1` | 退出 0；`143 passed (13.1s)`、`5 skipped`，跳过清单见下方 |
| `python3 /tmp/P0-06-verify.py`（脚本完整内容见下方） | 退出 0；27 个结论行的非空、状态、日期、路径、模型决策与完整邮箱扫描通过；范围检查通过 |
| `git diff --check` | 退出 0；无输出 |

构建命令与最终状态见本文末尾；本地受控中断不计为通过。

## 按既有项目分工跳过的 e2e

以下 5 项在本次对应项目上**跳过，未计为通过**，均位于 `tests/e2e/a11y.spec.ts`：

| 项目 | 用例 | 既有跳过原因 |
| --- | --- | --- |
| desktop-chromium | U28 触控目标：主要按钮、导航、展开入口与输入的有效点击区 ≥ 44px | 移动端视口专测 |
| desktop-chromium | U28 页面缩放（窄视口代理）：关键操作不丢失、无横向溢出 | 移动端视口专测 |
| mobile-chromium | U28 对比度：token 全部前景/背景组合与半透明合成色逐一达到阈值 | 纯计算用例，单项目执行即可 |
| mobile-chromium | U28 颜色单一来源：tokens.css 之外不允许出现颜色字面量 | 纯计算用例，单项目执行即可 |
| mobile-chromium | U28 color.ts 工具函数：contrastRatio / compositeOver 对照已知值 | 纯计算用例，单项目执行即可 |

## A-P0-GATE 文档核验

本卡没有新增业务代码或持久测试。人工逐项核对门禁与现存文件，辅以下列一次性检查；自动检查仅确认文档结构与引用存在，不声称重新取得外部事实。
可把以下内容保存至 `/tmp/P0-06-verify.py`，在仓库根运行 `python3 /tmp/P0-06-verify.py`：

```python
from pathlib import Path
import re
import subprocess
p = Path('docs/evidence/p0/CONCLUSIONS.md')
s = p.read_text()
rows = [[c.strip() for c in line.strip('|').split('|')]
        for line in s.splitlines() if line.startswith('|')]
data = [r for r in rows if r[0] not in ('项目', '---')]
assert '待补' not in s
assert all(all(r) for r in rows)
assert all(r[1] in ('通过', '失败', '未取得') and '2026-' in r[2]
           and '](' in r[2] for r in data)
for target in re.findall(r'\]\(([^)]+)\)', s):
    if not target.startswith('https://'):
        assert (p.parent / target.split('#')[0]).exists(), target
assert '降级：首版只用规则模板与人工审核（所有者 2026-09-30 决定）' in s
assert not re.search(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', s)
assert '2026-09-21T17:41:54.846Z' in s
changed = subprocess.check_output(['git', 'diff', '--name-only', 'origin/main'], text=True).splitlines()
untracked = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'], text=True).splitlines()
assert all(f.startswith('docs/evidence/p0/') for f in changed + untracked)
print(f'A-P0-GATE: {len(data)} data rows checked; nonempty cells, statuses, evidence dates, paths, model decision and email scan passed')
print('Scope check passed: only docs/evidence/p0/** changed; no code, migrations, parameters or maintained gate documents changed')
```

实际输出：

```text
A-P0-GATE: 27 data rows checked; nonempty cells, statuses, evidence dates, paths, model decision and email scan passed
Scope check passed: only docs/evidence/p0/** changed; no code, migrations, parameters or maintained gate documents changed
```

另人工核对新增文档没有密钥、Cookie、OTP、恢复码、真实 Feed / 退订 URL、Push endpoint；正文不复制既有记录中的真实邮箱及 messageId。
代码、迁移、参数注册表和验收方文档没有变更，因此没有引入禁止设计或第二份运行参数。

## 准备与诊断中的失败 / 限制

- 沙箱内首次 `gh pr view 46 --json state,mergedAt,mergeCommit,url,title` 无法连接 GitHub；获网络执行权限后同命令退出 0，确认 PR 为 MERGED。
- 读取猜测文件 `docs/evidence/p0/sources-collection-report.md` 返回不存在；改用实际文件 `source-params.md` 和 source-samples JSON 核对。
- 沙箱内 `ps -eo pid,etime,command` 被拒绝；获执行权限后只读查看本次构建进程。以上不是测试通过记录。
- 第一次临时文档检查的行数摘要使用了错误的表头计数；逐行断言已执行，随后修正摘要算法并重跑，最终为 27 个数据行。
- 本卡未执行任何新的 P0 E3 实测；缺失项按 CONCLUSIONS.md 的“未取得”与所有者前置处理。

## build 的实际结果

实际命令：

```bash
CI=1 WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/P0-06-build-wrangler.log pnpm build > /tmp/P0-06-build.log 2>&1
```

2026-10-01 约 04:08:30Z 开始。Worker 输出 `Total Upload: 1349.05 KiB / gzip: 255.91 KiB` 和 `--dry-run: exiting now.`；Web 输出 `22 page(s) built in 1.53s`、`Complete!`。
等待满五分钟仍未自然退出（04:13:23Z 附近 `ps` 记录 Wrangler 外层存活 05:00）。按 ENGINEERING §3，对已核实属于本次工作树的三个构建进程执行 `kill -TERM 7809 7841 7844`。
终止后父命令报告退出 0，日志追加 `apps/worker build: Done`；**因为经过手动终止，本地 build 仍记“未确认通过”，不把退出 0 当作正常构建成功**。最终以本 PR CI 的 build 步骤为准，结果写入 PR 描述。
