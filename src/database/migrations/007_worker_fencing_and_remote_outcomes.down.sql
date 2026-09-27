ALTER TABLE scheduled_moderation_tasks DROP COLUMN IF EXISTS remote_started_at;
ALTER TABLE scheduled_moderation_tasks DROP CONSTRAINT IF EXISTS scheduled_moderation_tasks_status_check;
ALTER TABLE scheduled_moderation_tasks ADD CONSTRAINT scheduled_moderation_tasks_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'));

ALTER TABLE connection_commands DROP COLUMN IF EXISTS remote_started_at;
ALTER TABLE connection_commands DROP CONSTRAINT IF EXISTS connection_commands_status_check;
ALTER TABLE connection_commands ADD CONSTRAINT connection_commands_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'));
