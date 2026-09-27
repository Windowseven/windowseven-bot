-- Migration 010: Customer Connection Uniqueness
-- Enforces the business invariant: Exactly one WhatsApp connection per customer account (tenant).

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_connections_tenant_unique
    ON whatsapp_connections (tenant_id);
