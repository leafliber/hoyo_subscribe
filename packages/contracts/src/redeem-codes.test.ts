import { describe, expect, it } from "vitest";
import { REDEEM_CODE_UNDATED_DISPLAY } from "./params/registry";
import { redeemCodeHiddenAt, redeemCodeVisible, redeemExpiryExpression } from "./redeem-codes";

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

describe("ADR-0030 「有效兑换码」条的显示期", () => {
  const revealedAt = Date.UTC(2026, 9, 9, 11, 45);
  const hour = 3_600_000;

  it("发放前不显示；官方写了有效期的到期即止", () => {
    const code = { revealedAt, expiresAt: revealedAt + 16 * hour, liveClosedAt: null };
    expect(redeemCodeVisible(code, revealedAt - 1)).toBe(false);
    expect(redeemCodeVisible(code, revealedAt)).toBe(true);
    expect(redeemCodeVisible(code, revealedAt + 16 * hour - 1)).toBe(true);
    expect(redeemCodeVisible(code, revealedAt + 16 * hour)).toBe(false);
    expect(redeemCodeHiddenAt(code)).toBe(revealedAt + 16 * hour);
  });

  it("官方有效期优先于活动结束：活动页先关闭也照有效期显示", () => {
    const code = { revealedAt, expiresAt: revealedAt + 16 * hour, liveClosedAt: revealedAt + hour };
    expect(redeemCodeVisible(code, revealedAt + 2 * hour)).toBe(true);
  });

  it("没写有效期的：官方活动结束或满显示上限即止", () => {
    const open = { revealedAt, expiresAt: null, liveClosedAt: null };
    const limit = revealedAt + REDEEM_CODE_UNDATED_DISPLAY * 1000;
    expect(redeemCodeVisible(open, limit - 1)).toBe(true);
    expect(redeemCodeVisible(open, limit)).toBe(false);
    expect(redeemCodeHiddenAt(open)).toBe(limit);
    expect(
      redeemCodeVisible({ ...open, liveClosedAt: revealedAt + hour }, revealedAt + 2 * hour),
    ).toBe(false);
  });
});
