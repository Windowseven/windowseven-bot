-- 006_policy_moderation_and_durable_commands.down.sql
-- Windowseven MD Phase 4E: Policy & Moderation REST Endpoints + Durable Moderation Scheduling (Rollback)

DROP TABLE IF EXISTS scheduled_moderation_tasks CASCADE;
DROP TABLE IF EXISTS connection_commands CASCADE;
DROP TABLE IF EXISTS api_idempotency_keys CASCADE;

ALTER TABLE groups 
    DROP CONSTRAINT IF EXISTS uq_groups_tenant_connection_id;
