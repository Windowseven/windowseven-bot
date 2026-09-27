/**
 * Windowseven MD Tenant Repository
 * Manages tenant entities with support for standalone pooling and transactional clients.
 */
class TenantRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create({ name, status = 'ACTIVE' }, client = null) {
        if (!name || typeof name !== 'string' || !name.trim()) {
            throw new Error('Tenant name is required');
        }
        const executor = client || this.pool;
        const sql = `
            INSERT INTO tenants (name, status)
            VALUES ($1, $2)
            RETURNING id, name, status, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [name.trim(), status]);
        return rows[0];
    }

    async findById(id, client = null) {
        if (!id) return null;
        const executor = client || this.pool;
        const sql = `
            SELECT id, name, status, created_at, updated_at
            FROM tenants
            WHERE id = $1;
        `;
        const { rows } = await executor.query(sql, [id]);
        return rows[0] || null;
    }

    async update(id, { name }, client = null) {
        if (!id || !name || !name.trim()) {
            throw new Error('Tenant id and updated name are required');
        }
        const executor = client || this.pool;
        const sql = `
            UPDATE tenants
            SET name = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, name, status, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [name.trim(), id]);
        return rows[0] || null;
    }

    async updateStatus(id, status, client = null) {
        if (!id || !status) {
            throw new Error('Tenant id and status are required');
        }
        const validStatuses = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'];
        if (!validStatuses.includes(status)) {
            throw new Error(`Invalid tenant status: ${status}`);
        }
        const executor = client || this.pool;
        const sql = `
            UPDATE tenants
            SET status = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, name, status, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [status, id]);
        return rows[0] || null;
    }

    async listAllTenants({ limit = 50, offset = 0, status = null } = {}, client = null) {
        const executor = client || this.pool;
        let sql = `
            SELECT t.id, t.name, t.status, t.created_at, t.updated_at,
                   (SELECT COUNT(*)::int FROM whatsapp_connections WHERE tenant_id = t.id) AS connection_count,
                   (SELECT COUNT(*)::int FROM groups WHERE tenant_id = t.id) AS group_count,
                   (SELECT COUNT(*)::int FROM tenant_memberships WHERE tenant_id = t.id) AS member_count
            FROM tenants t
        `;
        const params = [];
        if (status) {
            params.push(status);
            sql += ` WHERE t.status = $${params.length}`;
        }
        params.push(limit, offset);
        sql += ` ORDER BY t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length};`;

        const { rows } = await executor.query(sql, params);
        return rows;
    }

    async listCustomers({ search = null, status = null, limit = 50, offset = 0 } = {}, client = null) {
        const executor = client || this.pool;
        const sql = `
            SELECT 
                t.id AS tenant_id,
                t.name AS tenant_name,
                t.status AS status,
                t.created_at,
                u.id AS user_id,
                u.email,
                u.phone_number,
                (SELECT COUNT(*)::int FROM whatsapp_connections WHERE tenant_id = t.id) AS connection_count,
                (SELECT COUNT(*)::int FROM groups WHERE tenant_id = t.id) AS group_count,
                cs.id AS subscription_id,
                cs.status AS subscription_status,
                cs.expires_at AS subscription_expires_at,
                p.name AS subscription_plan_name
            FROM tenants t
            LEFT JOIN tenant_memberships tm ON tm.tenant_id = t.id AND tm.role = 'OWNER'
            LEFT JOIN users u ON u.id = tm.user_id
            LEFT JOIN LATERAL (
                SELECT id, status, expires_at, plan_id
                FROM customer_subscriptions
                WHERE tenant_id = t.id
                ORDER BY created_at DESC
                LIMIT 1
            ) cs ON true
            LEFT JOIN plans p ON p.id = cs.plan_id
            WHERE ($1::text IS NULL OR (
                u.email ILIKE '%' || $1 || '%' OR
                u.phone_number ILIKE '%' || $1 || '%' OR
                t.name ILIKE '%' || $1 || '%'
            ))
            AND ($2::text IS NULL OR t.status = $2)
            ORDER BY t.created_at DESC
            LIMIT $3 OFFSET $4;
        `;
        const { rows } = await executor.query(sql, [
            search ? search.trim() : null,
            status ? status.toUpperCase() : null,
            parseInt(limit, 10) || 50,
            parseInt(offset, 10) || 0
        ]);
        return rows;
    }

    async delete(id, client = null) {
        if (!id) return null;
        const executor = client || this.pool;
        const sql = 'DELETE FROM tenants WHERE id = $1 RETURNING id;';
        const { rows } = await executor.query(sql, [id]);
        return rows[0] || null;
    }
}

module.exports = TenantRepository;
