// P1-01 占位入口：无业务路由。后续任务卡按 docs/ENGINEERING.md §1 的子目录挂载各域实现。
export { DeliveryDO } from "./executors/delivery-do";
export { PipelineDO } from "./executors/pipeline-do";

export default {
  fetch(): Response {
    return new Response("hoyo_subscribe worker skeleton (P1-01)\n", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
