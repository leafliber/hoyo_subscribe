# 合同基线索引

> **这份文件不是合同**，是把主方案 v2.1 与前端 v1.0 中跨阶段反复使用的枚举、公式与边界集中到一处，避免执行者每次通读 160 KB。
> 每条都标注了合同出处。**有任何歧义，回到出处原文**；本文件与原文冲突时以原文为准，并同时修正本文件。

## 0. 已生效的合同修订（ADR）

两份合同的正文自 2026-09-22 导入后不改写；已接受的 ADR 是增补或修订，**被修订的章节以 ADR 为准**。下表按合同章节列出修订它的 ADR 与现行规则（2026-10-06 整理）。部分 ADR 自己的"受影响的合同"表没有点名某一节，但决策正文改到了它，也一并列入。0002 已被 0003 取代，0004 为预留编号，均不列。

**主方案 v2.1**

| 章节 | ADR | 现行规则 |
| --- | --- | --- |
| §1.2 本版明确改变的合同 | 0003 | "可持续邮件预算"改为纯 UTC 日额度，不再有月预算与日平滑 |
| §3.1 来源适配 | 0001、0016 | 生产只登记三个游戏内公告来源（`level` + 登出态哑 `uid`），同一响应读 `data.list` 与 `data.pic_list`；米游社下线 |
| §3.2 采集与版本 | 0016、0019 | 图文资讯条目外部 ID 加 `pic-` 前缀；标题为空且正文没有可读文字的图文资讯条目不入库 |
| §3.3 Event / Milestone 合同 | 0011、0013、0019、0027 | `deterministic_derived` 新增版本锚点推导与补全年份（参照依次为同篇日期、所属版本更新开始、发布日期、本站首次采集日期）；斜线、横线两种完整时刻都算 `official_explicit`（见本文 §1） |
| §3.4 规则、模型与人工三条发布路径 | 0009、0010、0018 | AI 草稿只做预填，管理员按看到的草稿版本采用并批准；「跳过审核」开启时，合格的新草稿由系统按模型路径批准 |
| §3.5 模型预算与降级 | 0009、0010 | 草稿模型 glm-5.3-flash，按实际输入预占，日累计不超过 `AI_SOFT_DAY`；模型抽取的计费 profile 仍未配置（P3-09 未做） |
| §3.6 发布一致性 | 0011、0018 | 版本时间表、补全年份的变化不自动改已发布事件；系统批准的发布不加人工锁，疑似重复留给人工 |
| §7.8 可选 Web Push | 0025 | 推送服务登记表（FCM、Mozilla、Apple 精确主机，WNS 单标签子域），登记与外发前各校验一次、不跟随重定向；登记与可见激活分两步（`POST` 交付一次 receipt token，页面存好后 `PATCH activate` 发激活通知）；状态 pending / active / paused / gone，暂停后恢复须重新验证；401/403 自动关闭 `push_enabled`、不动绑定；408/429/5xx 按 `WATCHDOG_INTERVAL` 翻倍退避；业务通知与邮件共用兴趣匹配、不分两层 |
| §8.1 逻辑数据契约 | 0003、0005、0007、0009、0011、0025 | 管理员审计、系统审计各保留 180 天；新增 `ai_drafts`、`ai_usage_days`（0027）与版本时间表（0028）；`usage_periods` 不含 envelope/carry；0029 为 `push_bindings` 增加激活、测试、暂停事实，新增 `push_messages`（Push"实际哪一条"）与 `users.push_revocation_version` 触发器 |
| §8.2 API 分组 | 0009、0011、0014、0025 | 新增公开 `GET /api/v2/events/{eventId}/articles`；admin 下新增 `review/adopt-draft`、`versions` 等（预览接口见 D2；完整清单见本文 §12）；Push 路由已挂载（本文 §12） |
| §8.3 安全、秘密与日志 | 0021、0022、0024 | 允许 Cloudflare 边缘自动注入的 Web Analytics 信标出现在全部页面（含认证与退订页面），站点自身代码仍不引入第三方追踪代码；静态页面 Referrer-Policy 为 `strict-origin-when-cross-origin`（`apps/web/public/_headers`），Worker 响应仍为 no-referrer；平台调用日志（Workers Logs）已开，会记下带 token 的完整 URL，接受与否待所有者确认 |
| §9.1 唯一预算口径 | 0003 | 只有 UTC 日池：认证 90（其中注册 10）、基础 50、紧急 120，池间不互借 |
| §9.2 按月剩余自动平滑 | 0003 | 删去 envelope、carry、E=1、软线 S、月末片段；两个 floor 按当日剩余 ≤20 触发；恢复入口仍不依赖发信预算 |
| §9.3 初值的数量关系 | 0003 | 认证量按日估算，不超过 `MAIL_AUTH_DAY`；按月的算例作废 |
| §9.4 存量、日额度与回收 | 0025 | Push 租期 `PUSH_LEASE` 由激活、真实处理回执（按 `PUSH_RECEIPT_WRITE_INTERVAL` 合并）、测试与续期续上；到期暂停，暂停或失效超过 `PUSH_STALE_GRACE` 清理，激活过期的 pending 即清理 |
| §10.1 观测与开关 | 0003、0009、0018、0024、0025 | 新增 `review_skip_enabled`（默认关）；`model_enabled` 控制 AI 草稿；月额、envelope 指标作废（开关全表见本文 §13）；平台侧开启 Workers Logs；公开能力 `push` 另核对部署配置（VAPID 等），推送服务 401/403 时系统自动关闭 `push_enabled` |
| §10.3 合并后的验收矩阵 | 0003 | 月末片段、envelope/carry、认证软线相关用例作废 |
| §10.5 仓库、配置与迁移 | 0003 | 禁止项改为"不得恢复月度池、envelope、carry、认证软线"（AGENTS.md §3） |
| 附录 A.1 产品、来源与后台 | 0012、0016 | `API_BODY_MAX_BYTES` 仍为 8 KiB，候选另有 `CANDIDATE_MAX_BYTES`；`SOURCE_LIMIT_PROFILE` 只保留三个来源 |
| 附录 A.3 日历、通知有效期与模型 | 0006、0009、0010、0012、0013、0015、0027 | `PUBLIC_CACHE_FRESH` 3600；私人预览限流 60 秒 30 次；AI 草稿参数（单次最大预占 1,238）；候选上限 32 KiB；补全年份窗口 −30/+330 天，参照为首次采集日期时 −30/+90 天 |
| 附录 A.4 邮件与 Push | 0003 | 席位 100、常规 40；日池合计 260，不超过平台 1,000；两个 floor 各 20；删去五个 `*_MONTH` |
| 附录 A.5 保留与配置依赖 | 0003、0005、0006、0007、0009、0010、0012、0013、0027 | 邮件等式改为日模型；新增两项审计 TTL，以及 AI、预览限流、候选字节、补全年份窗口（含首次采集窗口）的等式（全表见本文 §11） |

**前端 v1.0**

