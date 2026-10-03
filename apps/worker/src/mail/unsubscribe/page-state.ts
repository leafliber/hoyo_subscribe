/** 仅为 GET 呈现读取当前绑定和两层开关；不检查额度、租期或发送可用性。 */
export async function readUnsubscribePageState(
  db: D1Database,
  bindingId: string,
): Promise<"confirm" | "closed" | "stale"> {
  const row = await db
    .prepare(`SELECT c.enabled, c.routine_enabled
      FROM users u LEFT JOIN email_channels c ON c.user_id=u.id
      WHERE u.email_binding_id=? AND u.status='active'`)
    .bind(bindingId)
    .first<{ enabled: number | null; routine_enabled: number | null }>();
  if (!row) return "stale";
  // 无通道行也没有业务同意；只呈现事实，不补行、不续租。
  return row.enabled || row.routine_enabled ? "confirm" : "closed";
}
