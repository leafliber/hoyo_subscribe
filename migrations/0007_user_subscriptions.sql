-- P1-04 · 数据组 7/14：云配置（主方案 §8.1 第 7 组、§4.4、§5.1、§5.3）
-- 每用户一份；uninitialized 不参与匹配也不能开通道；非空约束只对 initialized 成立；
-- 条件版本更新（§8.1 第 7 组约束）。JSON 结构由 packages/contracts 订阅 schema（P1-02）校验，
-- 这里的 CHECK 只做合同级底线的第二道防线。

CREATE TABLE user_subscriptions (
  user_id           TEXT PRIMARY KEY REFERENCES users (id),
  state             TEXT NOT NULL CHECK (state IN ('uninitialized','initialized')),
  schema_version    INTEGER NOT NULL,       -- 当前为 3（§5.1）
  revision          INTEGER NOT NULL DEFAULT 0,   -- CAS 版本列：expected_revision 条件更新（§5.4）
  scope_json        TEXT CHECK (scope_json IS NULL OR json_valid(scope_json)),
  calendar_json     TEXT CHECK (calendar_json IS NULL OR json_valid(calendar_json)),
  notifications_json TEXT CHECK (notifications_json IS NULL OR json_valid(notifications_json)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  -- scope.games 与 calendar.event_types 非空约束只对 initialized 成立（§5.1）；
  -- uninitialized 表示用户尚未做过任何选择，禁止写入代替用户选择的默认值（§4.4）。
  CHECK (
    state = 'uninitialized'
    OR (
      scope_json IS NOT NULL
      AND json_array_length(scope_json, '$.games') > 0
      AND calendar_json IS NOT NULL
      AND json_array_length(calendar_json, '$.event_types') > 0
    )
  )
);

-- 受众匹配先按 state 缩小范围（uninitialized 不参与匹配，§4.4）。
CREATE INDEX idx_user_subscriptions_state ON user_subscriptions (state);

-- uninitialized → initialized 单向，不可退回（§5.1）。
CREATE TRIGGER trg_user_subscriptions_state_oneway
BEFORE UPDATE ON user_subscriptions
WHEN OLD.state = 'initialized' AND NEW.state <> 'initialized'
BEGIN
  SELECT RAISE (ABORT, 'user_subscriptions.state 单向 uninitialized → initialized，不可退回（主方案 §5.1）');
END;

-- 每个兴趣的启用时间（§5.3）：新增或重新启用只影响该兴趣，未变化的规则不重新计时。
-- §8.1 行内字段 interest_enabled_at 的落地载体：以 (game, region, interest) 粒度持久化。
CREATE TABLE subscription_interests (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES user_subscriptions (user_id),
  game           TEXT NOT NULL,
  region         TEXT NOT NULL,
  interest_kind  TEXT NOT NULL,             -- rule | change_switch（§5.3）
  interest_id    TEXT NOT NULL,             -- rule_id 或变更开关名
  enabled_at     INTEGER NOT NULL,
  UNIQUE (user_id, game, region, interest_kind, interest_id)
);

CREATE INDEX idx_subscription_interests_user ON subscription_interests (user_id);
