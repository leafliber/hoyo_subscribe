import { type PublicArticleBlock, unwrapOfficialTimeTags } from "@hoyo/contracts";
import { el, icon } from "../../lib/dom";

// P3-22（ADR-0014）：把官方公告正文块整理成便于阅读的文字（前端 §5：受控文本结构，按数据转义）。
// html 块只交给 DOMParser 惰性解析：解析出的文档没有浏览上下文，不执行脚本、不加载图片。
// 解析出的节点从不进入页面；这里只读文字和少数校验过的属性，按白名单重建为本站元素。
// 段落、标题、列表、表格、折叠段保留结构；颜色、字号等样式全部丢弃；图片只给链接，不自动加载。

/** 整段跳过：脚本、样式、嵌入内容、表单控件和表格列宽。 */
const SKIP = new Set([
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "NOSCRIPT",
  "IFRAME",
  "FRAME",
  "OBJECT",
  "EMBED",
  "SVG",
  "MATH",
  "CANVAS",
  "VIDEO",
  "AUDIO",
  "SOURCE",
  "TRACK",
  "LINK",
  "META",
  "TITLE",
  "HEAD",
  "BASE",
  "FORM",
  "INPUT",
  "BUTTON",
  "SELECT",
  "TEXTAREA",
  "COLGROUP",
  "COL",
  "MAP",
  "AREA",
]);
/** 弹窗标题是 h2、公告名是 h3，正文标题降两级。 */
const HEADINGS: Record<string, "h4" | "h5"> = {
  H1: "h4",
  H2: "h4",
  H3: "h5",
  H4: "h5",
  H5: "h5",
  H6: "h5",
};
/** 只起分段作用的块级容器：本身不保留，里面的行内内容另起一段。 */
const BLOCKS = new Set([
  "BODY",
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "MAIN",
  "ASIDE",
  "NAV",
  "CENTER",
  "FIGURE",
  "FIGCAPTION",
  "ADDRESS",
  "BLOCKQUOTE",
  "PRE",
  "DL",
  "DT",
  "DD",
  "FIELDSET",
  "LEGEND",
  "HGROUP",
  "SUMMARY",
]);
/** 行内上下文里遇到块级元素时只换行，不再嵌套结构。 */
const LINE_BREAKING = new Set([
  ...BLOCKS,
  ...Object.keys(HEADINGS),
  "UL",
  "OL",
  "LI",
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "TR",
  "TD",
  "TH",
  "CAPTION",
  "DETAILS",
  "HR",
]);

const hasText = (node: Node) => (node.textContent ?? "").trim() !== "";
const isBlank = (node: Node | null) =>
  node !== null && (node.nodeName === "BR" || (node.nodeType === Node.TEXT_NODE && !hasText(node)));

/** 去掉首尾的空行与空白；返回是否还有文字。 */
function tidy(element: HTMLElement): boolean {
  while (isBlank(element.lastChild)) element.lastChild?.remove();
  while (isBlank(element.firstChild)) element.firstChild?.remove();
  return hasText(element);
}

/** 文字节点：官方转义的 <t> 时间标签只留时间（与审核页可读文本同一定义）。 */
function text(value: string): Text {
  return document.createTextNode(unwrapOfficialTimeTags(value));
}

