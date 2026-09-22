// A-P1-PARAM：参数注册表与附录 A.5 启动等式校验（任务卡 P1-03）。
//
// 反向验证是本卡的核心验收：人为破坏**每一条**等式，校验必须失败并**准确指出该条**
// （任务卡明言"只测全部成立时通过的测试永远绿，没有意义"）。破坏值来自 verify.ts 中
// 每条等式自带的 breakSample，测试同时自校验 breakSample 确实使该条失败。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTED_SCOPE_GAMES, SUPPORTED_SCOPE_REGIONS } from "../enums";
import { buildAppendixMarkdown } from "./docs";
import {
  AI_BILLING_PROFILE_CONFIGURED,
  MODEL_MAX_BILLED_OUTPUT,
  MODEL_MAX_INPUT,
  PARAM_META,
  PARAMS,
  RETIRED_MAIL_PARAMS,
} from "./registry";
import type { WritableParamValues } from "./verify";
import {
  checkParamEquations,
  PARAM_EQUATIONS,
  ParamEquationError,
  SEMANTIC_INVARIANTS,
  verifyParams,
} from "./verify";

const override = (patch: Partial<WritableParamValues>): WritableParamValues => ({
  ...PARAMS,
  ...patch,
});

describe("A-P1-PARAM 参数注册表", () => {
  it("注册表与元数据键一一对应（文档导出完备性）", () => {
    expect(Object.keys(PARAM_META).sort()).toEqual(Object.keys(PARAMS).sort());
  });

  it("ADR-0003 已废止的月度邮件参数不出现在注册表（禁止清单静态检查）", () => {
    const names = Object.keys(PARAMS);
    const leaked = RETIRED_MAIL_PARAMS.filter((retired) => names.includes(retired));
    expect(leaked).toEqual([]);
    // 反向自检：废止名单本身非空，防止空名单让断言恒真
    expect(RETIRED_MAIL_PARAMS.length).toBe(5);
  });

  it("SUPPORTED_SCOPE 引用 enums.ts 的单一运行时定义源，不是第二份值", () => {
    expect(PARAMS.SUPPORTED_SCOPE.games).toBe(SUPPORTED_SCOPE_GAMES);
    expect(PARAMS.SUPPORTED_SCOPE.regions).toBe(SUPPORTED_SCOPE_REGIONS);
  });

  it("MODEL_MAX_INPUT / MODEL_MAX_BILLED_OUTPUT 未填写，模型自动调用能力默认关闭", () => {
    expect(MODEL_MAX_INPUT).toBeNull();
    expect(MODEL_MAX_BILLED_OUTPUT).toBeNull();
    // 不得用假设值冒充实测值让能力开启
    expect(AI_BILLING_PROFILE_CONFIGURED).toBe(false);
  });

  it("类型层面：普通数组不带界面预选标记，不能冒充 DEFAULT_*（§4.4）", () => {
    // @ts-expect-error UiPresetSuggestion 是标记交叉类型，普通数组不得赋给 DEFAULT_* 的类型
    const forged: typeof PARAMS.DEFAULT_CALENDAR_EVENT_TYPES = ["livestream"] as const;
    expect(forged).toEqual(["livestream"]);
  });
});

describe("A-P1-PARAM 附录 A.5 启动等式", () => {
  it("注册表当前值下全部等式成立（verifyParams 不抛）", () => {
    const results = verifyParams();
    expect(results).toHaveLength(PARAM_EQUATIONS.length);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("覆盖 §11 的全部数值等式（24 条）外加 1 条语义条款单列", () => {
    expect(PARAM_EQUATIONS).toHaveLength(24);
    expect(SEMANTIC_INVARIANTS.map((s) => s.id)).toEqual(["mail-digest-window-forward-only"]);
  });

  // 反向验证：逐条破坏，校验必须准确指出被破坏的那一条。
  it.each(PARAM_EQUATIONS.map((e) => [e.id, e] as const))(
    "反向验证：破坏 %s 时校验准确指出该条",
    (_id, e) => {
      const broken = override(e.breakSample);
      const results = checkParamEquations(broken);
      const failed = results.filter((r) => !r.ok);
      const failedIds = failed.map((r) => r.id);
      expect(failedIds).toContain(e.id);
      // 失败结果携带合同原文与代入实际值的公式（消息可指明是哪一条）
      const hit = failed.find((r) => r.id === e.id);
      expect(hit?.contract.length ?? 0).toBeGreaterThan(0);
      expect(hit?.formula).toContain("(");
    },
  );

  it("紧条目：MAIL_URGENT_DAY 120→119 立刻失败（取等号无余量；本条 + 总和连带）", () => {
    const failed = checkParamEquations(override({ MAIL_URGENT_DAY: 119 })).filter((r) => !r.ok);
    expect(failed.map((r) => r.id)).toContain("mail-urgent-day-covers-seats-plus-floor");
    expect(failed.map((r) => r.id)).toContain("mail-total-day-sum");
  });

  it("紧条目：MAIL_BASE_DAY 调小 1（50→49）时 49>=40 仍成立、本条不失败，但总和等式立刻失败；跌破名额（50→39）则本条失败", () => {
    // 任务卡参考文字"把这两条各调小 1 应当立刻失败"对取等号的 urgent 条成立；对 1.25x 余量的
    // base 条，调小 1 不越容量界（49 >= 40 为真），params:verify 仍因 mail-total-day-sum 立刻失败。
    // 本条自身的失败场景是名额越界（MAIL_ROUTINE_SEATS_MAX 40→41，见反向验证）或日池跌破名额。
    const failed49 = checkParamEquations(override({ MAIL_BASE_DAY: 49 })).filter((r) => !r.ok);
    expect(failed49.map((r) => r.id)).toEqual(["mail-total-day-sum"]);

    const failed39 = checkParamEquations(override({ MAIL_BASE_DAY: 39 })).filter((r) => !r.ok);
    expect(failed39.map((r) => r.id)).toContain("mail-base-day-covers-routine-seats");
    expect(failed39.map((r) => r.id)).toContain("mail-total-day-sum");
  });

  it("verifyParams 失败时抛 ParamEquationError，消息逐条指明等式 ID 与公式", () => {
    expect(() => verifyParams(override({ MAIL_TOTAL_DAY: 259 }))).toThrowError(ParamEquationError);
    try {
      verifyParams(override({ MAIL_TOTAL_DAY: 259 }));
      expect.unreachable("verifyParams 应已抛出");
    } catch (error) {
      expect(error).toBeInstanceOf(ParamEquationError);
      const message = (error as ParamEquationError).message;
      expect(message).toContain("mail-total-day-sum");
      expect(message).toContain("MAIL_TOTAL_DAY(259)");
      // failed 结构同样携带逐条结果
      expect((error as ParamEquationError).failed.map((f) => f.id)).toContain("mail-total-day-sum");
    }
  });
});

describe("A-P1-PARAM 文档同源", () => {
  it("docs/APPENDIX_A.generated.md 与注册表生成输出一致（防手改漂移）", () => {
    const onDisk = readFileSync(
      new URL("../../../../docs/APPENDIX_A.generated.md", import.meta.url),
      "utf8",
    );
    expect(onDisk).toBe(buildAppendixMarkdown());
  });
});
