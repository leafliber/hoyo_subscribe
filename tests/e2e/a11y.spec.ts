/**
 * U28 · 手机、键盘、页面缩放和读屏关键流程（前端 v1.0 §14.1；F1-01 交付）。
 *
 * 覆盖：八条路由骨架、主导航仅两项、键盘走查与焦点环、弹窗焦点移动与恢复、
 * 表单标签持续可见、折叠区错误自动展开定位、状态播报、触控目标 ≥44px、
 * 窄视口（缩放代理）不丢关键操作、token 对比度（含半透明合成色）、
 * 颜色单一来源扫描、桌面与手机截图证据。
 *
 * 说明：对比度只按 WCAG 对比度公式与阈值（4.5 / 3）做自动化检查，
 * 本文件不是完整无障碍合规审计，不得据此宣称某个合规等级（前端 §11.2）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  compositeOver,
  contrastRatio,
  parseHexColor,
  type Rgb,
  toHex,
} from "../../apps/web/src/styles/color";
import { CONTRAST_CHECKS } from "../../apps/web/src/styles/contrast-checks";

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = resolve(here, "../../apps/web/src");
const ROUTES = [
  "/",
  "/events/sample",
  "/subscription",
  "/login",
  "/recover",
  "/account",
  "/help",
  "/status",
] as const;

function skipUnlessDesktop(reason: string): void {
  test.skip(test.info().project.name !== "desktop-chromium", reason);
}

function skipUnlessMobile(reason: string): void {
  test.skip(test.info().project.name !== "mobile-chromium", reason);
}

// ---------------------------------------------------------------------------
// 纯计算用例：token 对比度与颜色单一来源（只在 desktop 项目跑一次）
// ---------------------------------------------------------------------------

function parseTokensCss(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const pattern = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
  for (const match of css.matchAll(pattern)) {
    tokens.set(`--${match[1]}`, match[2].trim());
  }
  return tokens;
}

test("U28 对比度：token 全部前景/背景组合与半透明合成色逐一达到阈值", () => {
  skipUnlessDesktop("纯计算用例，单项目执行即可");
  const tokens = parseTokensCss(readFileSync(join(webSrc, "styles/tokens.css"), "utf8"));
  const resolveColor = (name: string): Rgb => {
    const value = tokens.get(name);
    // parseHexColor 只接受 hex 字面量：颜色 token 若写了 var() 引用会在这里抛错，
    // 即颜色 token 必须可直接解析（tokens.css 文件头规则 2）。
    return parseHexColor(value ?? "");
  };
  const resolveAlpha = (name: string): number => {
    const alpha = Number(tokens.get(name));
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new Error(`透明度 token 非法：${name} = ${tokens.get(name)}`);
    }
    return alpha;
  };

  const failures: string[] = [];
  for (const check of CONTRAST_CHECKS) {
    let background = resolveColor(check.background.base);
    for (const overlay of check.background.overlays ?? []) {
      background = compositeOver(
        resolveColor(overlay.color),
        resolveAlpha(overlay.alpha),
        background,
      );
    }
    let foreground = resolveColor(check.text.color);
    if (check.text.alpha !== undefined) {
      // 半透明降权：对「合成后的实际颜色」测，不是对原色测。
      foreground = compositeOver(foreground, resolveAlpha(check.text.alpha), background);
    }
    const ratio = contrastRatio(foreground, background);
    if (ratio < check.min) {
      failures.push(
        `${check.use}：${ratio.toFixed(3)} < ${check.min}（前景 ${toHex(foreground)} on ${toHex(background)}）`,
      );
    }
  }
  expect(failures.join("\n"), `应登记并通过 ${CONTRAST_CHECKS.length} 个组合`).toBe("");
});

test("U28 颜色单一来源：tokens.css 之外不允许出现颜色字面量", () => {
  skipUnlessDesktop("纯计算用例，单项目执行即可");
  const colorLiteral = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/;
  const tokensFile = join(webSrc, "styles/tokens.css");
  const scanned: string[] = [];
  const violations: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(css|astro)$/.test(full) || full === tokensFile) continue;
      scanned.push(full);
      const lines = readFileSync(full, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (colorLiteral.test(line)) violations.push(`${full}:${index + 1}: ${line.trim()}`);
      });
    }
  };
  walk(webSrc);
  expect(scanned.length, "至少应扫描到 base.css 与页面文件").toBeGreaterThan(0);
  expect(violations.join("\n")).toBe("");
});

test("U28 color.ts 工具函数：contrastRatio / compositeOver 对照已知值", () => {
  skipUnlessDesktop("纯计算用例，单项目执行即可");
  expect(contrastRatio(parseHexColor("#ffffff"), parseHexColor("#000000"))).toBeCloseTo(21, 1);
  expect(contrastRatio(parseHexColor("#767676"), parseHexColor("#ffffff"))).toBeCloseTo(4.54, 2);
  const halfBlackOnWhite = compositeOver(parseHexColor("#000000"), 0.5, parseHexColor("#ffffff"));
  expect(toHex(halfBlackOnWhite)).toBe("#808080");
  expect(contrastRatio(halfBlackOnWhite, parseHexColor("#ffffff"))).toBeCloseTo(3.95, 2);
});

// ---------------------------------------------------------------------------
// 浏览器用例：路由、导航、键盘、弹窗、表单、折叠、播报
// ---------------------------------------------------------------------------

test("U28 路由骨架：八条路由全部可达并渲染统一布局", async ({ page }) => {
  for (const route of ROUTES) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBeLessThan(400);
    await expect(page.locator("header .primary-nav"), route).toBeVisible();
    await expect(page.locator("h1"), route).toBeVisible();
    await expect(page.locator("footer.app-footer"), route).toBeVisible();
  }
});

test("U28 主导航仅「日程 / 我的订阅」两项；登录在页头，帮助与服务状态在页脚；能力型 URL 不出现在页面", async ({
  page,
}) => {
  await page.goto("/");
  const primaryLinks = page.locator('nav[aria-label="主导航"] a');
  await expect(primaryLinks).toHaveCount(2);
  await expect(primaryLinks.nth(0)).toHaveText("日程");
  await expect(primaryLinks.nth(1)).toHaveText("我的订阅");
  await expect(page.locator("header").getByRole("link", { name: "登录" })).toBeVisible();
  const footerNav = page.locator('nav[aria-label="页脚"]');
  await expect(footerNav.getByRole("link", { name: "帮助" })).toBeVisible();
  await expect(footerNav.getByRole("link", { name: "服务状态" })).toBeVisible();
  // 只有一个主导航区域：手机端不为形式完整增加底部标签栏（前端 §2.2）
  await expect(page.locator('nav[aria-label="主导航"]')).toHaveCount(1);
  // 能力型 URL（Feed、退订、receipt、API）不进入站内普通导航或页面链接（前端 §2.1）
  const capabilityHrefs = await page
    .locator("a[href]")
    .evaluateAll((els) =>
      els
        .map((el) => el.getAttribute("href") ?? "")
        .filter((href) => /unsubscribe|feed|receipt|\/api\//.test(href)),
    );
  expect(capabilityHrefs).toEqual([]);
});

test("U28 键盘 Tab 走完主要操作（跳过链接→主导航→登录→表单→页脚），焦点环可见", async ({
  page,
}) => {
  await page.goto("/login");
  const expectedOrder = [
    "跳到主要内容",
    "米哈游官方日程订阅",
    "日程",
    "我的订阅",
    "登录",
    "login-email",
    "发送验证码",
    "帮助",
    "服务状态",
  ];
  const seen: string[] = [];
  for (let i = 0; i < expectedOrder.length; i++) {
    await page.keyboard.press("Tab");
    seen.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return "(none)";
        return el.textContent?.trim() || el.getAttribute("aria-label") || el.id || "(unnamed)";
      }),
    );
  }
  expect(seen).toEqual(expectedOrder);
  // 焦点明显：当前焦点元素带 ≥2px 的 outline
  const outline = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const style = window.getComputedStyle(el);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) || 0 };
  });
  expect(outline?.style).not.toBe("none");
  expect(outline?.width ?? 0).toBeGreaterThanOrEqual(2);
});

test("U28 弹窗：焦点移入、Tab 只在弹窗内循环、背景 inert 不可误操作、Esc 关闭并恢复焦点", async ({
  page,
}) => {
  await page.goto("/help");
  const trigger = page.getByRole("button", { name: "打开示例弹窗" });
  const dialog = page.locator("#demo-dialog");
  await trigger.click();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((root) => root.contains(document.activeElement))).toBe(true);
  // 背景不可误操作：页头、主内容、页脚带 inert
  for (const selector of ["header.app-header", "main.app-main", "footer.app-footer"]) {
    await expect(page.locator(selector)).toHaveAttribute("inert", "");
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((root) => root.contains(document.activeElement))).toBe(true);
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((root) => root.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("U28 表单标签在 placeholder 之外持续可见并与控件关联", async ({ page }) => {
  await page.goto("/login");
  const input = page.locator("#login-email");
  const label = page.locator('label[for="login-email"]');
  await expect(label).toBeVisible();
  await expect(label).toHaveText("邮箱地址");
  // 输入内容后标签仍然可见（不只用 placeholder）
  await input.fill("demo@example.com");
  await expect(label).toBeVisible();
  expect(
    await input.evaluate((el) => (el as HTMLInputElement).labels?.length ?? 0),
  ).toBeGreaterThanOrEqual(1);
});

test("U28 折叠区含错误时自动展开并把焦点定位到错误", async ({ page }) => {
  await page.goto("/help");
  const details = page.locator("#demo-collapse");
  await expect(details).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "模拟校验失败" }).click();
  await expect(details).toHaveAttribute("open", "");
  await expect(page.locator("#demo-field-error")).toBeVisible();
  await expect(page.locator("#demo-field-error")).toBeFocused();
});

test("U28 状态播报：加载/保存/失败消息经 role=status 区域可被辅助技术获知", async ({ page }) => {
  await page.goto("/help");
  const region = page.locator("#global-status");
  await expect(region).toHaveAttribute("role", "status");
  await expect(region).toBeHidden(); // 初始为空、不占位
  await page.getByRole("button", { name: "模拟状态播报" }).click();
  await expect(region).toBeVisible();
  await expect(region).toContainText("示例：这条状态消息会被辅助技术播报");
  // 登录骨架的按钮同样写入全局状态区，而不是无反馈或只靠 Toast
  await page.goto("/login");
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.locator("#global-status")).toContainText("骨架页：验证码发送由 F3 轮交付");
});

// ---------------------------------------------------------------------------
// 移动端用例：触控目标与缩放（窄视口作页面放大代理）
// ---------------------------------------------------------------------------

test("U28 触控目标：主要按钮、导航、展开入口与输入的有效点击区 ≥ 44px", async ({ page }) => {
  skipUnlessMobile("移动端视口专测");
  await page.goto("/help");
  const targets = page.locator("header a, footer a, main button, main summary, main input");
  const count = await targets.count();
  expect(count).toBeGreaterThan(0);
  const tooSmall: string[] = [];
  for (let i = 0; i < count; i++) {
    const target = targets.nth(i);
    const box = await target.boundingBox();
    if (!box) continue; // 隐藏元素（如弹窗内关闭按钮）不参与
    const smaller = Math.min(box.width, box.height);
    if (smaller < 44) {
      tooSmall.push(`${await target.textContent()}（${smaller.toFixed(0)}px）`);
    }
  }
  expect(tooSmall.join("; "), "触控目标不足 44px 的元素").toBe("");
});

test("U28 页面缩放（窄视口代理）：关键操作不丢失、无横向溢出", async ({ page }) => {
  skipUnlessMobile("移动端视口专测");
  for (const width of [400, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/login");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px 视口不应横向溢出`).toBeLessThanOrEqual(1);
    // 关键操作仍可见且落在视口横向范围内
    const keyActions = [
      // exact：品牌链接名「米哈游官方日程订阅」包含「日程」，非精确匹配会撞上
      page.getByRole("link", { name: "日程", exact: true }),
      page.getByRole("link", { name: "我的订阅", exact: true }),
      page.getByRole("link", { name: "登录", exact: true }),
      page.getByRole("button", { name: "发送验证码", exact: true }),
    ];
    for (const action of keyActions) {
      const box = await action.boundingBox();
      expect(box, `${width}px 视口：关键操作应渲染`).not.toBeNull();
      expect(box?.x ?? -1, `${width}px 视口：不应被裁到左侧`).toBeGreaterThanOrEqual(0);
      expect(
        (box?.x ?? 0) + (box?.width ?? 0),
        `${width}px 视口：不应被裁到右侧`,
      ).toBeLessThanOrEqual(width + 1);
    }
    // 页脚入口滚动后可达
    const help = page.getByRole("link", { name: "帮助" });
    await help.scrollIntoViewIfNeeded();
    await expect(help).toBeVisible();
  }
});

// ---------------------------------------------------------------------------
// 交付证据：桌面与手机实际截图（前端 §14.3：不以效果图替代实现截图）
// ---------------------------------------------------------------------------

test("U28 交付证据截图：桌面与手机两个视口的实际渲染", async ({ page }, testInfo) => {
  const viewport = testInfo.project.name === "mobile-chromium" ? "mobile" : "desktop";
  await page.goto("/");
  await page.screenshot({ path: testInfo.outputPath(`home-${viewport}.png`), fullPage: true });
  await page.goto("/help");
  await page.screenshot({ path: testInfo.outputPath(`help-${viewport}.png`), fullPage: true });
});
