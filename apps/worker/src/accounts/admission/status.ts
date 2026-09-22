// GET /api/v2/status：全局公开状态（任务卡 P2-01 交付物三；主方案 §4.2、§8.2）。
//
// 合同约束：
// - 公布全局 registration_open（§4.2：`/status` 公布全局注册开关）。
// - 本端点**不接受也不返回任何按邮箱的存在性信息**（§4.2 绝对条款）：请求体不读、
//   响应体是固定形状的全局字段，与具体邮箱无关。
// - 读侧失败关闭：开关行缺失/损坏时公布 registration_open = false（与准入读同一口径）。

import type { ShellRoute } from "../../shell";
import { jsonResponse } from "../../shell";
import { readRegistrationOpen } from "./registration";

export const statusRoute: ShellRoute = {
  method: "GET",
  pattern: "/api/v2/status",
  domain: "public",
  write: false,
  handler: async (ctx) => {
    const registrationOpen = await readRegistrationOpen(ctx.env.DB);
    return jsonResponse({ registration_open: registrationOpen });
  },
};
