# 文档索引

> 本索引只指向当前有效版本：主方案 **v2.1（r2）**、前端设计 **v1.0（r2）**。不存在其他有效版本；出现引用旧版的文档或代码注释，按缺陷处理。

## 合同文档（唯一事实源）

| 文档 | 覆盖 | 谁必须读 |
| --- | --- | --- |
| [HOYO_OFFICIAL_EVENT_SUBSCRIPTION_PLAN_v2.1.md](HOYO_OFFICIAL_EVENT_SUBSCRIPTION_PLAN_v2.1.md) | 产品范围、平台预案、抽取管线、认证与恢复、云端订阅、个人 ICS、通知调度、数据与接口、预算与生命周期、运维验收、附录 A 参数基线 | 全体 |
| [HOYO_SUBSCRIPTION_FRONTEND_DESIGN_v1.0.md](HOYO_SUBSCRIPTION_FRONTEND_DESIGN_v1.0.md) | 信息架构、状态归属、各页面交互、保存状态机、接收方式呈现、视觉与可访问性、前端验收 U01–U29 | 前端轮次 F1–F5；后端在设计对外字段时 |

## 执行层文档（导航与约定，不是合同）

| 文档 | 用途 |
| --- | --- |
| [../AGENTS.md](../AGENTS.md) | 执行者 Agent 入口：硬规则、禁止清单、工作流、交付报告模板 |
| [BUILD_PLAN.md](BUILD_PLAN.md) | 阶段依赖图、门禁规则与当前状态、进度与后续计划、任务卡总表、并行策略 |
| [ENGINEERING.md](ENGINEERING.md) | 仓库结构、工具链、命令、代码与测试约定、Definition of Done |
| [CONTRACTS_BASELINE.md](CONTRACTS_BASELINE.md) | 跨阶段反复使用的枚举、公式与边界的集中索引 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 验收矩阵 → 测试 ID 映射；每阶段放行检查单；拒收条件 |
| [DEPLOYMENT_PREREQUISITES.md](DEPLOYMENT_PREREQUISITES.md) | 各卡产生的「需所有者执行」项汇总：secrets、平台配置、待取得实测值 |
| [D2_CALENDAR_PREVIEW.md](D2_CALENDAR_PREVIEW.md) | 前端 §13 待确认项 D2 的答案：实际日历预览、启用时的版本核对、公开变更数据（**2026-09-30 所有者审定**；F2-02 正式预览与 F3-04 开通体验以它为准） |
| [D3_STATE_VIEWS.md](D3_STATE_VIEWS.md) | 前端 §13 待确认项 D3 的答案：状态视图与操作结果（**2026-09-30 所有者审定**，§1.2 改为浏览器推导；F3 联调以它为准） |
| [备份恢复手册](runbooks/backup-restore.md) | P5-03 本地加密备份/校验/隔离恢复、分离保管与所有者目标环境证据门；工具已合，正式备份未执行 |
| [P5-04 本地交付证据](evidence/p5/results.md) | 负载13组、离线对账、公开限制和历史失败；仅E1/E2，不当目标计费证据 |
| [P5-04 关闭门部署与E3清单](evidence/p5/owner-handoff.md) | 首次资源名称/公开 Site Key、空库 D1/账户映射与配置待办、Turnstile 秘密配置边界、关闭门顺序与E3；Agent不代部署 |
| [tasks/](tasks/) | 每阶段的任务卡：P0–P6（后端与管线）、F1–F5（前端轮次）、F6（管理端，`tasks/F6.md`） |
| [adr/](adr/) | 变更合同的决策记录；改动禁止清单中的任何一条都必须先有 ADR |
| [ADR-0006](adr/0006-private-calendar-preview-rate-limit.md) | 私人预览按会话近似限速的已批准参数；P3-15 已实施 |
| [ADR-0007](adr/0007-system-audit-retention.md) | 系统审计保留 180 天的已批准参数；P5-02 负责注册、期限校正与清理 |
| [ADR-0008](adr/0008-blocked-preview-pagination-limit.md) | 极大 blocked 私人预览取不全的已接受限制；F3-04 如实处理，P5-04 公开 |

## 阅读顺序

1. 第一次进入本仓库：`AGENTS.md` → `BUILD_PLAN.md` → `ENGINEERING.md`。
2. 领到任务卡：`tasks/<阶段>.md` 中本卡全文 → 卡中列出的合同章节原文 → `CONTRACTS_BASELINE.md` 对应条目。
3. 自检与交付：`ACCEPTANCE.md` 中本卡涉及的验收 ID → `AGENTS.md` 第 5 节报告模板。

## 状态

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| 主方案 v2.1 / 前端 v1.0 | 已定稿 | 变更须经 ADR |
| 执行层文档 | 随阶段推进更新 | 任务卡在阶段开始前细化，不追溯修改已验收卡的验收标准 |
| D1′ / D2 / D3 三组待确认合同 | D1′ **已定案**；D2、D3 **2026-09-30 已审定** | 见前端文档 §13 与 `BUILD_PLAN.md` 门禁表；未关闭前受影响功能不得按前端推测上线 |
| P0 证据 | **部分取得** | 来源样本、Apple 日历实测、平台计量、真实收件人发信与邮件反馈链路已取得（G-P0-MAIL 已开）；目标环境（Cloudflare 上）探针仍缺；模型计费首版不需要（2026-09-30 所有者决定首版不带模型抽取），见 `BUILD_PLAN.md` 门禁表 |


2026-10-03 最新状态：F3-05 #71与P5-04 #83已验收squash为 `64dd5ea`、`ec89300`，首版69/69张卡的代码全部合入；P5-04平台E3及最终上线仍未放行。联合完整八命令、真实首次保存22/22、19个独立探针及9条精准变异通过；部署顺序和剩余证据见上方P5-04清单与DEPLOYMENT_PREREQUISITES。同日按所有者指定已有组件流程复查，发现Turnstile hostname/action及null响应缺口，P2-01合入后维护现可开工；不新增卡号。公开Site Key已完成本地构建检查，Worker尚未创建，D1已由所有者创建并确认空库，真实认证未验收。#42仍暂停，模型/Push首版不做。主干迁移最大0026，已批准参数不重复问。
