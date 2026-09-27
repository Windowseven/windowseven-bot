-- Migration 010: Drop Customer Connection Uniqueness

DROP INDEX IF EXISTS uq_whatsapp_connections_tenant_unique;
