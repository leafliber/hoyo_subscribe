// 从参数注册表导出附录 A 文档表格（任务卡 P1-03：保证文档与运行参数同源）。
//
// 本文件只提供纯函数 buildAppendixMarkdown()；写盘由 scripts/params/export-docs.ts 完成
// （tsx 运行）。docs/APPENDIX_A.generated.md 是生成物，不得手改——改参数请改 registry.ts
// 后重新运行 `pnpm params:docs`；contracts 的测试会比对生成文件与注册表输出，防止漂移。
//
// A.6 提醒规则注册表不复制：直接从 ../rules.ts 的 REMINDER_RULES 生成同一张表。

import { REMINDER_RULES } from "../rules";
import type { ParamMeta } from "./registry";
import { PARAM_META, PARAMS, RETIRED_MAIL_PARAMS } from "./registry";
import type { EquationResult } from "./verify";
import { checkParamEquations, PARAM_EQUATIONS, SEMANTIC_INVARIANTS } from "./verify";

const SECTION_TITLES: Record<ParamMeta["section"], string> = {
  "A.1": "A.1 产品、来源与后台",
  "A.2": "A.2 认证与账号",
  "A.3": "A.3 日历、通知有效期与模型",
  "A.4": "A.4 邮件与 Push（按 ADR-0003 纯日额度模型）",
  "A.5": "A.5 保留与配置依赖",
};

const STATUS_LABELS: Record<ParamMeta["status"], string> = {
  baseline: "基线",
  "adr-0003": "ADR-0003 修订",
  measured: "平台实测",
  "measured-ref": "实测引用",
  "pending-p0": "P0 待定",
  "ui-preset": "界面预选",
  strategy: "策略",
};

const formatValue = (value: unknown): string => {
  if (value === null) {
    return "未填写（P0 待定）";
  }
  if (typeof value === "number") {
    return value.toLocaleString("en-US");
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return String(value);
  }
  return JSON.stringify(value);
};

const renderParamRow = (name: string): string => {
  const value = PARAMS[name as keyof typeof PARAMS];
  const meta = PARAM_META[name as keyof typeof PARAMS];
  const statusNote = meta.note ? `；${meta.note}` : "";
  return `| ${name} | ${formatValue(value)} | ${meta.unit} | ${meta.description} | ${STATUS_LABELS[meta.status]}${statusNote} |`;
};

const renderSection = (section: ParamMeta["section"]): string[] => {
  const names = (Object.keys(PARAM_META) as (keyof typeof PARAM_META)[]).filter(
    (n) => PARAM_META[n].section === section,
  );
  return [
    `### ${SECTION_TITLES[section]}`,
    "",
    "| 参数 | 值 | 单位 | 含义 | 状态与备注 |",
    "| --- | --- | --- | --- | --- |",
    ...names.map((n) => renderParamRow(n)),
    "",
  ];
};

const renderEquationRow = (result: EquationResult): string =>
  `| ${result.id} | ${result.group} | ${result.contract} | ${result.formula} |`;

/** 生成完整的附录 A 参数文档（Markdown）。纯函数，无 I/O。 */
export function buildAppendixMarkdown(): string {
  const lines: string[] = [
    "<!-- 生成物：由 packages/contracts/src/params/registry.ts 经 `pnpm params:docs` 生成，请勿手改。 -->",
    "<!-- 文档与运行参数同源是 P1-03 的交付物；与本文冲突时以注册表代码为准并重新生成。 -->",
    "",
    "# 附录 A：唯一参数基线（生成版）",
    "",
    "> 本文件是主方案附录 A 的**生成视图**：参数值、单位、含义、状态全部来自",
    "> `packages/contracts/src/params/registry.ts`。合同原文见",
    "> `docs/HOYO_OFFICIAL_EVENT_SUBSCRIPTION_PLAN_v2.1.md` 附录 A；邮件部分按",
    "> **ADR-0003（纯日额度模型）** 落地，主方案附录 A.4/A.5 中与之冲突的行以 ADR-0003 为准。",
    "",
    "## ADR-0003 修订说明",
    "",
    `以下月度参数已废止，**不在本注册表**（AGENTS.md 第 3 节禁止清单，出现即判不合格）：${RETIRED_MAIL_PARAMS.join("、")}；`,
    "envelope 公式、carry、E=1 兜底、认证软线 S、月末半日片段同此。邮件预算为纯日额度模型：",
    "每个 UTC 日独立重置、池间不互借、不跨日结转；唯一平台硬约束是 `PLATFORM_MAIL_DAY_LIMIT`（实测）。",
    "",
    "`DEFAULT_*` 与 `CHANGE_DEFAULTS` 只是**界面预选建议**（主方案 §4.4）：新账号以 `uninitialized` 建立，",
    "服务端不得把预选写入订阅行，用户首次保存才产生正式配置。",
    "",
    "P0 待定项（`MODEL_MAX_INPUT`、`MODEL_MAX_BILLED_OUTPUT`）未填写前，依赖模型自动调用的能力默认关闭",
    "（开关 `AI_BILLING_PROFILE_CONFIGURED` 由实测值推导，不得用假设值翻转）。",
    "",
    ...renderSection("A.1"),
    ...renderSection("A.2"),
    ...renderSection("A.3"),
    ...renderSection("A.4"),
    ...renderSection("A.5"),
    "## A.6 固定提醒规则注册表",
    "",
    "> 本表由 `packages/contracts/src/rules.ts` 的 `REMINDER_RULES`（P1-02 交付）生成，参数注册表不复制第二份。",
    "",
    "| rule_id | 事件类型 | 节点 | 提前量（秒） | 用户文案 |",
    "| --- | --- | --- | --- | --- |",
    ...REMINDER_RULES.map(
      (r) =>
        `| ${r.rule_id} | ${r.event_type} | ${r.node_type} | ${r.lead_time_seconds.toLocaleString("en-US")} | ${r.user_copy_zh} |`,
    ),
    "",
    "## 附录 A.5 / CONTRACTS_BASELINE.md §11 启动等式（生成时的实际值）",
    "",
    "| 等式 ID | 分组 | 合同 | 当前值 |",
    "| --- | --- | --- | --- |",
    ...checkParamEquations().map((r) => renderEquationRow(r)),
    "",
    "### 语义条款（无法用参数数值校验，由实现阶段测试保证）",
    "",
    ...SEMANTIC_INVARIANTS.map((s) => `- **${s.id}**：${s.contract}——由${s.enforcedBy}。`),
    "",
    "### 等式数量核对",
    "",
    `数值等式 ${PARAM_EQUATIONS.length} 条、语义条款 ${SEMANTIC_INVARIANTS.length} 条。`,
    "`pnpm params:verify` 与 Worker 启动路径逐条校验数值等式，任一不成立即拒绝并指明该条。",
    "",
  ];
  return lines.join("\n");
}
