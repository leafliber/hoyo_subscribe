// P3-17（ADR-0009）· 把保真正文块转成给人和模型读的纯文本。
// 只用于审核页展示与模型提示词；证据校验仍以保存的原始块为准（extraction/article.ts）。
import { unwrapOfficialTimeTags } from "@hoyo/contracts";
import { type ArticleBodyBlock, decodeHtmlEntities } from "../../sources/articles/blocks";

const BLOCK_BREAK =
  /<\/(?:p|div|li|tr|h[1-6]|table|thead|tbody|ul|ol|section|blockquote|details|summary)\s*>|<br\s*\/?>/gi;
const TABLE_CELL = /<t([dh])\b[^>]*>([\s\S]*?)<\/t\1\s*>/gi;
const REAL_TAG = /<[^>]*>/g;

function normalize(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t\r\f\v 　]+/g, " ")
        .replace(/^\s*\|\s*/, "")
        .replace(/\s*\|\s*$/, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join("\n");
}

/** 块级结束标签换行；表格一行一行、单元格以「 | 」分隔；官方转义的 <t> 时间标签只保留时间文本。 */
export function readableBlockText(block: ArticleBodyBlock): string {
  if (block.kind === "title") return normalize(block.text);
  if (block.kind === "text") return normalize(decodeHtmlEntities(block.text));
  const marked = block.html
    .replace(TABLE_CELL, (_whole, _kind, inner: string) => ` ${inner.replace(BLOCK_BREAK, " ")} |`)
    .replace(BLOCK_BREAK, "\n");
  // 先剥真实标签再解码：转义的 <t> 标签此时才变成字面文本，随后只留其中的时间。
  return normalize(unwrapOfficialTimeTags(decodeHtmlEntities(marked.replace(REAL_TAG, ""))));
}
