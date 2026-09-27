-- Migration 009 Down: Revert Admin Business Layer & Subscriptions Foundation
DROP TABLE IF EXISTS subscription_notifications CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS customer_subscriptions CASCADE;
DROP TABLE IF EXISTS plans CASCADE;
DELETE FROM platform_user_roles WHERE role IN ('ADMIN', 'CUSTOMER');
DELETE FROM platform_roles WHERE name IN ('ADMIN', 'CUSTOMER');
DROP INDEX IF EXISTS idx_users_phone_number;
ALTER TABLE users DROP COLUMN IF EXISTS phone_number;

-- Restore original strict immutability trigger function from migration 008
CREATE OR REPLACE FUNCTION prevent_platform_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'platform_audit_logs entries are strictly immutable';
END;
$$ LANGUAGE plpgsql;
