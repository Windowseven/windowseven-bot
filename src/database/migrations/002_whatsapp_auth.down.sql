-- 002_whatsapp_auth.down.sql
-- Rollback Baileys Authentication Storage

DROP TABLE IF EXISTS whatsapp_auth_keys CASCADE;
DROP TABLE IF EXISTS whatsapp_auth_credentials CASCADE;
