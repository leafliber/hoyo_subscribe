# 文档索引

> 本索引只指向当前有效版本：主方案 **v2.1（r2）**、前端设计 **v1.0（r2）**。不存在其他有效版本；出现引用旧版的文档或代码注释，按缺陷处理。
> 两份合同的正文自 2026-09-22 导入后没有改写，之后的合同变化全部记在 [ADR](adr/README.md) 里；**读合同正文前先看 [CONTRACTS_BASELINE §0](CONTRACTS_BASELINE.md) 的"已生效的合同修订"表**，被修订的章节以 ADR 为准。

## 合同文档（唯一事实源）

| 文档 | 覆盖 | 谁必须读 |
| --- | --- | --- |
| [HOYO_OFFICIAL_EVENT_SUBSCRIPTION_PLAN_v2.1.md](HOYO_OFFICIAL_EVENT_SUBSCRIPTION_PLAN_v2.1.md) | 产品范围、平台预案、抽取管线、认证与恢复、云端订阅、个人 ICS、通知调度、数据与接口、预算与生命周期、运维验收、附录 A 参数基线 | 全体 |
| [HOYO_SUBSCRIPTION_FRONTEND_DESIGN_v1.0.md](HOYO_SUBSCRIPTION_FRONTEND_DESIGN_v1.0.md) | 信息架构、状态归属、各页面交互、保存状态机、接收方式呈现、视觉与可访问性、前端验收 U01–U29 | 前端轮次 F1–F6；后端在设计对外字段时 |
| [adr/](adr/README.md) | 变更合同的决策记录（0001–0030；0002 被 0003 取代，0004 为预留编号）。改动禁止清单中的任何一条、改动合同语义，都必须先有 ADR | 全体；改合同前必读 |
| [D2_CALENDAR_PREVIEW.md](D2_CALENDAR_PREVIEW.md) | 前端 §13 待确认项 D2 的答案：实际日历预览、启用时的版本核对、公开变更数据（**2026-09-30 所有者审定**；F2-02 正式预览与 F3-04 开通体验以它为准） | 日历预览、启用相关的卡 |
| [D3_STATE_VIEWS.md](D3_STATE_VIEWS.md) | 前端 §13 待确认项 D3 的答案：状态视图与操作结果（**2026-09-30 所有者审定**，§1.2 改为浏览器推导；F3 联调以它为准） | 账号、通道状态相关的卡 |

D1′（浏览时间范围预设）的定案写在 [F1-02 卡](tasks/F1-F2.md)与 [BUILD_PLAN](BUILD_PLAN.md) 门禁表；#89 起首页不再提供"未来 90 天"，已由 ADR-0023 追认。

## 执行层文档（导航与约定，不是合同）

| 文档 | 用途 |
| --- | --- |
| [../AGENTS.md](../AGENTS.md) | 执行者 Agent 入口：硬规则、禁止清单、工作流、交付报告模板 |
| [BUILD_PLAN.md](BUILD_PLAN.md) | 阶段依赖图、门禁规则与当前状态、进度与后续计划、任务卡总表、已知缺口、并行策略 |
| [ENGINEERING.md](ENGINEERING.md) | 仓库结构、工具链、命令、代码与测试约定、Definition of Done |
| [CONTRACTS_BASELINE.md](CONTRACTS_BASELINE.md) | 跨阶段反复使用的枚举、公式、启动等式、运行开关与接口分组的集中索引（含 ADR 修订后的现行值） |
| [APPENDIX_A.generated.md](APPENDIX_A.generated.md) | 附录 A 参数表，由 `pnpm params:docs` 从 `packages/contracts` 注册表生成，勿手改 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 验收矩阵 → 测试 ID 映射；变异测试登记；每阶段放行检查单；拒收条件 |
| [DEPLOYMENT_PREREQUISITES.md](DEPLOYMENT_PREREQUISITES.md) | 各卡产生的「需所有者执行」项汇总：secrets、平台配置、待取得实测值、各次部署须知 |
| [tasks/](tasks/) | 每阶段的任务卡：P0–P6（后端与管线）、F1–F5（前端轮次）、F6（管理端，`tasks/F6.md`） |
| [备份恢复手册](runbooks/backup-restore.md) | P5-03 本地加密备份/校验/隔离恢复、分离保管与所有者目标环境证据门；工具已合，正式备份未执行 |
| [P5-04 关闭门部署与E3清单](evidence/p5/owner-handoff.md) | 首次关闭门发布记录、之后每次部署的顺序、E3 取证表（仍未完成） |
| [P5-04 本地交付证据](evidence/p5/results.md) | 负载13组、离线对账、公开限制和历史失败；仅E1/E2，不当目标计费证据 |
| [P0 证据目录](evidence/p0/README.md) | 来源样本、平台事实、日历客户端与邮件链路的 P0 证据（结论见 `evidence/p0/CONCLUSIONS.md`） |
| [ADR-0030 直播兑换码接口取证](evidence/p3/miyolive-redeem-codes.md) | 米游社首页发现入口与官方直播页 `index`/`refreshCode` 的实测（2026-10-07，当天无直播，活动与兑换码字段用合成样本）；直播期间的取证待补 |
| [P3-17 真实调用取证](evidence/p3/ai-draft-probe.md) | 6 次真实调用的响应形状、计费口径与 `/no_think` 结论（ADR-0009 依据，不是 P0-03b 质量评估） |
| [P6-03 Web Push 客户端取证清单](evidence/p6/README.md) | 桌面、Android、iOS 主屏幕与目标网络的逐项取证步骤与记录模板（ADR-0025）；**尚无记录**，需所有者执行 |

