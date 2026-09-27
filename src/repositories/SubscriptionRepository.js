class SubscriptionRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create({
        tenantId,
        customerUserId,
        planId = null,
        pricePaid = 0.00,
        currency = "TZS",
        durationDays,
        status = "ACTIVE",
        startedAt = null,
        expiresAt,
        metadata = {}
    }, client = null) {
        if (!tenantId) throw new Error("tenantId is required");
        if (!customerUserId) throw new Error("customerUserId is required");
        if (!durationDays || durationDays <= 0) throw new Error("durationDays must be > 0");
        if (!expiresAt) throw new Error("expiresAt is required");

        const executor = client || this.pool;
        const sql = `
            INSERT INTO customer_subscriptions (
                tenant_id, customer_user_id, plan_id, price_paid, currency,
                duration_days, status, started_at, expires_at, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9, $10)
            RETURNING id, tenant_id, customer_user_id, plan_id, price_paid, currency,
                      duration_days, status, started_at, expires_at, metadata, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [
            tenantId,
            customerUserId,
            planId,
            Number(pricePaid),
            currency.toUpperCase(),
            parseInt(durationDays, 10),
            status.toUpperCase(),
            startedAt,
            expiresAt,
            JSON.stringify(metadata || {})
        ]);
        return rows[0];
    }

    async findById(id, client = null) {
        if (!id) return null;
        const executor = client || this.pool;
        const sql = `
            SELECT s.*, p.name as plan_name, u.email as customer_email, u.phone_number as customer_phone
            FROM customer_subscriptions s
            LEFT JOIN plans p ON s.plan_id = p.id
            LEFT JOIN users u ON s.customer_user_id = u.id
            WHERE s.id = $1;
        `;
        const { rows } = await executor.query(sql, [id]);
        return rows[0] || null;
    }

    async findActiveByTenantId(tenantId, client = null) {
        if (!tenantId) return null;
        const executor = client || this.pool;
        const sql = `
            SELECT s.*, p.name as plan_name
            FROM customer_subscriptions s
            LEFT JOIN plans p ON s.plan_id = p.id
            WHERE s.tenant_id = $1
              AND s.status IN ('ACTIVE', 'MANUALLY_GRANTED')
              AND s.expires_at > NOW()
            ORDER BY s.expires_at DESC
            LIMIT 1;
        `;
        const { rows } = await executor.query(sql, [tenantId]);
        return rows[0] || null;
    }

    async findLatestByTenantId(tenantId, client = null) {
        if (!tenantId) return null;
        const executor = client || this.pool;
        const sql = `
            SELECT s.*, p.name as plan_name
            FROM customer_subscriptions s
            LEFT JOIN plans p ON s.plan_id = p.id
            WHERE s.tenant_id = $1
            ORDER BY s.created_at DESC
            LIMIT 1;
        `;
        const { rows } = await executor.query(sql, [tenantId]);
        return rows[0] || null;
    }

    async findAll({ tenantId = null, customerUserId = null, status = null, limit = 50, offset = 0 } = {}, client = null) {
        const executor = client || this.pool;
        let sql = `
            SELECT s.*, p.name as plan_name, u.email as customer_email, u.phone_number as customer_phone
            FROM customer_subscriptions s
            LEFT JOIN plans p ON s.plan_id = p.id
            LEFT JOIN users u ON s.customer_user_id = u.id
            WHERE 1=1
        `;
        const params = [];
        if (tenantId) {
            params.push(tenantId);
            sql += ` AND s.tenant_id = $${params.length}`;
        }
        if (customerUserId) {
            params.push(customerUserId);
            sql += ` AND s.customer_user_id = $${params.length}`;
        }
        if (status) {
            params.push(status.toUpperCase());
            sql += ` AND s.status = $${params.length}`;
        }

        sql += ` ORDER BY s.created_at DESC`;

        params.push(parseInt(limit, 10) || 50);
        sql += ` LIMIT $${params.length}`;

        params.push(parseInt(offset, 10) || 0);
        sql += ` OFFSET $${params.length}`;

        const { rows } = await executor.query(sql, params);
        return rows;
    }

    async extendSubscription(id, additionalDays, client = null) {
        if (!id) throw new Error("Subscription id is required");
        const days = parseInt(additionalDays, 10);
        if (isNaN(days) || days <= 0) throw new Error("additionalDays must be > 0");

        const executor = client || this.pool;
        // If current expires_at > NOW(), add to current expires_at. Otherwise add to NOW().
        const sql = `
            UPDATE customer_subscriptions
            SET expires_at = (
                CASE 
                    WHEN expires_at > NOW() THEN expires_at + ($2 * INTERVAL '1 day')
                    ELSE NOW() + ($2 * INTERVAL '1 day')
                END
            ),
            duration_days = duration_days + $2,
            status = 'ACTIVE',
            updated_at = NOW()
            WHERE id = $1
            RETURNING id, tenant_id, customer_user_id, plan_id, price_paid, currency,
                      duration_days, status, started_at, expires_at, metadata, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [id, days]);
        return rows[0] || null;
    }

    async cancelSubscription(id, client = null) {
        if (!id) throw new Error("Subscription id is required");
        const executor = client || this.pool;
        const sql = `
            UPDATE customer_subscriptions
            SET status = 'CANCELLED', updated_at = NOW()
            WHERE id = $1
            RETURNING id, tenant_id, customer_user_id, plan_id, price_paid, currency,
                      duration_days, status, started_at, expires_at, metadata, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [id]);
        return rows[0] || null;
    }

    async expireSubscriptions(client = null) {
        const executor = client || this.pool;
        const sql = `
            UPDATE customer_subscriptions
            SET status = 'EXPIRED', updated_at = NOW()
            WHERE expires_at <= NOW()
              AND status IN ('ACTIVE', 'MANUALLY_GRANTED')
            RETURNING id, tenant_id, customer_user_id, expires_at;
        `;
        const { rows } = await executor.query(sql);
        return rows;
    }

    async findExpiringSubscriptions({ hoursRemaining, notificationType }, client = null) {
        const executor = client || this.pool;
        const sql = `
            SELECT s.*, u.phone_number, u.email, t.name as tenant_name
            FROM customer_subscriptions s
            JOIN users u ON s.customer_user_id = u.id
            JOIN tenants t ON s.tenant_id = t.id
            LEFT JOIN subscription_notifications sn 
                   ON sn.subscription_id = s.id 
                  AND sn.notification_type = $2
            WHERE s.status IN ('ACTIVE', 'MANUALLY_GRANTED')
              AND s.expires_at > NOW()
              AND s.expires_at <= NOW() + ($1 * INTERVAL '1 hour')
              AND sn.id IS NULL;
        `;
        const { rows } = await executor.query(sql, [hoursRemaining, notificationType]);
        return rows;
    }

    async findExpiredSubscriptionsForNotification({ notificationType = 'EXPIRED' } = {}, client = null) {
        const executor = client || this.pool;
        const sql = `
            SELECT s.*, u.phone_number, u.email, t.name as tenant_name
            FROM customer_subscriptions s
            JOIN users u ON s.customer_user_id = u.id
            JOIN tenants t ON s.tenant_id = t.id
            LEFT JOIN subscription_notifications sn 
                   ON sn.subscription_id = s.id 
                  AND sn.notification_type = $1
            WHERE s.expires_at <= NOW()
              AND s.status != 'CANCELLED'
              AND sn.id IS NULL;
        `;
        const { rows } = await executor.query(sql, [notificationType]);
        return rows;
    }

    async recordNotification(subscriptionId, tenantId, notificationType, client = null) {
        const executor = client || this.pool;
        const sql = `
            INSERT INTO subscription_notifications (subscription_id, tenant_id, notification_type, sent_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (subscription_id, notification_type) DO NOTHING
            RETURNING id, subscription_id, tenant_id, notification_type, sent_at;
        `;
        const { rows } = await executor.query(sql, [subscriptionId, tenantId, notificationType]);
        return rows[0] || null;
    }

    async listNotificationsForTenant(tenantId, { limit = 20, offset = 0 } = {}, client = null) {
        if (!tenantId) return [];
        const executor = client || this.pool;
        const sql = `
            SELECT sn.id, sn.subscription_id, sn.tenant_id, sn.notification_type, sn.sent_at, sn.created_at,
                   s.status as subscription_status, s.expires_at,
                   p.name as plan_name
            FROM subscription_notifications sn
            JOIN customer_subscriptions s ON sn.subscription_id = s.id
            LEFT JOIN plans p ON s.plan_id = p.id
            WHERE sn.tenant_id = $1
            ORDER BY sn.sent_at DESC
            LIMIT $2 OFFSET $3;
        `;
        const { rows } = await executor.query(sql, [tenantId, limit, offset]);
        return rows;
    }

    async countNotificationsForTenant(tenantId, client = null) {
        if (!tenantId) return 0;
        const executor = client || this.pool;
        const sql = `SELECT COUNT(*)::int as count FROM subscription_notifications WHERE tenant_id = $1;`;
        const { rows } = await executor.query(sql, [tenantId]);
        return rows[0] ? rows[0].count : 0;
    }
}

module.exports = SubscriptionRepository;
