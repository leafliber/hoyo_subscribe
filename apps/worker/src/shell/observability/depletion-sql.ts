import {
  AUTH_MAIL_POOLS,
  BUDGET_PERIOD_KIND,
  MAIL_AUTH_DAY,
  MAIL_BASE_DAY,
  MAIL_SIGNUP_AUTH_DAY,
  MAIL_URGENT_DAY,
} from "@hoyo/contracts";
/** 0025 声明式迁移的唯一生成源；阈值全部取注册表，测试逐字防漂移。 */
export function buildDepletionMigration(): string {
  const authNames = AUTH_MAIL_POOLS.map((p) => `'${p}'`).join(",");
  const occupancy = (pools: string) =>
    `(SELECT COALESCE(SUM(reserved+settled+uncertain),0) FROM usage_periods WHERE period_kind='${BUDGET_PERIOD_KIND}' AND period_key=NEW.period_key AND user_id IS NULL AND pool IN (${pools}))`;
  const authFull = `${occupancy(authNames)}>=${MAIL_AUTH_DAY}`;
  const checks = [
    ["auth", `NEW.pool IN (${authNames}) AND ${authFull}`],
    [
      "signup",
      `NEW.pool IN (${authNames}) AND (${occupancy("'new_registration'")}>=${MAIL_SIGNUP_AUTH_DAY} OR ${authFull})`,
    ],
    [
      "base",
      `NEW.pool='base_business' AND NEW.reserved+NEW.settled+NEW.uncertain>=${MAIL_BASE_DAY}`,
    ],
    [
      "urgent",
      `NEW.pool='urgent_business' AND NEW.reserved+NEW.settled+NEW.uncertain>=${MAIL_URGENT_DAY}`,
    ],
  ];
  const statements = checks
    .map(
      ([key, test]) => `  INSERT INTO system_state(key,value_json,updated_at)
  SELECT 'obs:depleted:${key}',json_object('day',NEW.period_key,'at',NEW.updated_at),NEW.updated_at WHERE ${test}
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
  WHERE json_extract(system_state.value_json,'$.day')<NEW.period_key;`,
    )
    .join("\n");
  return (
    `-- P5-01 所有者批准：只观测全局预算占用，不改变预算、不新增表。\n-- 由 scripts/migrate/observability.ts 生成；阈值只来自 contracts。\n-- 固定槽只保留最新耗尽日；既有历史不倒填，首次同事务写入后当日不覆盖。\n` +
    ["INSERT", "UPDATE OF reserved,settled,uncertain"]
      .map(
        (event, i) => `CREATE TRIGGER trg_observe_mail_depletion_${i === 0 ? "insert" : "update"}
AFTER ${event} ON usage_periods
WHEN NEW.user_id IS NULL AND NEW.period_kind='${BUDGET_PERIOD_KIND}' AND NEW.reserved+NEW.settled+NEW.uncertain>${i === 0 ? "0" : "OLD.reserved+OLD.settled+OLD.uncertain"}
BEGIN
${statements}
END;`,
      )
      .join("\n\n") +
    "\n"
  );
}
