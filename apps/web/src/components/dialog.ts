/**
 * 通用对话框控制（前端 v1.0 §11.2）：
 * - 打开后焦点移入弹窗；关闭后焦点恢复到触发元素；
 * - Tab / Shift+Tab 只在弹窗内循环；
 * - 打开期间背景容器设 inert，不可误操作；
 * - Esc 关闭。
 *
 * HTML 约定：触发按钮带 data-dialog-open="<弹窗 id>"；弹窗根元素带 hidden、
 * role="dialog"、aria-modal="true"；面板带 data-dialog-panel 与 tabindex="-1"；
 * 关闭动作（按钮/遮罩）带 data-dialog-close。
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

interface ActiveDialog {
  readonly root: HTMLElement;
  readonly panel: HTMLElement;
  readonly restoreTo: HTMLElement;
  readonly inerted: readonly HTMLElement[];
}

let active: ActiveDialog | null = null;

function focusableIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null,
  );
}

export function openDialog(root: HTMLElement, opener: HTMLElement): void {
  if (active) return;
  const panel = root.querySelector<HTMLElement>("[data-dialog-panel]") ?? root;
  const inerted = Array.from(document.body.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el !== root,
  );
  for (const el of inerted) {
    el.inert = true;
  }
  root.hidden = false;
  active = { root, panel, restoreTo: opener, inerted };
  (focusableIn(panel)[0] ?? panel).focus();
}

export function closeDialog(restoreFocus: boolean): void {
  if (!active) return;
  const { root, restoreTo, inerted } = active;
  root.hidden = true;
  for (const el of inerted) {
    el.inert = false;
  }
  active = null;
  if (restoreFocus) {
    restoreTo.focus();
  }
}

document.addEventListener("keydown", (event) => {
  if (!active) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeDialog(true);
    return;
  }
  if (event.key !== "Tab") return;
  const list = focusableIn(active.panel);
  if (list.length === 0) {
    event.preventDefault();
    active.panel.focus();
    return;
  }
  const currentIndex = list.indexOf(document.activeElement as HTMLElement);
  if (event.shiftKey && currentIndex <= 0) {
    event.preventDefault();
    list[list.length - 1].focus();
  } else if (!event.shiftKey && (currentIndex === -1 || currentIndex === list.length - 1)) {
    event.preventDefault();
    list[0].focus();
  }
});

for (const opener of document.querySelectorAll<HTMLButtonElement>("[data-dialog-open]")) {
  const root = document.getElementById(opener.dataset.dialogOpen ?? "");
  if (!(root instanceof HTMLElement)) continue;
  // 弹窗根提升到 body 层：openDialog 会给 body 直接子元素设 inert，
  // 弹窗若留在 <main> 插槽里会被自己所在的容器连带给禁掉。
  if (root.parentElement !== document.body) {
    document.body.appendChild(root);
  }
  opener.addEventListener("click", () => openDialog(root, opener));
}

for (const closer of document.querySelectorAll<HTMLElement>("[data-dialog-close]")) {
  closer.addEventListener("click", () => closeDialog(true));
}
