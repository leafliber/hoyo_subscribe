// P0-02 单元测试（node --test）。标题带验收 ID A-P0-SOURCE。
// 测试数据全部为 synthetic（自造最小信封），真实样本在 fixtures/sources/（synthetic:false）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAnnContentUrl,
  buildAnnListUrl,
  buildNewsContentUrl,
  buildNewsListUrl,
  encodeParams,
  findAbsoluteDatetimes,
  findDateOnly,
  findDateRanges,
  findRelativeStartRanges,
  isDateCarriedByImage,
  makeSampleRecord,
  parseAnnList,
  parseNewsList,
  scrubValue,
  stripHtml,
  utf8ByteLength,
} from "./collect-core.mjs";

const annSource = {
  source_id: "test-ann",
  approved_hosts: ["ann-api.example.com"],
  list: { path: "/common/test_cn/announcement/api/getAnnList", params: { game: "test", game_biz: "test_cn", bundle_id: "test_cn", channel_id: "1", lang: "zh-cn", level: "60", platform: "pc", region: "cn_test", uid: "100000000" }, pagination: "page/page_size" },
  content: { path: "/common/test_cn/announcement/api/getAnnContent", params_key: "announcement_id" },
};

const newsSource = {
  source_id: "test-news",
  approved_hosts: ["news.example.com"],
  list: { path: "/painter/wapi/getNewsList", params: { gids: "2" } },
  content: { path: "/post/wapi/getPostFull", params_key: "post_id" },
};

test("A-P0-SOURCE: encodeParams 键序稳定且跳过空值", () => {
  assert.equal(encodeParams({ b: "2", a: "1" }), "b=2&a=1");
  assert.equal(encodeParams({ a: "1", skip: undefined, n: null }), "a=1");
  assert.equal(encodeParams({ "zh": "中文" }), "zh=%E4%B8%AD%E6%96%87");
});

test("A-P0-SOURCE: 公告列表/正文 URL 构造（含 page/page_size 与 announcement_id）", () => {
  const url = buildAnnListUrl(annSource, { page: 2, pageSize: 20 });
  assert.equal(url, "https://ann-api.example.com/common/test_cn/announcement/api/getAnnList?game=test&game_biz=test_cn&bundle_id=test_cn&channel_id=1&lang=zh-cn&level=60&platform=pc&region=cn_test&uid=100000000&page=2&page_size=20");
  const curl = buildAnnContentUrl(annSource, 12345);
  assert.ok(curl.endsWith("getAnnContent?game=test&game_biz=test_cn&bundle_id=test_cn&channel_id=1&lang=zh-cn&level=60&platform=pc&region=cn_test&uid=100000000&announcement_id=12345"));
});

test("A-P0-SOURCE: 米游社列表/正文 URL 构造（type/last_id/page_size）", () => {
  const url = buildNewsListUrl(newsSource, { type: 1, lastId: "77", pageSize: 20 });
  assert.equal(url, "https://news.example.com/painter/wapi/getNewsList?gids=2&type=1&last_id=77&page_size=20");
  const empty = buildNewsListUrl(newsSource, { type: 3, lastId: null, pageSize: 50 });
  assert.ok(empty.includes("last_id=&page_size=50"));
  assert.ok(buildNewsContentUrl(newsSource, 42).endsWith("/post/wapi/getPostFull?post_id=42"));
});

test("A-P0-SOURCE: parseAnnList 识别分组列表与扁平正文两种形状（synthetic 数据）", () => {
  const grouped = JSON.stringify({
    retcode: 0, message: "OK",
    data: { total: 3, timezone: "UTC+8", alert: 0, alert_id: 9, list: [
      { type_label: "公告", list: [{ ann_id: 1, title: "a", has_content: true }] },
      { type_label: "活动", list: [{ ann_id: 2, title: "b" }, { ann_id: 3, title: "c" }] },
    ] },
  });
  const g = parseAnnList(grouped);
  assert.equal(g.ok, true);
  assert.equal(g.retcode, 0);
  assert.equal(g.total, 3);
  assert.equal(g.timezone, "UTC+8");
  assert.deepEqual(g.flatItems.map((i) => i.ann_id), [1, 2, 3]);
  assert.deepEqual(g.groups.map((x) => x.type_label), ["公告", "活动"]);

  const flat = JSON.stringify({ retcode: 0, message: "OK", data: { list: [{ ann_id: 1, content: "<p>x</p>" }] } });
  const f = parseAnnList(flat);
  assert.equal(f.ok, true);
  assert.equal(f.flatItems.length, 1);
  assert.equal(f.flatItems[0].content, "<p>x</p>");

  assert.equal(parseAnnList("not-json").ok, false);
  assert.equal(parseAnnList(JSON.stringify({ nope: 1 })).ok, false);
});

test("A-P0-SOURCE: parseNewsList 解析游标与 is_last（synthetic 数据）", () => {
  const body = JSON.stringify({ retcode: 0, message: "OK", data: { list: [{ post: { post_id: "1", uid: "0", post_status: { is_top: true } } }], last_id: 555, is_last: false } });
  const p = parseNewsList(body);
  assert.equal(p.ok, true);
  assert.equal(p.lastId, "555");
  assert.equal(p.isLast, false);
  assert.equal(p.items[0].post.post_status.is_top, true);
  const last = parseNewsList(JSON.stringify({ retcode: 0, data: { list: [], last_id: 0, is_last: true } }));
  assert.equal(last.isLast, true);
});

