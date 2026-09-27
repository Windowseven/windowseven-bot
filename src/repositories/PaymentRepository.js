class PaymentRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create({
        tenantId,
        customerUserId,
        subscriptionId = null,
        planId,
        amount,
        currency = "TZS",
        provider = "MANUAL",
        transactionReference = null,
        status = "PENDING",
        failureReason = null,
        metadata = {}
    }, client = null) {
        if (!tenantId) throw new Error("tenantId is required");
        if (!customerUserId) throw new Error("customerUserId is required");
        if (!planId) throw new Error("planId is required");
        if (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) < 0) {
            throw new Error("Valid non-negative amount is required");
        }

        const executor = client || this.pool;
        const sql = `
            INSERT INTO payments (
                tenant_id, customer_user_id, subscription_id, plan_id, amount,
                currency, provider, transaction_reference, status, failure_reason, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id, tenant_id, customer_user_id, subscription_id, plan_id, amount,
                      currency, provider, transaction_reference, status, failure_reason,
                      metadata, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [
            tenantId,
            customerUserId,
            subscriptionId,
            planId,
            Number(amount),
            currency.toUpperCase(),
            provider.toUpperCase(),
            transactionReference,
            status.toUpperCase(),
            failureReason,
            JSON.stringify(metadata || {})
        ]);
        return rows[0];
    }

    async findById(id, client = null) {
        if (!id) return null;
        const executor = client || this.pool;
        const sql = `
            SELECT p.*, pl.name as plan_name, u.email as customer_email, u.phone_number as customer_phone
            FROM payments p
            LEFT JOIN plans pl ON p.plan_id = pl.id
            LEFT JOIN users u ON p.customer_user_id = u.id
            WHERE p.id = $1;
        `;
        const { rows } = await executor.query(sql, [id]);
        return rows[0] || null;
    }

    async findByTransactionReference(ref, client = null) {
        if (!ref) return null;
        const executor = client || this.pool;
        const sql = `
            SELECT p.*, pl.name as plan_name, u.email as customer_email, u.phone_number as customer_phone
            FROM payments p
            LEFT JOIN plans pl ON p.plan_id = pl.id
            LEFT JOIN users u ON p.customer_user_id = u.id
            WHERE p.transaction_reference = $1;
        `;
        const { rows } = await executor.query(sql, [ref]);
        return rows[0] || null;
    }

    async updateStatus(id, { status, failureReason = null, subscriptionId = null }, client = null) {
        if (!id) throw new Error("Payment id is required");
        const executor = client || this.pool;
        const sql = `
            UPDATE payments
            SET status = $2,
                failure_reason = COALESCE($3, failure_reason),
                subscription_id = COALESCE($4, subscription_id),
                updated_at = NOW()
            WHERE id = $1
            RETURNING id, tenant_id, customer_user_id, subscription_id, plan_id, amount,
                      currency, provider, transaction_reference, status, failure_reason,
                      metadata, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [id, status.toUpperCase(), failureReason, subscriptionId]);
        return rows[0] || null;
    }

    async findAll({ tenantId = null, customerUserId = null, status = null, limit = 50, offset = 0 } = {}, client = null) {
        const executor = client || this.pool;
        let sql = `
            SELECT p.*, pl.name as plan_name, u.email as customer_email, u.phone_number as customer_phone
            FROM payments p
            LEFT JOIN plans pl ON p.plan_id = pl.id
            LEFT JOIN users u ON p.customer_user_id = u.id
            WHERE 1=1
        `;
        const params = [];
        if (tenantId) {
            params.push(tenantId);
            sql += ` AND p.tenant_id = $${params.length}`;
        }
        if (customerUserId) {
            params.push(customerUserId);
            sql += ` AND p.customer_user_id = $${params.length}`;
        }
        if (status) {
            params.push(status.toUpperCase());
            sql += ` AND p.status = $${params.length}`;
        }

        sql += ` ORDER BY p.created_at DESC`;

        params.push(parseInt(limit, 10) || 50);
        sql += ` LIMIT $${params.length}`;

        params.push(parseInt(offset, 10) || 0);
        sql += ` OFFSET $${params.length}`;

        const { rows } = await executor.query(sql, params);
        return rows;
    }

    async count({ tenantId = null, customerUserId = null, status = null } = {}, client = null) {
        const executor = client || this.pool;
        let sql = `SELECT COUNT(*)::int as count FROM payments WHERE 1=1`;
        const params = [];
        if (tenantId) {
            params.push(tenantId);
            sql += ` AND tenant_id = $${params.length}`;
        }
        if (customerUserId) {
            params.push(customerUserId);
            sql += ` AND customer_user_id = $${params.length}`;
        }
        if (status) {
            params.push(status.toUpperCase());
            sql += ` AND status = $${params.length}`;
        }
        const { rows } = await executor.query(sql, params);
        return rows[0] ? rows[0].count : 0;
    }
}

module.exports = PaymentRepository;
