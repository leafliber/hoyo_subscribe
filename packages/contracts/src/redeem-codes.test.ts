import { describe, expect, it } from "vitest";
import { REDEEM_CODE_STATUS_CHECK, REDEEM_LIVE_TRACK_DAYS } from "./params/registry";
import {
  parseRedeemExpiryInput,
  REDEEM_STATUS_CHECK_HOURS,
  RedeemExpirySetSchema,
  redeemCodeHiddenAt,
  redeemCodeVisible,
  redeemExpiryExpression,
  redeemStatusCheckAfter,
} from "./redeem-codes";

describe("ADR-0030 兑换码有效期写法", () => {
  it.each([
    ["兑换码有效期至10月10日12:00，请尽快兑换", "10月10日12:00"],
    ["兑换码有效期至10月10日 12:00", "10月10日 12:00"],
    ["有效期：2026/10/10 12:00", "2026/10/10 12:00"],
    ["有效期截止2026-10-10 12:00:00", "2026-10-10 12:00:00"],
    ["兑换码有效期为2026年10月10日 12:00前", "2026年10月10日 12:00"],
    ["有效期：10月9日20:00-10月10日12:00", "10月10日12:00"],
    ["有效期 10月9日20:00 至 10月10日12:00", "10月10日12:00"],
    ["请于10月10日12:00前完成兑换", "10月10日12:00"],
    ["兑换截止时间：10月10日 23:59", "10月10日 23:59"],
    ["本批兑换码10月10日12:00后失效", "10月10日12:00"],
    ["兑换码将于10月10日12:00过期", "10月10日12:00"],
    ["兑换码10月10日12:00前有效", "10月10日12:00"],
    ["兑换码有效期至10月10日", "10月10日"],
  ])("「%s」认出 %s", (text, expected) => {
    expect(redeemExpiryExpression(text)).toBe(expected);
  });

  it("同一日期写了两遍仍算一个", () => {
    expect(redeemExpiryExpression("有效期至10月10日12:00。请于10月10日12:00前兑换。")).toBe(
      "10月10日12:00",
    );
  });

  it.each([
    ["兑换码有效期较短，请尽快兑换", "没写日期"],
    ["直播将于10月9日19:30开始，期间发放兑换码", "直播开始时间不是有效期"],
    ["有效期至次日中午", "不认相对写法，不猜惯例"],
    ["有效期至12:00", "只写时刻"],
    ["第一批有效期至10月10日12:00；第二批有效期至10月11日12:00", "两个不同的日期，有歧义"],
    ["有效期至110月10日12:00", "日期前紧挨着数字"],
    ["有效期至10月10日12：00", "全角冒号的时刻不在已核验写法内"],
    ["", "空"],
  ])("「%s」不认（%s）", (text) => {
    expect(redeemExpiryExpression(text)).toBeNull();
  });
});

describe("ADR-0030/ADR-0034 「有效兑换码」条的显示期", () => {
  const revealedAt = Date.UTC(2026, 9, 9, 11, 45);
  const hour = 3_600_000;
  const undated = { revealedAt, expiresAt: null, liveClosedAt: null, goneAt: null };

  it("发放前不显示；有截止时间的到截止时间即止", () => {
    const code = { ...undated, expiresAt: revealedAt + 16 * hour };
    expect(redeemCodeVisible(code, revealedAt - 1)).toBe(false);
    expect(redeemCodeVisible(code, revealedAt)).toBe(true);
    expect(redeemCodeVisible(code, revealedAt + 16 * hour - 1)).toBe(true);
    expect(redeemCodeVisible(code, revealedAt + 16 * hour)).toBe(false);
    expect(redeemCodeHiddenAt(code)).toBe(revealedAt + 16 * hour);
  });

  it("有截止时间时不看官方状态：活动页先关闭、兑换码从列表消失也照截止时间显示", () => {
    const code = {
      ...undated,
      expiresAt: revealedAt + 16 * hour,
      liveClosedAt: revealedAt + hour,
      goneAt: revealedAt + hour,
    };
    expect(redeemCodeVisible(code, revealedAt + 2 * hour)).toBe(true);
  });

  it("没有截止时间：官方仍列出就一直显示，不再有 24 小时上限；最长到跟踪期满", () => {
    const limit = revealedAt + REDEEM_LIVE_TRACK_DAYS * 86_400_000;
    expect(redeemCodeVisible(undated, revealedAt + 30 * hour)).toBe(true);
    expect(redeemCodeVisible(undated, limit - 1)).toBe(true);
    expect(redeemCodeVisible(undated, limit)).toBe(false);
    expect(redeemCodeHiddenAt(undated)).toBe(limit);
  });

  it("没有截止时间：官方不再列出或活动已结束即收回", () => {
    expect(
      redeemCodeVisible({ ...undated, goneAt: revealedAt + 3 * hour }, revealedAt + 3 * hour),
    ).toBe(false);
    expect(
      redeemCodeVisible({ ...undated, liveClosedAt: revealedAt + hour }, revealedAt + 2 * hour),
    ).toBe(false);
  });
});