| 章节 | ADR / 补充合同 | 现行规则 |
| --- | --- | --- |
| §1.3 首版范围 | 0011 | 管理端拆为 `/admin/`、`/admin/versions/`、`/admin/settings/` 三页，不进普通导航 |
| §4.1 页面骨架 | 0017、0020、0028 | 筛选行为"游戏、临近截止、筛选"；时间轴自上而下：回看昨天（主轴第一行）→ 当前范围逐日 → "已显示完{档位}"与"显示更多"；时间待定在时间轴下方单独成卡；"即将截止"没有条目时整块不显示 |
| §4.2 筛选 | 0017 | 时间范围移入「筛选」弹层，按钮显示当前档位与筛选计数；清除时恢复默认档 |
| §4.3 条目与排序 | 0015、0017、0020 | 先后顺序统一用 contracts `compareScheduleNodes`；全天条目排在当天精确条目之后；结束节点叫"活动结束"；用官方游戏图标；今天总在轴上 |
| §4.4 时间与状态呈现 | 0011、0013、0027、0028 | 推导出的时间在详情里写明推导依据（版本锚点、补全年份；补全年份的依据句涵盖首次采集日期）；近期重要变更与节点、详情的 `change` 不收没有任何曾公开旧时间的改期（contracts `isPublicChange`），共享更正层不变 |
| §4.5 数据状态与空结果 | 0015 | 公开读取为 `no-cache`；页面开满 1 小时显示"内容可能已过时/当前离线"与信息获取时间，并给刷新按钮 |
| §5 事件详情 | 0014、0015、0017 | "查看官方公告"打开本站存档的原文弹窗；删去说明句；时间线用同一先后规则 |
| §9.1 日历订阅 | 0023 | 界面统一称"订阅链接 / 链接"；四项事实为 链接状态 / 使用的设置 / 内容输出 / 日历应用拉取，客户端情况在"查看订阅步骤"里说明；含义不变 |
| §9.3 本浏览器通知 | 0025 | 订阅页"浏览器通知"卡片只在能力开放或本人已有绑定时出现；点击"在当前浏览器开启通知"后才申请权限、登记、发激活通知；权限与绑定状态分开显示；绑定属于其他账号时用户可明确选择为当前账号重新订阅（新端点），不认领他人绑定；iPhone/iPad 需添加到主屏幕（新增 `manifest.webmanifest`） |
| §10.1、§10.2 账号页与退出 | 0025 | 账号页"浏览器通知"分区列出本账号全部浏览器（本浏览器按本机绑定 ID 标出）；"退出并暂停本浏览器通知"只在本浏览器有本账号可暂停的通知时出现，先暂停（用当前会话）再退出，逐项报告 |
| §11.1 视觉方向 | 0015、0020 | 游戏色只用于已选胶囊；截止 24 小时内为高危、72 小时内为临近；已过条目用次要文字色 |
| §11.3 错误与重试 | 0023 | 不设全站故障横幅；故障由各功能区状态区与服务状态页说明，本节的反馈要求对这些状态区照样适用 |
| §12.2 对接责任 | D2、D3、0014 | 权威预览与展示状态字段由 D2、D3 定义；公开读取增加原文子资源 |
| §13 D1′ 行 | F1-02 卡 D1′；0017、0020、0023 | 默认近 3 天；首页五档：今天 / 近3天 / 近7天 / 近30天 / 全部（旧链接 `range=90d` 按"全部"读，contracts 与公开接口保留 `90d`）；昨天在主轴顶部、默认折叠 |
| §13.2 D2 的处理原则 | D2；0006、0008、0015 | 浏览器用 `/api/v2/calendar/nodes` 自己算；启用以 `/api/v2/me/calendar/preview` 为准并核对订阅版本与发布代次；极大 blocked 集合可能取不全；续页游标有效 1 小时 |
| §13.3 D3 的最小语义清单 | D3 | 服务端只给事实，浏览器用 contracts 纯函数推导置灰；操作结果分四种；`GET /api/v2/me` 汇总 |
| §14.1 体验与交互验收矩阵 | 0015 | U02 读作"活动结束与奖励截止"，验收语义不变 |

## 1. 枚举（§3.3）

| 维度 | 取值 |
| --- | --- |
| 事件类型 | `livestream` / `maintenance` / `limited_event` / `gacha` |
| 节点类型 | `start` / `end` / `phase_unlock` / `reward_deadline` / `expected_end` / `actual_end` |
| 审核状态 | `pending` / `approved` / `rejected` |
| 事件状态 | `scheduled` / `postponed` / `cancelled` / `retracted`（`retracted` = 本站纠错，**不是**官方取消） |
| 时间依据 | `official_explicit` / `deterministic_derived` / `official_estimate` / `unresolved` |
| 时间精度 | `datetime` / `date` / `unknown` |
| 订阅行状态 | `uninitialized` / `initialized`（单向，§4.4、§5.1） |
| 会话状态 | `pending` / `active` / `revoked`（§4.5） |
| 发送状态 | `pending` / `leased` / `calling_provider` / `accepted` / `retry_wait` / `unknown` / `deferred` / `bounced` / `failed` / `complained` / `rejected` / `skipped` / `superseded` / `expired`（§7.4） |

**只有证据通过、依据为 `official_explicit` 或 `deterministic_derived` 且 precision 为 `datetime` 的时间可用于提醒**（contracts `time.ts`）；预计与未知时间可在 Web 标注但不冒充精确提醒（§3.3）。只推出日期的推导（版本更新锚点、只写日期的补全年份）不进精确提醒。

ADR-0011（P3-19）版本锚点的确定性推导，唯一定义在 contracts `deriveVersionTime`：

| 原始表达（必须整体就是锚点） | 推导结果 | 用到的确认值 |
| --- | --- | --- |
| `X.Y版本更新后` / `更新完成后` / `更新开始后` / `上线后` / `开启后` / `上线起`（可带前缀"自"），以及 `X.Y版更后`（后两种为 ADR-0013 新增） | 更新开始当天的日期（北京时间），precision `date`，不推出几点 | 该版本的更新开始 |
| `X.Y版本结束` / `结束前` / `结束时` | 版本结束时刻，precision `datetime`，可用于提醒 | 该版本的结束：官方写明的时刻，或紧接着的下一版本（小版本+1，没有时大版本+1 的 .0）已确认的更新开始 |

两者的 `time_basis` 都是 `deterministic_derived`，原始表达原样保留；只推导依据为 `unresolved` 的未定节点。`结束后`、夹带其他文字的表达和官方"预计"（`official_estimate`）的锚点都不推导。确认值只来自管理端版本时间表，未确认时保持 `unknown`。人工写入或批准时，版本锚点节点必须与推导一致（`version_derivation_mismatch`）。公开详情的时间依据里要写明推导依据（前端 §4.4）。

ADR-0013（P3-21）补全年份，唯一定义在 contracts `completeYear`：原始表达整体为"M月D日"（可带 `HH:MM(:SS)` 与"(UTC+8)""（服务器时间）"注记）的未定节点，参照日期依次取正文里最早的四位年份日期、所属版本（标题唯一，否则全文唯一的版本号）已确认的更新开始、公告发布日期、本站首次采集日期（`articles.first_seen_at`，ADR-0027 / P3-26）；取落在参照日期前 `beforeDays`（30）天到后 `afterDays`（330）天之内的唯一年份（`YEAR_COMPLETION_WINDOW`；参照为首次采集日期时用 `YEAR_COMPLETION_CAPTURE_WINDOW`，前 30 天、后 90 天），没有符合的或没有参照时保持未定。只写日期的补成日期，写了时刻的按北京时间补成精确时刻；`time_basis` 为 `deterministic_derived`，原文保留；官方"预计"不补。推导与版本锚点同在读取时进行，人工写入或批准时同样核对（`version_derivation_mismatch`）。

官方明确时间（`official_explicit`）的完整写法："YYYY/MM/DD HH:MM(:SS)"与"YYYY-MM-DD HH:MM(:SS)"（后者为 ADR-0019 新增），按 UTC+8 解析并做往返校验，分隔符前后必须一致；解析函数在 Worker `extraction/time.ts`，草稿构建与候选证据校验共用。规则白名单模板仍只认斜线写法，规则路径数正文日期时把横线写法算进去、多出的日期转人工。

