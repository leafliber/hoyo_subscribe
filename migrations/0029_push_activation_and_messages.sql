-- P6 · 可选 Web Push（主方案 §7.8、§8.1 第 10 组、§9.4；ADR-0025）。
-- 只增列、增表、增索引与触发器。0010 的 push_bindings 此前没有任何写入路径（P6 未实现），
-- 不需要数据迁移；新列取值与状态机见 apps/worker/src/push/README.md。

-- 绑定的可见激活、测试与暂停事实（D3 §2.8 只给事实）。新列由代码约束取值，不在 ALTER 上加 CHECK。
ALTER TABLE push_bindings ADD COLUMN push_service TEXT NOT NULL DEFAULT 'unknown';   -- 由端点主机推出的登记推送服务
ALTER TABLE push_bindings ADD COLUMN activation_deadline INTEGER;                     -- 本轮可见激活截止（PUSH_ACTIVATION_TTL）
ALTER TABLE push_bindings ADD COLUMN activation_attempts INTEGER NOT NULL DEFAULT 0;  -- 本轮已发激活通知次数（≤ PUSH_ACTIVATION_ATTEMPTS）
ALTER TABLE push_bindings ADD COLUMN activation_sent_at INTEGER;
ALTER TABLE push_bindings ADD COLUMN activation_outcome TEXT;                         -- 最近一次激活通知的外发结果
ALTER TABLE push_bindings ADD COLUMN activation_challenges_json TEXT;                 -- 本轮挑战的 SHA-256（JSON 数组）；激活、暂停或期满清空
ALTER TABLE push_bindings ADD COLUMN last_test_at INTEGER;                            -- 同绑定测试冷却（PUSH_TEST_COOLDOWN）
ALTER TABLE push_bindings ADD COLUMN last_test_outcome TEXT;
ALTER TABLE push_bindings ADD COLUMN last_test_received_at INTEGER;                   -- Service Worker 回执：本浏览器确实收到测试通知
ALTER TABLE push_bindings ADD COLUMN paused_reason TEXT;                              -- user / safety / lease_expired / restore
ALTER TABLE push_bindings ADD COLUMN gone_at INTEGER;                                 -- 推送服务明确 404/410 的时刻

-- 全站容量计数与回收按状态缩范围（pending 看激活截止，gone 看失效时刻）。
CREATE INDEX idx_push_bindings_state ON push_bindings (state, activation_deadline);

-- 实际外发记录（§7.4 的"实际哪一条"在 Push 侧的对应物；业务 Delivery 仍记录"通知谁"）。
-- binding_id / delivery_id 不设外键：绑定删除、Delivery 到期清理后，发送记录按自身期限清理，
-- 发送前复核绑定与 Delivery 仍有效；id 只出现在端到端加密载荷里，作本条处理回执的凭据。
CREATE TABLE push_messages (
  id               TEXT PRIMARY KEY,
  binding_id       TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users (id),
  purpose          TEXT NOT NULL CHECK (purpose IN ('activation','test','business')),
  critical         INTEGER NOT NULL DEFAULT 0 CHECK (critical IN (0, 1)),   -- 可动用 PUSH_CRITICAL_RESERVED_DAY
  priority         INTEGER CHECK (priority IS NULL OR priority BETWEEN 1 AND 5),
  delivery_id      TEXT UNIQUE,                                             -- business：对应 deliveries 行（1:1）
  period_key       TEXT,                                                    -- 计入哪一 UTC 日的外发预算（每次外发前写入）
  status           TEXT NOT NULL CHECK (status IN ('pending','calling_provider','accepted','retry_wait','unknown','failed','skipped','superseded','expired')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  lease_version    INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,                                                 -- calling_provider 的租约：崩溃后转 unknown，不盲目重发
  last_http_status INTEGER,                                                 -- 推送服务 HTTP 状态码（无秘密）
  reason           TEXT,
  expires_at       INTEGER NOT NULL,
  accepted_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- 到期领取：先按状态缩范围，再按下次尝试时间。
CREATE INDEX idx_push_messages_due ON push_messages (status, next_attempt_at);
-- 本人绑定的最近测试/激活与处理回执核对。
CREATE INDEX idx_push_messages_binding ON push_messages (binding_id, purpose, created_at);
-- 清理时间。
CREATE INDEX idx_push_messages_expiry ON push_messages (expires_at);

-- 安全暂停与删除账号的同批效果：守卫命中后更新账号一行，触发器再暂停零到多个绑定
-- （与 0023 的 calendar_revocation_version 同一做法；D1 changes() 只计直接写入）。
ALTER TABLE users ADD COLUMN push_revocation_version INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER trg_push_revoke AFTER UPDATE OF push_revocation_version ON users
WHEN NEW.push_revocation_version > OLD.push_revocation_version
BEGIN
  UPDATE push_bindings SET state='paused', paused_reason='safety', activation_challenges_json=NULL,
    binding_version=binding_version+1, updated_at=NEW.updated_at
  WHERE user_id=NEW.id AND state IN ('pending','active');
END;
