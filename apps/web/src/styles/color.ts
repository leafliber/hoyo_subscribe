/**
 * 颜色数学工具（纯函数，无 DOM 依赖）：浏览器代码与 U28 对比度测试共用。
 *
 * 半透明降权的正确测法（F1-01 交付、F1-02「昨天」带消费）：
 * 对「合成后的实际颜色」计算对比度，不是对原色测——
 * 先 compositeOver(foreground, alpha, background) 得到不透明合成色，
 * 再 contrastRatio(合成色, background)。
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** 正文文字（<18.66px 粗体 / <24px 常规）的对比度阈值。 */
export const CONTRAST_NORMAL_TEXT = 4.5;
/** 大字号文字（≥18.66px 粗体或 ≥24px 常规）的对比度阈值。 */
export const CONTRAST_LARGE_TEXT = 3;
/** 非文字界面组件（焦点环、图标、输入边框等）的对比度阈值。 */
export const CONTRAST_UI_COMPONENT = 3;

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** 解析 #rgb 或 #rrggbb；其余格式抛错（token 文件只允许这两种 + tokens.css 内的 rgb()）。 */
export function parseHexColor(hex: string): Rgb {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    throw new Error(`parseHexColor: 不支持的颜色格式：${hex}`);
  }
  const digits = match[1];
  if (digits.length === 3) {
    return {
      r: Number.parseInt(`${digits[0]}${digits[0]}`, 16),
      g: Number.parseInt(`${digits[1]}${digits[1]}`, 16),
      b: Number.parseInt(`${digits[2]}${digits[2]}`, 16),
    };
  }
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

export function toHex(color: Rgb): string {
  const part = (v: number) => clampByte(v).toString(16).padStart(2, "0");
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/** 半透明前景按 alpha 叠加在不透明背景上，返回合成后的实际颜色。 */
export function compositeOver(foreground: Rgb, alpha: number, background: Rgb): Rgb {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new Error(`compositeOver: alpha 必须在 [0,1]，收到 ${alpha}`);
  }
  const mix = (fg: number, bg: number) => clampByte(fg * alpha + bg * (1 - alpha));
  return {
    r: mix(foreground.r, background.r),
    g: mix(foreground.g, background.g),
    b: mix(foreground.b, background.b),
  };
}

function linearizeChannel(value255: number): number {
  const c = value255 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 相对亮度。 */
export function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * linearizeChannel(color.r) +
    0.7152 * linearizeChannel(color.g) +
    0.0722 * linearizeChannel(color.b)
  );
}

/** WCAG 对比度，取值 [1, 21]。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
