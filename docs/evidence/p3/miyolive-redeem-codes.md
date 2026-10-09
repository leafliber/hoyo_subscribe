# ADR-0030 · 米游社直播兑换码接口取证（2026-10-07；2026-10-09 补真实样本，见第 5 节）

> 本机网络（E2 级）只读请求；诚实 UA `hoyo-subscribe-source-collector/1.0 (…)`，无 Cookie、无凭据、串行、间隔 1 秒、不重试。
> 样本在 `fixtures/sources/miyolive/`（与 P0-02 样本同一封装格式）。合成样本单独标明 `"synthetic": true`。

## 1. 结论

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 发现入口：米游社首页 `bbs-api.miyoushe.com/apihub/api/home/new?gids=2/6/8` | 三个游戏都匿名可读（200、retcode 0）；有 `lives`、`navigator`、`carousels` 字段；**当天没有直播入口**（`lives` 为空，导航与轮播里没有官方直播页链接） | `home-genshin.json`、`home-hsr.json`、`home-zzz.json` |
| 直播活动接口 `api-takumi.mihoyo.com/event/miyolive/index`（请求头 `x-rpc-act_id`） | 不存在或已结束的活动返回 `{"retcode":-500012,"message":"活动已结束 (-500012)","data":null}` | `index-closed.json`（活动 ID 为本站构造的不存在 ID） |
| 兑换码接口 `api-takumi-static.mihoyo.com/event/miyolive/refreshCode` | 同上 | `refresh-code-closed.json` |
| 进行中的直播与兑换码字段 | **未取得真实样本**（当天没有直播） | 合成样本 `synthetic-index-active.json`、`synthetic-refresh-code.json` |
| 游戏内公告是否给出直播页活动 ID | 否：绝区零 3.3 前瞻公告（ann_id 252）只链接 B 站直播间，写明"节目直播期间还将发放限定兑换码福利" | 2026-10-07 `getAnnContent`（nap） |
| 米游社资讯列表是否给出直播页链接 | 否：资讯条目只有标题（"3.3版本「重返天空的旅程」前瞻特别节目预告"），正文接口 403（ADR-0016），不再尝试 | 2026-10-07 `painter/wapi/getNewsList?gids=8&type=1/2/3` |

## 2. 接口与字段的出处

米游社官方直播页 `https://webstatic.mihoyo.com/bbs/event/live/index.html` 的公开脚本（2026-10-07 读取 `index_c69564cdbfc918c3b45a.js`、`commons_987141cfa71c5e633d76.js`，只用于定位接口，未入库）：

- 接口根：`apiBase = https://api-takumi.mihoyo.com/event/miyolive/`、`cdnBase = https://api-takumi-static.mihoyo.com/event/miyolive/`；请求拦截器给每个请求加 `x-rpc-act_id`（取页面地址的 `act_id`）。
- 活动信息 `GET /index`：页面读取 `live.code_ver`、`live.is_end`、`live.remain`、`live.now`、`live.title`、`live.start`、`live.end`，以及 `template`（JSON 字符串，内含 `codeTipText` 兑换码说明、`codeVisible` 等）。
- 兑换码 `GET {cdnBase}refreshCode`，参数 `version = live.code_ver`、`time = 当前秒数按 20 秒取整`，`withCredentials: false`；读取 `code_list[]` 的 `code`、`title`（奖励说明，作为 HTML 渲染）、`img`、`to_get_time`（发放时刻，秒）。页面在每个 `to_get_time` 到点后每 20–40 秒重取一次，直到该条 `code` 出现。
- 兑换码的有效期在页面上只显示为 `codeTipText` 说明文字，没有结构化字段。
- 同一脚本还有 `/list`、`/listRefresh`（直播列表，需要列表 ID）、抽奖与订阅等接口，本站不用。

## 3. 本次请求量

发现与接口定位约 20 次请求（含官方页面与两个脚本文件、三个首页各 2–3 次、两个接口的"已结束"信封、绝区零公告正文 1 次、米游社资讯列表 3 次），全部串行。

## 4. 待取证（需在直播期间进行）

