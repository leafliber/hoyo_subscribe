// ADR-0030 · 把一次直播活动快照写成可核对的正文版本，并按同一格式读回（规则模板与审核页都看这份正文）。
//
// 官方接口给的是结构化字段，不是公告正文：标题、每个兑换码的发放时刻（to_get_time）、奖励说明与兑换码说明。
// 本站把它们逐行写成 <p>（文本先转义），时间写成"YYYY/MM/DD HH:MM"（北京时间，与公告已核验的写法同形），
// 这样证据引用、时间校验与原文弹窗都沿用公告的流程。写法固定，读回时逐行严格匹配，不认的行不参与。
//
// ADR-0034：只写已发放的兑换码（官方预告了发放时刻、码还是空的条目不写——它的时刻在真正发放时可能被
// 官方改掉，写进去就会在日历上产生一次改期）；曾经发放过的兑换码即使后来从官方列表消失也保留。
// 管理员照官方说明登记了截止时间时，另写一行"有效期至：…（本站依据官方说明登记）"。
// 旧版本正文里的"待发放"行照常读回（只是不再写）。
import { browseTimestamp } from "@hoyo/contracts";
import { type ArticleBodyBlock, decodeHtmlEntities } from "../articles/blocks";

const PENDING = "待发放";
const CODE_LINE =
  /^发放时间：(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}(?::\d{2})?)｜兑换码：([A-Za-z0-9_-]{1,64}|待发放)｜奖励：(.*)$/s;
const TIP_LINE = /^兑换码说明：(.+)$/s;
const MANUAL_EXPIRY_NOTE = "（本站依据官方说明登记）";
const EXPIRY_LINE =
  /^有效期至：(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}(?::\d{2})?)（本站依据官方说明登记）$/;

/** 写进正文的一个已发放兑换码。 */
export interface RevealedLiveCode {
  readonly code: string;
  /** 奖励说明（纯文本）。 */
  readonly reward: string;
  /** 官方发放时刻 to_get_time（UTC 毫秒）。 */
  readonly revealAtMs: number;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 北京时间"YYYY/MM/DD HH:MM(:SS)"；秒为 0 时省略（同公告写法）。 */
export function liveRevealExpression(utcMs: number): string {
  const minute = browseTimestamp(utcMs).replace(/-/g, "/");
  const seconds = Math.floor(utcMs / 1000) % 60;
  return seconds === 0 ? minute : `${minute}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 正文 HTML：每个已发放的兑换码一行（按发放时刻），然后是官方兑换码说明，最后是管理员照官方说明登记的
 * 截止时间（ADR-0034，写法"YYYY/MM/DD HH:MM(:SS)"）。标题另作标题块。
 */
export function liveArticleHtml(
  codes: readonly RevealedLiveCode[],
  tip: string | null,
  manualExpiry: string | null = null,
): string {
  const lines = codes.map(
    (code) =>
      `发放时间：${liveRevealExpression(code.revealAtMs)}｜兑换码：${code.code}｜奖励：${code.reward}`,
  );
  if (tip !== null) lines.push(`兑换码说明：${tip}`);
  if (manualExpiry !== null) lines.push(`有效期至：${manualExpiry}${MANUAL_EXPIRY_NOTE}`);
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

export interface LiveArticleCode {
  readonly blockIndex: number;
  /** 原文里的发放时刻写法（证据引用）。 */
  readonly revealExpression: string;
  readonly code: string | null;
  readonly reward: string;
}

export interface LiveArticle {
  readonly title: string;
  readonly codes: readonly LiveArticleCode[];
  readonly tip: { readonly blockIndex: number; readonly text: string } | null;
  /** ADR-0034：管理员照官方说明登记的截止时间（原文写法）；没有为 null。 */
  readonly manualExpiry: { readonly blockIndex: number; readonly expression: string } | null;
}

/** 按 liveArticleHtml 的写法读回；第一块是标题块。认不出的行不参与。 */
export function readLiveArticle(blocks: readonly ArticleBodyBlock[]): LiveArticle | null {
  const first = blocks[0];
  if (first?.kind !== "title" || first.text === "") return null;
  const codes: LiveArticleCode[] = [];
  let tip: LiveArticle["tip"] = null;
  let manualExpiry: LiveArticle["manualExpiry"] = null;
  blocks.forEach((block, blockIndex) => {
    if (blockIndex === 0 || block.kind !== "html") return;
    // 先去掉本站写的 <p> 标签再解码：转义过的文字里的"<…>"是原文，不能当标签剥掉。
    const text = decodeHtmlEntities(block.html.replace(/<[^>]*>/g, ""));
    const line = CODE_LINE.exec(text);
    if (line !== null) {
      codes.push({
        blockIndex,
        revealExpression: line[1],
        code: line[2] === PENDING ? null : line[2],
        reward: line[3],
      });
      return;
    }
    const expiry = EXPIRY_LINE.exec(text);
    if (expiry !== null) {
      if (manualExpiry === null) manualExpiry = { blockIndex, expression: expiry[1] };
      return;
    }
    const note = TIP_LINE.exec(text);
    if (note !== null && tip === null) tip = { blockIndex, text: note[1] };
  });
  return { title: first.text, codes, tip, manualExpiry };
}
