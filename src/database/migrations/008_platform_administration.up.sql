-- Phase 4F: Platform Administration & Operations Schema Foundation
-- Migration 008: tenants.status, platform_roles, platform_user_roles, platform_idempotency_keys, platform_audit_logs

-- 1. Tenant lifecycle status
ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED'));

-- 2. Platform roles
CREATE TABLE IF NOT EXISTS platform_roles (
    name VARCHAR(50) PRIMARY KEY,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_roles (name, description) VALUES
    ('PLATFORM_ADMIN', 'Operational platform administrator'),
    ('SUPER_ADMIN', 'Root system platform administrator')
ON CONFLICT DO NOTHING;

-- 3. Platform user role mappings
CREATE TABLE IF NOT EXISTS platform_user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL REFERENCES platform_roles(name) ON DELETE RESTRICT,
    assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_platform_user_role UNIQUE (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_platform_user_roles_user ON platform_user_roles (user_id);

-- 4. Platform-scoped idempotency table
CREATE TABLE IF NOT EXISTS platform_idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(64) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED')),
    response_status_code INT,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
    CONSTRAINT uq_platform_idempotency_actor_key UNIQUE (actor_user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_platform_idempotency_lookup ON platform_idempotency_keys (actor_user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_platform_idempotency_expires ON platform_idempotency_keys (expires_at);

-- 5. Platform audit logs
CREATE TABLE IF NOT EXISTS platform_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_role VARCHAR(50) NOT NULL,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50) NOT NULL,
    target_id VARCHAR(100) NOT NULL,
    target_tenant_id UUID,
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_action ON platform_audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_platform_audit_target ON platform_audit_logs (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_platform_audit_tenant ON platform_audit_logs (target_tenant_id);

-- 6. Audit immutability trigger
CREATE OR REPLACE FUNCTION prevent_platform_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'platform_audit_logs entries are strictly immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_platform_audit ON platform_audit_logs;
CREATE TRIGGER trg_protect_platform_audit
BEFORE UPDATE OR DELETE ON platform_audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_platform_audit_modification();
