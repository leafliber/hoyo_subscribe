# F1-01 · U28 交付证据截图（E2 受控观测）

- 获取方式：`pnpm test:e2e`（Playwright 1.63.0，`tests/e2e/a11y.spec.ts` 的
  「U28 交付证据截图」用例，fullPage 截图，由用例自动落盘后复制到本目录）。
- 环境：本机 macOS（darwin 25.6.0 arm64）、Node 26.8.1、astro preview 静态服务
  （127.0.0.1:4173）、bundled Chromium（playwright chromium v1243）。
- 时间：2026-09-22 20:07（本地时区）。

| 文件 | 视口 | 页面 |
| --- | --- | --- |
| home-desktop.png | Desktop Chrome 1280×720 | / （日程骨架） |
| help-desktop.png | Desktop Chrome 1280×720 | /help（含可访问性基线示例区） |
| home-mobile.png | Pixel 7 412×915 | / |
| help-mobile.png | Pixel 7 412×915 | /help |

说明：截图来自实际构建产物的真实渲染，不是效果图（前端 v1.0 §14.3）。
