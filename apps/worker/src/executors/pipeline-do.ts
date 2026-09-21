// P1-01 占位：仅使 wrangler.jsonc 的 DO 绑定可解析，不含任何业务逻辑。
// 真实实现（采集与发布管线调度）由 P3 阶段任务卡交付。
export class PipelineDO {
  fetch(): Response {
    return new Response("PipelineDO placeholder (P1-01)", { status: 501 });
  }
}
