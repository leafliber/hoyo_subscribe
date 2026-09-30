-- P4-07 返工：已完成记录 TTL/容量压力清理、未关联记录到期清理均按时间有界取页。
-- 显式 stage=done 与“已关联”不同：待重试/处理中记录不能被压力清理删除。
-- 兼容迁移前可能存在的非 JSON 脱敏引用，迁移不改写历史内容。
CREATE INDEX idx_mail_feedback_completed_cleanup ON mail_feedback (created_at, id)
  WHERE json_extract(CASE WHEN json_valid(raw_ref) THEN raw_ref ELSE '{}' END,'$.stage')='done';
CREATE INDEX idx_mail_feedback_unmatched_cleanup ON mail_feedback (created_at, id)
  WHERE mail_outbox_id IS NULL;
