// packages/contracts：Worker 与 Web 共用的唯一业务定义源
// （枚举、Schema、参数注册表、时间语义、规范化纯函数——docs/ENGINEERING.md §1）。
//
// 任务卡 P1-02 交付：枚举、时间语义、订阅配置 schema、邮箱身份规范化、提醒规则注册表、
// 变更通知范围与日历有效节点纯函数。参数注册表（附录 A）属 P1-03，错误模型属 P1-08。
//
// 硬约束（AGENTS.md 第 2 节规则 2/3）：所有阈值、TTL、配额、提前量只来自参数注册表；
// 枚举、规范化、提醒规则、投影语义只在本包定义一次。前端不得另写判断、不得按中文标签
// 反推规则（前端 v1.0 §12.1）。本文件是包的唯一出口（package.json exports 仅 "."）。

export * from "./budget/decision";
export * from "./budget/mutations";
export * from "./budget/pools";
export * from "./calendar-nodes";
export * from "./crypto-types/purposes";
export * from "./crypto-types/redaction";
export * from "./crypto-types/storage-policy";
export * from "./email";
export * from "./enums";
export * from "./errors/codes";
export * from "./errors/existence";
export * from "./errors/sampling";
export * from "./notification-scope";
export * from "./params/docs";
export * from "./params/registry";
export * from "./params/verify";
export * from "./rules";
export * from "./subscription";
export * from "./time";
