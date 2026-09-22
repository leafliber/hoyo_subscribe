// P0-02 证据生成器（离线，无网络）：从 fixtures/sources/ 的真实样本生成
// docs/evidence/p0/list-display-time-vs-event-time.md ——
// "列表展示时间 ≠ 活动时间"实证对照（任务卡要求至少三例），并汇总
// 含图片承载日期 / 跨年 / 纯日期 / 结束包含性歧义样本的取得情况。
// 本脚本是证据工具，不是主方案 §3.4 的抽取实现（不在本卡范围）。
// 运行：node scripts/probes/source-samples/analyze-time.mjs

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findAbsoluteDatetimes,
  findDateOnly,
  findDateRanges,
  findRelativeStartRanges,
  stripHtml,
} from "./collect-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const FIXTURES = path.join(REPO_ROOT, "fixtures", "sources");
const OUT = path.join(REPO_ROOT, "docs", "evidence", "p0", "list-display-time-vs-event-time.md");

const ANN_SOURCES = ["genshin-ann", "hsr-ann", "zzz-ann"];

function cleanTitle(t) {
  return String(t ?? "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

async function loadAnnContents(sourceId) {
  const index = JSON.parse(await readFile(path.join(FIXTURES, sourceId, "index.json"), "utf8"));
  const out = [];
  for (const c of index.contents ?? []) {
    if (!c.ann_id) continue;
    const sample = JSON.parse(
      await readFile(path.join(FIXTURES, sourceId, `content-${c.ann_id}.json`), "utf8"),
    );
    const item = (sample.body?.data?.list ?? []).find((x) => String(x.ann_id) === String(c.ann_id));
    if (!item) continue;
    const raw = String(item.content ?? "");
    out.push({
      sourceId,
      annId: c.ann_id,
      title: cleanTitle(item.title ?? c.title),
      // start_time 是列表字段；正文条目不含它，从采集时记下的列表对照取
      listStartTime: c.list_start_time ?? item.start_time,
      listEndTime: c.list_end_time ?? item.end_time,
      capturedAt: sample.captured_at_utc,
      text: stripHtml(raw),
      ranges: findDateRanges(stripHtml(raw)),
      relRanges: findRelativeStartRanges(stripHtml(raw)),
      absDatetimes: findAbsoluteDatetimes(stripHtml(raw)),
      dateOnly: findDateOnly(stripHtml(raw)),
      imageCount: (raw.match(/<img\b/gi) ?? []).length,
    });
  }
  return out;
}

/** 把 "2026/09/23 06:00" / "2026-09-21 11:10:00" 解析为 UTC+8 的 epoch 毫秒（证据对照用）。 */
function parseCnDatetime(s) {
  const m = String(s).match(
    /(\d{4})[/年.-](\d{1,2})[/月.-](\d{1,2})日?(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, se = 0] = m.slice(1).map((x) => Number(x ?? 0));
  return Date.UTC(y, mo - 1, d, h - 8, mi, se);
}

function endPrecision(end) {
  if (!end) return "—";
  if (/\d{1,2}:\d{2}:\d{2}$/.test(end)) return "到秒";
  if (/\d{1,2}:\d{2}$/.test(end)) return "到分（秒位缺失，结束包含性歧义）";
  return "无时刻（纯日期）";
}

function trimRelStart(s) {
  const parts = String(s)
    .split(/[）】]/)
    .filter(Boolean);
  return (parts[parts.length - 1] ?? String(s)).trim();
}

function fmtDur(ms) {
  const hours = ms / 3_600_000;
  if (Math.abs(hours) >= 48) return `${(hours / 24).toFixed(1)} 天`;
  return `${hours.toFixed(1)} 小时`;
}

async function main() {
  const _sections = [];
  const cases = [];
  for (const id of ANN_SOURCES) {
    cases.push(...(await loadAnnContents(id)));
  }

  // ---- 对照例：列表展示窗口开始 vs 正文陈述的活动时间 ----
  const rows = [];
  for (const c of cases) {
    const listMs = parseCnDatetime(c.listStartTime);
    const eventStart = c.ranges[0]?.start ?? null;
    const eventStartMs = eventStart ? parseCnDatetime(eventStart) : null;
    const relStart = c.relRanges[0]?.relative_start ?? null;
    if (!listMs) continue;
    if (eventStartMs !== null) {
      rows.push({
        source: c.sourceId,
        annId: c.annId,
        title: c.title,
        listStart: c.listStartTime,
        eventStart,
        deltaMs: eventStartMs - listMs,
        kind: c.ranges[0] ? "正文绝对区间" : "正文绝对时间点",
        rangeEnd: c.ranges[0]?.end ?? null,
        endHasTime: c.ranges[0]?.end_has_time ?? null,
        capturedAt: c.capturedAt,
      });
    } else if (relStart) {
      // 表格版式会把表头文字带进相对起点，取最后一个右括号/表头之后的核心短语
      rows.push({
        source: c.sourceId,
        annId: c.annId,
        title: c.title,
        listStart: c.listStartTime,
        eventStart: trimRelStart(relStart),
        deltaMs: null,
        kind: "正文相对起点（版本更新后）",
        rangeEnd: c.relRanges[0]?.end ?? null,
        endHasTime: /\d{1,2}:\d{2}/.test(c.relRanges[0]?.end ?? "") || null,
        capturedAt: c.capturedAt,
      });
    }
  }

  // 米游社：祈愿帖 created_at vs 同期祈愿实际开始（genshin 21876 正文：7.1版本更新后 ~ 2026/10/13）
  const miyousheList = JSON.parse(
    await readFile(path.join(FIXTURES, "miyoushe-news", "news-list-type1-page1.json"), "utf8"),
  );
  const miyousheItems = miyousheList?.body?.data?.list ?? [];
  const miyousheCases = [];
  for (const it of miyousheItems.slice(0, 3)) {
    const post = it?.post;
    if (!post?.post_id) continue;
    miyousheCases.push({
      postId: post.post_id,
      subject: post.subject,
      createdAtUtcMs: (Number(post.created_at) || 0) * 1000,
      capturedAt: miyousheList.captured_at_utc,
      images: (post.images ?? []).length,
      contentPreviewLength: String(post.content ?? "").length,
    });
  }

  // ---- 歧义样本汇总 ----
  const imageDateSamples = cases.filter(
    (c) => c.imageCount > 0 && c.ranges.length === 0 && c.text.length < 400,
  );
  const crossYear = cases.filter((c) => c.ranges.some((r) => r.cross_year));
  const dateOnlySamples = cases.filter((c) => c.dateOnly.length > 0);
  const endInclusivity = cases.filter((c) =>
    c.ranges.some(
      (r) =>
        (/59$/.test(r.end) && !/:\d{2}$/.test(r.end.replace(/.*\s/, ""))) ||
        r.end.endsWith("23:59") ||
        r.end.endsWith("17:59") ||
        r.end.endsWith("03:59"),
    ),
  );
  const noTimeText = cases.filter(
    (c) =>
      !c.ranges.length &&
      !c.relRanges.length &&
      !c.absDatetimes.length &&
      !c.dateOnly.length &&
      c.text.length > 0,
  );

  const md = [];
  md.push("# 列表展示时间 ≠ 活动时间：实证对照（P0-02）");
  md.push("");
  md.push(
    "> 依据：主方案 §3.1「后三项的列表/正文方法为 getAnnList/getAnnContent，不得把列表展示时间当成活动时间」。",
  );
  md.push(
    "> 数据来源：`fixtures/sources/` 真实样本（`synthetic:false`），抓取时间见各文件 `captured_at_utc`。",
  );
  md.push("> 时间解析：列表 `start_time` 与正文时间均按公告 API `timezone=8`（UTC+8）换算。");
  md.push(
    "> 本文档由 `node scripts/probes/source-samples/analyze-time.mjs` 离线生成，不访问网络。",
  );
  md.push("");
  md.push("## 一、对照例（公告 API）");
  md.push("");
  md.push(
    "| # | 来源 | ann_id | 标题（截断） | 列表 start_time（展示窗口开始） | 正文活动开始 | 差值 | 区间终点 | 终点秒位 |",
  );
  md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  rows.slice(0, 12).forEach((r, i) => {
    md.push(
      `| ${i + 1} | ${r.source} | ${r.annId} | ${r.title.slice(0, 18)} | ${r.listStart} | ${r.eventStart} | ${r.deltaMs === null ? "—（相对起点）" : fmtDur(r.deltaMs)} | ${r.rangeEnd ?? "—"} | ${endPrecision(r.rangeEnd)} |`,
    );
  });
  md.push("");
  md.push("说明：");
  md.push(
    "- `start_time` 是公告在游戏内/启动器里的**展示窗口开始**，不是活动开始。展示窗口通常早于活动开始 2 小时到 2 天以上。",
  );
  md.push(
    "- 祈愿类公告的起点是**相对时间**（例：genshin `21876`「7.1版本更新后」），绝对起点不存在于文本中，必须关联版本维护节点解析。",
  );
  md.push("");
  md.push("## 二、对照例（米游社资讯，正文被访问控制，仅列表字段）");
  md.push("");
  md.push("| post_id | 标题（截断） | created_at（UTC→UTC+8） | 图片数 | 正文摘要长度 |");
  md.push("| --- | --- | --- | --- | --- |");
  for (const m of miyousheCases) {
    const cn = new Date(m.createdAtUtcMs + 8 * 3600_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    md.push(
      `| ${m.postId} | ${m.subject.slice(0, 20)} | ${cn} | ${m.images} | ${m.contentPreviewLength} |`,
    );
  }
  md.push("");
  md.push(
    "米游社列表项 `created_at` 是**发帖时间**。以同期祈愿为例：发帖约 09-21，祈愿实际开始为 09-23 维护完成后（见 genshin `21876`），两者相差约 2 天。且该类帖正文摘要为空、日期承载在图片里（见下）。",
  );
  md.push("");

  md.push("## 三、歧义样本取得情况（如实登记）");
  md.push("");
  md.push("| 类别 | 取得 | 实例 |");
  md.push("| --- | --- | --- |");
  md.push(
    `| 含图片承载日期 | ${imageDateSamples.length > 0 ? "是" : "未取得"} | ${imageDateSamples.map((c) => `${c.sourceId}:${c.annId}（${c.imageCount} 图，可读文本 ${c.text.length} 字）`).join("；") || "—"} |`,
  );
  md.push(
    `| 跨年 | ${crossYear.length > 0 ? "是" : "未取得"} | ${crossYear.map((c) => `${c.sourceId}:${c.annId}`).join("；") || "当前存续公告无跨年表述（2026-09 抓取窗口）；需在 12 月—次年 1 月窗口补采，已列入待办"} |`,
  );
  md.push(
    `| 纯日期（无时刻） | ${dateOnlySamples.length > 0 ? "是" : "未取得"} | ${
      dateOnlySamples
        .slice(0, 4)
        .map(
          (c) => `${c.sourceId}:${c.annId}（${[...new Set(c.dateOnly)].slice(0, 3).join("、")}）`,
        )
        .join("；") || "—"
    } |`,
  );
  md.push(
    `| 结束包含性歧义（终点无秒） | ${endInclusivity.length > 0 ? "是" : "未取得"} | ${
      endInclusivity
        .slice(0, 4)
        .map(
          (c) =>
            `${c.sourceId}:${c.annId}（终点 ${c.ranges
              .filter(
                (r) =>
                  r.end.endsWith("23:59") || r.end.endsWith("17:59") || r.end.endsWith("03:59"),
              )
              .map((r) => r.end)
              .slice(0, 2)
              .join("/")}）`,
        )
        .join("；") || "—"
    } |`,
  );
  md.push(
    `| 正文无任何时间文本（时间在图片或需关联） | ${noTimeText.length > 0 ? "是（作为缺口样本）" : "未取得"} | ${
      noTimeText
        .slice(0, 4)
        .map((c) => `${c.sourceId}:${c.annId}`)
        .join("；") || "—"
    } |`,
  );
  md.push("");
  md.push(
    '补充：官方正文把高亮时间包在转义 `<t class="t_gl">` 标签里（例：`fixtures/sources/genshin-ann/content-21928.json`），反转义后才是纯文本时间——这是正文块保真必须保留原始 HTML 的实证。',
  );
  md.push("");

  await writeFile(OUT, `${md.join("\n")}\n`, "utf8");
  process.stdout.write(
    `已生成：${OUT}\n对照例 ${rows.length} 条（公告 API）+ 米游社 ${miyousheCases.length} 条\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
