// 写 API 同源校验（任务卡 P1-08 交付物三；主方案 §8.2、§4.2 检查顺序第二环"同源/CSRF"）。
//
// 浏览器对跨站 POST/PATCH 会带 Origin；同源写请求在现代浏览器同样携带。因此写 API
// **要求** Origin 存在且与请求的部署源完全一致（协议 + 主机 + 端口）——缺头与跨源
// 同样拒绝（unauthorized）。公开读与能力型端点（Feed）不做 Origin 要求：日历客户端
// 与非浏览器抓取器不发 Origin，它们走各自的能力鉴权。

/** 同源检查结果；reason 直接进入 unauthorized details（contracts 闭合枚举）。 */
export type OriginCheckResult = "ok" | "origin_missing" | "origin_mismatch";

/** 校验写请求的 Origin：与 request 自身的协议+主机+端口完全一致才算同源。 */
export function sameOriginCheck(request: Request): OriginCheckResult {
  const origin = request.headers.get("origin");
  if (origin === null || origin.length === 0) {
    return "origin_missing";
  }
  const url = new URL(request.url);
  const parsed = new URL(origin);
  return parsed.origin === url.origin ? "ok" : "origin_mismatch";
}
