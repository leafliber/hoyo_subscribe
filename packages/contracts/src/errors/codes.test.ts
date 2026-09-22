// A-P1-SHELL：七类错误模型的合同测试（§8.2 末段；前端 §11.3）。
import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  type ApiErrorCode,
  buildApiErrorBody,
  DEFAULT_API_ERROR_MESSAGES,
  isApiErrorBody,
  type UnauthorizedReason,
} from "./codes";

describe("A-P1-SHELL 七类错误模型（contracts 唯一定义源）", () => {
  it("错误码集合与 §8.2 末段完全一致（七个、不多不少、顺序即合同顺序）", () => {
    expect([...API_ERROR_CODES]).toEqual([
      "validation",
      "unauthorized",
      "conflict",
      "rate_limited",
      "capacity_reached",
      "quota_paused",
      "temporarily_unavailable",
    ]);
  });

  it("每个错误码都有 HTTP 状态映射与固定默认文案", () => {
    for (const code of API_ERROR_CODES) {
      expect(Number.isInteger(API_ERROR_STATUS[code])).toBe(true);
      expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(DEFAULT_API_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
    // 抽查关键映射：客户端错误与会话类失败不混用服务端状态。
    expect(API_ERROR_STATUS.validation).toBe(400);
    expect(API_ERROR_STATUS.unauthorized).toBe(401);
    expect(API_ERROR_STATUS.conflict).toBe(409);
    expect(API_ERROR_STATUS.rate_limited).toBe(429);
    expect(API_ERROR_STATUS.capacity_reached).toBe(503);
  });

  it("默认文案不泄露存在性、不承诺恢复时刻（§4.2 / 前端 §11.3）", () => {
    const forbiddenPhrases = ["不存在", "未注册", "已注册", "一定恢复", "not exist", "registered"];
    for (const code of API_ERROR_CODES) {
      for (const phrase of forbiddenPhrases) {
        expect(DEFAULT_API_ERROR_MESSAGES[code]).not.toContain(phrase);
      }
    }
  });

  it("buildApiErrorBody 生成稳定形状；details 判别码与外层 code 一致", () => {
    const body = buildApiErrorBody("unauthorized", { code: "unauthorized", reason: "no_session" });
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBe(DEFAULT_API_ERROR_MESSAGES.unauthorized);
    expect(body.error.details).toEqual({ code: "unauthorized", reason: "no_session" });
    // JSON 序列化字节稳定（键序由字面量固定）——存在性折叠测试依赖这一性质。
    expect(JSON.stringify(buildApiErrorBody("conflict"))).toBe(
      JSON.stringify(buildApiErrorBody("conflict")),
    );
  });

  it("isApiErrorBody 接受全部七类合法体，拒绝缺 code、未知 code、details 判别码不一致", () => {
    for (const code of API_ERROR_CODES) {
      expect(isApiErrorBody(buildApiErrorBody(code))).toBe(true);
    }
    expect(isApiErrorBody(null)).toBe(false);
    expect(isApiErrorBody({})).toBe(false);
    expect(isApiErrorBody({ error: { code: "made_up", message: "x" } })).toBe(false);
    expect(isApiErrorBody({ error: { code: 42, message: "x" } })).toBe(false);
    expect(isApiErrorBody({ error: { code: "conflict", message: "x" } })).toBe(true);
    // details 判别码与外层不一致 → 拒绝。
    expect(
      isApiErrorBody({
        error: { code: "unauthorized", message: "x", details: { code: "validation", fields: [] } },
      }),
    ).toBe(false);
  });

  it("unauthorized 的 reason 是闭合枚举，不含存在性表述", () => {
    const reasons = [
      "origin_missing",
      "origin_mismatch",
      "csrf_missing",
      "csrf_mismatch",
      "no_session",
      "session_expired",
      "pending_activation",
      "wrong_domain",
    ] as const satisfies readonly UnauthorizedReason[];
    // 类型级穷尽：联合的每个成员都在上面的字面量清单里。
    type AllReasonsCovered = UnauthorizedReason extends (typeof reasons)[number] ? true : never;
    const covered: AllReasonsCovered = true;
    expect(covered).toBe(true);
    expect(new Set<string>(reasons).size).toBe(8);
    expect(reasons.some((r) => /exist|unknown_email|registered/.test(r))).toBe(false);
    const body = buildApiErrorBody("unauthorized", {
      code: "unauthorized",
      reason: "no_session",
    });
    expect((body.error.details as { reason: string }).reason).toBe("no_session");
  });

  it("类型级检查：ApiErrorCode 与运行时集合同源（编译期即合同）", () => {
    const codes: ApiErrorCode[] = [...API_ERROR_CODES];
    expect(codes).toHaveLength(7);
  });
});