## 2. 凭证与授权边界（§1.3）

| 凭证 | 能做什么 | 绝对不能做什么 |
| --- | --- | --- |
| 登录会话 Cookie `__Host-session` | 管理本人资源 | 不进 URL / localStorage / 导出 |
| 预认证 Cookie `__Host-preauth` | 绑定挑战与 CSRF | 不升级为正式会话 |
| Feed token | 只读日历 | 不授权账号操作 |
| 退订 token | 关闭**对应地址**的业务邮件 | 不读写账号 |
| Push receipt token | 确认本浏览器接收 | 不取邮箱、不改账号、不管别的设备 |
| 恢复码 | 紧急停用（**不消费**）/ 恢复登录（消费一次） | 不证明新邮箱所有权 |

退出本机、关闭邮件、暂停浏览器通知、停用日历、删除账号是**五个不同操作**，互不连带。

Push receipt token 由服务器生成，只在登记响应里出现一次，库里只存 SHA-256；激活还要本轮随机挑战（只出现在端到端加密的激活通知里），业务处理回执还要消息 ID（ADR-0025）。

## 3. 订阅配置模型（§5.1）

```json
{
  "schema_version": 3,
  "revision": 1,
  "scope": {"games": ["genshin","hsr"], "regions": ["CN"]},
  "calendar": {
    "event_types": ["livestream","maintenance","limited_event"],
    "node_types": ["start","end","reward_deadline"],
    "alarms_enabled": true
  },
  "notifications": {
    "rule_ids": ["livestream_start_1h","limited_end_1d"],
    "new_event": false, "important_change": true,
    "cancelled_or_retracted": true, "late_discovery": true
  }
}
```

- 上例**只表示结构**，初值见附录 A.1。数组为有限枚举，去重排序，拒绝未知键与额外层级。
- `scope` 与 `calendar.event_types` **非空约束只对 `initialized` 成立**。
- `notifications.rule_ids` **可以为空**，且为空时变更开关必须仍可开启（§5.3）。
- `email_channels.routine_enabled` 属于通道状态，**不进订阅 JSON**（§7.5）。
- 邮件 enabled、设备权限、Feed 状态是独立服务状态，不由 JSON 里的布尔值冒充。

## 4. 四类设置的作用域（§5.1、§5.3；前端 §3.2）

```text
scope                          → 同时限制日历与通知的游戏/区域
calendar.event_types/node_types→ 仅控制基础可见节点
notifications.rule_ids         → 精确提前提醒的唯一业务选择源
                                 （发送资格【不】与 calendar.node_types 隐式相交）
变更通知范围 = scope ∩ ( calendar.event_types ∪ rule_ids 所涉及的事件类型 )
```

取并集的理由：日历里看得见的事件出了变化该被告知；只选了提醒规则、没把类型放进日历显示的用户也不该漏掉取消。

## 5. 日历投影（§5.2、§6）

```text
有效日历节点 = 基础可见节点 ∪ 当前提醒规则需要的节点
              （均受 scope、时间依据及第 6 章窗口合同约束）

UID      = feed_namespace + milestone_id + 固定日历命名空间
SEQUENCE = public_ical_revision(milestone) + view_revision(feed)
```

- 提醒所需但被基础筛选隐藏的节点显示为**"提醒关联节点"**，沿用同一 Milestone/UID，不另造重复事件。
- 只对合法精确节点嵌入 DISPLAY VALARM；同节点相同提前量去重；预计与未知节点不生成精确闹钟。
- 基础窗口 `FEED_PAST_DAYS` / `FEED_FUTURE_DAYS`，按固定 UTC 日桶；纯日期节点按保存的日期语义判断。
- DTSTAMP/LAST-MODIFIED 取实际公共/Feed 变更时间，**不每次设为 now**。
- SEQUENCE 按协议非负整数范围校验，接近上限**停下并迁移，不回绕**。

### 5.1 共享更正层（§6.3）

| 变化 | 当前响应 |
| --- | --- |
| 有明确新时间的改期 | 同 UID 输出真实新时间 + 更高公共版本 |
| 改期越过基础窗口未来端 | 保留期内仍通过共享层输出真实新时间 |
| 官方取消 / 系统撤回 / 节点删除 / 延期但新时间未知 | 用最近已发布时间输出 CANCELLED，分别说明事实原因，**不虚构新日期** |
| 分类/归属纠正 | 新分类显示正确节点；旧分类按完整快照删除语义移除 |
| 纯自然窗口退出或用户隐藏 | 从完整快照移除，**不伪称官方取消** |

**更正层条目与基础节点走同一套用户筛选**——用户隐藏了某类节点，就不该凭空收到该类型的"已取消"条目。更正层是共享存储，不是绕过筛选的旁路。

保留截止 = `max(最后更正时间 + CAL_PATCH_MIN_DAYS, 仍需覆盖的旧节点最晚时间 + CAL_PATCH_TAIL_DAYS)`。连续改期累计旧时间水位。

### 5.2 缩水守卫（§6.5）

```text
若  本次条目数 相对 last_served_node_count 下降 > FEED_SHRINK_GUARD_RATIO
且  view_revision 未变
且  公共代次无对应的取消/删除/窗口推移证据
且  条目数 >= FEED_SHRINK_GUARD_MIN
则  拒绝返回该响应 → 503 + 告警
```

理由：完整快照下"少输出一条"等于**向客户端下达删除指令**。客户端对 5xx 的常规行为是保留上一次成功结果，正是需要的兜底。守卫只拦无法解释的收缩；用户自行缩小筛选（`view_revision` 变化）或事实确实取消（公共代次有证据）照常输出。

实现：contracts `feedShrinkBlocked`；#90 起以快照节点的内容代次戳 `content_generation` 判断哪些节点原样属于上次输出的那一代，判定式不变。

前端表现（前端 §9.1、U21a）：显示"本次输出未通过完整性检查，已暂停更新以保护你现有的日历内容"，给出上次成功时间与条目数、重试与联系入口；**不得显示为普通网络错误，不得建议重置地址或重新订阅**。

### 5.3 读路径（§6.6）

```text
校验方法/长度/token 规范编码
 → 主状态验证 Feed + User + token 代次 + 恢复 epoch
 → 取云配置、view_revision、当前完整发布代次
 → 只读该代次的公共快照与更正层（缓存代次不符则回源）
 → 计算基础节点/提醒关联节点，按同一筛选取更正层，组装完整 ICS
 → 再核对授权代次、配置版本、公共数据代次；变化则有界重试
 → 缩水守卫
 → 授权后处理 HEAD / ETag / If-None-Match
 → Cache-Control: private, no-store
```

个人响应不进公共 CDN；授权数据库不可用返回 503（即使有旧内容）；ETag 来自实际内容与版本，不用条目数量或请求时间。

`last_feed_poll_at` 随授权查询在同一条 D1 条件更新里完成，每 `FEED_ACTIVITY_WRITE_INTERVAL` 最多写一次；**写入失败不改变本次日历内容，但必须计入 `activity_write_failures`**，且指标异常或最近成功写入早于 `RECLAIM_TELEMETRY_STALE_HOURS` 时**全局暂停账号与席位回收**。

## 6. 通知调度（§7）

### 6.1 优先级阶梯（唯一，不由实现临时解释）

