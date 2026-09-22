-- P1-04 · 数据组 10/14：Push（主方案 §8.1 第 10 组、§7.8）
-- endpoint 唯一不授权；receipt 不管理账号（§8.1 第 10 组约束）。
-- 同 endpoint 同 owner 幂等、不同 owner 冲突不 UPSERT 抢占（§7.8）：
-- endpoint_hash 唯一索引让冲突在写入边界暴露，交由 P6-01 处理。

CREATE TABLE push_bindings (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id),
  endpoint_hash       TEXT NOT NULL UNIQUE,     -- endpoint 唯一不授权（§8.1）
  endpoint_ciphertext BLOB NOT NULL,            -- 端点密文
  keys_ciphertext     BLOB NOT NULL,            -- p256dh / auth 加密密钥密文
  state               TEXT NOT NULL,            -- pending / active / … 状态机属 P6-01
  binding_version     INTEGER NOT NULL DEFAULT 0,  -- CAS 版本列
  receipt_token_hash  TEXT UNIQUE,              -- 窄能力 receipt 凭证：只确认本浏览器接收，不管理账号（§7.8）
  lease_expires_at    INTEGER,                  -- 服务租期与宽限（§7.8）
  activated_at        INTEGER,
  last_processed_at   INTEGER,                  -- 真实业务处理确认续期信号；平台接受不算（§7.8）
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- 所有者维度：本人绑定列表。
CREATE INDEX idx_push_bindings_owner ON push_bindings (user_id, state);
-- 清理时间：租期到期暂停、宽限后清理（§7.8）。
CREATE INDEX idx_push_bindings_lease ON push_bindings (lease_expires_at);
