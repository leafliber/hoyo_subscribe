/**
 * 全局状态播报区（前端 v1.0 §11.2：加载、保存和失败可被辅助技术获知）。
 * _Layout.astro 的 #global-status 带 role="status"（aria-live=polite）。
 * 关键结果不依赖短暂 Toast：消息保留在区域内，直到被下一次播报替换。
 */
export type StatusKind = "info" | "success" | "warning" | "error";

export function announce(message: string, kind: StatusKind = "info"): void {
  const region = document.getElementById("global-status");
  if (!(region instanceof HTMLElement)) return;
  region.dataset.kind = kind;
  region.textContent = message;
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-announce-demo]")) {
  button.addEventListener("click", () => {
    announce("示例：这条状态消息会被辅助技术播报", "info");
  });
}