describe("ADR-0034 没有截止时间时的核对时刻", () => {
  const beijing = (text: string) => Date.parse(`${text}+08:00`);

  it("北京时间 0、3、6……21 点整，严格晚于上次核对", () => {
    expect(REDEEM_CODE_STATUS_CHECK).toBe(10_800);
    expect(redeemStatusCheckAfter(beijing("2026-10-09T20:35:00"))).toBe(
      beijing("2026-10-09T21:00:00"),
    );
    expect(redeemStatusCheckAfter(beijing("2026-10-09T21:00:00"))).toBe(
      beijing("2026-10-10T00:00:00"),
    );
    expect(redeemStatusCheckAfter(beijing("2026-10-09T23:59:59"))).toBe(
      beijing("2026-10-10T00:00:00"),
    );
    expect(redeemStatusCheckAfter(beijing("2026-10-10T00:00:01"))).toBe(
      beijing("2026-10-10T03:00:00"),
    );
  });

  it("页面说明用的核对时刻由参数推出", () => {
    expect(REDEEM_STATUS_CHECK_HOURS).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
  });

  it("一天恰好八个核对时刻", () => {
    const hours: number[] = [];
    let at = beijing("2026-10-09T00:00:00");
    while (at < beijing("2026-10-10T00:00:00")) {
      hours.push(new Date(at + 8 * 3_600_000).getUTCHours());
      at = redeemStatusCheckAfter(at);
    }
    expect(hours).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
  });
});

describe("ADR-0034 管理员登记的截止时间", () => {
  it.each([
    ["2026-10-11T23:59:59", "2026/10/11 23:59:59", "2026-10-11T23:59:59+08:00"],
    ["2026-10-11T12:00", "2026/10/11 12:00", "2026-10-11T12:00:00+08:00"],
    [" 2026/10/11 12:00 ", "2026/10/11 12:00", "2026-10-11T12:00:00+08:00"],
  ])("「%s」→ %s（北京时间）", (raw, expression, instant) => {
    expect(parseRedeemExpiryInput(raw)).toEqual({ utcMs: Date.parse(instant), expression });
  });

  it.each([
    ["2026-02-30T12:00", "不存在的日子"],
    ["2026-10-11", "只有日期"],
    ["2026-10-11T24:00", "不存在的时刻"],
    ["10月11日 12:00", "没写年份"],
    ["2026-10-11T12:00:00+09:00", "带时区"],
    ["", "空"],
  ])("「%s」不认（%s）", (raw) => {
    expect(parseRedeemExpiryInput(raw)).toBeNull();
  });

  it("登记请求只接受活动 ID 形状、闭合理由与非负版本", () => {
    const body = {
      source: "zzz-live",
      act_id: "ea202609241643161324",
      expires_at: "2026-10-11T23:59:59",
      reason: "evidence_reviewed",
      expected_updated_at: 0,
    };
    expect(RedeemExpirySetSchema.safeParse(body).success).toBe(true);
    expect(RedeemExpirySetSchema.safeParse({ ...body, act_id: "a/b" }).success).toBe(false);
    expect(RedeemExpirySetSchema.safeParse({ ...body, reason: "随便" }).success).toBe(false);
    expect(RedeemExpirySetSchema.safeParse({ ...body, expected_updated_at: -1 }).success).toBe(
      false,
    );
    expect(RedeemExpirySetSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });
});
