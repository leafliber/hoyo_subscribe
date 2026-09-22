// SQL 语句切分器（任务卡 P1-04）。
// 为什么不用 D1 exec 重放迁移文件：P1-04 开发期实测，D1 exec 的语句切分不感知注释
// （行尾 `-- trailing comment` 也会报 "SQL code did not contain a statement"），
// 而迁移文件的注释承载合同出处，不能删。这里做注释/字符串/触发体感知的切分，
// 再交给 prepare/batch 执行，顺带让每个迁移文件获得 batch 的原子性
// （P0-01 证据：batch 对 SQL 错误整体回滚）。
// 限制：不支持 BEGIN TRANSACTION ... COMMIT 文本（当前迁移不使用）。

/** 把多语句 SQL 文本切成语句数组；剥除 `--` 行注释与 `/* ... *​/` 块注释，保留字符串字面量。 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  // BEGIN/CASE 开块压栈，END 弹栈；仅当栈里没有 BEGIN 时 ';' 才是语句边界
  // （触发器体 BEGIN ... END; 内部的分号不切分；CASE 表达式内本就不可能出现分号）。
  const blocks: string[] = [];
  let i = 0;
  const n = sql.length;

  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);

  while (i < n) {
    const ch = sql[i];

    // 行注释：跳到行尾
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // 块注释：跳到 */
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // 字符串字面量：原样保留（含 '' 转义）
    if (ch === "'") {
      current += ch;
      i++;
      while (i < n) {
        current += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // 引号标识符：原样保留（含 "" 转义）
    if (ch === '"') {
      current += ch;
      i++;
      while (i < n) {
        current += sql[i];
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // 关键字：BEGIN / CASE / END
    if (isIdentStart(ch)) {
      let word = "";
      while (i < n && /[A-Za-z0-9_]/.test(sql[i])) {
        word += sql[i];
        i++;
      }
      const upper = word.toUpperCase();
      if (upper === "BEGIN" || upper === "CASE") {
        blocks.push(upper);
      } else if (upper === "END" && blocks.length > 0) {
        blocks.pop();
      }
      current += word;
      continue;
    }
    // 语句边界
    if (ch === ";" && !blocks.includes("BEGIN")) {
      const statement = current.trim();
      if (statement.length > 0) statements.push(statement);
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}