```text
取消/撤回 > 重要更正 > 晚发现 > 常规提前提醒 > 新事件公布
前三档 → 紧急池      后两档 → 基础池
```

### 6.2 同批次合并（§7.3）

- 合并范围：同一用户、同一批次、同一优先级组内所有已到期未过期候选，外加 `due_at` 落在 `MAIL_DIGEST_WINDOW` 内的即将到期候选。
- **只允许提前发送，不允许推迟任何一条**（因此不与 `REMINDER_GRACE` 冲突）。
- 合并后计为**一次**发送机会、一个 MailOutbox 意图；每条 Delivery 各自保留 `(node, schedule_revision, rule_id, channel, target)` 去重键并记录共享的 `mail_outbox` 引用。
- 跨优先级不合并。

游标在**批准一次发送尝试**时推进（unknown/失败也算已获机会）；明确失去资格则跳过、不扣机会。每个优先级/预算池单独保存游标，不按注册顺序重置。

### 6.3 晚发现（§7.2）

| 情况 | 行为 |
| --- | --- |
| 节点未发生、提前窗口已过 | 创建立即到期的 late_discovery，不超过节点时间与自身有效期 |
| 开始节点刚过、仍在补报窗口且无已确认结束事实 | 可补报"刚收录的安排已到计划开始时间"，**不声称正在进行或尚未结束** |
| 截止已过 / 已确认结束 / 陈旧回填 | 不补发 |
| 普通提前提醒仍在有效窗口 | 继续原发生项，不再生成晚发现 |

晚发现走**紧急池**（没有 VALARM 兜底）。与普通提醒共享去重族 `(node, schedule_revision, rule_id, channel, target)`。

### 6.4 邮件两层（§7.5）

| 层 | 内容 | 默认 | 名额 | 池 |
| --- | --- | --- | --- | --- |
| 邮件席位 `email_channels.enabled` | 取消/撤回、重要更正、晚发现 | 用户同意后开启 | `MAIL_SEATS_MAX = 100` | 紧急池 |
| 常规提醒邮件 `routine_enabled` | 常规提前提醒、新事件公布 | **关闭** | `MAIL_ROUTINE_SEATS_MAX = 40`（席位子集） | 基础池 |

第二层默认关闭的理由：`CALENDAR_ALARMS_DEFAULT = true` 之后，启用了个人日历的用户本地已收到同一提醒，再发邮件是重复。

## 7. 预算（§9.1；**按 ADR-0003 改为纯日额度模型**）

> ADR-0003 取消了月度池、envelope、`carry` 与认证软线。平台侧唯一硬约束是**日上限**
> （`PLATFORM_MAIL_DAY_LIMIT = 1,000`，实测）。每个 UTC 日独立，**不跨日结转**。

### 7.1 三个日池

```text
每个 UTC 日开始时重置为固定日额度，池之间不互借：

  认证池  MAIL_AUTH_DAY    = 90    （新注册子额度 MAIL_SIGNUP_AUTH_DAY = 10）
  基础池  MAIL_BASE_DAY    = 50    （常规提前提醒、新事件公布）
  紧急池  MAIL_URGENT_DAY  = 120   （取消/撤回、重要更正、晚发现）

  MAIL_TOTAL_DAY = 260 <= PLATFORM_MAIL_DAY_LIMIT = 1,000

当日用尽即当日停发，次日自动恢复。`settled + reserved + uncertain` 均占用当日额度。
```

### 7.2 降级（口径为**当日剩余**）

```text
当日紧急池剩余 <= MAIL_URGENT_FLOOR (20)
  → 收紧为只发取消/撤回这一最高档

当日认证池剩余 <= MAIL_AUTH_FLOOR (20)
  → 只接受既有账号的首次登录意图
  → 暂停新注册发信与全部重发
  → 页面明确标示处于认证降级
```

**恢复入口不依赖发信预算**——认证降级期间用户仍能取回控制权的唯一保障（§9.2 保留条款）。

### 7.3 紧急池为什么是 120 而不是 100

§9.1 要求「一次官方取消当天覆盖全部席位」。若 `MAIL_URGENT_DAY` 恰等于 `MAIL_SEATS_MAX`，
一次全量取消就把当天打空，floor 永远来不及触发。因此：

```text
MAIL_URGENT_DAY >= MAIL_SEATS_MAX + MAIL_URGENT_FLOOR
120             >= 100            + 20                （取等号）
```

一次全量取消后当天余 20，恰好落到 floor 上自动收紧。

**判定用 `<=` 而不是 `<`**：floor 是**储备**，降到储备线就该保护它，
而不是先烧穿一封再说。取 `<` 的话上面那条等式就失去意义——
`MAIL_URGENT_DAY = MAIL_SEATS_MAX + MAIL_URGENT_FLOOR` 的全部目的
就是让一次全量取消之后**恰好**触发降级。两个 floor 同口径。

### 7.4 已废止（不得恢复，见 AGENTS.md 禁止清单）

`MAIL_TOTAL_MONTH` / `MAIL_EXISTING_AUTH_MONTH` / `MAIL_SIGNUP_AUTH_MONTH` /
`MAIL_BASE_MONTH` / `MAIL_URGENT_MONTH`、envelope 公式、`carry`、`E = 1` 兜底、
认证软线 `S`、月末半日片段、跨账单周期的预留释放与重新预占。

**已知代价**：跨日结转没有了。一天内发生两次全量取消时，第二次只能覆盖 20 个席位
（该场景的概率与后果已由所有者接受，见 ADR-0003）。

## 8. 认证与会话时序（§4.3、§4.5、附录 A.5）

```text
PREAUTH_MIN_TTL >= OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN
OTP 绑定 Cookie 截止 >= 最晚挑战截止 + AUTH_COMPLETION_TTL + PREAUTH_MARGIN

SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER > SESSION_IDLE_TTL > SESSION_RENEW_INTERVAL
SESSION_IDLE_TTL > SESSION_EXPIRY_NOTICE
```

**第一式是不等式，不是等式——且存在性折叠依赖它**（P2-02 验收裁定，2026-09-22）：

预认证 Cookie 同值续期的目标为
`max(当前截止, now + PREAUTH_MIN_TTL, 最晚未过期挑战截止 + AUTH_COMPLETION_TTL + PREAUTH_MARGIN)`。
任何未过期挑战的截止 ≤ `now + OTP_TTL`，故第三项 ≤ `now + OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN`
≤ `now + PREAUTH_MIN_TTL` = 第二项——**第三项永远超不过下限项**。于是续期取值与"本次申请
是否真的创建了挑战"**路径无关**，四条折叠路径可附加同一个 `Set-Cookie`，不经其取值回显
邮箱注册状态。

这条安全性挂在**不等式**上（`params:verify` 每次校验），不挂在当前参数恰好取等
（1320 = 600 + 600 + 120）的巧合上。调参时保持不等式成立即可，**不必**保持相等。

### 8.1 投递地址解析（§4.1，跨卡红线）

身份键折叠大小写（`canonicalizeEmail`），**投递地址不折叠**。已有身份再次登录时，验证码
只发到数据库中已验证的实际投递地址，**不按请求中不同大小写的地址改投**——极少数邮箱
服务商的本地部分确实大小写敏感，按请求地址投递会把验证码发给另一个人。

**任何路径拿不到已验证投递地址时一律失败关闭，绝不回退到请求原文地址。**
这条对申请、重发、换邮箱、恢复各入口同等生效。创建路径失败关闭而重发路径回退，等于把
同一条红线在两个入口上判成两种结果（P2-02 验收发现，已在返工 `78a77932` 中改为失败关闭）。

