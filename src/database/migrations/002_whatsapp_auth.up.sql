-- 002_whatsapp_auth.up.sql
-- Baileys Authentication & Signal Key Storage

-- 1. whatsapp_auth_credentials table
CREATE TABLE IF NOT EXISTS whatsapp_auth_credentials (
    connection_id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    credentials TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_auth_creds_connection_tenant FOREIGN KEY (tenant_id, connection_id)
        REFERENCES whatsapp_connections(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_creds_tenant ON whatsapp_auth_credentials (tenant_id);

-- 2. whatsapp_auth_keys table
CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    key_type VARCHAR(100) NOT NULL,
    key_id VARCHAR(255) NOT NULL,
    key_value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_auth_keys_connection_tenant FOREIGN KEY (tenant_id, connection_id)
        REFERENCES whatsapp_connections(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_auth_keys_conn_type_id UNIQUE (connection_id, key_type, key_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_keys_tenant ON whatsapp_auth_keys (tenant_id);
CREATE INDEX IF NOT EXISTS idx_auth_keys_lookup ON whatsapp_auth_keys (connection_id, key_type, key_id);
CREATE INDEX IF NOT EXISTS idx_auth_keys_fetch ON whatsapp_auth_keys (connection_id, key_type);
