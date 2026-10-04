import { el, icon } from "./dom";

/**
 * 轻提示：只用于「已复制」「已下载」这类即时确认；关键结果仍在页面里持久呈现。
 * 提示区带 role="status"，可被读屏获知。
 */
export function toast(message: string, options: { duration?: number } = {}): void {
  let region = document.getElementById("toast-region");
  if (!region) {
    region = el("div", {
      id: "toast-region",
      class: "toast-region",
      role: "status",
      "aria-live": "polite",
    });
    document.body.append(region);
  }
  const item = el("div", { class: "toast" }, icon("check-circle"), message);
  region.append(item);
  setTimeout(() => item.remove(), options.duration ?? 3200);
}

/** 复制文本；失败时返回 false，由调用方提供可手动选择的文本。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