`signup` 用途没有已验证地址，其投递串按请求原文形态取（去两端空白、域名小写去尾点、
**本地部分保留原大小写**）——这是首次绑定，不是改投。

**挑战绑定的投递地址独立落库（2026-09-27 裁定）**：该地址原本只存在于验证码载荷（`otp-mail-payload`）里，
而载荷按 §4.3 在发送被接受后清除——P4 实现「发送后清除」后，消费建号与重发都会失去地址来源，只剩 verify
请求里的串，而用它就是改投。因此每个挑战创建时把实际投递地址另存为受控密文（`auth_challenges` 新列），
**随挑战生命周期清除，不随发送清除**。新账号的 `users.email_ciphertext` 取自这一列，不取 verify 请求里的串。

### 8.2 受控密文的 AAD 记录 ID（跨卡约定）

| 记录类型 | AAD 记录 ID | 定义卡 | 必须遵守的卡 |
| --- | --- | --- | --- |
| `delivery-email-address` | `users.id` | P2-02（读取侧） | P2-03（建号写入）、P2-07（换邮箱） |
| `otp-mail-payload` | `mail_outbox` 行 id | P2-02 | P4 发送阶段 |
| `delivery-email-address`（挑战绑定的投递地址） | `auth_challenges.id` | P2-03 | P2-03 消费建号、P2-02 重发 |
| `auth-completion-receipt` | `auth_challenges.id` | P2-03 | P2-04 激活时清除 |

AAD 不一致 = 解密认证失败。写入侧与读取侧必须用同一个记录 ID，不得各自约定。

**只存校验值的秘密用什么算（2026-09-27 验收更正）**：高熵随机 token（会话、Feed，≥ `SECRET_BITS`）
存 **SHA-256**；带密钥的 MAC/pepper **只用于低熵输入**（验证码、邮箱 lookup），因为只有那里能被穷举。
此前登记表把会话与 Feed token 写成 HMAC 是过度规定——主方案 §4.5、§6.1 只要求"只存 hash"，
九个密钥用途里也没有给它们的一项。单一来源：`packages/contracts/src/crypto-types/storage-policy.ts`。

### 8.3 其余

**"真实前台操作"的定义（不留给实现解释，§4.5、前端 §12.2）**：用户在本会话中完成一次**显式的状态变更或账号管理请求**——保存订阅、启用/停用通道、管理会话或设备、换邮箱、轮换恢复码、导出数据——之后前端可发起一次续期 POST。

**不算**：页面加载、被动 GET、路由切换、返回前台、预取、可见性事件、后台标签页、Service Worker、外部日历拉取、收到邮件。

绝对期限在**创建会话时**取 `SESSION_ABSOLUTE_TTL ± SESSION_ABSOLUTE_JITTER` 内的随机值并固定写入（摊平上线期集中到期）。认证预算按 `min(抖动后绝对期限, SESSION_IDLE_TTL)` 估算，**不按绝对期限**（§9.3）。

**激活窗口 = `min(AUTH_COMPLETION_TTL, SESSION_PENDING_TTL)`（P2-03/P2-04 实现事实，2026-09-28 登记）**：
激活事务要把完成回执一并清掉，而 `conditionalCommit` 对"守卫命中、依赖写入零行"抛不变量错误，所以激活守卫要求
回执**仍在且未过期**；回执期限又取 `min(now + AUTH_COMPLETION_TTL, pending 期限)`。当前两值同为 600 秒，窗口与
pending 期限重合，没有问题。**若把 `AUTH_COMPLETION_TTL` 调得比 `SESSION_PENDING_TTL` 短，pending 后段会出现
"会话有效却永远激活不了"的死区**——调这两个参数前先改激活设计。

## 9. 恢复码（§4.6）

| 动作 | 是否消费恢复码 | 之后 |
| --- | --- | --- |
| 紧急停用 | **否** | 撤销所有会话与 Feed、关闭业务邮件、暂停 Push；不返回任何私人数据；幂等；受 `RECOVERY_ATTEMPTS_HOUR/DAY` 限制 |
| 恢复登录 | **是** | 执行同样的安全暂停 → pending 恢复会话 → 激活后**立即交付新恢复码**；在用户完成保存确认前**只允许查看、导出、保存新码、删除账号**，不得启用通道或换邮箱 |

`recovery_id` 与秘密一起校验，单独提交 `recovery_id` 不得产生存在性差异。

## 10. 提醒规则注册表（附录 A.6；前端 §6.2 文案映射）

| rule_id | 事件类型 | 节点 | 提前量 | 用户文案 |
| --- | --- | --- | --- | --- |
| `livestream_start_1h` | livestream | start | 3,600 s | 前瞻开始前 1 小时 |
| `maintenance_start_1h` | maintenance | start | 3,600 s | 维护开始前 1 小时 |
| `limited_start_1h` | limited_event | start | 3,600 s | 限时活动开始前 1 小时 |
| `limited_end_1d` | limited_event | end | 86,400 s | 限时活动结束前 1 天 |
| `gacha_start_1h` | gacha | start | 3,600 s | 卡池开始前 1 小时 |
| `gacha_end_1d` | gacha | end | 86,400 s | 卡池结束前 1 天 |
| `phase_unlock_1h` | limited_event | phase_unlock | 3,600 s | 活动阶段解锁前 1 小时 |
| `reward_deadline_1d` | limited_event | reward_deadline | 86,400 s | 奖励领取截止前 1 天 |

规则 ID 一旦发布**不得改成另一种提前量**；新增语义用新 ID。"前 1 天"沿用固定提前量，**不改成前一日零点**。

## 11. 附录 A.5 启动等式（`pnpm params:verify` 必须实现全部）

`pnpm params:verify` 与 Worker 启动路径执行同一份校验（`packages/contracts/src/params/verify.ts`），任一不成立即非零退出、拒绝启动。2026-10-06（main `cea8145`）共 36 条数值等式；P3-26（ADR-0027）新增 1 条，现为 **37 条**，全部成立；另有 1 条语义条款由实现保证。新增等式时同步本表（AGENTS.md §4 允许的例外）。

