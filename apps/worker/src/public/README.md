# P3-14 公共读接口交接

响应的唯一合同是 `packages/contracts/src/public-api.ts`。首个提交 `cc28af8` 已先行推送；后续只增加纯函数与类型别名，响应字段未变。

## F1-06 接入

- `GET /api/v2/catalog`：`SUPPORTED_SCOPE`、事件/节点枚举、当前 `publication`。
- `GET /api/v2/events?range=3d&games=genshin,hsr`：`range` 是 `BROWSE_RANGES` 中的预设；省略时用 `BROWSE_DEFAULT_RANGE`。`games` 省略选全部，空串选空集。其他参数、重复参数、无效枚举均拒绝。`all` 也只取本代今天起的节点；未知日期在待定区域。
- 继续加载时使用原筛选及 `cursor=encodeURIComponent(nextCursor)`。每页是稳定节点身份序的有界扫描结果，前端按时间分组；空页也必须继续检查 `nextCursor`。只有它为 `null` 才加载完毕。换代、跨北京时间日或换筛选使用旧游标时返回 `409 conflict`，清空后重新加载，不跨代拼接。
- `GET /api/v2/events/{eventId}`：使用节点的 `eventId`，不是 Milestone `id`。缺少本代事件返回 404。`importantNodeId` 只选择实际存在、尚未到计划时刻/日期或待定的节点；没有当前安排时为 null，不虚构“实际进行中”。
- `GET /api/v2/status`：保留原有注册和全局邮件可用字段；公开来源状态、缺口聚合、代次、客户端实测范围。P5-01 的四种能力全部 `unknown`。
- 不传 Cookie 或私人参数；服务端公开路由不读取 Cookie、不鉴权、不建身份、不续会话。

`PublicScheduleNode` 沿用样例节点的 `id/title/game/eventType/nodeType/status/time/evidence/noticePublishedAt`，新增 `eventId`；未知公告发布时间为 null，`change` 缺失时为 null（样例为 undefined）。真实列表有独立 `recentChanges` 和分页字段，不能强转成 `synthetic: true` 的 `ScheduleSnapshot`。

## 数据与显示边界

- `time` 沿用 `TimeValue`，日期不补午夜。所有其他时间为 UTC 毫秒。
- `publication.publishedAt` 是完整代次发布时间；`sources[].verifiedAt` 是该游戏各来源成功核验水位的最小值（任一未知则 null）；`noticePublishedAt` 是能绑定的官方公告发布时间；`cache.generatedAt` 是响应生成时间。这四类时间不得互相冒充。
- `verificationState` 从来源已保存的核验状态派生，不是当前网络连通性探针。维护状态保留最近成功水位；没有来源或无法确认核验时为 unknown。
- 近期变更使用当前快照中仍未过 `retain_until` 的共享更正，保留期限沿用 `CAL_PATCH_MIN_DAYS/CAL_PATCH_TAIL_DAYS`，条数取 `PUBLIC_READ_LIMITS.recentChanges`，按保留水位降序再按身份排序。`recentChangesTruncated` 表示还有变更未列出，不能声称变更历史完整。它只按游戏筛选，不被浏览未来窗口隐藏；不建立用户级历史。
- `historicalTime` 是共享层累计的历史时间水位，可能不是紧邻本次更正的旧时间；必须标“历史”，不能当当前安排。节点删除只在变更区域出现，以 `change.kind=deleted` 与系统撤回表现区分官方取消。
- 官方发布者与官方更新时间目前未持久化，返回 null。发布时间/证据只在已发布证据、不晚于代次发布、当前投影仍与本代完全一致的条件下补充；证据片段还需逐字段匹配标题、类型、状态、节点键和完整时间。无法绑定时仅显示本代已保存的原始时间表达、官方链接和更正原因，不取更新的未发布事实。
- `excerpts/evidence` 是需转义的文本，可能含 HTML 字面内容，不能放进 `innerHTML`。不返回文章正文块、完整候选、审核人、内部锁或投影 JSON。
- 事件详情是当前完整代次内的节点时间线，不是无限历史档案；同一事件下发布时间不一致时汇总 `official.publishedAt=null`，节点仍保留各自的时间。

## 缓存、失败和读量

公共响应允许缓存；剩余新鲜时间以代次 `publishedAt + PUBLIC_CACHE_FRESH` 计算，读操作不续命。陈旧代次仍可响应，但 `stale=true`、实际发布时间不变，HTTP `max-age=0, must-revalidate`。不配置 stale-while-revalidate，避免过期响应仍带 `stale=false`。此模块不供私人 Feed 使用。

没有完整代次：catalog/status 的 `publication=null`；events/detail 返回 503。查询失败、行超字节保护、详情超节点/字节保护、待审精确计数超过保护值或无法归属、来源数量超过保护值均明确不可用；不截断详情或计数冒充完整结果。

没有调用整代 `readCurrentPublicSnapshot().all()`，因为那会令单次读量随整代增长。本模块以相同 `state=current` 为权威、用索引分片读取，并在输出前再次核对代次身份；未改共享快照构建器。P3-06 后续合入时需变基核对这一读模型。

所有保护值来自 `PUBLIC_READ_LIMITS`。SQL 查询数上界：catalog 1；events 8（3 个游戏、最多两批证据）；detail 13（最大详情节点数分 10 批证据）；status 公共新增部分 5，另沿用注册和邮件开关查询。每条 SQL 绑定参数个数固定；证据输入按 scanPage 分块，原始节点字节上限 × scanPage 加有界封装低于 D1 单值上限。响应序列化后再次按 UTF-8 字节检查；列表超预算时缩小该页并从最后已消费身份续取，单节点/详情不可容纳则明确报错。

新增迁移只增加四个索引，无新表、无新保留数据。暂取 `0020_public_read_indexes.sql`（基线 main 为 `a1b6084`）；若 P3-06 先占用 0020，后合入者改为合入时下一个编号。

## 本地实测记录

2026-09-30，本地 workerd/Miniflare D1，全部为 synthetic 数据；没有生产访问或真实发送。

`src/storage/schema.test.ts` 的 A-P3-PUBLIC 基准使用生产 SQL。分别加入 2,000 条旧代次与节点、已审核候选、无关来源、晚于发布的同节点证据后：

| 热查询 | baseline rows_read | 增加历史后 |
| --- | ---: | ---: |
| head | 1 | 1 |
| page | 90 | 90 |
| detail | 1 | 1 |
| changes | 1 | 1 |
| sources | 2 | 2 |
| pending | 36 | 36 |
| notice | 8 | 8 |

`src/public/read.test.ts` 构造 1,000 个实际尺寸节点、整代序列化超过 2 MB，遍历所有按字节缩小的页，断言无重复/遗漏、每页不超过注册表响应字节上限。并发用例暂停真实 D1 的分片读取、在另一操作中切换真实 current 代次，然后恢复读取，确认返回 conflict。

外部 CDN 缓存行为和生产部署未执行；这些本地证据不替代 P0/P5 放行。
