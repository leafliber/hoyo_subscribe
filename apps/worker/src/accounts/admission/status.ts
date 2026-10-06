// P4-03 所有者补充授权：公开全局邮件故障状态，无按邮箱信息。
// GET /api/v2/status：全局公开状态（任务卡 P2-01 交付物三；主方案 §4.2、§8.2）。
//
// 合同约束：
// - 公布全局 registration_open（§4.2：`/status` 公布全局注册开关）。
// - 本端点**不接受也不返回任何按邮箱的存在性信息**（§4.2 绝对条款）：请求体不读、
//   响应体是固定形状的全局字段，与具体邮箱无关。
// - 读侧失败关闭：开关行缺失/损坏时公布 registration_open = false（与准入读同一口径）。

import { PublicStatusResponseSchema, publicOperationalCapabilities } from "@hoyo/contracts";
import { environmentMailAvailable } from "../../mail/provider/environment";
import { publicResponse, readPublicStatus, validatePublicQuery } from "../../public/read";
import { type PushEnvironment, pushConfigured } from "../../push/config";
import type { ShellRoute } from "../../shell";
import { readControls } from "../../shell/observability/controls";
import { readRegistrationOpen } from "./registration";

export const statusRoute: ShellRoute = {
  method: "GET",
  pattern: "/api/v2/status",
  domain: "public",
  write: false,
  handler: async (ctx) => {
    validatePublicQuery(ctx.url);
    const [registrationOpen, mailSendingAvailable, publicStatus, pushReady] = await Promise.all([
      readRegistrationOpen(ctx.env.DB).catch(() => false),
      environmentMailAvailable(ctx.env).catch(() => false),
      readPublicStatus(ctx.env.DB),
      // P6（ADR-0025）：VAPID 与站点源等部署配置齐备才可能开放；缺失时如实为 closed。
      pushConfigured(ctx.env as Env & PushEnvironment).catch(() => false),
    ]);
    const controls = await readControls(ctx.env.DB);
    return publicResponse(
      PublicStatusResponseSchema.parse({
        ...publicStatus,
        capabilities: publicOperationalCapabilities(
          {
            ...controls,
            mail_sending_available: mailSendingAvailable
              ? controls.mail_sending_available
              : controls.mail_sending_available === false
                ? false
                : "unknown",
          },
          { push_configured: pushReady },
        ),
        registration_open: registrationOpen,
        mail_sending_available: mailSendingAvailable,
      }),
    );
  },
};
