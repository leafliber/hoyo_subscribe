// 条件提交（CAS）原语（任务卡 P1-05，验收 ID A-P1-CAS）。
//
// 合同依据：主方案 §3.6（发布一致性）、§8.1 末段（容量判断不能 COUNT → 无条件 INSERT）、[R08]。
// P0-01 实测事实（docs/evidence/p0/d1-conditional-tx-20260921T165034Z.json）：
//   - D1 batch 的 SQL 失败会整批回滚（batch_rolls_back_on_sql_error = true）；
//   - 但 CAS 更新命中零行**不会**让 batch 失败，同批后续写入照样落库
//     （dependent_write_persisted_despite_cas_zero_rows = true）。
// 所以「UPDATE ... WHERE version = ? 与依赖 INSERT 放进同一个 batch」不是事务边界——
// 这正是本模块要消灭的失败模式。统一条件守卫的做法：
//   1. 守卫语句（UPDATE/DELETE，WHERE 承载全部条件）必须恰好命中 1 行，整批才生效；
//   2. 每条依赖写入都带 changes() = 1 谓词：守卫零行时自动退化为空操作（P0-01 E3 已实测
//      该谓词在 batch 内可用），链条上任何一环零行都会让后续环节继续零行；
//   3. SQL 报错（约束、语法）仍走 batch 自带的整批回滚——这条路 batch 管得了。
// 由此「条件未命中」是正常控制流（返回 condition_missed，不抛错），
// 「数据库报错」是异常（reject，整批回滚）——两者行为不同，§8.1 末段要求分开测试。

/** D1 可绑定的参数值（SQLite 无布尔，布尔用 0/1 整数表达）。 */
export type SqlParam = string | number | bigint | Uint8Array | ArrayBuffer | null;

/** SET 赋值右值：绑定参数，或代码拥有的 SQL 片段（如 `value - 1` 相对增量，不接受用户输入）。 */
export type SetAssignment = SqlParam | { sql: string; params?: readonly SqlParam[] };

export interface GuardStatement {
  /** UPDATE 或 DELETE 语句；全部条件写进 WHERE，命中行数即整批命运。 */
  sql: string;
  params?: readonly SqlParam[];
}

export type GuardedEffect =
  | {
      kind: "insert";
      table: string;
      columns: readonly string[];
      /** 每行长度与 columns 一致；全部行随守卫一起生效或一起空操作。 */
      rows: readonly (readonly SqlParam[])[];
    }
  | {
      kind: "update";
      table: string;
      set: Readonly<Record<string, SetAssignment>>;
      /** 谓词：守卫命中时必须必然成立（同批事务内可见，确定性成立），否则是计划编写错误。 */
      where: { sql: string; params?: readonly SqlParam[] };
    };

export interface ConditionalCommitPlan {
  /** 守卫前的幂等铺垫（如容量计数行的 INSERT ... ON CONFLICT DO NOTHING），不参与条件判定。 */
  preamble?: readonly GuardStatement[];
  guard: GuardStatement;
  effects?: readonly GuardedEffect[];
}

export type ConditionalCommitOutcome =
  | { readonly outcome: "committed" }
  | { readonly outcome: "condition_missed" };

/** 计划自相矛盾或 D1 行为回归：不是业务失败，是编程/平台错误，必须尽快暴露。 */
export class CasInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasInvariantError";
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new CasInvariantError(`非法标识符：${identifier}（表/列名必须是代码内静态常量）`);
  }
  return `"${identifier}"`;
}

function prepare(db: D1Database, sql: string, params?: readonly SqlParam[]): D1PreparedStatement {
  const stmt = db.prepare(sql);
  return params && params.length > 0 ? stmt.bind(...params) : stmt;
}

function compileInsertEffect(effect: Extract<GuardedEffect, { kind: "insert" }>): {
  sql: string;
  params: SqlParam[];
} {
  const columns = effect.columns.map(quoteIdentifier).join(", ");
  const placeholders = effect.columns.map(() => "?").join(", ");
  const selectList = effect.rows
    .map(() => `SELECT ${placeholders} WHERE changes() = 1`)
    .join(" UNION ALL ");
  return {
    sql: `INSERT INTO ${quoteIdentifier(effect.table)} (${columns}) ${selectList}`,
    params: effect.rows.flat(),
  };
}