| 组 | 等式 ID | 内容 | 依据 |
| --- | --- | --- | --- |
| 邮件（纯日额度） | `mail-total-day-sum` | `MAIL_TOTAL_DAY = MAIL_AUTH_DAY + MAIL_BASE_DAY + MAIL_URGENT_DAY` | ADR-0003 |
| 邮件（纯日额度） | `mail-total-day-within-platform-limit` | `MAIL_TOTAL_DAY <= PLATFORM_MAIL_DAY_LIMIT`（平台实测日上限） | ADR-0003 |
| 邮件（纯日额度） | `mail-signup-auth-day-subset` | `MAIL_SIGNUP_AUTH_DAY <= MAIL_AUTH_DAY` | ADR-0003 |
| 邮件（纯日额度） | `mail-auth-floor-below-day` | `MAIL_AUTH_FLOOR < MAIL_AUTH_DAY`（floor 必须真正触得到） | ADR-0003 |
| 邮件（纯日额度） | `mail-urgent-floor-below-day` | `MAIL_URGENT_FLOOR < MAIL_URGENT_DAY` | ADR-0003 |
| 邮件（池容量） | `mail-routine-seats-within-seats` | `MAIL_ROUTINE_SEATS_MAX <= MAIL_SEATS_MAX` | §7.5 |
| 邮件（池容量） | `mail-base-day-covers-routine-seats` | `MAIL_BASE_DAY >= MAIL_ROUTINE_SEATS_MAX × MAIL_USER_BASE_DAY` | §9.1 |
| 邮件（池容量） | `mail-urgent-day-covers-seats-plus-floor` | `MAIL_URGENT_DAY >= MAIL_SEATS_MAX + MAIL_URGENT_FLOOR`（本文 §7.3） | §9.1 |
| 认证时序 | `preauth-min-ttl-safe` | `PREAUTH_MIN_TTL >= OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN`（本文 §8） | §4.3 |
| 认证时序 | `otp-cookie-covers-late-challenge` | OTP 绑定 Cookie 截止 >= 最晚挑战截止 + `AUTH_COMPLETION_TTL` + `PREAUTH_MARGIN` | §4.3 |
| 会话时序 | `session-absolute-lower-above-idle` | `SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER > SESSION_IDLE_TTL` | §4.5 |
| 会话时序 | `session-idle-above-renew-interval` | `SESSION_IDLE_TTL > SESSION_RENEW_INTERVAL` | §4.5 |
| 会话时序 | `session-idle-above-expiry-notice` | `SESSION_IDLE_TTL > SESSION_EXPIRY_NOTICE` | §4.5 |
| 其余 | `delivery-dedupe-above-occurrence-ttls` | `DELIVERY_DEDUPE_TTL >` 业务发生项最大有效期（重试余量由调度实现另行加算） | 附录 A.5 |
| 其余 | `feed-shrink-guard-ratio-open-interval` | `0 < FEED_SHRINK_GUARD_RATIO < 1` | §6.5 |
| 预留与容量 | `mail-auth-reserved-within-pending` | `MAIL_AUTH_RESERVED_PENDING <= MAIL_PENDING_MAX` | 附录 A.5 |
| 预留与容量 | `mail-pending-within-record` | `MAIL_PENDING_MAX <= MAIL_RECORD_MAX` | 附录 A.5 |
| 预留与容量 | `mail-unmatched-within-feedback` | `MAIL_UNMATCHED_MAX <= MAIL_FEEDBACK_MAX` | 附录 A.5 |
| 预留与容量 | `delivery-pending-within-record` | `DELIVERY_PENDING_MAX <= DELIVERY_RECORD_MAX` | 附录 A.5 |
| 预留与容量 | `push-active-within-total` | `PUSH_ACTIVE_MAX <= PUSH_TOTAL_MAX` | 附录 A.5 |
| 预留与容量 | `push-pending-within-total` | `PUSH_PENDING_MAX <= PUSH_TOTAL_MAX` | 附录 A.5 |
| 预留与容量 | `push-critical-reserved-within-send-day` | `PUSH_CRITICAL_RESERVED_DAY <= PUSH_SEND_DAY` | 附录 A.5 |
| 预留与容量 | `push-test-day-within-send-day` | `PUSH_TEST_DAY <= PUSH_SEND_DAY` | 附录 A.5 |
| 模型用量（Neurons/日） | `ai-soft-below-hard` | `AI_SOFT_DAY < AI_HARD_DAY` | 附录 A.3 |
| 模型用量（Neurons/日） | `ai-hard-within-included` | `AI_HARD_DAY < AI_INCLUDED_DAY`（账户共用的每日免费额度） | ADR-0009；ENGINEERING §4.1 |
| 模型用量（Neurons/日） | `ai-draft-reservation-within-soft` | `AI_DRAFT_RESERVATION <= AI_SOFT_DAY`；profile 各数值合法 | ADR-0009、ADR-0010 |
| D1 工程上限 | `public-snapshot-chunk-within-d1` | `API_BODY_MAX_BYTES < chunkBytes / 2`；`2 < chunkBytes <= singleValueBytes / 2`；`queryLimit > 18` | P3-06；ENGINEERING §5.4 |
| D1 工程上限 | `candidate-bytes-within-d1` | `API_BODY_MAX_BYTES <= CANDIDATE_MAX_BYTES < chunkBytes / 2` | ADR-0012 |
| 时间推导 | `year-completion-window-single-year` | `YEAR_COMPLETION_WINDOW` 两端为正安全整数且 `beforeDays + afterDays < 365` | ADR-0013 |
| 时间推导 | `year-completion-capture-window-narrower` | `YEAR_COMPLETION_CAPTURE_WINDOW` 两端为正安全整数，且两端都不超过 `YEAR_COMPLETION_WINDOW` 对应的一端 | ADR-0027 |
| 来源上限 | `source-response-caps-within-ceiling` | 每来源 `responseCapsBytes > 0` 且 `<= responseCapCeilingBytes` | P3-08 |
| 公共读保护 | `public-read-bounds` | `PUBLIC_READ_LIMITS` 为正整数；`recentChanges <= scanPage <= detailNodes`；`nodeBytes × (recentChanges + 1) < responseBytes <= FEED_RESPONSE_MAX_BYTES`；`queryBytes <= nodeBytes` | P3-14 |
| 私人预览限流 | `calendar-preview-rate-bounds` | 两参数为正安全整数；`CALENDAR_PREVIEW_RATE_WINDOW < PUBLIC_CACHE_FRESH` | ADR-0006 |
| 回收维护 | `reclaim-query-budget` | `RECLAIM_QUERY_BUDGET` 为安全整数，`>= 9 × MATCH_PAGE + 6` 且低于 D1 每调用 1,000 条 | P5-02 |
| 系统审计 | `system-audit-retention` | `SYSTEM_AUDIT_TTL` 为正安全整数，×1000 后仍为安全整数 | ADR-0007 |
| 观测 | `observability-capacity-ratio` | `0 < OBS_CAPACITY_WARN_RATIO < 1` | P5-01 |
| 观测 | `feedback-maintenance-bounds` | `FEEDBACK_MAINTENANCE_ROUNDS` 为正整数且 `FEEDBACK_MAINTENANCE_ROUNDS × FEEDBACK_BATCH <= MAIL_FEEDBACK_MAX` | P5-01 |

语义条款 `mail-digest-window-forward-only`：`MAIL_DIGEST_WINDOW` 只用于提前发送；合并后任一条的实际发送时间不得晚于其自身 `expires_at`（P4-02 调度实现保证，不在数值校验内）。

### 11.1 各等式的来由与边界（原登记保留）

P5-02 查询预算：`RECLAIM_QUERY_BUDGET` 为安全整数、至少容纳 `9 × MATCH_PAGE + 6` 条（一页最坏语句数及状态读取/提交），且小于 D1 每调用 1000 条平台上限（所有者在 #78 提案后批准 800）；与执行器墙钟同时约束。#90 起流水线清理与旧代回收也共用这份预算，用尽按有界推迟降级并告警。

P5-02 / ADR-0007：`SYSTEM_AUDIT_TTL` 为独立正安全整数，乘 1000 后仍为安全整数；系统审计期限从 `created_at` 计算，历史行先校正后清理。


P3-06 工程等式 `public-snapshot-chunk-within-d1`：`API_BODY_MAX_BYTES < PUBLIC_SNAPSHOT_WRITE_PROFILE.chunkBytes / 2`，`2 < chunkBytes <= singleValueBytes / 2`，`queryLimit > 18`，分块字节数和查询上限为安全整数。只约束 D1 集合写入，不改变日历业务语义（ENGINEERING §5.4）。

P3-20 / ADR-0012 工程等式 `candidate-bytes-within-d1`：`API_BODY_MAX_BYTES <= CANDIDATE_MAX_BYTES < PUBLIC_SNAPSHOT_WRITE_PROFILE.chunkBytes / 2`，`CANDIDATE_MAX_BYTES` 为安全整数。人工新建、修正的候选总能存下；采用 AI 草稿生成的大候选仍在 D1 分块写入的安全界内。单个公共节点仍受 `PUBLIC_READ_LIMITS.nodeBytes` 约束。

