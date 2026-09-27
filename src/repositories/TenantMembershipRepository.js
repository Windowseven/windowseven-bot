/**
 * Windowseven MD Tenant Membership Repository
 * Manages user-tenant membership relationships and roles.
 */
class TenantMembershipRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create({ tenantId, userId, role = 'MEMBER' }, client = null) {
        if (!tenantId || !userId) {
            throw new Error('tenantId and userId are required');
        }
        const validRoles = ['OWNER', 'ADMIN', 'MEMBER'];
        if (!validRoles.includes(role)) {
            throw new Error(`Invalid role: ${role}. Valid roles are: ${validRoles.join(', ')}`);
        }
        const executor = client || this.pool;
        const sql = `
            INSERT INTO tenant_memberships (tenant_id, user_id, role)
            VALUES ($1, $2, $3)
            RETURNING id, tenant_id, user_id, role, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [tenantId, userId, role]);
        return rows[0];
    }

    async findByTenantAndUser(tenantId, userId, client = null) {
        if (!tenantId || !userId) return null;
        const executor = client || this.pool;
        const sql = `
            SELECT id, tenant_id, user_id, role, created_at, updated_at
            FROM tenant_memberships
            WHERE tenant_id = $1 AND user_id = $2;
        `;
        const { rows } = await executor.query(sql, [tenantId, userId]);
        return rows[0] || null;
    }

    async listUsersForTenant(tenantId, client = null) {
        if (!tenantId) return [];
        const executor = client || this.pool;
        const sql = `
            SELECT tm.id, tm.tenant_id, tm.user_id, tm.role, tm.created_at, tm.updated_at,
                   u.email
            FROM tenant_memberships tm
            JOIN users u ON u.id = tm.user_id
            WHERE tm.tenant_id = $1
            ORDER BY tm.created_at ASC;
        `;
        const { rows } = await executor.query(sql, [tenantId]);
        return rows;
    }

    async listTenantsForUser(userId, client = null) {
        if (!userId) return [];
        const executor = client || this.pool;
        const sql = `
            SELECT tm.id, tm.tenant_id, tm.user_id, tm.role, tm.created_at, tm.updated_at,
                   t.name AS tenant_name, t.status AS tenant_status
            FROM tenant_memberships tm
            JOIN tenants t ON t.id = tm.tenant_id
            WHERE tm.user_id = $1
            ORDER BY tm.created_at ASC;
        `;
        const { rows } = await executor.query(sql, [userId]);
        return rows;
    }

    async updateRole(tenantId, userId, role, client = null) {
        if (!tenantId || !userId) return null;
        const validRoles = ['OWNER', 'ADMIN', 'MEMBER'];
        if (!validRoles.includes(role)) {
            throw new Error(`Invalid role: ${role}. Valid roles are: ${validRoles.join(', ')}`);
        }
        const executor = client || this.pool;
        const sql = `
            UPDATE tenant_memberships
            SET role = $1, updated_at = NOW()
            WHERE tenant_id = $2 AND user_id = $3
            RETURNING id, tenant_id, user_id, role, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [role, tenantId, userId]);
        return rows[0] || null;
    }

    async delete(tenantId, userId, client = null) {
        if (!tenantId || !userId) return null;
        const executor = client || this.pool;
        const sql = `
            DELETE FROM tenant_memberships
            WHERE tenant_id = $1 AND user_id = $2
            RETURNING id;
        `;
        const { rows } = await executor.query(sql, [tenantId, userId]);
        return rows[0] || null;
    }

    async countOwnersForTenant(tenantId, client = null) {
        if (!tenantId) return 0;
        const executor = client || this.pool;
        const sql = `
            SELECT COUNT(*)::int AS count
            FROM tenant_memberships
            WHERE tenant_id = $1 AND role = 'OWNER';
        `;
        const { rows } = await executor.query(sql, [tenantId]);
        return rows[0]?.count || 0;
    }
}

module.exports = TenantMembershipRepository;
