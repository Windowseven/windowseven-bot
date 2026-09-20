-- 001_initial_schema.down.sql
-- Rollback Windowseven MD Multi-Tenant Relational Schema

DROP TABLE IF EXISTS group_policies CASCADE;
DROP TABLE IF EXISTS groups CASCADE;
DROP TABLE IF EXISTS whatsapp_connections CASCADE;
DROP TABLE IF EXISTS tenant_memberships CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;
DROP TABLE IF EXISTS users CASCADE;
