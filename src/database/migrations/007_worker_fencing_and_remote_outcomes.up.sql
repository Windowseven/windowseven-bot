-- Phase 4F P0: an external WhatsApp request may have crossed the network
-- boundary even when this worker cannot confirm its outcome.  Do not put such
-- work back into the generic retry queue.
ALTER TABLE connection_commands DROP CONSTRAINT IF EXISTS connection_commands_status_check;
ALTER TABLE connection_commands ADD CONSTRAINT connection_commands_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REMOTE_OUTCOME_UNKNOWN'));
ALTER TABLE connection_commands ADD COLUMN IF NOT EXISTS remote_started_at TIMESTAMPTZ;

ALTER TABLE scheduled_moderation_tasks DROP CONSTRAINT IF EXISTS scheduled_moderation_tasks_status_check;
ALTER TABLE scheduled_moderation_tasks ADD CONSTRAINT scheduled_moderation_tasks_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REMOTE_OUTCOME_UNKNOWN', 'PAUSED'));
ALTER TABLE scheduled_moderation_tasks ADD COLUMN IF NOT EXISTS remote_started_at TIMESTAMPTZ;

