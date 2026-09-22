// P0-02 采集 runner（本地模式）：按 sources.verified.json 的已核验参数，
// 对四个官方来源做受限采集，产出 fixtures/sources/ 真实样本与 docs/evidence/p0/ 证据。
// 边界（AGENTS.md 规则 6 / 任务卡 P0-02）：
//   - 所有请求经 lib/guard-core.mjs guardedFetch：域名白名单、GET、不跟随重定向、
//     超时、限量读体、诚实 UA、无凭据、不重试；
//   - 响应命中受限信号（403/429/鉴权标记等）→ 立即停止该来源后续步骤并如实记录；
//   - 米游社正文 getPostFull 已知 403：只发一次取证请求，不绕过、不伪装 UA；
//   - 请求间 sleep 限频；样本入库前经凭敏剥离。
// 运行：node scripts/probes/source-samples/run-local.mjs [--label 自定义环境标注] [--dry-run]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvelope, writeEvidenceFile } from "../lib/evidence.mjs";
import { analyzeRestrictionSignals, guardedFetch, sha256Hex } from "../lib/guard-core.mjs";
import {
  buildAnnContentUrl,
  buildAnnListUrl,
  buildNewsContentUrl,
  buildNewsListUrl,
  findAbsoluteDatetimes,
  findDateOnly,
  findDateRanges,
  findRelativeStartRanges,
  isDateCarriedByImage,
  makeSampleRecord,
  parseAnnList,
  parseNewsList,
  stripHtml,
} from "./collect-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures", "sources");

// 采集操作性限制（探针自身约束，非业务参数；业务侧登记为 registry.draft.json 的 limit_profile 实测值）
const PAGE_SIZE = 20;
const MAX_WALK_PAGES = 6; // 公告 API 翻页上限（防失控）
const MAX_NEWS_WALK_PAGES = 3; // 米游社游标翻页上限（限频考虑）
const MAX_CONTENTS_PER_SOURCE = 6;
const REQUEST_GAP_MS = 800;
const LIST_TIMEOUT_MS = 10_000;
const CONTENT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 正文可能含长 HTML，放宽到 4 MiB（仍是限量读体）

const CONTENT_PICK_PATTERNS = [
  ["gacha", /祈愿|概率UP|跃迁/],
  ["maintenance", /维护|停机|更新|版本/],
  ["livestream", /前瞻|直播|发布会|特别节目/],
  ["event", /活动|限时|开启/],
  ["notice", /招募|问卷|调查|补偿|致.{0,6}(旅行者|开拓者|绳匠)/],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const labelIndex = argv.indexOf("--label");
  const onlyIndex = argv.indexOf("--only");
  return {
    label: labelIndex >= 0 ? argv[labelIndex + 1] : undefined,
    only: onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined,
    dryRun: argv.includes("--dry-run"),
    reindex: argv.includes("--reindex"),
  };
}