P3-21 / ADR-0013 等式 `year-completion-window-single-year`：`YEAR_COMPLETION_WINDOW` 的 `beforeDays`、`afterDays` 为正安全整数，且 `beforeDays + afterDays < 365`。窗口短于一年，没写年份的日期至多一个年份落在窗口内；没有符合的年份时保持未定时刻。

P3-26 / ADR-0027 等式 `year-completion-capture-window-narrower`：`YEAR_COMPLETION_CAPTURE_WINDOW` 的 `beforeDays`、`afterDays` 为正安全整数，且分别不超过 `YEAR_COMPLETION_WINDOW` 的 `beforeDays`、`afterDays`（因此也短于一年）。首次采集日期只会晚于真实发布，窗口只能更窄：后端 90 天时，日期要早于首次采集 275 天以上才会被补到下一年。

> 邮件部分按 **ADR-0003** 改写；其余不变。

```text
# 邮件：纯日额度模型
MAIL_TOTAL_DAY = MAIL_AUTH_DAY + MAIL_BASE_DAY + MAIL_URGENT_DAY     # 260 = 90+50+120
MAIL_TOTAL_DAY <= PLATFORM_MAIL_DAY_LIMIT                            # 260 <= 1,000（实测）
MAIL_SIGNUP_AUTH_DAY <= MAIL_AUTH_DAY                                # 10 <= 90
MAIL_AUTH_FLOOR   < MAIL_AUTH_DAY                                    # 20 < 90
MAIL_URGENT_FLOOR < MAIL_URGENT_DAY                                  # 20 < 120

# 池容量要对得起承诺的名额
MAIL_ROUTINE_SEATS_MAX <= MAIL_SEATS_MAX                             # 40 <= 100
MAIL_BASE_DAY   >= MAIL_ROUTINE_SEATS_MAX × MAIL_USER_BASE_DAY       # 50 >= 40（含 1.25x 重试余量）
MAIL_URGENT_DAY >= MAIL_SEATS_MAX + MAIL_URGENT_FLOOR                # 120 >= 120
    # 一次官方取消要能当天覆盖全部席位，且之后仍触得到 floor

# 合并不得制造新的过期风险
MAIL_DIGEST_WINDOW 只用于提前发送；合并后任一条的实际发送时间不得晚于其自身 expires_at

# 认证时序：下限本身即安全，不依赖实现另行加算
PREAUTH_MIN_TTL >= OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN
OTP绑定Cookie截止 >= 最晚挑战截止 + AUTH_COMPLETION_TTL + PREAUTH_MARGIN

# 会话时序：抖动下界仍须显著大于不活跃期限
SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER > SESSION_IDLE_TTL > SESSION_RENEW_INTERVAL
SESSION_IDLE_TTL > SESSION_EXPIRY_NOTICE

# 其余
DELIVERY_DEDUPE_TTL > 业务发生项最大有效期 + 最大重试余量
0 < FEED_SHRINK_GUARD_RATIO < 1
各预留包含于对应总量；pending <= total；价格/usage单位一致

# P3-08 工程依赖（§3.1 请求大小限制，附录 A.1 SOURCE_LIMIT_PROFILE）
每来源 responseCapsBytes > 0 且 <= responseCapCeilingBytes
```

**已删除的等式**（月度模型的遗留，不得恢复）：
`MAIL_TOTAL_MONTH = …`、`MAIL_AUTH_FLOOR < MAIL_EXISTING_AUTH_MONTH`、
`MAIL_URGENT_FLOOR < MAIL_URGENT_MONTH`、`MAIL_BASE_MONTH >= … × 本账单周期相交UTC日期数 × …`。

P3-14 工程依赖：`PUBLIC_READ_LIMITS` 所有值为正整数；`recentChanges <= scanPage <= detailNodes`；
`nodeBytes × (recentChanges + 1) < responseBytes <= FEED_RESPONSE_MAX_BYTES`；`queryBytes <= nodeBytes`。
近期重要变更期限取当前共享更正的 `retain_until`，条数取 `recentChanges`。详情/单节点超限明确不可用，状态聚合超限为未知，不静默截断。

ADR-0009（P3-17）AI 草稿：`AI_HARD_DAY < AI_INCLUDED_DAY`（10,000，账户共用的每日免费额度）；
`AI_DRAFT_RESERVATION = ⌈((maxInputBytes + templateOverheadTokens) × 输入单价 + maxOutputTokens × 输出单价) / 10⁶⌉ <= AI_SOFT_DAY`
（ADR-0010 后为 1,238，是单次最大预占；每次调用按本篇提示词实际字节代入同一公式），
profile 各数值为正安全整数、推理档位 ∈ {low, high, max}、temperature ∈ [0, 1]。草稿日累计以 `AI_SOFT_DAY` 为上限；`AI_BILLING_PROFILE_CONFIGURED` 仍为 false。

P5-01 所有者 2026-10-02 批准的观测依赖：`0 < OBS_CAPACITY_WARN_RATIO < 1`；
`FEEDBACK_MAINTENANCE_ROUNDS` 为正整数，且 `FEEDBACK_MAINTENANCE_ROUNDS × FEEDBACK_BATCH <= MAIL_FEEDBACK_MAX`。
反馈维护同时受 `EXECUTOR_BATCH_WALL_LIMIT` 约束；平台 query-limit 的真实本地最坏路径测试不得超限。

P3-15 / ADR-0006 启动校验 `calendar-preview-rate-bounds`：`CALENDAR_PREVIEW_RATE_WINDOW` 与
`CALENDAR_PREVIEW_RATE_LIMIT` 均为正安全整数，且 `CALENDAR_PREVIEW_RATE_WINDOW < PUBLIC_CACHE_FRESH`。
首屏与续页共用每会话、每 isolate 的限额；窗口小于新鲜期为等待后的续页留余量，不代替最大分页测量。当前取值 60 < 3600（ADR-0015 起 `PUBLIC_CACHE_FRESH` 为 3600）；公开读取与公开预览的 HTTP 缓存为 `no-cache`。

## 12. API 分组速查（§8.2；2026-10-06 按 Worker 实际路由核对）

