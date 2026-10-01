-- P3-10：管理员到期清理不扫描历史系统审计；系统审计保留策略由 P5-02 负责。
CREATE INDEX idx_audit_log_admin_expiry ON audit_log (expires_at, id) WHERE actor_type = 'admin';
