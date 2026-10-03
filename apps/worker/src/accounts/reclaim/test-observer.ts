/** 合成 D1 基准：统计真正执行的语句和平台返回的行数，不以预算上界冒充实测。 */
export function observeDatabase(db: D1Database) {
  const stats = { queries: 0, rows_read: 0, rows_written: 0 };
  const raw = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const observe = (result: D1Result) => {
    stats.rows_read += result.meta.rows_read;
    stats.rows_written += result.meta.rows_written;
    return result;
  };
  function wrap(s: D1PreparedStatement): D1PreparedStatement {
    const p = new Proxy(s, {
      get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === "first")
          return async (column?: string) => {
            stats.queries++;
            const r = observe(await target.all());
            const row = r.results[0] as Record<string, unknown> | undefined;
            return column === undefined ? (row ?? null) : (row?.[column] ?? null);
          };
        if (key === "run" || key === "all")
          return async () => {
            stats.queries++;
            return observe(await target[key]());
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    raw.set(p, s);
    return p;
  }
  return {
    stats,
    db: new Proxy(db, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
        if (key === "batch")
          return async (s: D1PreparedStatement[]) => {
            stats.queries += s.length;
            return (await target.batch(s.map((stmt) => raw.get(stmt) ?? stmt))).map(observe);
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }),
  };
}