| 路径组 | 要点 |
| --- | --- |
| `/api/v2/catalog`、`/api/v2/events`、`/api/v2/events/{eventId}`、`/api/v2/status` | GET 公开；不创建身份、不读 Cookie；`/status` 公布全局 `registration_open`、`mail_sending_available`、来源与能力状态，**不提供按邮箱查询是否注册** |
| `/api/v2/events/{eventId}/articles` | GET 公开（ADR-0014）：该事件本代已发布节点所依据的官方公告正文版本；超过 `PUBLIC_READ_LIMITS.responseBytes` 返回 503 而不截断 |
| `/api/v2/calendar/nodes` | GET 公开节点数据（D2 §2），浏览器按草稿自己算预览 |
| `/api/v2/auth/preauth` | POST 同源初始化预认证 Cookie/CSRF |
| `/api/v2/auth/challenges`（+ `resend` / `verify`） | 用途、预占、限额、浏览器绑定 |
| `/api/v2/auth/complete` | 原 preauth + 操作键领取未激活的短期完成结果 |
| `/api/v2/auth/activate、renew、logout` | pending 激活 / 低频续期 / 仅撤销当前会话 |
| `/api/v2/auth/recovery`、`/api/v2/auth/recovery/code` | `emergency_stop` 幂等且**不消费**；`recover_login` 一次消费并立即交付新码；`recovery/code` 读取与确认保存新恢复码 |
| `/api/v2/me、me/sessions`、`me/sessions/{id}` | 本人资料（只给事实，D3 §1.2）/ 脱敏会话；DELETE 指定本人会话 |
| `/api/v2/me/subscription` | GET/PATCH；`expected_revision`；所有者服务端派生 |
| `/api/v2/me/calendar`（+ `enable` / `disable` / `reset`）、`/api/v2/me/calendar/preview` | GET 专用 URL；三个动作为 POST，**统一会话权限，不额外要求 OTP**；启用另带 `expected_revision`、`publication_generation` 核对（D2 §5）；私人预览受 ADR-0006 限流，极大 blocked 集合见 ADR-0008 |
| `/feeds/u/{token}.ics` | GET/HEAD；只读能力鉴权；304 同样授权；无交互挑战 |
| `/api/v2/me/email-channel` | GET/PUT；两层同意；子名额满时**只拒绝第二层**；不能借此更换收件地址 |
| `/unsubscribe/{token}`、`/email/one-click/{token}` | GET 仅展示；POST 退订；one-click 无登录依赖、不重定向 |
| `/api/v2/me/recent-auth/challenges`（+ `verify`）、`/api/v2/me/recent-auth/recovery` | 用途限定的最近认证（OTP 或恢复码） |
| `/api/v2/me/email-change、recovery-code、delete` | 凭最近认证执行 |
| `/api/v2/me/export` | 本人配置及必要数据，不导出秘密 |
| `/api/v2/me/push-bindings`（GET/POST）、`me/push-bindings/{id}`（PATCH `pause`/`activate`、DELETE）、`me/push-bindings/{id}/test`、`/renew` | 本人管理（ADR-0025）：active 非受限会话 + CSRF；POST 只交付一次 receipt token 不外发；暂停与删除是终止路径 |
| `/api/v2/push-bindings/{id}/activate、processed` | receipt 窄能力：不读 Cookie、不做 CSRF、同源 Origin；凭证/挑战/消息 ID 不符一律 404；只能确认本浏览器接收 |
| `/api/v2/admin/session/bootstrap、access、logout` | 管理员会话：引导秘密或 Access 换短期会话；与用户会话隔离 |
| `/api/v2/admin/review/queue`、`candidates/{id}`、`create`、`revise`、`reject`、`adopt-draft`、`approve`、`correct`、`associate`、`retract` | 候选审核与 AI 草稿采用；每个写操作带理由、`updated_at` 条件写入并审计 |
| `/api/v2/admin/versions`（+ `confirm` / `clear`） | 版本时间表（ADR-0011） |
| `/api/v2/admin/controls` | GET/PUT 运行开关（本文 §13） |
| `/api/v2/admin/observability`（+ `platform`）、`/api/v2/admin/sources/resume`、`/api/v2/admin/delivery/rearm` | 观测视图与平台事实录入；来源维护、投递终态的人工解除（#90） |
| `/api/v2/admin/reclaim`（+ `confirm/{id}`、`resume`） | 回收清单复核与恢复（P5-02） |

## 13. 运行开关（§10.1；P5-01，ADR-0009、ADR-0018）

唯一定义在 contracts `OPERATIONAL_CONTROLS`（`packages/contracts/src/observability/index.ts`）。值存 `system_state`，只接受 JSON boolean；管理端写入必须管理员会话、绑定 CSRF、闭合理由（`OperationalReasonSchema`）、`expected_updated_at` 条件写入与同批审计（实现说明见 `apps/worker/src/shell/observability/README.md`）。

| 开关（`system_state` 键） | 控制什么 | 没有记录时 |
| --- | --- | --- |
| `registration_open` | 新账号注册准入 | 未知 → 关闭 |
| `mail_sending_available` | 全部邮件外发（认证与业务）。公开状态同名字段另核对发信配置、发信绑定与核心退避行 | 未知 → 关闭 |
| `outbound_enabled` | 全部外发总门：邮件、Push、模型调用、来源请求 | 未知 → 关闭 |
| `email_seats_open` / `email_routine_enabled` / `business_mail_enabled` | 新邮件席位、常规提醒层、业务邮件；关闭不改用户同意 | 未知 → 关闭 |
| `push_enabled` | Web Push 登记与外发（ADR-0025）；还要求外发总门开、`read_only` 关、部署配置齐备。推送服务 401/403 时系统自动置 false 并写系统审计 | 未知 → 关闭 |
| `model_enabled` | AI 草稿调用（P3-17 起）；还要求外发总门开、`read_only` 关 | 未知 → 关闭 |
| `automatic_publication_enabled` | 规则路径（白名单模板）已批准候选的自动发布；跳过审核不经此门 | 未知 → 关闭 |
| `review_skip_enabled` | 「跳过审核」（ADR-0018）：只在 AI 草稿可用时生效 | **合同默认 false**（`OPERATIONAL_CONTROL_DEFAULTS`，首次部署后才加的开关）；读取出错仍是未知 |
| `account_reclaim_enabled` / `seat_reclaim_enabled` | 账号、席位回收的运营门；不替代活动水位可靠性门 `reclaim_paused` | 未知 → 关闭 |
| `read_only` | 维护只读：只限制扩大与修改，退订、停用、撤销、删除与管理员恢复操作保留 | 未知 → 按未配置处理 |
| `calendar_enabled` | 日历启用（D3）；不影响已有个人 Feed 的读取与停用 | 未知 → 关闭 |
| `source:<source_id>`（`source_enabled`） | 逐来源抓取；还要求外发总门开、`read_only` 关 | 未知 → 关闭 |

读取失败一律是未知（`unknown`），执行时失败关闭；默认值只能是 false，不能借默认值打开任何能力。公开 `GET /api/v2/status` 只导出 `registration_open`、`mail_sending_available` 与 `capabilities`（calendar / email_seats / routine_email / push）的 open / closed / unknown，不输出预算或私人数据。首次关闭门初始化（2026-10-03）写入的"18 项"是当时 13 个全局开关、4 个来源开关与 `reclaim_paused`。

## 14. 来源注册表（§3.1；ADR-0001、ADR-0016、ADR-0019）

| source_id | 游戏 | 抓取内容 |
| --- | --- | --- |
| `genshin-ann` | 原神 | 游戏内公告 API `getAnnList` / `getAnnContent`：公告目录 `data.list` 与图文资讯目录 `data.pic_list`（外部 ID 加 `pic-` 前缀） |
| `hsr-ann` | 崩坏：星穹铁道 | 同上（跃迁在 `pic_list`） |
| `zzz-ann` | 绝区零 | 同上（调频在 `pic_list`） |

- 请求参数沿用 P0-02 核验的参数集（含 ADR-0001 的登出态哑 `uid` 与 `level`），不自行调整；生产响应上限取 `SOURCE_LIMIT_PROFILE`，读取 `pic_list` 不改变上限。
- 米游社官方资讯（`miyoushe-news`）2026-10-05 下线（ADR-0016）：不再注册，遗留数据按 `RETIRED_SOURCE_IDS` 隔离——轮询待办直接结束、公开状态不列、历史文章不能再用于抽取与发布。
- 图文资讯里标题去噪后为空、正文没有可读文字的条目不入库（ADR-0019）；补上标题后按变更入库。
- 公告列表的 `start_time` / `end_time` 是展示窗口，**不得当作活动时间**（§3.1）。
