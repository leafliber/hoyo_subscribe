/** 复制失败时在原操作旁显示可手动选中的文本，且不宣称复制成功。 */
export function showManualCopy(host: HTMLElement, text: string): HTMLTextAreaElement {
  host.replaceChildren();
  const label = document.createElement("label");
  label.textContent = "复制失败，请手动选择并复制下方文本";
  const field = document.createElement("textarea");
  field.readOnly = true;
  field.rows = 3;
  field.value = text;
  field.setAttribute("aria-label", "可手动复制的文本");
  field.addEventListener("focus", () => field.select());
  label.append(field);
  host.append(label);
  host.dataset.copyState = "manual";
  field.focus();
  field.select();
  return field;
}

export async function copyWithFallback(host: HTMLElement, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    host.replaceChildren();
    host.textContent = "已复制";
    host.dataset.copyState = "copied";
    return true;
  } catch {
    showManualCopy(host, text);
    return false;
  }
}

/** 供跨组件复制控件使用；事件在控件自己的反馈容器上发出。 */
export function initCopyFallback(): void {
  document.addEventListener("hoyo:copy-request", (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (
      event.target instanceof HTMLElement &&
      typeof detail === "object" &&
      detail !== null &&
      "text" in detail &&
      typeof detail.text === "string"
    ) {
      void copyWithFallback(event.target, detail.text);
    }
  });
}