/** 游戏内链接写成 javascript:miHoYoGameJSSDK.openInBrowser('https://…')；只取其中的网址。 */
const GAME_SDK_LINK =
  /^javascript:\s*miHoYoGameJSSDK\.openIn(?:Browser|Webview)\(\s*(['"])(.+?)\1\s*\)\s*;?\s*$/i;
/** 只接受 http/https 绝对地址；其余（含 javascript:、相对地址）一律不做成链接。 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(GAME_SDK_LINK.exec(value)?.[2] ?? value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
/** 外链在新标签打开，不带来源页信息。 */
export const external = (href: string, className?: string) => ({
  href,
  target: "_blank",
  rel: "noopener noreferrer",
  referrerpolicy: "no-referrer",
  class: className,
});

/** 流式容器：行内内容收进当前段落，遇到块级内容另起一段；官方用作间距的空段落丢弃。 */
class Flow {
  private paragraph: HTMLParagraphElement | null = null;
  constructor(private readonly target: HTMLElement) {}

  inline(node: Node) {
    if (!this.paragraph) {
      if (node.nodeType === Node.TEXT_NODE && !hasText(node)) return;
      this.paragraph = el("p");
      this.target.append(this.paragraph);
    }
    this.paragraph.append(node);
  }

  lineBreak() {
    this.paragraph?.append(el("br"));
  }

  block(node: HTMLElement | null) {
    this.close();
    if (node) this.target.append(node);
  }

  close() {
    if (this.paragraph && !tidy(this.paragraph)) this.paragraph.remove();
    this.paragraph = null;
  }
}

function walkFlow(source: Node, flow: Flow) {
  for (const child of source.childNodes) flowNode(child, flow);
}

function flowNode(node: Node, flow: Flow) {
  if (node.nodeType === Node.TEXT_NODE) return flow.inline(text(node.textContent ?? ""));
  if (!(node instanceof Element) || SKIP.has(node.tagName)) return;
  const tag = node.tagName;
  if (tag === "BR") return flow.lineBreak();
  if (tag === "HR") return flow.block(el("hr"));
  const heading = HEADINGS[tag];
  if (heading) {
    const out = el(heading);
    walkInline(node, out);
    return flow.block(tidy(out) ? out : null);
  }
  if (tag === "UL" || tag === "OL") return flow.block(list(node));
  if (tag === "TABLE") return flow.block(table(node));
  if (tag === "DETAILS") return flow.block(details(node));
  if (BLOCKS.has(tag)) {
    flow.close();
    walkFlow(node, flow);
    return flow.close();
  }
  flow.inline(inlineElement(node));
}

function walkInline(source: Node, target: ParentNode) {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.append(text(child.textContent ?? ""));
      continue;
    }
    if (!(child instanceof Element) || SKIP.has(child.tagName)) continue;
    if (child.tagName === "BR") target.append(el("br"));
    else if (LINE_BREAKING.has(child.tagName)) {
      if (hasText(target as Node)) target.append(el("br"));
      walkInline(child, target);
    } else target.append(inlineElement(child));
  }
}

function inlineElement(node: Element): Node {
  const tag = node.tagName;
  if (tag === "IMG") {
    const href = safeExternalUrl(node.getAttribute("src"));
    return href
      ? el("a", external(href, "article-image"), icon("image"), "查看图片")
      : el("span", { class: "article-image" }, "［图片］");
  }
  if (tag === "A") {
    const href = safeExternalUrl(node.getAttribute("href"));
    if (!href) {
      const plain = document.createDocumentFragment();
      walkInline(node, plain);
      return plain;
    }
    const link = el("a", external(href, "article-link"));
    walkInline(node, link);
    // 链接里的图片不再嵌套链接，只留文字。
    for (const nested of link.querySelectorAll("a")) nested.replaceWith(...nested.childNodes);
    if (!tidy(link)) link.append("打开链接");
    link.append(icon("external-link"));
    return link;
  }
  const wrapper =
    tag === "STRONG" || tag === "B"
      ? el("strong")
      : tag === "EM" || tag === "I"
        ? el("em")
        : document.createDocumentFragment();
  walkInline(node, wrapper);
  return wrapper;
}

function list(source: Element): HTMLElement | null {
  const ordered = source.tagName === "OL";
  const out = el(ordered ? "ol" : "ul");
  const start = Number(source.getAttribute("start"));
  if (ordered && Number.isInteger(start) && start !== 1) out.setAttribute("start", String(start));
  for (const child of source.childNodes) {
    const item = el("li");
    const flow = new Flow(item);
    if (child instanceof Element && child.tagName === "LI") walkFlow(child, flow);
    else flowNode(child, flow);
    flow.close();
    if (hasText(item)) out.append(item);
  }
  return out.children.length ? out : null;
}

function table(source: Element): HTMLElement | null {
  const out = el("table");
  const caption = source.querySelector(":scope > caption");
  if (caption) {
    const label = el("caption");
    walkInline(caption, label);
    if (tidy(label)) out.append(label);
  }
  const body = el("tbody");
  for (const row of source.querySelectorAll(
    ":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr",
  )) {
    const tr = el("tr");
    for (const cell of row.children) {
      if (cell.tagName !== "TD" && cell.tagName !== "TH") continue;
      const td = el(cell.tagName === "TH" ? "th" : "td");
      for (const name of ["colspan", "rowspan"]) {
        const span = Number(cell.getAttribute(name));
        if (Number.isInteger(span) && span > 1) td.setAttribute(name, String(span));
      }
      const flow = new Flow(td);
      walkFlow(cell, flow);
      flow.close();
      tr.append(td);
    }
    if (tr.children.length) body.append(tr);
  }
  if (!body.children.length) return null;
  out.append(body);
  return el("div", { class: "article-table" }, out);
}

/** 官方折叠段保留折叠，展开状态照原文（原文默认展开的仍展开）。 */
function details(source: Element): HTMLElement | null {
  const summary = el("summary");
  const body = el("div", { class: "article-details-body" });
  const flow = new Flow(body);
  for (const child of source.childNodes) {
    if (child instanceof Element && child.tagName === "SUMMARY") walkInline(child, summary);
    else flowNode(child, flow);
  }
  flow.close();
  const titled = tidy(summary);
  if (!titled && !hasText(body)) return null;
  return el(
    "details",
    { class: "disclosure", open: source.hasAttribute("open") },
    titled ? summary : el("summary", {}, "展开内容"),
    body,
  );
}

/** 公告名（标题块）；没有时为 null。 */
export function articleTitle(blocks: readonly PublicArticleBlock[]): string | null {
  for (const block of blocks) if (block.kind === "title" && block.text.trim()) return block.text;
  return null;
}

/** 正文块 → 可读的本站元素（标题块由弹窗单独显示）。text 块是原文顶层的裸文字，同样按 HTML 解码。 */
export function renderArticleBody(blocks: readonly PublicArticleBlock[]): HTMLElement {
  const content = el("div", { class: "article-content" });
  const flow = new Flow(content);
  const parser = new DOMParser();
  for (const block of blocks) {
    if (block.kind === "title") continue;
    const doc = parser.parseFromString(
      block.kind === "html" ? block.html : block.text,
      "text/html",
    );
    flow.close();
    walkFlow(doc.body, flow);
  }
  flow.close();
  return content;
}
