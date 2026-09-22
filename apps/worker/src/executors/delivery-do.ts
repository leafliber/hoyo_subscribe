// P1-01 占位：仅使 wrangler.jsonc 的 DO 绑定可解析，不含任何业务逻辑。
// 真实实现（邮件派发与预算执行）由 P4 阶段任务卡交付。
export class DeliveryDO {
  fetch(): Response {
    return new Response("DeliveryDO placeholder (P1-01)", { status: 501 });
  }
}
