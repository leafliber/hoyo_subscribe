// A-P1-DB · 迁移语句切分器（纯函数）。
// 迁移重放依赖它把带注释的 SQL 文件正确切成语句（D1 exec 的切分不感知注释，实测如此）。
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./split-sql";

describe("A-P1-DB 迁移语句切分器", () => {
  it("剥除行注释与块注释，注释中的分号不切分", () => {
    const sql =
      "-- 头部注释; 含分号\nCREATE TABLE t (a TEXT); -- 行尾注释\n/* 块注释; 也有分号 */ CREATE INDEX i ON t (a);";
    expect(splitSqlStatements(sql)).toEqual(["CREATE TABLE t (a TEXT)", "CREATE INDEX i ON t (a)"]);
  });

  it("字符串字面量中的分号与引号转义不切分", () => {
    const sql = "INSERT INTO t VALUES ('a;b');\nINSERT INTO t VALUES ('it''s;fine');";
    expect(splitSqlStatements(sql)).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      "INSERT INTO t VALUES ('it''s;fine')",
    ]);
  });

  it("触发器体 BEGIN...END 内部分号不切分，整体为一条语句", () => {
    const sql = `CREATE TRIGGER trg
BEFORE UPDATE ON t
WHEN OLD.a <> NEW.a
BEGIN
  SELECT RAISE (ABORT, '不可变: 含分号; 与中文');
END;
CREATE INDEX after_trigger ON t (a);`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("RAISE (ABORT, '不可变: 含分号; 与中文')");
    expect(statements[0]).toContain("BEFORE UPDATE ON t");
    expect(statements[1]).toBe("CREATE INDEX after_trigger ON t (a)");
  });

  it("引号标识符（含保留字列名）原样保留", () => {
    const sql = 'CREATE TABLE u ("order" INTEGER NOT NULL UNIQUE);';
    expect(splitSqlStatements(sql)).toEqual(['CREATE TABLE u ("order" INTEGER NOT NULL UNIQUE)']);
  });

  it("空文本与纯注释返回空数组", () => {
    expect(splitSqlStatements("")).toEqual([]);
    expect(splitSqlStatements("-- 只有注释\n/* 也没有语句 */")).toEqual([]);
  });
});
