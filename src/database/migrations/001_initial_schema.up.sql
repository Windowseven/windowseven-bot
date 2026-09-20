-- 001_initial_schema.up.sql
-- Windowseven MD Multi-Tenant Relational Schema

-- 1. users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    password_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce case-insensitive email uniqueness at the database level
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

-- 2. tenants table
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. tenant_memberships table
CREATE TABLE IF NOT EXISTS tenant_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_tenant_memberships_user_tenant UNIQUE (user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user ON tenant_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant ON tenant_memberships (tenant_id);

-- 4. whatsapp_connections table
CREATE TABLE IF NOT EXISTS whatsapp_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    phone_number VARCHAR(50),
    display_name VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'CONNECTING', 'CONNECTED', 'DISCONNECTED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_whatsapp_connections_tenant_id UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_tenant ON whatsapp_connections (tenant_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_status ON whatsapp_connections (status);

-- 5. groups table
CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    whatsapp_jid VARCHAR(100) NOT NULL,
    name VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN ('DISCOVERED', 'MANAGED', 'UNMANAGED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_groups_connection_tenant FOREIGN KEY (tenant_id, connection_id) 
        REFERENCES whatsapp_connections(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_groups_connection_jid UNIQUE (connection_id, whatsapp_jid),
    CONSTRAINT uq_groups_tenant_id UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_groups_tenant ON groups (tenant_id);
CREATE INDEX IF NOT EXISTS idx_groups_connection ON groups (connection_id);
CREATE INDEX IF NOT EXISTS idx_groups_jid ON groups (whatsapp_jid);
CREATE INDEX IF NOT EXISTS idx_groups_tenant_status ON groups (tenant_id, status);

-- 6. group_policies table
CREATE TABLE IF NOT EXISTS group_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    group_id UUID NOT NULL UNIQUE,
    antilink_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    antilink_action VARCHAR(20) NOT NULL DEFAULT 'delete' CHECK (antilink_action IN ('delete', 'warn', 'kick')),
    antibadword_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    antibadword_action VARCHAR(20) NOT NULL DEFAULT 'delete' CHECK (antibadword_action IN ('delete', 'warn', 'kick')),
    max_warnings INTEGER NOT NULL DEFAULT 3 CHECK (max_warnings > 0),
    warning_action VARCHAR(20) NOT NULL DEFAULT 'warn' CHECK (warning_action IN ('warn', 'kick')),
    welcome_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    welcome_message TEXT,
    goodbye_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    goodbye_message TEXT,
    chatbot_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_group_policies_group_tenant FOREIGN KEY (tenant_id, group_id)
        REFERENCES groups(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_policies_tenant ON group_policies (tenant_id);
CREATE INDEX IF NOT EXISTS idx_group_policies_group ON group_policies (group_id);
