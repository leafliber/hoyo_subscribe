// API 外壳公共出口：中间件、路由与安全机制的唯一 import 面（任务卡 P1-08）。
// P2+ 的业务路由从这里消费 createApiShell 与各原语；不直接深入子模块。
export * from "./body-schema";
export * from "./csrf";
export * from "./domains";
export * from "./errors";
export * from "./existence-fold";
export * from "./headers";
export * from "./logger";
export * from "./origin";
export * from "./router";
