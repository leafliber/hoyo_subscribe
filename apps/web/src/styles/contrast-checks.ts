/**
 * U28 对比度声明表：列出站点实际使用的「前景/背景」token 组合。
 *
 * 约定：
 * - 颜色与透明度值一律来自 styles/tokens.css（这里只引用 token 名，不写字面量）。
 * - 半透明组合按合成后的实际颜色计算：背景先铺 base，再自底向顶叠加
 *   overlays；文字色按可选 alpha 合成到最终背景上，再算对比度。
 * - 若某组合达不到阈值：改用更小字号 / 更浅分隔线 / 折叠态；
 *   ★ 不要用"继续降低不透明度"来解决对比度不达标（半透明是视觉降权手段，
 *   不是降低可读性的许可）。
 * - 新增页面的颜色用法必须在这里登记组合，否则对比度测试不会覆盖它。
 */
import { CONTRAST_NORMAL_TEXT, CONTRAST_UI_COMPONENT } from "./color";

export interface ContrastOverlay {
  /** 叠层颜色 token 名（tokens.css）。 */
  readonly color: string;
  /** 叠层不透明度 token 名（tokens.css），取值 [0,1]。 */
  readonly alpha: string;
}

export interface ContrastCheck {
  /** 用途说明，出现在失败信息里。 */
  readonly use: string;
  /** 最低对比度阈值。 */
  readonly min: number;
  /** 文字色 token 名，可选不透明度 token 名。 */
  readonly text: { readonly color: string; readonly alpha?: string };
  /** 背景自底向顶：先 base，再逐层叠加 overlays。 */
  readonly background: { readonly base: string; readonly overlays?: readonly ContrastOverlay[] };
}

const onSurface = {
  background: { base: "--color-bg-surface" },
} as const;

const onPage = {
  background: { base: "--color-bg-page" },
} as const;

/** D1′「昨天」带背景：surface 上叠一层黑色减淡（--alpha-band-tint）。 */
const onBandTint = {
  background: {
    base: "--color-bg-surface",
    overlays: [{ color: "--color-tint-ink", alpha: "--alpha-band-tint" }],
  },
} as const;

export const CONTRAST_CHECKS: readonly ContrastCheck[] = [
  // —— 正文与次要文字 ——
  {
    use: "正文（surface 卡片/表单）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-text-primary" },
    ...onSurface,
  },
  {
    use: "正文（页面底）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-text-primary" },
    ...onPage,
  },
  {
    use: "次要文字（surface）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-text-secondary" },
    ...onSurface,
  },
  {
    use: "次要文字（页面底，页脚说明）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-text-secondary" },
    ...onPage,
  },
  {
    use: "14px 辅助文字（surface，字号不足大字口径）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-text-aux" },
    ...onSurface,
  },
  {
    use: "14px 辅助文字（页面底）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-text-aux" },
    ...onPage,
  },
  // —— 强调色（链接 / 主按钮）——
  {
    use: "链接/强调（surface）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-accent" },
    ...onSurface,
  },
  {
    use: "链接/强调（页面底，页脚链接）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-accent" },
    ...onPage,
  },
  {
    use: "主按钮文字 on 强调色",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-on-accent" },
    background: { base: "--color-accent" },
  },
  {
    use: "主按钮文字 on 强调色悬停态",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-on-accent" },
    background: { base: "--color-accent-strong" },
  },
  // —— 状态色（均配文字说明，颜色不是唯一载体）——
  {
    use: "成功文字（surface）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-success" },
    ...onSurface,
  },
  {
    use: "警告文字（surface）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-warning" },
    ...onSurface,
  },
  {
    use: "错误文字（surface，字段错误）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-danger" },
    ...onSurface,
  },
  {
    use: "错误文字（页面底，全站故障横幅）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-danger" },
    ...onPage,
  },
  // —— 焦点环（非文字界面组件）——
  {
    use: "焦点环（surface）",
    min: CONTRAST_UI_COMPONENT,
    text: { color: "--color-focus-ring" },
    ...onSurface,
  },
  {
    use: "焦点环（页面底）",
    min: CONTRAST_UI_COMPONENT,
    text: { color: "--color-focus-ring" },
    ...onPage,
  },
  // —— D1′「昨天」带：背景叠减淡层后，文字按合成背景测 ——
  {
    use: "昨天带：正文文字 on 带背景（合成）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-text-primary" },
    ...onBandTint,
  },
  {
    use: "昨天带：次要文字 on 带背景（合成）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-text-secondary" },
    ...onBandTint,
  },
  // —— 半透明降权文字：对合成后的实际颜色测 ——
  {
    use: "降权文字（合成，surface 上）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-text-primary", alpha: "--alpha-deemphasized-text" },
    ...onSurface,
  },
  {
    use: "降权文字（合成，页面底上）",
    min: CONTRAST_NORMAL_TEXT,
    text: { color: "--color-text-primary", alpha: "--alpha-deemphasized-text" },
    ...onPage,
  },
];
