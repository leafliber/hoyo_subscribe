-- P5-01 所有者批准：只观测全局预算占用，不改变预算、不新增表。
-- 由 scripts/migrate/observability.ts 生成；阈值只来自 contracts。
-- 固定槽只保留最新耗尽日；既有历史不倒填，首次同事务写入后当日不覆盖。
CREATE TRIGGER trg_observe_mail_depletion_insert
AFTER INSERT ON usage_periods
WHEN NEW.user_id IS NULL AND NEW.period_kind='utc_day' AND NEW.reserved+NEW.settled+NEW.uncertain>0
BEGIN
  INSERT INTO system_state(key,value_json,updated_at)
  SELECT 'obs:depleted:auth',json_object('day',NEW.period_key,'at',NEW.updated_at),NEW.updated_at WHERE NEW.pool IN ('existing_auth','new_registration') AND (SELECT COALESCE(SUM(reserved+settled+uncertain),0) FROM usage_periods WHERE period_kind='utc_day' AND period_key=NEW.period_key AND user_id IS NULL AND pool IN ('existing_auth','new_registration'))>=90
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
  WHERE json_extract(system_state.value_json,'$.day')<NEW.period_key;
  INSERT INTO system_state(key,value_json,updated_at)
  SELECT 'obs:depleted:signup',json_object('day',NEW.period_key,'at',NEW.updated_at),NEW.updated_at WHERE NEW.pool IN ('existing_auth','new_registration') AND ((SELECT COALESCE(SUM(reserved+settled+uncertain),0) FROM usage_periods WHERE period_kind='utc_day' AND period_key=NEW.period_key AND user_id IS NULL AND pool IN ('new_registration'))>=10 OR (SELECT COALESCE(SUM(reserved+settled+uncertain),0) FROM usage_periods WHERE period_kind='utc_day' AND period_key=NEW.period_key AND user_id IS NULL AND pool IN ('existing_auth','new_registration'))>=90)
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
  WHERE json_extract(system_state.value_json,'$.day')<NEW.period_key;
  INSERT INTO system_state(key,value_json,updated_at)
  SELECT 'obs:depleted:base',json_object('day',NEW.period_key,'at',NEW.updated_at),NEW.updated_at WHERE NEW.pool='base_business' AND NEW.reserved+NEW.settled+NEW.uncertain>=50
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
  WHERE json_extract(system_state.value_json,'$.day')<NEW.period_key;
  INSERT INTO system_state(key,value_json,updated_at)
  SELECT 'obs:depleted:urgent',json_object('day',NEW.period_key,'at',NEW.updated_at),NEW.updated_at WHERE NEW.pool='urgent_business' AND NEW.reserved+NEW.settled+NEW.uncertain>=120
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
  WHERE json_extract(system_state.value_json,'$.day')<NEW.period_key;
END;

CREATE TRIGGER trg_observe_mail_depletion_update
AFTER UPDATE OF reserved,settled,uncertain ON usage_periods
WHEN NEW.user_id IS NULL AND NEW.period_kind='utc_day' AND NEW.reserved+NEW.settled+NEW.uncertain>OLD.reserved+OLD.settled+OLD.uncertain
BEGIN
  INSERT INTO system_state(key,value_json,updated_at)
  SELECT 'obs:depleted:auth',json_object('day',NEW.period_key,'at',NEW.updated_at),NEW.updated_at WHERE NEW.pool IN ('existing_auth','new_registration') AND (SELECT COALESCE(SUM(reserved+settled+uncertain),0) FROM usage_periods WHERE period_kind='utc_day' AND period_key=NEW.period_key AND user_id IS NULL AND pool IN ('existing_auth','new_registration'))>=90
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
  WHERE json_extract(system_state.value_json,'$.day')<NEW.period_key;
  INSERT INTO system_state(key,value_json,updated_at)
  SELECT 'obs:depleted:signup',json_object('day',NEW.period_key,'at',NEW.updated_at),NEW.updated_at WHERE NEW.pool IN ('existing_auth','new_registration') AND ((SELECT COALESCE(SUM(reserved+settled+uncertain),0) FROM usage_periods WHERE period_kind='utc_day' AND period_key=NEW.period_key AND user_id IS NULL AND pool IN ('new_registration'))>=10 OR (SELECT COALESCE(SUM(reserved+settled+uncertain),0) FROM usage_periods WHERE period_kind='utc_day' AND period_key=NEW.period_key AND user_id IS NULL AND pool IN ('existing_auth','new_registration'))>=90)
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
  WHERE json_extract(system_state.value_json,'$.day')<NEW.period_key;
  INSERT INTO system_state(key,value_json,updated_at)
  SELECT 'obs:depleted:base',json_object('day',NEW.period_key,'at',NEW.updated_at),NEW.updated_at WHERE NEW.pool='base_business' AND NEW.reserved+NEW.settled+NEW.uncertain>=50
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
  WHERE json_extract(system_state.value_json,'$.day')<NEW.period_key;
  INSERT INTO system_state(key,value_json,updated_at)
  SELECT 'obs:depleted:urgent',json_object('day',NEW.period_key,'at',NEW.updated_at),NEW.updated_at WHERE NEW.pool='urgent_business' AND NEW.reserved+NEW.settled+NEW.uncertain>=120
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
  WHERE json_extract(system_state.value_json,'$.day')<NEW.period_key;
END;
