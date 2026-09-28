## 任务卡

F1-04 · 数据状态、空结果与错误反馈映射 · 阶段 F1

## 改动范围

- `apps/web/src/lib/errors/feedback.ts`：消费 contracts 错误联合，映射七类错误、全部 `UnauthorizedReason` 与网络超时。
- `apps/web/src/components/feedback/{ServiceFaultBanner.astro,service-fault.ts,CopyFallback.ts}`：全站故障横幅和复制失败的手动选择控件。
- `apps/web/src/pages/_Layout.astro`：仅挂载横幅；这是任务卡批准的跨卡改动。
- `tests/e2e/schedule.spec.ts`：仅追加 U05 用例，不修改原断言；这是任务卡批准的跨卡改动。
- `tests/e2e/account.spec.ts`：新增 U27 映射和 synthetic 操作入口夹具测试；账号页尚不存在，符合任务卡明确许可。
- `tests/e2e/evidence/f1-04/**`：本报告、真实日志与桌面/手机横幅截图；符合任务卡证据路径。

未改 F1-03 的详情目录/spec、F2-01 的订阅目录/spec 或任何验收方维护文档。e2e 自动重生成的 F1-02 截图已还原，未收入本卡。

## 继承的合同

- 主方案 §8.2：七类 API 错误与认证存在性敏感结果折叠。
- 前端 §4.5：筛选空结果、来源故障与加载失败分别表达；现有 F1-02 行为继续由 U05 验证。
- 前端 §11.3：每类错误的可执行下一步、超时结果不确定、复制失败手动选择、横幅保留恢复与终止入口。
- `packages/contracts/src/errors/codes.ts`：错误码、响应形状与 `UnauthorizedReason` 唯一来源。映射使用 `Record<ApiErrorCode, ...>` 和 `Record<UnauthorizedReason, ...>`，新增成员触发编译错误。

实现推断：已收到明确 API 错误的这次操作按失败反馈；网络超时、网络断开或无法识别的结果按“尚不确定”反馈。`quota_paused` 不承诺服务故障时停用一定完成；停用入口保持可访问，提交后的实际结果仍需确认。

## 交付物

- **完成**：七类错误与全部现有认证原因映射到标题、说明、下一步及动作类别；忽略服务端 `message`，避免借错误文案泄露邮箱存在性。
- **完成**：全站故障横幅挂到统一 Layout 的正常文档流中，提供服务状态和恢复入口；桌面与手机 synthetic 夹具验证五种恢复/终止按钮不被遮挡。
- **完成**：超时单独标为结果不确定；复制 API 失败时在原反馈容器显示可选中的只读文本；U05 区分来源故障、分页加载失败与真实空结果。

## 执行过的命令与结果

| 命令 | 实际结果 | 日志 |
| --- | --- | --- |
| `git fetch origin`、`git show origin/main:docs/tasks/F1-F2.md \| grep -c '穷尽检查'` | 成功；计数 `1`，门禁通过 | 本次命令输出 |
| `pnpm install --frozen-lockfile` | 初次在受限网络中 `ENOTFOUND`；重试成功，258 packages added | `logs/install.txt`、`logs/install-retry.txt` |
| `pnpm lint` | 初次 3 个导入/格式错误，修正后成功；最终 `Checked 265 files ... No fixes applied` | `logs/lint.txt`、`logs/lint-delivery.txt` |
| `pnpm typecheck` | 初次 e2e 测试解析包名失败，改为直接从合同源导入；最终成功 | `logs/typecheck.txt`、`logs/typecheck-post-test.txt` |
| `pnpm test` | 首次沙箱拒绝本地监听及 Wrangler 日志写入；隔离 worktree 外层权限重跑成功：contracts 18 files/175 tests，worker 37 files/376 tests | `logs/test.txt`、`logs/test-final.txt` |
| `pnpm params:verify` | 首次沙箱拒绝 tsx IPC；重跑成功：25/25 等式 | `logs/params.txt`、`logs/params-final.txt` |
| `pnpm migrate:check` | 首次沙箱拒绝本地 D1 监听；重跑成功：15 个迁移，schema 测试 6/6 | `logs/migrate.txt`、`logs/migrate-final.txt` |
| `pnpm build` | 成功：Worker dry-run；Web 8 个页面构建 | `logs/build-final.txt` |
| `lsof -nP -iTCP:4173 -sTCP:LISTEN` | e2e 前检查；最终运行前端口空闲。一次检查遇到其他短暂监听，等其结束再运行；未停止非本卡进程 | 本次命令输出 |
| `pnpm test:e2e` | 初次超时用例因文案包含“不能显示成功”而过严失败，修正文案后成功；最终 **59 passed、5 skipped**（现有 a11y 用例在移动项目跳过） | `logs/e2e.txt`、`logs/e2e-delivery.txt` |

