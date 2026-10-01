-- P3-07：当前迁移编号为 0023；0021 为 P3-14，0022 为 P4-07。
-- 一条 Feed 只保留最后一次操作指纹；更早重试用 expected_generation 拒绝，不能再次换证。
ALTER TABLE calendar_feeds ADD COLUMN last_management_operation TEXT;

-- 同一条授权条件 UPDATE 的原子依赖效果；不保存逐请求记录。
CREATE TRIGGER trg_feed_activity_merge AFTER UPDATE OF last_feed_poll_at ON calendar_feeds
WHEN NEW.last_feed_poll_at IS NOT NULL AND (OLD.last_feed_poll_at IS NULL OR NEW.last_feed_poll_at > OLD.last_feed_poll_at)
BEGIN
  UPDATE users SET last_feed_poll_at = MAX(COALESCE(last_feed_poll_at,NEW.last_feed_poll_at), NEW.last_feed_poll_at) WHERE id=NEW.user_id;
  INSERT INTO activity_write_failures(metric,utc_day,failures,last_success_at,updated_at)
    VALUES ('feed_poll_merge',strftime('%Y-%m-%d',NEW.last_feed_poll_at/1000,'unixepoch'),0,NEW.last_feed_poll_at,NEW.last_feed_poll_at)
    ON CONFLICT(metric,utc_day) DO UPDATE SET last_success_at=MAX(COALESCE(last_success_at,excluded.last_success_at),excluded.last_success_at);
END;

-- hook 专用撤销版本：守卫先命中，效果更新账号一行，触发器再撤销零或一个 Feed。
-- 不在 auth_epoch 守卫上加副作用（D1 meta.changes 包含触发器写入）。
ALTER TABLE users ADD COLUMN calendar_revocation_version INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER trg_feed_revoke AFTER UPDATE OF calendar_revocation_version ON users
WHEN NEW.calendar_revocation_version > OLD.calendar_revocation_version
BEGIN
  UPDATE calendar_feeds SET state='disabled', token_hash='revoked:' || namespace || ':' || (token_generation+1),
    token_ciphertext=X'', token_generation=token_generation+1, token_rotated_at=NEW.updated_at,
    last_management_operation=NULL, updated_at=NEW.updated_at WHERE user_id=NEW.id AND state='enabled';
END;
