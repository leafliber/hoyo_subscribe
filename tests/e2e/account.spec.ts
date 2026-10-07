// P2-07 获准跨卡接缝：最近认证原因的文案覆盖换邮箱、轮换和删除。
// P2-05 合并接缝：F1-04 的穷尽期望同步恢复码保存与最近认证两个原因。
import { expect, test } from "@playwright/test";
import type { ErrorFeedback } from "../../apps/web/src/lib/errors/feedback";
import {
  API_ERROR_FEEDBACK,
  feedbackForApiError,
  feedbackForFailure,
  UNAUTHORIZED_FEEDBACK,
} from "../../apps/web/src/lib/errors/feedback";
import type { UnauthorizedReason } from "../../packages/contracts/src/errors/codes";
import { API_ERROR_CODES, buildApiErrorBody } from "../../packages/contracts/src/errors/codes";

test("U27 七类错误码与全部 UnauthorizedReason 都给出可执行下一步", () => {
  expect(Object.keys(API_ERROR_FEEDBACK).sort()).toEqual([...API_ERROR_CODES].sort());
  const nextActions: Record<(typeof API_ERROR_CODES)[number], ErrorFeedback["action"]> = {
    validation: "correct_fields",
    unauthorized: "login",
    conflict: "compare",
    rate_limited: "wait",
    capacity_reached: "use_other_capability",
    quota_paused: "check_status",
    temporarily_unavailable: "retry",
  };
  for (const code of API_ERROR_CODES) {
    const feedback = feedbackForApiError(buildApiErrorBody(code));
    expect(feedback.title).toBeTruthy();
    expect(feedback.nextStep).toBeTruthy();
    expect(feedback.action).toBe(nextActions[code]);
    expect(feedback.outcome).toBe("failed");
    expect(feedback.automaticRetry).toBe(false);
  }
  const reasons: UnauthorizedReason[] = [
    "origin_missing",
    "origin_mismatch",
    "csrf_missing",
    "csrf_mismatch",
    "no_session",
    "session_expired",
    "pending_activation",
    "recovery_code_unconfirmed",
    "recent_auth_required",
    "wrong_domain",
  ];
  expect(Object.keys(UNAUTHORIZED_FEEDBACK).sort()).toEqual([...reasons].sort());
  for (const reason of reasons) {
    const feedback = feedbackForApiError(
      buildApiErrorBody("unauthorized", { code: "unauthorized", reason }),
    );
    expect(feedback.nextStep).toBeTruthy();
    // ADR-0026：恢复码可选，只剩恢复登录受限会话需要先保存新码。
    if (reason === "recovery_code_unconfirmed") {
      expect(feedback.action).toBe("save_recovery_code");
      expect(feedback.actionHref).toBe("/recover#save");
    }
    expect(feedback.outcome).toBe("failed");
  }
  const recent = feedbackForApiError(
    buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "recent_auth_required" }),
  );
  expect(recent.title).toBe("需要最近认证");
  expect(recent.nextStep).toContain("邮箱或恢复码验证");
  expect(recent.nextStep).not.toContain("生成恢复码");
});

test("U27 validation 定位首个字段，rate_limited 使用可公开等待信息", () => {
  const validation = feedbackForApiError(
    buildApiErrorBody("validation", {
      code: "validation",
      fields: [
        { path: "scope.games", reason: "type_mismatch" },
        { path: "calendar.enabled", reason: "type_mismatch" },
      ],
    }),
  );
  expect(validation.firstInvalidField).toBe("scope.games");
  expect(validation.preserveInput).toBe(true);
  expect(JSON.stringify(validation)).not.toContain("type_mismatch");
  const limited = feedbackForApiError(
    buildApiErrorBody("rate_limited", { code: "rate_limited", retry_after_ms: 5000 }),
  );
  expect(limited.nextStep).toContain("5 秒");
  expect(limited.automaticRetry).toBe(false);
});

test("U27 认证存在性敏感的服务端 message 不进入反馈", () => {
  const message = "某邮箱已注册";
  const feedback = feedbackForApiError({ error: { code: "unauthorized", message } });
  expect(JSON.stringify(feedback)).not.toContain(message);
  expect(JSON.stringify(feedback)).not.toContain("已注册");
  expect(feedback.action).toBe("login");
});

test("U27 pending_activation 指向完成激活，普通失效会话指向登录", () => {
  const activation = feedbackForApiError(
    buildApiErrorBody("unauthorized", {
      code: "unauthorized",
      reason: "pending_activation",
    }),
  );
  const expired = feedbackForApiError(
    buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "session_expired" }),
  );
  expect(activation.action).toBe("complete_activation");
  expect(activation.nextStep).toContain("完成激活");
  expect(expired.action).toBe("login");
});

test("U27 超时结果不确定，要求重新读取确认，不能显示成功或未执行", () => {
  const timeout = feedbackForFailure({ kind: "timeout" });
  expect(timeout.outcome).toBe("uncertain");
  expect(timeout.action).toBe("confirm_result");
  expect(timeout.nextStep).toContain("重新读取当前状态");
  expect(JSON.stringify(timeout)).not.toContain("未执行");
  expect(JSON.stringify(timeout)).not.toContain("成功");
  expect(timeout.automaticRetry).toBe(false);
});

test("U27 额度用尽仍保留停用入口，关闭失败与未知结果均不显示成功", () => {
  const paused = feedbackForApiError(buildApiErrorBody("quota_paused", { code: "quota_paused" }), {
    affectedOperation: "修改订阅",
  });
  expect(paused.explanation).toContain("修改订阅");
  expect(paused.nextStep).toContain("停用服务的入口仍应保留");
  expect(paused.keepTerminationAccess).toBe(true);
  expect(paused.outcome).toBe("failed");
  const unknown = feedbackForFailure({ kind: "unrecognized" });
  expect(unknown.outcome).toBe("uncertain");
  expect(unknown.nextStep).toContain("重新读取");
});

// 重设计删除了全站故障横幅（#service-fault-banner）与 hoyo:copy-request 复制兜底组件：应用内没有
// 任何调用方（死代码）。原先只驱动这两个组件的两条 DOM 用例随之删除；U27 的反馈语义仍由上面的单元断言覆盖。