test("A-P0-SOURCE: scrubValue 删除凭敏键并替换邮箱/手机号", () => {
  const redactions = [];
  const cleaned = scrubValue({
    cookie: "secret", stoken: "x", authkey_ver: "1",
    nested: { device_id: "d", keep: "v" },
    arr: [{ ltuid: 1 }, { ok: "13800138000" }],
    contact: "someone@example.com",
    long_text: "这是一个超过五百字符的正文，".repeat(60),
  }, redactions);
  assert.equal(cleaned.cookie, undefined);
  assert.equal(cleaned.stoken, undefined);
  assert.equal(cleaned.authkey_ver, undefined);
  assert.equal(cleaned.nested.device_id, undefined);
  assert.equal(cleaned.nested.keep, "v");
  assert.equal(cleaned.arr[0].ltuid, undefined);
  assert.ok(cleaned.arr[1].ok.includes("[redacted-phone]"));
  assert.ok(cleaned.contact.includes("[redacted-email]"));
  assert.ok(redactions.length >= 5);
});

test("A-P0-SOURCE: makeSampleRecord 强制 synthetic:false 且必含抓取时间与 URL", () => {
  const rec = makeSampleRecord({
    sourceId: "s", kind: "list-response", purpose: "p",
    url: "https://h.example/x", http: { status: 200, headers: {} },
    bodyText: '{"retcode":0,"message":"OK","data":{"list":[]}}',
    bodySha256: "deadbeef", capturedAtUtc: "2026-09-22T00:00:00.000Z",
  });
  assert.equal(rec.synthetic, false);
  assert.equal(rec.captured_at_utc, "2026-09-22T00:00:00.000Z");
  assert.equal(rec.url, "https://h.example/x");
  assert.equal(rec.body_sha256, "deadbeef");
  assert.equal(rec.body.retcode, 0);
  assert.equal(utf8ByteLength("中文"), 6);
  const raw = makeSampleRecord({
    sourceId: "s", kind: "k", purpose: "p", url: "https://h.example/x",
    http: { status: 200, headers: {} }, bodyText: "plain", bodySha256: "x",
    capturedAtUtc: "2026-09-22T00:00:00.000Z",
  });
  assert.deepEqual(raw.body, { raw_text: "plain" });
});

test("A-P0-SOURCE: findDateRanges 提取区间、跨年与结束无时间（synthetic 数据）", () => {
  const t1 = "祈愿时间：2026/09/18 12:00 ~ 2026/10/06 17:59";
  const r1 = findDateRanges(t1);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].cross_year, undefined);
  assert.equal(r1[0].end_has_time, true);

  const t2 = "活动时间：2025/12/25 10:00 至 2026/01/05 03:59:59";
  const r2 = findDateRanges(t2);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].cross_year, true);

  const t3 = "限时任务：9月18日 12:00 ~ 10月6日";
  const r3 = findDateRanges(t3);
  assert.equal(r3.length, 1);
  assert.equal(r3[0].end_has_time, false);

  assert.equal(findDateRanges("没有日期的文本").length, 0);
});

test("A-P0-SOURCE: 官方转义 t_gl 高亮标签与「（服务器时间）」注记不打断区间提取（synthetic 数据）", () => {
  const raw = "〓祈愿时间〓 &lt;t class=\"t_gl\"&gt;2026/09/18 12:00&lt;/t&gt; ~ &lt;t class=\"t_gl\"&gt;2026/10/06 17:59&lt;/t&gt;";
  const text = stripHtml(raw);
  const r = findDateRanges(text);
  assert.equal(r.length, 1);
  assert.equal(r[0].start, "2026/09/18 12:00");
  assert.equal(r[0].end, "2026/10/06 17:59");
  assert.equal(stripHtml("&lt;p&gt;a&lt;/p&gt;"), "a");

  const zzzStyle = "【活动时间】 2026/09/23 04:00（服务器时间）~2026/09/28 03:59（服务器时间）";
  const rz = findDateRanges(zzzStyle);
  assert.equal(rz.length, 1);
  assert.equal(rz[0].start, "2026/09/23 04:00");
  assert.equal(rz[0].end, "2026/09/28 03:59");
});

test("A-P0-SOURCE: 相对起点区间提取（祈愿「7.1版本更新后」）", () => {
  const text = "祈愿时间 7.1版本更新后 ~ 2026/10/13 17:59";
  const rel = findRelativeStartRanges(text);
  assert.equal(rel.length, 1);
  assert.ok(rel[0].relative_start.endsWith("7.1版本更新后"));
  assert.equal(rel[0].end, "2026/10/13 17:59");
  // 起点已是绝对时间的成对区间不算相对起点（由 findDateRanges 覆盖）
  const dup = findRelativeStartRanges("：2026/09/23 04:00（服务器时间）~2026/09/28 03:59");
  assert.equal(dup.length, 0);
});

test("A-P0-SOURCE: 绝对时间点与纯日期提取（synthetic 数据）", () => {
  const text = "2026/09/23 06:00 开始维护，2026-09-30 截止，10月8日 再次开放";
  const dts = findAbsoluteDatetimes(text);
  assert.deepEqual(dts, ["2026/09/23 06:00"]);
  const dates = findDateOnly(text);
  assert.ok(dates.includes("2026-09-30"));
  assert.ok(dates.includes("10月8日"));
  assert.ok(!findAbsoluteDatetimes("无时间文本").length);
});

test("A-P0-SOURCE: isDateCarriedByImage 判定日期主要在图片承载", () => {
  const imgHeavy = isDateCarriedByImage('<p><img src="a"><img src="b"><img src="c">祈愿开启！</p>', 3);
  assert.equal(imgHeavy.date_likely_in_image, true);
  const textHeavy = isDateCarriedByImage("<p>祈愿时间：9月18日 12:00 ~ 10月6日 17:59，更多说明……</p>", 1);
  assert.equal(textHeavy.date_likely_in_image, false);
  assert.equal(stripHtml("<p>a<br/>b</p>&nbsp;&amp;"), "a b &");
});
