import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  ACCOUNT_GRACE_DAYS,
  ACCOUNT_IDLE_DAYS,
  MAIL_ROUTINE_SEATS_MAX,
  MAIL_SEAT_LEASE,
  MAIL_SEATS_MAX,
  PUBLIC_CACHE_FRESH,
} from "../../packages/contracts/src/index";

const status = () => ({
  registration_open: false,
  mail_sending_available: false,
  publication: null,
  cache: {
    generatedAt: Date.now(),
    freshUntil: Date.now() + PUBLIC_CACHE_FRESH * 1000,
    stale: false,
  },
  sources: null,
  reviewGaps: [{ game: "genshin", count: null }],
  capabilities: {
    calendar: "unknown",
    email_seats: "closed",
    routine_email: "unknown",
    push: "closed",
  },
  calendarClients: [
    { client: "apple_calendar_macos", support: "verified" },
    { client: "google_calendar", support: "unknown" },
    { client: "outlook", support: "unknown" },
  ],
});
test("A-P5-RELEASE 用户帮助公开限制、参数与缩小预览范围，不再展示组件演示", async ({
  page,
}, info) => {
  await page.goto("/help");
  const main = page.locator("main");
  for (const text of [
    "Apple Calendar / macOS：已测",
    "Google Calendar：未测",
    "Outlook 桌面版与 Web 版：未测",
    "版本和刷新延迟未记录",
    "提醒非必达",
    "首版不自动补发",
    "业务通知到期即作废",
    "跨通道重复",
    "不会消费恢复码",
    "同一范围反复重试仍可能过期",
    "保存后重新取得完整预览",
    `邮件席位上限为 ${MAIL_SEATS_MAX}`,
    `最多 ${MAIL_ROUTINE_SEATS_MAX}`,
    `租期为 ${MAIL_SEAT_LEASE} 天`,
    `${ACCOUNT_IDLE_DAYS} 天`,
    `${ACCOUNT_GRACE_DAYS} 天`,
  ])
    await expect(main).toContainText(text);
  await expect(main).not.toContainText("页面骨架");
  await expect(main).not.toContainText("示例弹窗");
  await expect(main.getByRole("link", { name: "恢复入口" })).toHaveAttribute("href", "/recover");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("release-help.png"), fullPage: true });
});
test("A-P5-RELEASE 状态未知、来源缺失与空发布不冒充正常", async ({ page }, info) => {
  await page.route("**/api/v2/status", (r) => r.fulfill({ json: status() }));
  await page.goto("/status");
  await expect(page.locator("#release-status-message")).toContainText("已读取公开状态");
  const facts = page.locator("#release-status-facts");
  for (const text of [
    "日历：未知",
    "来源状态未知",
    "发布代次未知",
    "待审核缺口：未知",
    "邮件新席位：已关闭",
  ])
    await expect(facts).toContainText(text);
  await expect(page.locator("main")).toContainText("最终上线放行未完成");
  await page.screenshot({ path: info.outputPath("release-status.png"), fullPage: true });
});
test("A-P5-RELEASE 过期/异常响应失败关闭，重试可恢复且不泄露原始文本", async ({ page }) => {
  let mode = "stale";
  await page.route("**/api/v2/status", (r) => {
    if (mode === "failure")
      return r.fulfill({ status: 503, body: "private-diagnostic-must-not-render" });
    if (mode === "invalid") return r.fulfill({ json: { registration_open: true } });
    const s = status();
    s.capabilities.calendar = "open";
    s.registration_open = true;
    if (mode === "stale") s.cache.stale = true;
    return r.fulfill({ json: s });
  });
  await page.goto("/status");
  await expect(page.locator("#release-status-message")).toContainText("副本已过期");
  await expect(page.locator("#release-status-facts")).not.toContainText("已开放");
  for (const value of ["failure", "invalid"]) {
    mode = value;
    await page.getByRole("button", { name: "刷新状态" }).click();
    await expect(page.locator("#release-status-message")).toContainText("状态未知");
    await expect(page.locator("#release-status-facts")).toBeEmpty();
    await expect(page.locator("main")).not.toContainText("private-diagnostic");
  }
  mode = "ok";
  await page.getByRole("button", { name: "刷新状态" }).click();
  await expect(page.locator("#release-status-facts")).toContainText("日历：已开放");
});
test("A-P5-RELEASE 来源逐项显示维护与核验未知，不以单一绿灯覆盖", async ({ page }) => {
  await page.route("**/api/v2/status", (r) =>
    r.fulfill({
      json: {
        ...status(),
        publication: { generation: 3, publishedAt: Date.now() },
        sources: [
          {
            sourceId: "synthetic-maintenance",
            game: "genshin",
            verifiedAt: null,
            verificationState: "unknown",
            degradationReasons: ["maintenance_required"],
          },
          {
            sourceId: "synthetic-unknown",
            game: "hsr",
            verifiedAt: null,
            verificationState: "unknown",
            degradationReasons: ["not_verified"],
          },
        ],
      },
    }),
  );
  await page.goto("/status");
  const f = page.locator("#release-status-facts");
  await expect(f).toContainText("维护中，暂不可用");
  await expect(f).toContainText("核验状态未知");
  await expect(f).toContainText("发布代次：3");
});
test("A-P5-RELEASE U28 测试夹具与本地负载入口不进入生产产物", () => {
  const scan = (p: string): string[] =>
    readdirSync(p, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? scan(join(p, e.name)) : [join(p, e.name)],
    );
  for (const file of scan("apps/web/dist").filter((f) => /\.(html|js)$/.test(f))) {
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("/__test/p5-release/");
    expect(text).not.toContain("LOAD_LOCAL_ONLY");
    expect(text).not.toContain("打开示例弹窗");
  }
});
