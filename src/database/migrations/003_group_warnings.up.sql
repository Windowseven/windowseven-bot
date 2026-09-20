-- 003_group_warnings.up.sql
-- Windowseven MD Group Warnings Relational Storage

CREATE TABLE IF NOT EXISTS group_warnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    group_id UUID NOT NULL,
    subject_jid VARCHAR(100) NOT NULL,
    issued_by VARCHAR(100) NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_group_warnings_group_tenant FOREIGN KEY (tenant_id, group_id)
        REFERENCES groups(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_warnings_tenant_group_subject 
    ON group_warnings (tenant_id, group_id, subject_jid);
CREATE INDEX IF NOT EXISTS idx_group_warnings_tenant_group 
    ON group_warnings (tenant_id, group_id);
CREATE INDEX IF NOT EXISTS idx_group_warnings_created_at 
    ON group_warnings (created_at);