function isSqlFragment(
  value: SetAssignment,
): value is { sql: string; params?: readonly SqlParam[] } {
  return typeof value === "object" && value !== null && "sql" in value;
}

function compileUpdateEffect(effect: Extract<GuardedEffect, { kind: "update" }>): {
  sql: string;
  params: SqlParam[];
} {
  if (Object.keys(effect.set).length === 0) {
    throw new CasInvariantError("update 效果缺少 SET 赋值");
  }
  const params: SqlParam[] = [];
  const assignments = Object.entries(effect.set).map(([column, value]) => {
    if (isSqlFragment(value)) {
      params.push(...(value.params ?? []));
      return `${quoteIdentifier(column)} = (${value.sql})`;
    }
    params.push(value);
    return `${quoteIdentifier(column)} = ?`;
  });
  const whereParams = effect.where.params ?? [];
  return {
    sql: `UPDATE ${quoteIdentifier(effect.table)} SET ${assignments.join(", ")} WHERE changes() = 1 AND (${effect.where.sql})`,
    params: [...params, ...whereParams],
  };
}

/**
 * 统一条件提交：守卫命中 1 行时 preamble、守卫与全部 effects 一起成立；
 * 守卫命中 0 行时整批退化为空操作并返回 condition_missed；
 * 任何 SQL 报错则整批回滚并 reject。
 */
export async function conditionalCommit(
  db: D1Database,
  plan: ConditionalCommitPlan,
): Promise<ConditionalCommitOutcome> {
  if (!/^\s*(UPDATE|DELETE)\b/i.test(plan.guard.sql)) {
    throw new CasInvariantError(
      "守卫必须是 UPDATE 或 DELETE：条件由 WHERE 命中行数承载，其他语句无法判定",
    );
  }
  const preamble = plan.preamble ?? [];
  const effects = plan.effects ?? [];
  const statements = [
    ...preamble.map((statement) => prepare(db, statement.sql, statement.params)),
    prepare(db, plan.guard.sql, plan.guard.params),
    ...effects.map((effect) => {
      const compiled =
        effect.kind === "insert" ? compileInsertEffect(effect) : compileUpdateEffect(effect);
      return prepare(db, compiled.sql, compiled.params);
    }),
  ];
  const results = await db.batch(statements);

  const guardIndex = preamble.length;
  const guardChanges = results[guardIndex]?.meta?.changes;
  if (typeof guardChanges !== "number") {
    throw new CasInvariantError(
      "D1 未报告守卫语句的 meta.changes；条件判定失去依据（对照 P0-01 证据复测）",
    );
  }
  if (guardChanges > 1) {
    throw new CasInvariantError(
      `守卫语句命中 ${guardChanges} 行：守卫必须至多命中一行（把条件收紧到唯一键上）`,
    );
  }

  for (const [index, effect] of effects.entries()) {
    const changed = results[guardIndex + 1 + index]?.meta?.changes;
    if (typeof changed !== "number") {
      throw new CasInvariantError(`依赖写入 #${index} 未报告 meta.changes`);
    }
    if (guardChanges === 0) {
      if (changed !== 0) {
        throw new CasInvariantError(
          `守卫零行但依赖写入 #${index} 生效了：changes() 谓词链已被破坏，立即对照 P0-01 证据复测 D1 行为`,
        );
      }
      continue;
    }
    const expected = effect.kind === "insert" ? effect.rows.length : 1;
    if (changed < expected) {
      throw new CasInvariantError(
        `守卫命中但依赖写入 #${index} 只改了 ${changed} 行（期望 ≥ ${expected}）：` +
          "效果谓词在守卫命中时必须必然成立，这是计划编写错误",
      );
    }
  }
  return guardChanges === 1 ? { outcome: "committed" } : { outcome: "condition_missed" };
}
