// P3-17（ADR-0009）· AI 草稿提示词。只含官方正文与固定说明：无用户数据、凭据、网络或写库能力。
// 模型输出的是中间形状（draft.ts 的 DraftOutput），由服务端确定性地转换并过统一候选校验。
import { GAME_NAMES } from "@hoyo/contracts";
import type { StoredArticleVersion } from "../article";
import { readableBlockText } from "./readable";

/** 提示词或中间形状变化时递增，进入 profile_ref，保证同一组合结果可追溯。 */
export const DRAFT_PROMPT_VERSION = "draft-prompt-v1";

export const DRAFT_SYSTEM_PROMPT = `你是「HoYo日历」的公告日程抽取助手。用户给出一篇米哈游官方游戏公告的正文，正文按块编号（[blocks/N]）。你的输出只是给人工审核用的草稿，审核员会逐条对照原文。

任务：找出公告里明确写出的游戏日程，只输出一个 JSON 对象，不要输出任何其他文字。

一、classification：
- "events"：至少有一个下列类型的日程，且时间都能从正文逐字找到。
- "no_event"：不含下列类型的日程（例如商店上新、问卷调研、周边、FAQ、优化与已知问题说明、防沉迷或运营声明、社区页面）。
- "uncertain"：有日程但存在无法确定的地方（时间互相矛盾、关键时间只在图片里等），在 ambiguities 里逐条写明原因。

二、event_type 只能是：
- "gacha"：祈愿、跃迁、调频等卡池
- "limited_event"：限时活动（含网页活动、限时任务奖励、限时双倍掉落、赛季玩法等有开始或结束时间的玩法）
- "maintenance"：版本更新维护
- "livestream"：前瞻特别节目直播

三、node_type 只能是：
"start" 开始；"end" 结束；"phase_unlock" 阶段解锁（如第二阶段开放）；"reward_deadline" 奖励领取截止；"expected_end" 预计结束（正文写明了预计结束的具体时刻才用）；"actual_end" 实际结束（只用于正文明确写"已于某时结束/完成"的公告）。

四、时间规则（最重要）：
1. time_text 必须从正文逐字复制，只写一个时间点，绝不写区间。例如 "2026/10/13 17:59"、"7.1版本更新后"、"7.1版本结束"。
2. 不换算时区，不补全年份，不推算。正文只写了持续时长（例如"预计5个小时完成"）时，不写对应的节点。
3. block 填 time_text 所在块的编号 N。
4. 正文写了"预计"的时间，estimated 填 true，否则填 false。
5. 正文没写的节点不要编造。一个时间段通常是 start 和 end 两个节点；同一事件里不要拿同一个时间点充当不同节点。
6. 一篇公告里有几个时间各不相同的活动或卡池，就输出几个事件。

五、其他字段：
- title：简短的事件名，直接用公告里的名称，例如 "「煦风欢舞时」祈愿"。
- status：默认 "scheduled"；正文明确写了延期才用 "postponed"，明确写了取消才用 "cancelled"，这两种情况在 status_quote 里逐字引用那句话；否则 status_quote 为 null。
- type_quote：逐字引用能说明事件类型的一小段原文及所在块。
- label：节点的简短说明，可为空字符串，例如 "第二阶段"。

输出格式（严格 JSON）：
{"classification":"events","ambiguities":[],"events":[{"event_type":"gacha","status":"scheduled","title":"…","type_quote":{"block":0,"quote":"…"},"status_quote":null,"milestones":[{"node_type":"start","label":"","block":4,"time_text":"7.1版本更新后","estimated":false},{"node_type":"end","label":"","block":4,"time_text":"2026/10/13 17:59","estimated":false}]}]}`;

/** 空块不进提示词但保留编号，模型引用的块号与保存的正文一致。 */
export function draftUserPrompt(article: StoredArticleVersion): string {
  const body = article.blocks
    .map((block, index) => ({ index, text: readableBlockText(block) }))
    .filter((item) => item.text.length > 0)
    .map((item) => `[blocks/${item.index}]\n${item.text}`)
    .join("\n");
  return `游戏：${GAME_NAMES[article.game]}（国服）\n正文：\n${body}\n\n只输出 JSON。/no_think`;
}

export function draftMessages(article: StoredArticleVersion) {
  return [
    { role: "system", content: DRAFT_SYSTEM_PROMPT },
    { role: "user", content: draftUserPrompt(article) },
  ] as const;
}
