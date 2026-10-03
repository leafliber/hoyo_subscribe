-- P5-02：只增加清理/历史校正访问路径；TTL 取值仍由 contracts 驱动。
CREATE INDEX idx_audit_log_system_created ON audit_log(created_at,id) WHERE actor_type='system';
CREATE INDEX idx_audit_log_system_expiry ON audit_log(expires_at,id) WHERE actor_type='system';
CREATE INDEX idx_sessions_revoked_cleanup ON sessions(revoked_at,id) WHERE state='revoked';
CREATE INDEX idx_consent_events_cleanup ON consent_events(created_at,id);
CREATE INDEX idx_article_versions_cleanup ON article_versions(created_at,id);
CREATE INDEX idx_articles_cleanup ON articles(created_at,id);
CREATE INDEX idx_users_deleting_cleanup ON users(updated_at,id) WHERE status='deleting' AND deletion_completed_at IS NULL;
CREATE INDEX idx_mail_outbox_cleanup ON mail_outbox(updated_at,id)
 WHERE status IN('accepted','bounced','failed','complained','rejected','skipped','superseded','expired');
CREATE INDEX idx_recent_auth_outbox ON recent_auth_challenges(outbox_id);
CREATE INDEX idx_auth_challenges_reservation ON auth_challenges(reservation_id);
CREATE INDEX idx_auth_challenges_pending_session ON auth_challenges(pending_session_id);
CREATE INDEX idx_recovery_rotations_proof ON recovery_rotations(proof_id);
CREATE INDEX idx_jobs_dispatch_reclaim ON jobs(id,created_at) WHERE kind='mail_dispatch_batch';
