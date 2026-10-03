import { type IconName, icon } from "./icons";

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;

/**
 * 轻量 DOM 构建器：所有外部字符串都作为文本节点或属性值写入，不使用 innerHTML。
 * 属性值为 false/null/undefined 时省略，true 时写空属性。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    element.setAttribute(key, value === true ? "" : String(value));
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: (Child | Child[])[]): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export { icon };

export type CalloutKind = "info" | "success" | "warning" | "danger";
const CALLOUT_ICON: Record<CalloutKind, IconName> = {
  info: "info",
  success: "check-circle",
  warning: "alert-triangle",
  danger: "alert-circle",
};

/** 提示条：标题可选，正文为一段或多段文字/节点。 */
export function callout(
  kind: CalloutKind,
  body: Child | Child[],
  options: { title?: string; className?: string; role?: string; attrs?: Attrs } = {},
): HTMLElement {
  return el(
    "div",
    {
      class: `callout callout--${kind}${options.className ? ` ${options.className}` : ""}`,
      role: options.role,
      ...options.attrs,
    },
    icon(CALLOUT_ICON[kind]),
    el(
      "div",
      { class: "callout-body" },
      options.title ? el("p", { class: "callout-title" }, options.title) : null,
      ...(Array.isArray(body) ? body : [body]).map((part) =>
        typeof part === "string" ? el("p", {}, part) : part,
      ),
    ),
  );
}

export type BadgeKind = "neutral" | "accent" | "success" | "warning" | "danger";
export function badge(text: string, kind: BadgeKind = "neutral", name?: IconName): HTMLElement {
  return el(
    "span",
    { class: kind === "neutral" ? "badge" : `badge badge--${kind}` },
    name ? icon(name) : null,
    text,
  );
}

export function statusPill(text: string, kind: BadgeKind = "neutral"): HTMLElement {
  return el(
    "span",
    { class: kind === "neutral" ? "status-pill" : `status-pill status-pill--${kind}` },
    text,
  );
}

export function emptyState(
  name: IconName,
  title: string,
  text: string | null,
  ...actions: Child[]
): HTMLElement {
  return el(
    "div",
    { class: "empty-state" },
    el("div", { class: "empty-icon" }, icon(name)),
    el("h3", {}, title),
    text ? el("p", {}, text) : null,
    actions.some(Boolean) ? el("div", { class: "button-row" }, ...actions) : null,
  );
}