| 项 | 时间 | 做法 |
| --- | --- | --- |
| 首页直播入口出现在哪个字段、什么形状 | 绝区零 3.3 前瞻，2026-10-09 19:30 前后 | 开启 `zzz-live` 后看管理端运行开关页的"正在跟踪的直播"；没出现时在同页登记官方直播页链接 |
| `index` 与 `refreshCode` 的真实字段 | 同上 | 采集按合成样本的字段读取；不符时整份按"格式不符"失败（不猜），按真实样本修正适配器并补充样本 |
| `codeTipText` 的有效期写法 | 同上 | 认不出时日历只有"兑换码发放"，首页条写"官方未写有效期"并按 24 小时显示上限 |

2026-10-09 的结果见第 5 节；据此做出的修订见 [ADR-0034](../../adr/0034-redeem-expiry-and-status-checks.md)。

## 5. 2026-10-09 绝区零 3.3 前瞻特别节目（第一次真实样本）

> 本机网络只读请求，诚实 UA `hoyo-subscribe-source-collector/1.0 (evidence check)`，无 Cookie、串行、不重试。
> 活动 ID `ea202609241643161324`（线上采集自动发现，见公开接口 `/api/v2/redeem-codes` 的 `officialUrl`）。
> 样本：`fixtures/sources/miyolive/index-zzz-33-live.json`、`refresh-code-zzz-33-live.json`（北京时间 19:55）与
> `index-zzz-33-ended.json`、`refresh-code-zzz-33-ended.json`（20:31，过了官方结束时刻），均标 `"synthetic": false`。

| 项 | 结果 |
| --- | --- |
| 活动信息 `index` | retcode 0；`live` 有 `act_type`、`title`、`live_time`、`start`、`end`（北京时间"YYYY-MM-DD HH:MM:SS"）、`remain`、`now`、`is_end`、`code_ver`。与合成样本相比多 `act_type`、`live_time`，没有 `act_id`；适配器读取的字段都在 |
| 兑换码说明 `codeTipText` | **空字符串**。整个响应（含 `template` 里 `ruleCont` 等文字）没有"有效/过期/失效/截止"字样，只有 `codeEmptyTipText`"兑换码尚未发放，敬请期待~" |
| 兑换码 `refreshCode` | 只有一个兑换码 `PHOENIX1021`；每条只有 `title`（奖励说明 HTML，多个 `<p>`）、`code`、`img`、`to_get_time`（秒，字符串）。**没有有效期字段** |
| 官方页面脚本 | 与 2026-10-07 同一版本（`index_c69564cdbfc918c3b45a.js`）；兑换码区只渲染图标、奖励、"兑换码："+码、"复制"与 `codeTipText` 一行，没有其他有效期显示 |
| 发放时刻被官方改动 | 本站公开详情显示兑换码事件的开始节点先按官方预告的 19:49 发布，兑换码实际在 19:43:30 发放、`to_get_time` 随之改成 1791546210（19:43:30），开始节点因此记了一次"已公布新时间"的改期（ADR-0034 第 1 条的起因） |
| 过了结束时刻（20:30）之后 | `index` 仍 retcode 0（**不是**"活动已结束"），`is_end` 变为 `true`，`code_ver` 从 `8b62ca` 变为 `b3a393`；`refreshCode` 仍列出 `PHOENIX1021`；`codeTipText` 仍为空 |
| 游戏内公告 | 绝区零公告正文接口（`getAnnContent`，与生产来源同一请求）里没有前瞻兑换码的有效期；预告公告 ann_id 252 当时已不在列表里 |
| 官方有效期在哪里 | 往期绝区零前瞻的有效期写在直播后官方公众号、米游社帖子里（媒体转载原句如"本次特别节目中的兑换码将于6月8日 23:59:59失效"，出处标注为公众号）；本站不能匿名读取这些渠道（米游社帖子正文 403，ADR-0016），也不按惯例推算 |

本次请求：直播页 1 次、页面脚本 1 次、`index` 4 次、`refreshCode` 4 次、游戏内公告正文 1 次，全部串行。
