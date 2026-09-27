-- Phase 4F: Platform Administration & Operations Schema Rollback
-- Migration 008 Rollback

DROP TRIGGER IF EXISTS trg_protect_platform_audit ON platform_audit_logs;
DROP FUNCTION IF EXISTS prevent_platform_audit_modification();
DROP TABLE IF EXISTS platform_audit_logs CASCADE;
DROP TABLE IF EXISTS platform_idempotency_keys CASCADE;
DROP TABLE IF EXISTS platform_user_roles CASCADE;
DROP TABLE IF EXISTS platform_roles CASCADE;
ALTER TABLE tenants DROP COLUMN IF EXISTS status;
