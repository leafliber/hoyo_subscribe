-- P4-03 返工：热路径排除已展开/已失效历史，expires_at 范围直达排除已过期历史。
-- 当前 origin/main 下一个编号；若 P3-06 的 0019 先合入，本迁移顺延。
CREATE INDEX idx_occurrences_unexpanded_expiry
  ON occurrences(expires_at, due_at, id)
  WHERE invalidated_at IS NULL AND audience_upper_order IS NULL;
