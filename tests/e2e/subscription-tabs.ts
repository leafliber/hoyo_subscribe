import { expect, type Page } from "@playwright/test";

// ADR-0026：「我的订阅」分成「订阅内容」与「接收方式」两个标签页。
// 用例按真实用户路径切换分区，不直接改 hidden 属性。

export async function showChannels(page: Page): Promise<void> {
  await page.getByRole("tab", { name: /接收方式/ }).click();
  await expect(page.locator("#panel-channels")).toBeVisible();
}

export async function showContent(page: Page): Promise<void> {
  await page.getByRole("tab", { name: /订阅内容/ }).click();
  await expect(page.locator("#panel-content")).toBeVisible();
}
