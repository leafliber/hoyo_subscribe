# P0-06 · P0 结论表与放行决策记录

整理日期：2026-10-01。验收 ID：**A-P0-GATE**。
基线：`d0fcfe0a0b5ed17451ce4186c421c35a5d496737`，即 [PR #46](https://github.com/leafliber/hoyo_subscribe/pull/46)，已于 2026-10-01T03:59:47Z 合入 main。
依据：[BUILD_PLAN §2](../../BUILD_PLAN.md#2-门禁规则)、[P0-06 任务卡](../../tasks/P0.md)、主方案 §2.3、§10.4；模型降级另依 §3.4、§3.5 及所有者 2026-09-30 决定。

本文汇总仓库已有证据，本次未重做外部实测。表中日期沿用证据原始精度；只有日期的记录不补造时分秒或时区。
“未取得”的时间栏明确表示证据缺失，所附路径是缺口登记依据，不是假装存在的实测结果。E1 自动化检查不能替代 E3 外部事实。
所有路径均指向仓库文件；参数只引用 `packages/contracts/src/params/registry.ts`，本文不另设阈值。

## 1. 门禁结论

| 项目 | 结论 | 证据文件路径与取得时间 | 决策及放行边界 |
| --- | --- | --- | --- |
| G-P0-CAL：Apple Calendar / macOS | 通过 | [docs/evidence/p0/calendar-clients.md](calendar-clients.md)：所有者 2026-09-22 本机 localhost 订阅实测，七步及 VALARM 单独确认 | 继续：门禁已开；“日历提醒可用”仅限该已测客户端。删除、同 UID 重新加入、改期、取消、503 保留旧结果及恢复均通过；版本和刷新延迟另见 §2 |
| G-P0-SOURCE：三个公告来源已有样本与登记 | 通过 | [docs/evidence/p0/source-samples-20260921T174154Z.json](source-samples-20260921T174154Z.json)：2026-09-21T17:41:54.848Z，本机网络 E2；[fixtures/sources/registry.draft.json](../../../fixtures/sources/registry.draft.json)：2026-09-21T17:43:50Z；各来源文件见 §3 | 继续：按门禁表仅部分开，P3-01/P3-02 限 `genshin-ann`、`hsr-ann`、`zzz-ann`；不把本机 E2 写成目标 Cloudflare E3 通过，不代表每种样本均齐 |
| G-P0-SOURCE：米游社正文访问 | 失败 | [docs/evidence/p0/source-samples-20260921T174350Z.json](source-samples-20260921T174350Z.json)：2026-09-21T17:43:50.432Z；[docs/evidence/p0/source-params.md](source-params.md) §3：2026-09-21 至 2026-09-22 | 降级：保留 `maintenance-required-list-only` 登记；正文 403，停用该来源并提示维护。列表成功不能放行正文，不绕过访问控制 |
| G-P0-MODEL：真实计费与质量基线 | 未取得 | [docs/tasks/P0.md](../../tasks/P0.md) P0-03、P0-06 及 [docs/BUILD_PLAN.md](../../BUILD_PLAN.md) §2：所有者决定日期 2026-09-30；[docs/evidence/p0/platform-facts.md](platform-facts.md) §1：2026-09-22 仅取得模型目录与平台能力；计费与质量实测取得时间：未取得 | **降级：首版只用规则模板与人工审核（所有者 2026-09-30 决定）**。门禁未开、首版不开；P0-03a、P0-03b、P3-09 不进首版；不开放自动调用。此为合同内降级，无需 ADR |
| G-P0-MAIL：普通收件人反馈关联及账户日权限 | 通过 | [docs/evidence/p0/platform-facts.md](platform-facts.md) §1、§2.1、§2.2、§5：日权限于 2026-09-22 只读 API 取得；第二封 2026-09-28T12:50:45Z 发出，13:33:53Z 送达，2026-09-29 复查定稿 | 继续：门禁已开。真实普通收件人的 messageId 与 Queue 四次 deferred、一次 delivered 逐字关联；2026-09-29 查询确认账户无 routing 目标地址。`PLATFORM_MAIL_DAY_LIMIT` 实测值已由注册表登记；仅阿里企业邮有送达证据，不替代 §4 上线前置 |

G-P0-SOURCE 的“部分开”沿用验收方 2026-09-30 门禁记录；未覆盖部分仍未开。
本文不把 P0 写成全项通过，也不作 P5-04 受控上线放行。后续卡仍须满足各自门禁与验收。

## 2. 日历证据边界

| 项目 | 结论 | 证据文件路径与取得时间 | 决策 / 缺口处理 |
| --- | --- | --- | --- |
| Apple Calendar 客户端版本、macOS 版本和刷新延迟 | 未取得 | [docs/evidence/p0/calendar-clients.md](calendar-clients.md)：2026-09-22 记录未提供版本号及刷新延迟；这些字段取得时间：未取得 | 继续限定客户端结论；需所有者补录版本及实测刷新间隔，不承诺具体刷新时限 |
| Google Calendar | 未取得 | [docs/evidence/p0/calendar-clients.md](calendar-clients.md)：2026-09-22 登记未测；实测取得时间：未取得 | 不给兼容或提醒承诺；需所有者单独验证完整替换、VALARM 与刷新延迟 |
| Outlook 桌面版 | 未取得 | [docs/evidence/p0/calendar-clients.md](calendar-clients.md)：2026-09-22 登记未测；实测取得时间：未取得 | 不给兼容或提醒承诺；需所有者单独实测 |
| Outlook Web | 未取得 | [docs/evidence/p0/calendar-clients.md](calendar-clients.md)：2026-09-22 登记未测；实测取得时间：未取得 | 不从桌面版或 Apple 推导结论；需所有者单独实测 |

客户端实测使用手工构造的 ICS 序列，证明的是客户端行为；个人 Feed 服务端输出仍由 P3-06 / A-P3-ICS 独立验收。

## 3. 来源证据边界

| 项目 | 结论 | 证据文件路径与取得时间 | 决策 / 缺口处理 |
| --- | --- | --- | --- |
| 原神 `genshin-ann` | 通过 | [fixtures/sources/genshin-ann/index.json](../../../fixtures/sources/genshin-ann/index.json)、其列出的列表及正文文件；2026-09-21T17:41:54.846Z | 继续限定已登记 CN 公告来源；真实样本标记 `synthetic:false`，全量快照游标与请求限制已有记录 |
| 星铁 `hsr-ann` | 通过 | [fixtures/sources/hsr-ann/index.json](../../../fixtures/sources/hsr-ann/index.json)、其列出的列表及正文文件；2026-09-21T17:41:54.847Z | 继续限定已登记 CN 公告来源；分页参数被忽略，按全量快照登记 |
| 绝区零 `zzz-ann` | 通过 | [fixtures/sources/zzz-ann/index.json](../../../fixtures/sources/zzz-ann/index.json)、其列出的列表及正文文件；2026-09-21T17:41:54.847Z | 继续限定已登记 CN 公告来源；不从列表展示时间反推活动时间 |
| 列表展示时间与活动时间分离 | 通过 | [docs/evidence/p0/list-display-time-vs-event-time.md](list-display-time-vs-event-time.md)、三公告来源 index；样本取得于 2026-09-21，分析登记于 2026-09-22 | 继续以正文官方证据定活动时间；登记中的公告 API 无发布者 UID 字段，由官方域与 webview 形状核验来源，不虚构 UID |
| 目标 Cloudflare 环境 E3 可达性 | 未取得 | [docs/evidence/p0/source-params.md](source-params.md) §5：2026-09-21 至 2026-09-22 登记仅本机 E2；E3 取得时间：未取得 | 需所有者在目标环境以相同参数复测；本卡不部署探针、不将本机结果升格 |
| 跨年活动样本 | 未取得 | [docs/evidence/p0/source-params.md](source-params.md) §5：2026-09-21 至 2026-09-22 窗口无此样本；取得时间：未取得 | 继续保留缺口，在十二月至次年一月窗口由所有者安排采集；列表展示期跨年不算活动跨年 |
| 每来源图片承载日期、置顶项与纯日期 / 结束包含性歧义的完整覆盖 | 未取得 | 三公告来源 index 及 [fixtures/sources/miyoushe-news/index.json](../../../fixtures/sources/miyoushe-news/index.json)：2026-09-21；完整覆盖证据取得时间：未取得 | index 有图片、日期与 `pinned_like_observations` 线索，但不足以证明每来源每类都齐；米游社未观察到置顶项且无正文。只放行门禁表列明部分，不把启发式字段当人工标注 |
| 米游社正文、发布者身份、分页终点及另两游戏覆盖 | 未取得 | [fixtures/sources/miyoushe-news/index.json](../../../fixtures/sources/miyoushe-news/index.json)：2026-09-21T17:43:50.431Z；[docs/evidence/p0/source-params.md](source-params.md) §3、§5：2026-09-21 至 2026-09-22；缺失部分取得时间：未取得 | 继续维护；列表只有原神范围、发布者身份不可核验、分页终点未取得；正文不得继续尝试绕过 |

历史 P0 样本的最大响应观测不是新的运行阈值；运行 `SOURCE_LIMIT_PROFILE` 以 contracts 注册表为准。
门禁表已登记 P3-08 及返工通过（`aac8dfa`、`1579bfe`），本卡不将旧样本最大值重新作为零余量配置。

## 4. 邮件与平台证据边界

| 项目 | 结论 | 证据文件路径与取得时间 | 决策 / 缺口处理 |
| --- | --- | --- | --- |
| Workers Paid、Email Sending 资格、日权限 | 通过 | [docs/evidence/p0/platform-facts.md](platform-facts.md) §1：2026-09-22，只读账户 API 与所有者确认 | 继续沿用资格记录；按 ADR-0003 的纯日额度模型和 contracts 注册表执行，不恢复月度池或周期包含量 |
| 认证 / 业务子域配置 | 通过 | [docs/evidence/p0/platform-facts.md](platform-facts.md) §2：2026-09-28；认证域创建记录为 2026-09-28T17:06:45Z，随后只读复查 | 两域分开、认证域 preview 关闭、两用途静默丢弃关闭、DNS ready；仅引用既有结果，本卡不创建或修改资源 |
| 其他邮箱服务商送达 | 未取得 | [docs/evidence/p0/platform-facts.md](platform-facts.md) §2.2：所有者 2026-09-28 决定暂缓；实测取得时间：未取得 | 不外推阿里企业邮结果；需所有者另行决定与取证 |
| DKIM 对业务退订头的签名覆盖 | 部分确认 | 2026-10-02 所有者对话确认 DKIM pass；有效签名两个退订头 h= 覆盖待明确，未取得原始头 | 不把单独 pass、平台签名前原文或本地测试当作头覆盖证据；P4-06 仍待覆盖登记 |
| 认证域实际送达时延 | 未取得 | [docs/evidence/p0/platform-facts.md](platform-facts.md) §2.2：2026-09-29 复查，认证域未发信；认证域时延取得时间：未取得 | 业务域第二封耗时约 43 分钟，不能承诺验证码在 `OTP_TTL` 内到达；需所有者完成认证域时延验证 |
| 认证域事件订阅与生产反馈部署就绪 | 未取得 | [docs/evidence/p0/platform-facts.md](platform-facts.md) §2.2，2026-09-29 复查；[docs/DEPLOYMENT_PREREQUISITES.md](../../DEPLOYMENT_PREREQUISITES.md)：上线前置；实际部署完成时间：未取得 | 需所有者创建认证域订阅、完成反馈 DLQ / 变量配置并在部署前摘除取证 HTTP pull 消费者；G-P0-MAIL 已开不等于发送开关获准开启 |
| 首版 `send_email` 绑定真实发送与反馈 | 未取得 | [docs/evidence/p0/platform-facts.md](platform-facts.md) §2.1：2026-09-28 实测用 REST；绑定路径真实取得时间：未取得 | 需所有者在首版绑定路径复核；本地替身 / 集成测试不冒充真实外发证据 |
| 稳定站点 origin 与账户基础费记录 | origin 已定；部署与账单待核 | 2026-10-02 所有者指定 https://hoyo.airo.cc；尚未部署，账户基础费实测记录仍未取得 | 正式配置/部署由所有者完成；指定地址不等于已部署或已核账单 |
| 目标环境 D1 条件事务 | 未取得 | [docs/evidence/p0/d1-conditional-tx-20260921T165034Z.json](d1-conditional-tx-20260921T165034Z.json)：2026-09-21T16:50:34.060Z，本地 miniflare E2；目标环境 E3 取得时间：未取得 | 继续保留本地对照：SQL 错误回滚，CAS 零行不自动回滚，`changes()` 守卫有效；需所有者目标环境复测 |
| 目标环境 DO 发送位置与 alarm 行为 | 未取得 | [docs/evidence/p0/do-send-location-20260921T165128Z.json](do-send-location-20260921T165128Z.json)：2026-09-21T16:51:28.331Z，本地 miniflare E2；目标环境 E3 取得时间：未取得 | 继续保留本地 alarm / 并发观测；本地 colo 字段不能证明真实边缘发送位置，需所有者目标环境复测 |

`accepted` / `queued` 仅表示平台接受；本文邮件通过依赖后续 Queue 终态与 messageId 关联，不据此宣称已读或所有收件箱均可达。
邮件不可用或配额降低时，继续执行主方案 §2.3：暂停新验证码和业务外发，不先生成将过期的验证码；保留公共查询、已有会话、恢复入口与 ICS。替代 Provider 须由所有者批准，不自动新增供应商。

## 5. 首版降级与验收方交接

模型目录可用不等于模型计费或质量基线通过。输入保护值、完整计费输出上界（含思考 token）、单篇费用分布、推理相关 usage、可见 JSON 与计费输出差异、截断率、修复率、网络重试率、延迟及人工标注质量基线均未取得。
`MODEL_MAX_INPUT`、`MODEL_MAX_BILLED_OUTPUT` 继续保留注册表现有空值，模型自动调用保持关闭；`AI_*`、`MODEL_*` 均不改动。
以后启用模型先完成 P0-03a 计费门禁，再完成 P0-03b 质量基线与 P3-09 验收。首版白名单规则不能覆盖的公告进入人工审核，审核 API 与管理审核页面仍按后续任务卡完成。

建议验收方维持 BUILD_PLAN §2 的状态：**G-P0-CAL 已开（仅 Apple Calendar / macOS）；G-P0-SOURCE 部分开（三公告来源）；G-P0-MODEL 未开、首版不开；G-P0-MAIL 已开（限定既有实测与上线前置）**。
本卡按所有者指示只修改 `docs/evidence/p0/**`，不更新验收方维护的 BUILD_PLAN。上述建议同时写入 PR 交付报告，由验收方维护门禁状态。
