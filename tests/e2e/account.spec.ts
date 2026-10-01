// F2-04 获准跨卡：仅将证据截图写入改为显式环境变量启用。
// P2-07 获准跨卡接缝：最近认证原因的文案覆盖换邮箱、轮换和删除。
// P2-05 合并接缝：F1-04 的穷尽期望同步恢复码保存与最近认证两个原因。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
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

test("U27 全站横幅不遮挡恢复、停用、退订、登出、紧急停用入口", async ({ page }, info) => {
  await page.goto("/account");
  await page.evaluate(() => {
    const main = document.getElementById("main");
    if (!main) throw new Error("main missing");
    const fixture = document.createElement("nav");
    fixture.setAttribute("aria-label", "synthetic 终止入口夹具");
    const note = document.createElement("p");
    note.textContent = "synthetic 终止入口夹具：以下按钮仅用于遮挡测试";
    fixture.append(note);
    for (const name of ["恢复", "停用", "退订", "登出", "紧急停用"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = name;
      button.addEventListener("click", () => {
        button.dataset.clicked = "true";
      });
      fixture.append(button);
    }
    main.prepend(fixture);
    document.dispatchEvent(
      new CustomEvent("hoyo:service-fault", {
        detail: {
          failure: { error: { code: "quota_paused", message: "synthetic" } },
          context: { affectedOperation: "修改订阅" },
        },
      }),
    );
  });
  const banner = page.locator("#service-fault-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("停用服务的入口仍应保留");
  await expect(banner.getByRole("link", { name: "账号恢复与紧急停用入口" })).toBeVisible();
  for (const name of ["恢复", "停用", "退订", "登出", "紧急停用"]) {
    const button = page.getByRole("button", { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    const uncovered = await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return (
        document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element
      );
    });
    expect(uncovered, `${name} 被横幅遮挡`).toBe(true);
    await button.click();
    await expect(button).toHaveAttribute("data-clicked", "true");
  }
  const folder = resolve(
    process.env.HOYO_E2E_WRITE_EVIDENCE === "1"
      ? "tests/e2e/evidence/f1-04"
      : "tests/e2e/test-results/f1-04",
  );
  mkdirSync(folder, { recursive: true });
  const viewport = info.project.name.startsWith("mobile") ? "mobile" : "desktop";
  await page.screenshot({ path: `${folder}/${viewport}-fault-banner.png`, fullPage: true });
});

test("U27 复制失败提供可选文本且不显示复制成功", async ({ page }) => {
  await page.goto("/account");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => Promise.reject(new Error("synthetic copy failure")) },
    });
    const host = document.createElement("div");
    host.id = "synthetic-copy-feedback";
    document.getElementById("main")?.append(host);
    host.dispatchEvent(
      new CustomEvent("hoyo:copy-request", {
        bubbles: true,
        detail: { text: "synthetic-manual-copy" },
      }),
    );
  });
  const host = page.locator("#synthetic-copy-feedback");
  await expect(host).toContainText("复制失败");
  await expect(host).not.toContainText("已复制");
  await expect(host).toHaveAttribute("data-copy-state", "manual");
  const field = host.getByRole("textbox", { name: "可手动复制的文本" });
  await expect(field).toHaveValue("synthetic-manual-copy");
  await expect(field).toBeFocused();
  expect(await field.evaluate((element) => (element as HTMLTextAreaElement).selectionEnd)).toBe(
    "synthetic-manual-copy".length,
  );
});
