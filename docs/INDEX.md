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
| [BUILD_PLAN.md](BUILD_PLAN.md) | 阶段依赖图、门禁规则、任务卡总表、并行策略 |
| [ENGINEERING.md](ENGINEERING.md) | 仓库结构、工具链、命令、代码与测试约定、Definition of Done |
| [CONTRACTS_BASELINE.md](CONTRACTS_BASELINE.md) | 跨阶段反复使用的枚举、公式与边界的集中索引 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 验收矩阵 → 测试 ID 映射；每阶段放行检查单；拒收条件 |
| [tasks/](tasks/) | 每阶段的任务卡：P0–P6（后端与管线）、F1–F5（前端轮次） |
| [adr/](adr/) | 变更合同的决策记录；改动禁止清单中的任何一条都必须先有 ADR |

## 阅读顺序

1. 第一次进入本仓库：`AGENTS.md` → `BUILD_PLAN.md` → `ENGINEERING.md`。
2. 领到任务卡：`tasks/<阶段>.md` 中本卡全文 → 卡中列出的合同章节原文 → `CONTRACTS_BASELINE.md` 对应条目。
3. 自检与交付：`ACCEPTANCE.md` 中本卡涉及的验收 ID → `AGENTS.md` 第 5 节报告模板。

## 状态

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| 主方案 v2.1 / 前端 v1.0 | 已定稿 | 变更须经 ADR |
| 执行层文档 | 随阶段推进更新 | 任务卡在阶段开始前细化，不追溯修改已验收卡的验收标准 |
| D1′ / D2 / D3 三组待确认合同 | **未关闭** | 见前端文档 §13；未关闭前受影响功能不得按前端推测上线 |
| P0 证据 | **未取得** | 平台资格、来源样本、模型计费、日历客户端实测均未完成 |
