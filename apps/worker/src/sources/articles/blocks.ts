// 文章版本内容构造：标题去噪、正文块保真切分、媒体引用与内容 hash（任务卡 P3-02，验收 ID A-P3-ARTICLE）。
//
// 合同依据：主方案 §3.2 后半——语义内容变化新增不可变 ArticleVersion，保存正文块、内容 hash、
// 官方 URL、发布时间、抓取时间、媒体引用及 completeness；去掉阅读量等噪声，
// **但不能去掉时间和阶段文本**。
//
// 保真边界（P0-02 实测，docs/evidence/p0/source-params.md §2.3）：
//   - 正文里的时间被官方包成 `&lt;t class="t_gl"&gt;2026/09/23 06:00&lt;/t&gt;` 转义标签。
//     正文块必须保留**原始 HTML 原文**（含转义标签），纯文本化会丢失官方的语义标记；
//     切分只按顶层块元素边界分段，不改写字节。
//   - zzz 的列表/正文 title 字段含 HTML 包装（P0-02 §2.5）——标题是**去噪**对象：剥离真实
//     标签、解码实体后入库；正文块不走这条路径。
//   - 版本内容是白名单构造（标题块 + 正文块 + 媒体引用 + 发布时间），来源载荷中的阅读量/
//     互动统计/提醒配置等易变噪声字段在采集边界已被适配器的字段选择排除，本层不引入。
//
// 媒体引用只有 URL 与位置，没有内容验证——**不声称可以发现同 URL 换图**（红线）。
// 首版不做视觉转录；图片是否承载关键日期由 completeness 判定交给人工核验（任务卡红线）。

import { sha256Hex } from "../snapshot-diff";

/** 版本内容块。html 块为顶层元素的原始 HTML 片段（保真）；text 块为顶层裸文本残片（保真兜底）。 */
export type ArticleBodyBlock =
  | { readonly kind: "title"; readonly text: string }
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "text"; readonly text: string };

/**
 * 媒体引用：仅 URL 与来源位置。刻意不含图片内容 hash/尺寸/任何内容级校验——
 * 引用图片只有 URL 没有内容验证时，不声称可以发现同 URL 换图（§3.2 红线）。
 */
export interface ArticleMediaRef {
  readonly url: string;
  /** body = 正文 <img>；cover = 列表封面图；list = 列表 image_list（正文通道不可用来源的图片级信息）。 */
  readonly origin: "body" | "cover" | "list";
}

// ---------- HTML 工具（无 DOM；只服务保真切分与文本判定，不做 HTML 规范解析） ----------

/** 真实标签剥离（只剥 `<...>`，不动实体——先剥后解码的顺序用于标题，实体在解码阶段处理）。 */
export function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
};

/** 常用命名实体与数字实体解码；未知实体原样保留（用于文本判定与标题去噪，不用于保真块）。 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    const named = NAMED_ENTITIES[body];
    return named ?? whole;
  });
}

/**
 * 标题去噪：剥离真实 HTML 标签（zzz 的 `<p style=…>` 包装，P0-02 §2.5）并解码实体。
 * 只动标签与实体，不删任何文字——版本号、日期、阶段词必须原样保留（§3.2 不得去掉时间和阶段文本）。
 * 先剥标签后解码：标题里的字面 `&lt;…&gt;` 解码后作为文本保留，不会被当成标签误删。
 */
export function denoiseTitle(rawTitle: string): string {
  return decodeHtmlEntities(stripHtmlTags(rawTitle)).trim();
}

/** 顶层块元素（含完整子树作为一个块）；void 标签与未知标签同样按独立块保真收留。 */
const TOP_LEVEL_ELEMENT_PATTERN = /^<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/;

/** HTML void 元素：没有闭标签，元素自身即完整片段（不找配对，避免吞掉后续内容）。 */
const VOID_ELEMENTS = new Set([
  "img",
  "br",
  "hr",
  "input",
  "wbr",
  "source",
  "embed",
  "track",
  "area",
  "base",
  "col",
  "link",
  "meta",
  "param",
]);

/**
 * 顶层块切分：按块级元素边界把正文 HTML 原文切成块，块间纯空白（布局噪声）丢弃，
 * 其余字节全部保留。不递归、不改写——`<details>` 含 `<summary>/<p>` 子树时整体为一块。
 * 找不到配对闭标签（上游截断的形态之一）时把余量整体收为一块：拿到什么保真什么，不猜测补全。
 */
export function splitBodyBlocks(contentHtml: string): ArticleBodyBlock[] {
  const blocks: ArticleBodyBlock[] = [];
  const html = contentHtml;
  const length = html.length;
  let index = 0;
  while (index < length) {
    while (index < length && /[ \t\r\n\f\v]/.test(html[index])) {
      index += 1;
    }
    if (index >= length) break;
    if (html[index] === "<") {
      const element = readTopLevelElement(html, index);
      blocks.push({ kind: "html", html: element.fragment });
      index = element.end;
    } else {
      const nextTag = html.indexOf("<", index);
      const textEnd = nextTag === -1 ? length : nextTag;
      const text = html.slice(index, textEnd);
      if (text.trim().length > 0) {
        blocks.push({ kind: "text", text: text.trim() });
      }
      index = textEnd;
    }
  }
  return blocks;
}

