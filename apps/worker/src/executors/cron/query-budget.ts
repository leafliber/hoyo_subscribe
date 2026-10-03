/** 仅执行时计数；batch 在调用前整体预留，不能在事务中途截断。 */
export class ReclaimQueryLimit extends Error {}
export function boundedDatabase(db: D1Database, limit: number) {
  let used = 0;
  const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function charge(n: number) {
    if (used + n > limit) throw new ReclaimQueryLimit("reclaim_query_budget");
    used += n;
  }
  function wrap(stmt: D1PreparedStatement): D1PreparedStatement {
    const wrapped = new Proxy(stmt, {
      get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (["all", "run", "first", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            charge(1);
            const method = Reflect.get(target, property) as (...a: unknown[]) => unknown;
            return method.apply(target, args);
          };
        return Reflect.get(target, property);
      },
    });
    statements.set(wrapped, stmt);
    return wrapped;
  }
  const bounded = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch")
        return (batch: D1PreparedStatement[]) => {
          charge(batch.length);
          return target.batch(batch.map((s) => statements.get(s) ?? s));
        };
      if (property === "exec")
        return () => {
          throw new Error("reclaim_exec_not_allowed");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: bounded, used: () => used };
}
