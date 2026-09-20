-- 005_connection_lifecycle_and_worker_ownership.up.sql
-- Windowseven MD WhatsApp Connection Lifecycle, Worker Ownership & Fencing

-- 1. Modify whatsapp_connections table with lifecycle and fencing columns
ALTER TABLE whatsapp_connections
    ADD COLUMN IF NOT EXISTS desired_state VARCHAR(50) NOT NULL DEFAULT 'STOPPED',
    ADD COLUMN IF NOT EXISTS actual_state VARCHAR(50) NOT NULL DEFAULT 'UNASSIGNED',
    ADD COLUMN IF NOT EXISTS assigned_worker_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS lease_epoch BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_status_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(100),
    ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

-- Update status check constraint to support modern lifecycle states alongside legacy values
ALTER TABLE whatsapp_connections DROP CONSTRAINT IF EXISTS whatsapp_connections_status_check;
ALTER TABLE whatsapp_connections ADD CONSTRAINT whatsapp_connections_status_check 
    CHECK (status IN (
        'CREATED', 'CONNECTING', 'CONNECTED', 'DISCONNECTED',
        'UNASSIGNED', 'LEASE_ACQUIRED', 'SOCKET_STARTING', 'QR_PENDING',
        'AUTHENTICATING', 'ACTIVE', 'SOCKET_STOPPING', 'FAILED'
    ));

-- Check constraint for desired_state
ALTER TABLE whatsapp_connections DROP CONSTRAINT IF EXISTS whatsapp_connections_desired_state_check;
ALTER TABLE whatsapp_connections ADD CONSTRAINT whatsapp_connections_desired_state_check
    CHECK (desired_state IN ('STOPPED', 'RUNNING'));

-- Check constraint for actual_state (Authoritative Lifecycle State)
ALTER TABLE whatsapp_connections DROP CONSTRAINT IF EXISTS whatsapp_connections_actual_state_check;
ALTER TABLE whatsapp_connections ADD CONSTRAINT whatsapp_connections_actual_state_check
    CHECK (actual_state IN (
        'UNASSIGNED', 'LEASE_ACQUIRED', 'SOCKET_STARTING', 'QR_PENDING',
        'AUTHENTICATING', 'ACTIVE', 'SOCKET_STOPPING', 'DISCONNECTED', 'FAILED'
    ));

-- Indexes for distributed worker lease acquisition, heartbeats, and state reconciliation
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_lease 
    ON whatsapp_connections (assigned_worker_id, lease_epoch, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_reconciliation
    ON whatsapp_connections (desired_state, actual_state, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_tenant_lifecycle
    ON whatsapp_connections (tenant_id, desired_state, actual_state);

-- 2. workers table (Worker registry & operational scheduling hints)
CREATE TABLE IF NOT EXISTS workers (
    id VARCHAR(100) PRIMARY KEY,
    hostname VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'STARTING' CHECK (status IN ('STARTING', 'READY', 'DRAINING', 'STOPPING', 'OFFLINE')),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    capacity INT NOT NULL DEFAULT 50, -- Operational scheduling hint, NOT platform-wide connection ceiling
    active_connections INT NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workers_status_heartbeat 
    ON workers (status, last_heartbeat_at);
