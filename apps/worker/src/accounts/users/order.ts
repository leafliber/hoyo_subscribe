// P2-03 · users."order" 的并发安全分配（主方案 §8.1 分页 order；任务卡并发裁定）。
// 不做应用层 MAX+1：容量行上的单条 UPDATE ... RETURNING 在 D1 内原子递增，
// 同时取现存最大值作下界以兼容迁移前/测试种子行。消费 CAS 失败只会留下序号间隙。

const ORDER_SEQUENCE_KEY = "users_order_sequence";

export async function allocateUserOrder(db: D1Database, now: number): Promise<number> {
  await db
    .prepare(
      "INSERT INTO capacity_state (key, value, version, updated_at) VALUES (?, 0, 0, ?) ON CONFLICT (key) DO NOTHING",
    )
    .bind(ORDER_SEQUENCE_KEY, now)
    .run();
  const row = await db
    .prepare(
      `UPDATE capacity_state
          SET value = max(value, (SELECT coalesce(max("order"), 0) FROM users)) + 1,
              version = version + 1, updated_at = ?
        WHERE key = ? RETURNING value`,
    )
    .bind(now, ORDER_SEQUENCE_KEY)
    .first<{ value: number }>();
  if (row === null || !Number.isSafeInteger(row.value) || row.value <= 0) {
    throw new Error("users.order 原子分配失败");
  }
  return row.value;
}
