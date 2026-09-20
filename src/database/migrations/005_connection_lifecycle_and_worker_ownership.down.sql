-- 005_connection_lifecycle_and_worker_ownership.down.sql
-- Windowseven MD WhatsApp Connection Lifecycle, Worker Ownership & Fencing Rollback

-- 1. Drop workers table
DROP TABLE IF EXISTS workers;

-- 2. Drop indexes on whatsapp_connections
DROP INDEX IF EXISTS idx_whatsapp_connections_lease;
DROP INDEX IF EXISTS idx_whatsapp_connections_reconciliation;
DROP INDEX IF EXISTS idx_whatsapp_connections_tenant_lifecycle;

-- 3. Drop check constraints
ALTER TABLE whatsapp_connections DROP CONSTRAINT IF EXISTS whatsapp_connections_desired_state_check;
ALTER TABLE whatsapp_connections DROP CONSTRAINT IF EXISTS whatsapp_connections_actual_state_check;

-- Restore legacy status check constraint
ALTER TABLE whatsapp_connections DROP CONSTRAINT IF EXISTS whatsapp_connections_status_check;
ALTER TABLE whatsapp_connections ADD CONSTRAINT whatsapp_connections_status_check
    CHECK (status IN ('CREATED', 'CONNECTING', 'CONNECTED', 'DISCONNECTED'));

-- 4. Drop added columns on whatsapp_connections
ALTER TABLE whatsapp_connections
    DROP COLUMN IF EXISTS desired_state,
    DROP COLUMN IF EXISTS actual_state,
    DROP COLUMN IF EXISTS assigned_worker_id,
    DROP COLUMN IF EXISTS lease_epoch,
    DROP COLUMN IF EXISTS lease_expires_at,
    DROP COLUMN IF EXISTS last_status_at,
    DROP COLUMN IF EXISTS last_error_code,
    DROP COLUMN IF EXISTS last_error_at;
