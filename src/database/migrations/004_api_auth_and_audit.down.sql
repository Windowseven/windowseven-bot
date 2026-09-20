-- 004_api_auth_and_audit.down.sql
-- Rollback Windowseven MD Authentication Engine & Audit Logging Foundation

DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS refresh_tokens;
