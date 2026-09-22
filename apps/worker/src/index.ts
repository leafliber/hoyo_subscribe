// Worker 入口（P1-01 骨架；业务路由由后续任务卡按 docs/ENGINEERING.md §1 挂载）。
//
// 启动等式校验（任务卡 P1-03；ENGINEERING.md §4）：附录 A.5 / CONTRACTS_BASELINE.md §11
// 的全部数值等式在模块加载时执行。任一不成立时 verifyParams 抛出 ParamEquationError
// （消息逐条指明是哪一条），Worker 实例化失败即**拒绝启动**——与 `pnpm params:verify`
// 共用同一个函数，不存在第二套校验。
import { verifyParams } from "@hoyo/contracts";

verifyParams();

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
