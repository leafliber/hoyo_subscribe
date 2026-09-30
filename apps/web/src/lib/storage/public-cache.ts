/**
 * 当前未注册 Service Worker。将来接入时只能传构建产出的精确公开资源 URL 白名单，
 * 不能用“同源 GET”或 URL 前缀放行。私人路径即使误入白名单也始终拒绝。
 */
export function mayCachePublicResource(
  request: Request,
  origin: string,
  publicUrls: readonly string[],
): boolean {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== origin || url.search || url.hash) return false;
  if (
    !url.pathname.startsWith("/_astro/") &&
    !["/", "/subscription", "/subscription/", "/status", "/status/"].includes(url.pathname)
  )
    return false;
  return publicUrls.includes(url.href);
}