反向验证均先确认变异落地，再运行并还原复跑：

| 变异 | 落地确认 | 预期失败 | 还原后 |
| --- | --- | --- | --- |
| 超时改写为“服务端未执行” | `replacements=1` | 超时用例断言 `not.toContain("未执行")` 失败 | 同用例 `1 passed` |
| 横幅 CSS 改为全屏 fixed 覆盖 | `replacements=1` | U27 遮挡用例报“恢复 被横幅遮挡” | 同用例 `1 passed` |
| 删除 `pending_activation` 映射 | `entries before=1`、`removed_bytes=158` | `pnpm typecheck` 报 `src/lib/errors/feedback.ts(36,14): error TS2741: Property 'pending_activation' is missing ... Record<UnauthorizedReason, FeedbackCore>` | `pnpm typecheck` 全绿 |

日志：`logs/mutation-timeout*.txt`、`logs/mutation-banner*.txt`、`logs/mutation-unauthorized*.txt`。所有变异已还原；最终全量 e2e、lint 和 typecheck 通过。

## 验收测试

| 验收 ID | 测试文件:用例名 | 实际结果 |
| --- | --- | --- |
| U05 | `tests/e2e/schedule.spec.ts: U05 来源故障与加载失败都不伪装成筛选无结果` | 桌面、手机均通过；原有四空态与加载失败用例也通过 |
| U27 | `tests/e2e/account.spec.ts: U27 七类错误码与全部 UnauthorizedReason 都给出可执行下一步` | 桌面、手机均通过；删除映射变异使 typecheck 失败 |
| U27 | `tests/e2e/account.spec.ts: U27 超时结果不确定，要求重新读取确认，不能显示成功或未执行` | 桌面、手机均通过；“未执行”变异被检出 |
| U27 | `tests/e2e/account.spec.ts: U27 全站横幅不遮挡恢复、停用、退订、登出、紧急停用入口` | 桌面、手机均通过；全屏覆盖变异被检出 |
| U27 | `tests/e2e/account.spec.ts: U27 额度用尽仍保留停用入口，关闭失败与未知结果均不显示成功` | 桌面、手机均通过 |
| U27 | `tests/e2e/account.spec.ts` 其余认证折叠、激活、字段/等待、复制失败用例 | 桌面、手机均通过 |

本卡 U05、U27 没有未说明的验收 ID。U27 的真实账号停用闭环留给 F3-03；本卡按任务卡要求只验证映射与 synthetic 入口夹具，不将其当作真实后端证据。

## 证据

- `tests/e2e/evidence/f1-04/desktop-fault-banner.png`、`mobile-fault-banner.png`：2026-09-28，本机 Astro preview + Chromium，synthetic 终止入口夹具；截图已在页面上标明 synthetic。
- `tests/e2e/evidence/f1-04/logs/`：全部命令的真实输出和三项变异失败/还原日志。
- 未使用真实账号、发信、客户端或生产数据；无 E3 证据需求。

## 不在本次范围

账号页（F3-03）、登录页（F3-01）、真实后端联调；均未实现。未改 F1-03 详情或 F2-01 订阅目录/spec。

## 已知问题与回退点

- 账号与恢复路由目前仍是骨架；真实停用、退订、登出由后续卡实现。横幅只能证明现有组件和 synthetic 入口夹具不互相遮挡，不能证明未来真实流程完成。
- P2-05 若在本卡之后新增 `UnauthorizedReason`，其合入前须补本映射；类型检查会明确报缺失成员。
- 回退到本分支的基点 `fd3dc977de1b53ef64a722f3c7d26e15a41549bc` 可恢复上一可用状态。
