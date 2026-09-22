# P0-02 · 官方来源参数核验与发现记录

> 任务卡 P0-02。本文记录把 P0-01 的失败线索（米游社 404、三公告 API retcode:-1003）
> 变成可用参数集的完整过程，以及过程中发现的对设计有影响的 API 行为。
> 全部观测为本机网络（E2 级）实测，时间为 2026-09-21 至 2026-09-22。
> 机器可读结论见 `scripts/probes/source-samples/sources.verified.json` 与 `fixtures/sources/registry.draft.json`。

## 1. 公告 API（getAnnList / getAnnContent）：-1003 的原因与修复

P0-01 线索 URL 用的参数是 `page/page_size/game=hk4e_cn/lang`，返回 `retcode:-1003 提交参数有误`。

**逐项剔除法实测的最小必需集**：`game`、`game_biz`、`bundle_id`、`platform`、`region`（缺任一即 -1003）。
`lang`、`channel_id`、`announcement_version` 可省（省略后仍 retcode:0）。

**取值陷阱**（都实测过）：

| 参数 | 错误取值 | 实测结果 | 正确取值 |
| --- | --- | --- | --- |
| game | `hk4e_cn` / `hkrpg_cn` / `nap_cn` | -1003（hk4e）；**-1000 系统异常**（hkrpg/nap） | `hk4e` / `hkrpg` / `nap` |
| region（hkrpg） | `prod` | retcode:0 但 `total:0`（空列表陷阱） | `prod_gf_cn` |
| region（nap） | `prod` | 同上 | `prod_gf_cn` |
| platform | 1-6/windows/android/ios | 均被接受，但只有 `pc` 组合验证过有数据 | `pc` |

`region` 取值依据开源启动器项目 Starward 的 `GameNoticeClient.cs`（定位接口用，数据仍全部来自官方端点直接实测）。

**内容门控（level + uid）**：官方公告按玩家等级过滤内容。补上 `level` 与登出态哑 `uid=100000000`
（官方公告 webview 未登录时自带的值，非凭据、非伪造身份）后：

| 来源 | 无 level/uid | level=60/70 + uid | 说明 |
| --- | --- | --- | --- |
| genshin-ann | total 4 | **total 41** | level=60 |
| hsr-ann | total 2 | **total 14** | level=70 |
| zzz-ann | total 3 | **total 18** | level=60 |

## 2. 公告 API 的行为发现（对设计有影响）

1. **分页参数被服务端忽略**：`page_size=2/20/100/1000` 全部返回同一份 41 条全集；`page=2` 与 `page=1` 首条相同。
   采集模型应是"每请求全量快照 + ann_id 差分"，不是页码游标。`registry.draft.json` 的 cursor 已按此登记。
2. **getAnnContent 同样忽略 announcement_id**：单次返回全部 41 条正文（约 254 KiB）。一次调用即得全部正文，
   但意味着"单篇复查"并不存在——复查窗口的按篇重拉在公告 API 侧等价于全量重拉。
3. **时间高亮是转义标签**：正文里的时间被包成 `&lt;t class="t_gl"&gt;2026/09/23 06:00&lt;/t&gt;`。
   正文块保真必须保留原始 HTML（含转义标签），纯文本化会丢失官方的语义标记。
4. **timezone=8**：列表 `start_time/end_time` 为 UTC+8。活动开始时间常以"7.1版本更新后"等相对表述出现
   （见 `list-display-time-vs-event-time.md`）。
5. **nap（绝区零）的列表 title 字段含 HTML**（`<p style=…>`），入库前需剥离。
6. **"（服务器时间）"注记**：ZZZ 正文在时间后标注服务器时间再接分隔符，时间解析需容忍。

## 3. 米游社：路径迁移与正文访问控制

1. **`post/wapi/getNewsList` 已 404**（bbs-api.mihoyo.com 与 bbs-api.miyoushe.com 两台主机一致）。
   从米游社线上前端 bundle（`www.miyoushe.com/_static/*.js`）确认现行调用为 **`painter/wapi/getNewsList`**，
   参数 `gids`（2=原神）、`type`（1 公告 / 2 活动 / 3 资讯，来自 bundle 内枚举 `I={DEFAULT:"1",EVENT:"2",NEWS:"3"}`）、
   `last_id`（偏移量游标）、`page_size`（1-50，超范围回落 20——100 与 1000 实测都只回 20 条）。
2. **`post/wapi/getPostFull` 返回 403 Forbidden**：诚实探针 UA、无凭据、单次请求，两台官方主机一致。
   这是访问控制信号——按 AGENTS.md 规则 6 与任务卡边界：**停止该正文通道、米游社来源标维护、正文样本记"未取得"**。
   未测试浏览器 UA 伪装，未改用 SSR 页面替代，未使用第三方聚合后端。
   米游社列表条目 `uid="0"`，不携带发布者身份，`verified_publishers` 无法核验，登记为空并注明原因。

## 4. 发现过程请求量（诚实申报）

参数核验阶段的探索性请求约 55 次（含失败的参数组合、矩阵试探、bundle 抓取）；
正式采集两轮共 48 次（run 1：39 次，run 2 仅米游社补跑：9 次），全部串行、间隔 ≥800 ms、无重试。
全部证据在 `docs/evidence/p0/source-samples-20260921T174154Z.json`（run 1）与
`source-samples-20260921T174350Z.json`（run 2）。

## 5. 需所有者/后续窗口补齐的事项

| 事项 | 原因 | 建议 |
| --- | --- | --- |
| 跨年样本 | 2026-09 抓取窗口内无跨年存续公告 | 12 月—次年 1 月窗口重跑 `run-local.mjs` 补采 |
| 米游社正文通道 | getPostFull 403 访问控制 | 如所有者确认可用受信任客户端方式获得官方许可路径再议；在此之前按维护处理 |
| 目标 Cloudflare 环境复测 | 本卡证据为本机网络（E2 级） | P3-01 前在 Workers 侧用相同参数集复测一次可达性（所有者执行或部署探针） |
| 米游社 gids=5/6（星铁/绝区零） | 本卡按 P0-01 线索只登记 gids=2 | 若 scope 需要米游社覆盖另两游戏，补一次采集即可 |