/** 离线重建：从已保存的 content-*.json 重算时间/图片分析字段，写回 index.json。 */
async function reindexAnnSource(source) {
  const dir = path.join(FIXTURES_DIR, source.source_id);
  const indexPath = path.join(dir, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  for (const c of index.contents ?? []) {
    if (!c.ann_id) continue;
    try {
      const sample = JSON.parse(await readFile(path.join(dir, `content-${c.ann_id}.json`), "utf8"));
      const items = sample.body?.data?.list ?? [];
      const item = items.find((x) => String(x.ann_id) === String(c.ann_id));
      if (!item) continue;
      const raw = String(item.content ?? "");
      const text = stripHtml(raw);
      c.extracted_event_time_ranges = findDateRanges(text);
      c.relative_start_ranges = findRelativeStartRanges(text);
      c.absolute_datetimes = findAbsoluteDatetimes(text);
      c.date_only = findDateOnly(text);
      const imgCount = (raw.match(/<img\b/gi) ?? []).length;
      c.image_date_analysis = isDateCarriedByImage(raw, imgCount);
      c.content_text_bytes = utf8len(text);
    } catch {
      // 样本文件缺失时保留原值
    }
  }
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

/** 单次受限采集请求 + 请求日志条目 + 受限信号检查。不抛出：restricted 信号返回给调用方裁决。 */
class StopSource extends Error {
  constructor(reason) {
    super(reason);
    this.name = "StopSource";
  }
}

async function fetchOnce(url, allowedHosts, requestLog, purpose, timeoutMs) {
  const obs = await guardedFetch(url, { allowedHosts, timeoutMs, maxBytes: MAX_BODY_BYTES });
  const entry = {
    purpose,
    url: url.replace(/([?&]uid=)\d+/, "$1<dummy-uid>"),
    elapsed_ms: obs.elapsed_ms,
    error: obs.error ? { kind: obs.error.kind, code: obs.error.code } : null,
    http_status: obs.http ? obs.http.status : null,
    redirect_status: obs.http ? obs.http.redirect_status : null,
    bytes_read: obs.body ? obs.body.bytes_read : null,
    truncated: obs.body ? obs.body.truncated : null,
  };
  requestLog.push(entry);
  let restriction = null;
  if (!obs.error) {
    restriction = analyzeRestrictionSignals({
      status: obs.http.status,
      headers: obs.http.headers,
      bodyText: obs.body.text,
      contentType: obs.http.headers.content_type,
    });
    if (restriction.restricted) entry.restriction = restriction.signals;
  }
  return { obs, entry, restriction };
}

/** 常规请求：受限即停该来源。 */
async function fetchOrFail(url, allowedHosts, requestLog, purpose, timeoutMs) {
  const r = await fetchOnce(url, allowedHosts, requestLog, purpose, timeoutMs);
  if (r.restriction?.restricted) {
    throw new StopSource(`受限信号：${JSON.stringify(r.restriction.signals)}`);
  }
  return r;
}

async function saveSample(dir, name, record) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function captureAnnSource(source, requestLog, runStats) {
  const dir = path.join(FIXTURES_DIR, source.source_id);
  const files = [];
  const index = {
    source_id: source.source_id,
    list_observation: {},
    contents: [],
    boundary: null,
    pinned_like_observations: [],
  };
  const listUrl = (page, pageSize = PAGE_SIZE) => buildAnnListUrl(source, { page, pageSize });
  const itemByAnnId = new Map();
  const latencies = [];

  // 1) 首页列表 + 翻页到边界
  let page = 1;
  let boundary = null;
  const perPageCounts = [];
  let parsedFirst = null;
  for (; page <= MAX_WALK_PAGES; page += 1) {
    const { obs } = await fetchOrFail(
      listUrl(page),
      source.approved_hosts,
      requestLog,
      `list-page-${page}`,
      LIST_TIMEOUT_MS,
    );
    latencies.push(obs.elapsed_ms);
    if (obs.error) throw new StopSource(`列表请求失败：${obs.error.kind}/${obs.error.code}`);
    const parsed = parseAnnList(obs.body.text);
    if (!parsed.ok || parsed.retcode !== 0)
      throw new StopSource(`列表信封异常：retcode=${parsed.retcode}`);
    const count = parsed.flatItems.length;
    perPageCounts.push({ page, count });
    if (page === 1) {
      parsedFirst = parsed;
      for (const item of parsed.flatItems) itemByAnnId.set(String(item.ann_id), item);
    }
    if (count === 0) {
      boundary = { page, observation: "空页（该页起无更多公告）" };
      await saveSample(
        dir,
        `list-page-${page}-boundary`,
        makeSampleRecord({
          sourceId: source.source_id,
          kind: "pagination-boundary",
          purpose: `第 ${page} 页返回空列表（分页边界实测）`,
          url: listUrl(page),
          http: { status: obs.http.status, headers: obs.http.headers },
          bodyText: obs.body.text,
          bodySha256: await sha256Hex(obs.body.text),
          capturedAtUtc: new Date().toISOString(),
          extra: { per_page_counts_so_far: perPageCounts, api_total: parsed.total },
        }),
      );
      files.push(`list-page-${page}-boundary.json`);
      break;
    }
    // 每个走过的非空页都登记 item id；页样本全部落盘
    for (const item of parsed.flatItems) itemByAnnId.set(String(item.ann_id), item);
    await saveSample(
      dir,
      `list-page-${page}`,
      makeSampleRecord({
        sourceId: source.source_id,
        kind: page === 1 ? "list-response" : "pagination-walk",
        purpose:
          page === 1 ? "首页列表响应样本（page=1, page_size=20）" : `翻页样本（page=${page}）`,
        url: listUrl(page),
        http: { status: obs.http.status, headers: obs.http.headers },
        bodyText: obs.body.text,
        bodySha256: await sha256Hex(obs.body.text),
        capturedAtUtc: new Date().toISOString(),
        extra: { page, returned_items: count, api_total: parsed.total },
      }),
    );
    files.push(`list-page-${page}.json`);
    if (
      parsed.total !== undefined &&
      perPageCounts.reduce((s, c) => s + c.count, 0) >= parsed.total
    ) {
      // 已拿满 total：再请求一页验证空页边界
      const nextPage = page + 1;
      if (nextPage <= MAX_WALK_PAGES) {
        const { obs: nobs } = await fetchOrFail(
          listUrl(nextPage),
          source.approved_hosts,
          requestLog,
          `list-page-${nextPage}-boundary-check`,
          LIST_TIMEOUT_MS,
        );
        latencies.push(nobs.elapsed_ms);
        const nparsed = parseAnnList(nobs.body.text);
        boundary = {
          page: nextPage,
          observation: `拿满 total=${parsed.total} 后下一页 count=${nparsed.flatItems.length}`,
        };
        if (nparsed.flatItems.length === 0) {
          await saveSample(
            dir,
            `list-page-${nextPage}-boundary`,
            makeSampleRecord({
              sourceId: source.source_id,
              kind: "pagination-boundary",
              purpose: `拿满 total 后第 ${nextPage} 页为空（分页边界实测）`,
              url: listUrl(nextPage),
              http: { status: nobs.http.status, headers: nobs.http.headers },
              bodyText: nobs.body.text,
              bodySha256: await sha256Hex(nobs.body.text),
              capturedAtUtc: new Date().toISOString(),
              extra: { per_page_counts_so_far: perPageCounts, api_total: parsed.total },
            }),
          );
          files.push(`list-page-${nextPage}-boundary.json`);
        }
        break;
      }
    }
    await sleep(REQUEST_GAP_MS);
  }
  index.list_observation = {
    page_size: PAGE_SIZE,
    per_page_counts: perPageCounts,
    api_total_first_page: parsedFirst?.total,
    timezone: parsedFirst?.timezone,
    t: parsedFirst?.t,
    alert: parsedFirst?.alert,
    alert_id: parsedFirst?.alert_id,
    type_labels: parsedFirst?.groups.map((g) => g.type_label),
    boundary,
  };
  if (!boundary) index.boundary_note = `未在 ${MAX_WALK_PAGES} 页内到达空页边界`;

  // 置顶/常驻类观察：非零的提醒/弹窗标记字段
  for (const item of itemByAnnId.values()) {
    const flags = {};
    for (const k of ["remind", "alert", "login_alert", "logout_remind", "extra_remind"]) {
      if (item[k]) flags[k] = item[k];
    }
    if (Object.keys(flags).length > 0) {
      index.pinned_like_observations.push({ ann_id: item.ann_id, title: item.title, flags });
    }
  }

  // 2) 正文采集：按模式挑选 + 每组第一条
  const picked = [];
  const seenKind = new Set();
  for (const item of itemByAnnId.values()) {
    if (picked.length >= MAX_CONTENTS_PER_SOURCE) break;
    for (const [kind, re] of CONTENT_PICK_PATTERNS) {
      if (!seenKind.has(kind) && re.test(String(item.title ?? "")) && item.has_content) {
        picked.push({ annId: item.ann_id, kind, title: item.title });
        seenKind.add(kind);
        break;
      }
    }
  }
  for (const item of itemByAnnId.values()) {
    if (picked.length >= MAX_CONTENTS_PER_SOURCE) break;
    if (item.has_content && !picked.some((p) => p.annId === item.ann_id)) {
      picked.push({ annId: item.ann_id, kind: "misc", title: item.title });
    }
  }

  let maxContentBytes = 0;
  for (const p of picked) {
    await sleep(REQUEST_GAP_MS);
    const url = buildAnnContentUrl(source, p.annId);
    const { obs } = await fetchOrFail(
      url,
      source.approved_hosts,
      requestLog,
      `content-${p.annId}`,
      CONTENT_TIMEOUT_MS,
    );
    latencies.push(obs.elapsed_ms);
    if (obs.error) {
      index.contents.push({
        ann_id: p.annId,
        kind: p.kind,
        title: p.title,
        outcome: "fetch-error",
        error: obs.error.kind,
      });
      continue;
    }
    const cParsed = parseAnnList(obs.body.text); // getAnnContent 信封同构：data.list 为数组
    const contentItems = cParsed.ok ? cParsed.flatItems : [];
    const contentItem =
      contentItems.find((c) => String(c.ann_id) === String(p.annId)) ?? contentItems[0];
    const listItem = itemByAnnId.get(String(p.annId));
    const text = stripHtml(contentItem?.content ?? "");
    const imageCount = countImages(contentItem?.content ?? "");
    const dateRanges = findDateRanges(text);
    const imgAnalysis = isDateCarriedByImage(contentItem?.content ?? "", imageCount);
    const bytes = Buffer.byteLength(obs.body.text, "utf8");
    maxContentBytes = Math.max(maxContentBytes, bytes);
    await saveSample(
      dir,
      `content-${p.annId}`,
      makeSampleRecord({
        sourceId: source.source_id,
        kind: "content-response",
        purpose: `正文样本（${p.kind}：${p.title}）`,
        url,
        http: { status: obs.http.status, headers: obs.http.headers },
        bodyText: obs.body.text,
        bodySha256: await sha256Hex(obs.body.text),
        capturedAtUtc: new Date().toISOString(),
      }),
    );
    files.push(`content-${p.annId}.json`);
    index.contents.push({
      ann_id: p.annId,
      kind: p.kind,
      title: p.title,
      list_start_time: listItem?.start_time ?? null,
      list_end_time: listItem?.end_time ?? null,
      list_tag_start_time: listItem?.tag_start_time ?? null,
      content_start_time: contentItem?.start_time ?? null,
      content_time_timezone: contentItem?.timezone ?? parsedFirst?.timezone ?? null,
      extracted_event_time_ranges: dateRanges,
      image_date_analysis: imgAnalysis,
      content_text_bytes: utf8len(text),
    });
  }

  // 3) LIMIT 探测：page_size 批量上限
  const pageSizeProbe = [];
  for (const size of [100, 1000]) {
    await sleep(REQUEST_GAP_MS);
    const { obs } = await fetchOrFail(
      buildAnnListUrl(source, { page: 1, pageSize: size }),
      source.approved_hosts,
      requestLog,
      `limit-pagesize-${size}`,
      LIST_TIMEOUT_MS,
    );
    latencies.push(obs.elapsed_ms);
    const parsed = parseAnnList(obs.body?.text ?? "");
    pageSizeProbe.push({
      requested_page_size: size,
      returned_items: parsed.flatItems.length,
      api_total: parsed.total,
      http_status: obs.http?.status ?? null,
      elapsed_ms: obs.elapsed_ms,
    });
  }
  index.limit_probe = { page_size: pageSizeProbe, max_content_bytes: maxContentBytes };

  runStats.push({ source_id: source.source_id, latencies_ms: latencies });
  return { dir, files, index };
}

function countImages(html) {
  const m = String(html).match(/<img\b/gi);
  return m ? m.length : 0;
}
function utf8len(text) {
  return new TextEncoder().encode(text).byteLength;
}

async function captureMiyousheSource(source, requestLog, runStats) {
  const dir = path.join(FIXTURES_DIR, source.source_id);
  const files = [];
  const index = { source_id: source.source_id, list_observation: {}, contents: [], boundary: null };
  const latencies = [];
  let blockedContent = null;

  // 1) 三类资讯首页
  const lastIds = {};
  for (const type of [1, 2, 3]) {
    const url = buildNewsListUrl(source, { type, lastId: "", pageSize: PAGE_SIZE });
    const { obs } = await fetchOrFail(
      url,
      source.approved_hosts,
      requestLog,
      `news-list-type${type}-page1`,
      LIST_TIMEOUT_MS,
    );
    latencies.push(obs.elapsed_ms);
    const parsed = parseNewsList(obs.body?.text ?? "");
    if (!parsed.ok || parsed.retcode !== 0)
      throw new StopSource(`米游社列表信封异常：retcode=${parsed.retcode}`);
    lastIds[type] = parsed.lastId;
    await saveSample(
      dir,
      `news-list-type${type}-page1`,
      makeSampleRecord({
        sourceId: source.source_id,
        kind: "list-response",
        purpose: `米游社资讯列表样本（type=${type}：${type === 1 ? "公告" : type === 2 ? "活动" : "资讯"}）`,
        url,
        http: { status: obs.http.status, headers: obs.http.headers },
        bodyText: obs.body.text,
        bodySha256: await sha256Hex(obs.body.text),
        capturedAtUtc: new Date().toISOString(),
        extra: {
          returned_items: parsed.items.length,
          last_id: parsed.lastId,
          is_last: parsed.isLast,
        },
      }),
    );
    files.push(`news-list-type${type}-page1.json`);
    const tops = parsed.items
      .filter((i) => i?.post?.post_status?.is_top)
      .map((i) => ({ post_id: i.post.post_id, subject: i.post.subject }));
    index.list_observation[`type${type}`] = {
      returned_items: parsed.items.length,
      last_id: parsed.lastId,
      is_last: parsed.isLast,
      pinned_items: tops,
      uid_values: [...new Set(parsed.items.map((i) => String(i?.post?.uid ?? "")))],
    };
    await sleep(REQUEST_GAP_MS);
  }

  // 2) 游标翻页（type=1），观察 is_last 边界
  let cursor = lastIds[1];
  for (let page = 2; page <= MAX_NEWS_WALK_PAGES + 1 && cursor; page += 1) {
    const url = buildNewsListUrl(source, { type: 1, lastId: cursor, pageSize: PAGE_SIZE });
    const { obs } = await fetchOrFail(
      url,
      source.approved_hosts,
      requestLog,
      `news-list-type1-page${page}`,
      LIST_TIMEOUT_MS,
    );
    latencies.push(obs.elapsed_ms);
    const parsed = parseNewsList(obs.body?.text ?? "");
    if (!parsed.ok || parsed.retcode !== 0) break;
    await saveSample(
      dir,
      `news-list-type1-page${page}`,
      makeSampleRecord({
        sourceId: source.source_id,
        kind: "pagination-walk",
        purpose: `游标翻页样本（type=1 第 ${page} 页，last_id=${cursor}）`,
        url,
        http: { status: obs.http.status, headers: obs.http.headers },
        bodyText: obs.body.text,
        bodySha256: await sha256Hex(obs.body.text),
        capturedAtUtc: new Date().toISOString(),
        extra: {
          returned_items: parsed.items.length,
          last_id: parsed.lastId,
          is_last: parsed.isLast,
        },
      }),
    );
    files.push(`news-list-type1-page${page}.json`);
    if (parsed.isLast) {
      index.boundary = { page, observation: "is_last=true（游标耗尽）" };
      break;
    }
    cursor = parsed.lastId;
    await sleep(REQUEST_GAP_MS);
  }
  if (!index.boundary)
    index.boundary_note = `未在 ${MAX_NEWS_WALK_PAGES} 页内到达 is_last（边界未取得，只观察到游标可前进）`;

  // 3) LIMIT 探测：page_size 超范围
  const pageSizeProbe = [];
  for (const size of [100, 1000]) {
    await sleep(REQUEST_GAP_MS);
    const url = buildNewsListUrl(source, { type: 1, lastId: "", pageSize: size });
    const { obs } = await fetchOrFail(
      url,
      source.approved_hosts,
      requestLog,
      `limit-pagesize-${size}`,
      LIST_TIMEOUT_MS,
    );
    latencies.push(obs.elapsed_ms);
    const parsed = parseNewsList(obs.body?.text ?? "");
    pageSizeProbe.push({
      requested_page_size: size,
      returned_items: parsed.items.length,
      http_status: obs.http?.status ?? null,
      elapsed_ms: obs.elapsed_ms,
    });
  }
  index.limit_probe = { page_size: pageSizeProbe };

  // 4) 正文取证：getPostFull 预期 403（访问控制）。仅一次，不重试、不换 UA。
  //    该 403 是"米游社正文通道被访问控制"的证据本身，按取证记录，不算采集失败。
  const list1 = JSON.parse(await readFile(path.join(dir, "news-list-type1-page1.json"), "utf8"));
  const postId = list1?.body?.data?.list?.[0]?.post?.post_id;
  if (postId) {
    await sleep(REQUEST_GAP_MS);
    const url = buildNewsContentUrl(source, postId);
    const { obs, restriction } = await fetchOnce(
      url,
      source.approved_hosts,
      requestLog,
      `content-blocked-${postId}`,
      LIST_TIMEOUT_MS,
    );
    latencies.push(obs.elapsed_ms);
    const status = obs.http?.status ?? null;
    const restricted = restriction?.restricted === true;
    blockedContent = {
      post_id: postId,
      url,
      http_status: status,
      outcome: restricted ? "access-restricted-403" : `unexpected-${status ?? obs.error?.kind}`,
    };
    await saveSample(dir, `content-blocked-${postId}`, {
      schema_version: 1,
      synthetic: false,
      source_id: source.source_id,
      kind: "access-blocked-content",
      purpose:
        "getPostFull 正文接口取证：诚实探针 UA、无凭据、单次请求；返回 403 Forbidden（访问控制信号）",
      captured_at_utc: new Date().toISOString(),
      url,
      http: { status, headers: obs.http?.headers ?? null },
      restriction_signals: restriction?.signals ?? null,
      body_text: obs.body?.text ?? "",
      decision:
        "米游社正文样本未取得。不绕过、不伪装 UA、不使用第三方聚合后端冒充官方来源（AGENTS.md 规则 6 / 主方案 §3.1）。",
    });
    files.push(`content-blocked-${postId}.json`);
  }

  index.contents = [
    {
      outcome: blockedContent?.outcome ?? "no-post-id",
      detail: "正文接口 getPostFull 被访问控制拦截（403），正文样本未取得；列表通道正常",
    },
  ];
  runStats.push({ source_id: source.source_id, latencies_ms: latencies });
  return { dir, files, index };
}

async function main() {
  const { label, only, dryRun, reindex } = parseArgs(process.argv.slice(2));
  const verified = JSON.parse(await readFile(path.join(HERE, "sources.verified.json"), "utf8"));
  const requestLog = [];
  const runStats = [];
  const sourceResults = [];
  const sources = only ? verified.sources.filter((s) => s.source_id === only) : verified.sources;
  if (only && sources.length === 0) throw new Error(`未找到来源：${only}`);

  if (reindex) {
    // 离线模式：不发网络请求，用已保存样本重算 index.json 里的时间/图片分析字段
    // （采集与分析函数修正后，用同一份原始样本重derive，避免重新抓取）。
    for (const source of sources) {
      if (source.source_id === "miyoushe-news") continue; // 米游社无正文样本可重析
      await reindexAnnSource(source);
      process.stdout.write(`[reindex] ${source.source_id} 完成\n`);
    }
    return;
  }

  if (dryRun) {
    const ann = verified.sources.find((s) => s.source_id === "genshin-ann");
    process.stdout.write(
      `[dry-run] 示例 URL：\n${buildAnnListUrl(ann, { page: 1, pageSize: 20 })}\n${buildAnnContentUrl(ann, 3648)}\n${buildNewsListUrl(
        verified.sources.find((s) => s.source_id === "miyoushe-news"),
        { type: 1, lastId: "", pageSize: 20 },
      )}\n`,
    );
    return;
  }

  for (const source of sources) {
    process.stdout.write(`== 采集 ${source.source_id} ==\n`);
    try {
      const result =
        source.source_id === "miyoushe-news"
          ? await captureMiyousheSource(source, requestLog, runStats)
          : await captureAnnSource(source, requestLog, runStats);
      sourceResults.push({ source_id: source.source_id, outcome: "captured", ...result });
      process.stdout.write(`   完成：${result.files.length} 个样本文件\n`);
    } catch (e) {
      if (e instanceof StopSource) {
        sourceResults.push({ source_id: source.source_id, outcome: "stopped", reason: e.message });
        process.stdout.write(`   停止：${e.message}\n`);
      } else {
        throw e;
      }
    }
    await sleep(REQUEST_GAP_MS * 2);
  }

  // 每来源 index.json 落盘
  for (const r of sourceResults) {
    if (r.outcome !== "captured" || !r.index) continue;
    await writeFile(
      path.join(r.dir, "index.json"),
      `${JSON.stringify({ schema_version: 1, generated_at_utc: new Date().toISOString(), ...r.index, files: r.files }, null, 2)}\n`,
      "utf8",
    );
  }

  // 汇总 LIMIT_PROFILE 观测
  const allLatencies = runStats
    .flatMap((s) => s.latencies_ms)
    .filter((n) => typeof n === "number")
    .sort((a, b) => a - b);
  const stat = (arr, p) =>
    arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
  const limitObservations = {
    request_timeout_ms: {
      observed_count: allLatencies.length,
      observed_max_ms: allLatencies.length ? allLatencies[allLatencies.length - 1] : null,
      observed_p95_ms: stat(allLatencies, 0.95),
      observed_median_ms: stat(allLatencies, 0.5),
      probe_operational_timeout_ms: LIST_TIMEOUT_MS,
    },
    redirects: {
      observed: requestLog.filter((r) => r.redirect_status !== null).length,
      note: "全部请求 redirect:manual，未跟随任何重定向；本次未观察到 3xx",
    },
  };

  const envelope = buildEnvelope({
    probe: "source-samples",
    runEnvironment: {
      type: "local-node",
      label: label ?? "local",
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      user_agent_sent: "见 lib/guard-core.mjs PROBE_USER_AGENT（诚实探针 UA，无浏览器伪装）",
      evidence_grading: "本机网络观测（E2 类），不是目标 Cloudflare 环境证据",
    },
    results: {
      sources: sourceResults.map((r) => ({
        source_id: r.source_id,
        outcome: r.outcome,
        reason: r.reason,
        sample_files: r.files,
      })),
      request_log: requestLog,
      limit_observations: limitObservations,
      run_stats: runStats,
    },
    notes: [
      "请求间隔 ≥800ms，串行；命中受限信号（403 等）立即停止该来源并记录（主方案 §3.1 / AGENTS.md 规则 6）。",
      "米游社 getPostFull 在采集前已知 403，仍按流程发一次取证请求（诚实 UA、无凭据、不重试）。",
      "uid=100000000 为官方公告页登出态哑 uid（对齐官方 webview 行为），非凭据、非伪造身份。",
    ],
  });
  const file = await writeEvidenceFile(envelope);
  process.stdout.write(`证据已写入：${file}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