/**
 * 读取 index 处的顶层元素（含配对闭标签）原文。深度按同名标签计数（嵌套自包含）；
 * 属性值中的 `>` 依赖官方 HTML 的良构性（实测样本未见属性内 `>`），本模块不声称通用 HTML 解析。
 */
function readTopLevelElement(html: string, index: number): { fragment: string; end: number } {
  const rest = html.slice(index);
  // 注释 / DOCTYPE / CDATA：到 `>` 为止整体收留（保真，不解释）。
  if (rest.startsWith("<!") || rest.startsWith("<?")) {
    const close = rest.indexOf(">");
    const end = close === -1 ? html.length : index + close + 1;
    return { fragment: html.slice(index, end), end };
  }
  const match = TOP_LEVEL_ELEMENT_PATTERN.exec(rest);
  if (match === null) {
    // `<` 后不是元素名（如孤立的 `<`）：整段收留，保证重建不丢字节。
    const next = html.indexOf("<", index + 1);
    const end = next === -1 ? html.length : next;
    return { fragment: html.slice(index, end), end };
  }
  const tagName = match[1].toLowerCase();
  const selfClosing = match[3] === "/";
  const afterOpen = index + match[0].length;
  if (selfClosing || VOID_ELEMENTS.has(tagName)) {
    return { fragment: html.slice(index, afterOpen), end: afterOpen };
  }
  const openPattern = new RegExp(`<${tagName}(?=[\\s/>])[^>]*?(/?)>`, "gi");
  const closePattern = new RegExp(`</${tagName}\\s*>`, "gi");
  let depth = 1;
  let end = -1;
  let cursor = afterOpen;
  for (;;) {
    // 找下一个同名开/闭标签，取更靠前者处理（深度计数）。
    openPattern.lastIndex = cursor;
    closePattern.lastIndex = cursor;
    const nextOpen = openPattern.exec(html);
    const nextClose = closePattern.exec(html);
    if (nextClose === null) {
      // 无配对闭标签：余量整体收留（截断保真，不猜测）。
      return { fragment: html.slice(index), end: html.length };
    }
    if (nextOpen !== null && nextOpen.index < nextClose.index) {
      if (nextOpen[1] !== "/") {
        depth += 1;
      }
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      end = nextClose.index + nextClose[0].length;
      break;
    }
    cursor = nextClose.index + nextClose[0].length;
  }
  return { fragment: html.slice(index, end), end };
}

const IMG_SRC_PATTERN = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;

/** 从 html 块中提取 <img src> 引用（保真块的派生视图；顺序=正文出现顺序）。 */
export function extractImageRefsFromHtml(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(IMG_SRC_PATTERN)) {
    const url = match[1] ?? match[2] ?? match[3];
    if (typeof url === "string" && url.length > 0) {
      urls.push(url);
    }
  }
  return urls;
}

/**
 * 块的可读文本：先解码实体再剥标签——`&lt;t class="t_gl"&gt;…&lt;/t&gt;` 解码后成为
 * 真实标签被剥除，留下时间文本本身。此函数只用于"正文是否承载可读信息"的判定，不用于保存。
 */
export function blockVisibleText(block: ArticleBodyBlock): string {
  if (block.kind === "title") return block.text;
  if (block.kind === "text") return decodeHtmlEntities(block.text);
  return stripHtmlTags(decodeHtmlEntities(block.html));
}

/** 正文（不含标题块）是否承载任何可读文本。纯图片正文（如 genshin ann 21922 六周年福利速览）为 false。 */
export function bodyHasVisibleText(blocks: readonly ArticleBodyBlock[]): boolean {
  return blocks.some(
    (block) => block.kind !== "title" && /[^\s\u00a0]/.test(blockVisibleText(block)),
  );
}

// ---------- 内容 hash（语义指纹：噪声不触发新版本） ----------

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 版本内容 hash：canonical(blocks + mediaRefs)。标题块在 blocks 内——标题变化同样触发新版本。
 * 抓取时间、completeness、易变的易读统计一律不参与：同一语义内容重复抓取不产生新版本（噪声去噪的落点）。
 */
export async function articleContentHash(
  blocks: readonly ArticleBodyBlock[],
  mediaRefs: readonly ArticleMediaRef[],
): Promise<string> {
  return sha256Hex(canonicalJson({ blocks, mediaRefs }));
}

/** 去重合并媒体引用（保持出现顺序；同 URL 只保留首个 origin）。 */
export function mergeMediaRefs(
  ...groups: readonly (readonly ArticleMediaRef[])[]
): ArticleMediaRef[] {
  const seen = new Set<string>();
  const merged: ArticleMediaRef[] = [];
  for (const group of groups) {
    for (const ref of group) {
      if (ref.url.length === 0 || seen.has(ref.url)) continue;
      seen.add(ref.url);
      merged.push(ref);
    }
  }
  return merged;
}
