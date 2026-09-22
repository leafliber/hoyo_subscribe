/**
 * 折叠区含错误时自动展开并定位（前端 v1.0 §11.2）。
 * 基础开合用原生 details/summary（键盘可达，无需 JS）；
 * 本模块只补「校验失败 → 展开 → 焦点移到错误」的通用函数。
 */
export function expandAndFocusError(details: HTMLDetailsElement, error: HTMLElement): void {
  error.hidden = false;
  details.open = true;
  error.focus();
}

// /help 的基线演示接线：模拟校验失败触发自动展开与定位。
document.getElementById("demo-invalidate")?.addEventListener("click", () => {
  const details = document.getElementById("demo-collapse");
  const error = document.getElementById("demo-field-error");
  if (details instanceof HTMLDetailsElement && error instanceof HTMLElement) {
    expandAndFocusError(details, error);
  }
});
