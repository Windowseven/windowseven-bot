-- Migration 009: Admin Business Layer & Subscriptions Foundation
-- Adds phone_number to users, ADMIN platform role, plans, customer_subscriptions, payments, subscription_notifications

-- 1. Phone number for customer identification
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_users_phone_number ON users (phone_number);

-- 2. Consolidate ADMIN and CUSTOMER operational authority in platform roles
INSERT INTO platform_roles (name, description) VALUES
    ('ADMIN', 'Windowseven Admin operational authority'),
    ('CUSTOMER', 'Windowseven customer account')
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;

-- 3. Subscription Plans
CREATE TABLE IF NOT EXISTS plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'TZS',
    duration_days INT NOT NULL CHECK (duration_days > 0),
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plans_status ON plans (status);

-- 4. Customer Subscriptions (with historical price and currency snapshot)
CREATE TABLE IF NOT EXISTS customer_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES plans(id) ON DELETE RESTRICT,
    price_paid NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (price_paid >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'TZS',
    duration_days INT NOT NULL CHECK (duration_days > 0),
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'CANCELLED', 'MANUALLY_GRANTED')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_subs_tenant ON customer_subscriptions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_customer_subs_user ON customer_subscriptions (customer_user_id);
CREATE INDEX IF NOT EXISTS idx_customer_subs_status ON customer_subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_customer_subs_expires ON customer_subscriptions (expires_at);

-- 5. Payments (Immutable transaction audit records, server-side validated amounts)
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id UUID REFERENCES customer_subscriptions(id) ON DELETE SET NULL,
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'TZS',
    provider VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
    transaction_reference VARCHAR(100) UNIQUE,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
    failure_reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (customer_user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments (created_at DESC);

-- 6. Subscription Expiry Notifications Tracking (prevents duplicate customer notifications)
CREATE TABLE IF NOT EXISTS subscription_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES customer_subscriptions(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('3_DAYS_BEFORE', '24_HOURS_BEFORE', 'EXPIRED')),
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_sub_notification UNIQUE (subscription_id, notification_type)
);

CREATE INDEX IF NOT EXISTS idx_sub_notif_sub_type ON subscription_notifications (subscription_id, notification_type);

-- 7. Refine platform audit log immutability trigger to allow declarative ON DELETE SET NULL on actor_user_id
-- while strictly preserving row immutability against manual or application-level tampering
CREATE OR REPLACE FUNCTION prevent_platform_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    -- Permit system foreign-key cascade SET NULL on user deletion when actor_user_id transitions to NULL
    -- and all other audit fields remain strictly unchanged
    IF TG_OP = 'UPDATE' AND OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL THEN
        IF OLD.id = NEW.id 
           AND OLD.actor_role = NEW.actor_role 
           AND OLD.action = NEW.action 
           AND OLD.target_type = NEW.target_type 
           AND OLD.target_id = NEW.target_id 
           AND OLD.target_tenant_id IS NOT DISTINCT FROM NEW.target_tenant_id 
           AND OLD.reason IS NOT DISTINCT FROM NEW.reason 
           AND OLD.metadata = NEW.metadata 
           AND OLD.created_at = NEW.created_at THEN
            RETURN NEW;
        END IF;
    END IF;

    RAISE EXCEPTION 'platform_audit_logs entries are strictly immutable';
END;
$$ LANGUAGE plpgsql;
