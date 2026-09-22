// 认证存在性敏感结果的折叠合同（任务卡 P1-08 交付物二；主方案 §4.2 末段、§8.2 末段）。
//
// 合同原文（§4.2）："满额或关闭注册时，未知邮箱不生成实际发信任务；公开响应仍与普通
// 申请同形，说明『符合条件的请求将发送验证码』。不能回显『该邮箱不存在』。"
//
// 折叠的完整含义（任务卡 P1-08）：同一输入形状必须返回同一响应——响应体结构相同、
// HTTP 状态码相同、响应大小相同，且两条内部路径完成等成本的工作量（时序不泄露）。
// 本文件提供**公开响应的唯一模板**与**同形断言**；等成本执行的机制在 Worker 侧
// shell/existence-fold.ts（前端不需要执行机制，只需要这份形状）。

/** 折叠响应的 HTTP 状态：202 Accepted——"符合条件的请求将发送验证码"是受理语义。 */
export const AUTH_INTENT_PUBLIC_STATUS = 202 as const;

/**
 * 折叠响应的固定正文模板（§4.2 原文文案）。已注册、未注册、满额、关闭注册四条路径
 * 必须输出同一份字节；正文不携带任何随输入变化的字段。
 */
export const AUTH_INTENT_PUBLIC_BODY = {
  message: "符合条件的请求将发送验证码。",
} as const;

/** 待比较的响应形状（供同形断言与测试取用）。 */
export interface FoldedResponseShape {
  readonly status: number;
  readonly bodyText: string;
}

/**
 * 同形断言：两条响应必须状态一致且字节级正文一致（字节一致蕴含 Content-Length 一致，
 * 即响应大小不泄露存在性）。供 P2 路由验收与外壳测试复用；不一致时抛错并描述差异。
 */
export function assertResponsesFolded(a: FoldedResponseShape, b: FoldedResponseShape): void {
  if (a.status !== b.status) {
    throw new Error(`存在性折叠被破坏：状态码不同（${a.status} vs ${b.status}）`);
  }
  if (a.bodyText !== b.bodyText) {
    throw new Error(
      `存在性折叠被破坏：响应体不一致（长度 ${a.bodyText.length} vs ${b.bodyText.length}）`,
    );
  }
}
