-- 006_policy_moderation_and_durable_commands.up.sql
-- Windowseven MD Phase 4E: Policy & Moderation REST Endpoints + Durable Moderation Scheduling

-- 1. Relational Integrity: Enforce composite uniqueness on groups (tenant_id, connection_id, id)
-- so foreign keys in commands and scheduled tasks can guarantee group↔connection ownership.
ALTER TABLE groups 
    DROP CONSTRAINT IF EXISTS uq_groups_tenant_connection_id;
ALTER TABLE groups 
    ADD CONSTRAINT uq_groups_tenant_connection_id UNIQUE (tenant_id, connection_id, id);

-- 2. api_idempotency_keys: Atomic reservation & replay caching for mutating API endpoints
CREATE TABLE IF NOT EXISTS api_idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(64) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED')),
    response_status_code INT,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
    CONSTRAINT uq_api_idempotency_tenant_user_key UNIQUE (tenant_id, user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_api_idempotency_lookup 
    ON api_idempotency_keys (tenant_id, user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_api_idempotency_expires 
    ON api_idempotency_keys (expires_at);

-- 3. connection_commands: Durable asynchronous worker commands
CREATE TABLE IF NOT EXISTS connection_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    group_id UUID,
    command_type VARCHAR(50) NOT NULL CHECK (command_type IN (
        'SYNC_GROUPS',
        'MUTE_GROUP',
        'UNMUTE_GROUP',
        'KICK_PARTICIPANT'
    )),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK (status IN (
        'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'
    )),
    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    last_attempt_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_by_worker_id VARCHAR(100),
    claim_epoch BIGINT,
    claim_expires_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,
    result JSONB,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_connection_commands_conn_tenant FOREIGN KEY (tenant_id, connection_id)
        REFERENCES whatsapp_connections(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_connection_commands_group FOREIGN KEY (tenant_id, connection_id, group_id)
        REFERENCES groups(tenant_id, connection_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_connection_commands_claim 
    ON connection_commands (connection_id, status, next_attempt_at) 
    WHERE status IN ('PENDING', 'PROCESSING');

CREATE INDEX IF NOT EXISTS idx_connection_commands_tenant 
    ON connection_commands (tenant_id, created_at DESC);

-- 4. scheduled_moderation_tasks: Crash-resilient durable scheduled unmutes
CREATE TABLE IF NOT EXISTS scheduled_moderation_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    group_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL CHECK (action IN ('UNMUTE_GROUP')),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    run_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK (status IN (
        'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'
    )),
    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    last_attempt_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_by_worker_id VARCHAR(100),
    claim_epoch BIGINT,
    claim_expires_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_scheduled_moderation_group_conn FOREIGN KEY (tenant_id, connection_id, group_id)
        REFERENCES groups(tenant_id, connection_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scheduled_moderation_claim 
    ON scheduled_moderation_tasks (connection_id, status, run_at, next_attempt_at) 
    WHERE status IN ('PENDING', 'PROCESSING');

CREATE INDEX IF NOT EXISTS idx_scheduled_moderation_group_pending 
    ON scheduled_moderation_tasks (tenant_id, group_id, action) 
    WHERE status IN ('PENDING', 'PROCESSING');