代码目录里另有模块说明（不是合同）：`apps/web/README.md`（网页目录与设计系统约定）、`apps/worker/src/push/README.md`（Web Push 状态机、预算与外发）、`apps/web/src/features/channels/push/README.md`（浏览器通知界面与 Service Worker）、`apps/worker/src/public/README.md`（公共读 API）、`apps/worker/src/shell/observability/README.md`（观测与运行开关）、`apps/worker/src/mail/*/README.md`、`apps/worker/src/accounts/reclaim/README.md`、`scripts/load/README.md`、`scripts/probes/README.md`。

## 阅读顺序

1. 第一次进入本仓库：`AGENTS.md` → `BUILD_PLAN.md` → `ENGINEERING.md`。
2. 领到任务卡：`tasks/<阶段>.md` 中本卡全文 → 卡中列出的合同章节原文（先查 `CONTRACTS_BASELINE.md` §0 该节有没有被 ADR 修订）→ `CONTRACTS_BASELINE.md` 对应条目。
3. 自检与交付：`ACCEPTANCE.md` 中本卡涉及的验收 ID → `AGENTS.md` 第 5 节报告模板。

## 状态

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| 主方案 v2.1 / 前端 v1.0 | 已定稿 | 正文不改；变更经 ADR，文首导航注指向 `CONTRACTS_BASELINE.md` §0 的逐节修订表 |
| 执行层文档 | 随阶段推进更新 | 任务卡在阶段开始前细化，不追溯修改已验收卡的验收标准；2026-10-06 按 main `cea8145` 与线上部署整理过一次 |
| D1′ / D2 / D3 三组待确认合同 | D1′ **已定案**；D2、D3 **2026-09-30 已审定** | 见前端文档 §13 与 `BUILD_PLAN.md` 门禁表；D1′ 的首页档位按 ADR-0023 为五档 |
| P0 证据 | **部分取得** | 来源样本、Apple 日历实测、平台计量、真实收件人发信与邮件反馈链路已取得（G-P0-MAIL 已开）；目标环境（Cloudflare 上）的 E3 取证仍缺。模型：所有者 2026-09-30 决定首版不带模型抽取，G-P0-MODEL 未开；2026-10-04 起 AI 草稿预填（ADR-0009/0010）不经该门禁、人工批准才发布，「跳过审核」开关（ADR-0018）默认关闭、P0-03b 未做由所有者知情接受 |

## 最新状态（2026-10-06）

main `cea8145`；正式站点 https://hoyo.airo.cc 运行同一提交（2026-10-06 13:37 部署）。除暂停的 P3-13（#42）、首版不做的 P0-03a/03b 与 P3-09、待所有者确认范围的 F6-02 和可选 Push 外，任务卡代码全部合入（可选 Push：2026-10-06 晚所有者要求实施，P6-01/P6-02/F5-01 代码与迁移 0029 已在工作区完成待验收，见 ADR-0025）（90 张中 82 张，另有 3 张 2026-10-06 起草、暂不派发的修正卡；2026-10-03 首版口径 69/69 不变）。最大迁移 0028。平台侧 Secrets、发信绑定、Queue 消费者与 DLQ、事件订阅、Cron、边缘限速均已配置；公开状态显示注册关闭、发信可用、日历与邮件能力开放、Push 关闭。P5-04 的 E3 取证与开放注册仍未完成。2026-10-06 整理时发现的偏差，所有者当日裁定：统计信标与静态页 Referrer-Policy 按现状修订合同（ADR-0021、0022），#89 的三处界面调整追认（ADR-0023）；日历区域的客户端说法、"即将截止"卡、续租状态与退订头 DKIM 取证记为已知问题，暂不处理。详见 [BUILD_PLAN 进度与后续计划](BUILD_PLAN.md)。
