/**
 * Windowseven MD Platform Role Repository
 * Manages global platform operator roles and assignments.
 */
class PlatformRoleRepository {
    constructor(pool) {
        if (!pool) {
            throw new Error('[PlatformRoleRepository] Database pool is required');
        }
        this.pool = pool;
    }

    /**
     * Assigns a platform role to a user.
     * @param {object} params
     * @param {string} params.userId
     * @param {string} params.role
     * @param {string|null} [params.assignedBy]
     * @param {import('pg').PoolClient|null} [client]
     */
    async assignRole({ userId, role, assignedBy = null }, client = null) {
        if (!userId || !role) {
            throw new Error('userId and role are required');
        }

        const executor = client || this.pool;
        const sql = `
            INSERT INTO platform_user_roles (user_id, role, assigned_by)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, role) DO UPDATE
                SET assigned_by = EXCLUDED.assigned_by,
                    created_at = NOW()
            RETURNING id, user_id, role, assigned_by, created_at;
        `;

        const { rows } = await executor.query(sql, [userId, role, assignedBy]);
        return rows[0];
    }

    /**
     * Revokes a specific platform role from a user.
     * @param {object} params
     * @param {string} params.userId
     * @param {string} params.role
     * @param {import('pg').PoolClient|null} [client]
     */
    async revokeRole({ userId, role }, client = null) {
        if (!userId || !role) {
            throw new Error('userId and role are required');
        }

        const executor = client || this.pool;
        const sql = `
            DELETE FROM platform_user_roles
            WHERE user_id = $1 AND role = $2
            RETURNING id, user_id, role;
        `;

        const { rows } = await executor.query(sql, [userId, role]);
        return rows[0] || null;
    }

    /**
     * Revokes all platform roles for a user.
     * @param {string} userId
     * @param {import('pg').PoolClient|null} [client]
     */
    async revokeAllRoles(userId, client = null) {
        if (!userId) throw new Error('userId is required');

        const executor = client || this.pool;
        const sql = `
            DELETE FROM platform_user_roles
            WHERE user_id = $1
            RETURNING id, user_id, role;
        `;

        const { rows } = await executor.query(sql, [userId]);
        return rows;
    }

    /**
     * Finds all platform roles assigned to a user.
     * @param {string} userId
     * @param {import('pg').PoolClient|null} [client]
     * @returns {Promise<string[]>}
     */
    async findRolesByUserId(userId, client = null) {
        if (!userId) return [];

        const executor = client || this.pool;
        const sql = `
            SELECT role
            FROM platform_user_roles
            WHERE user_id = $1
            ORDER BY created_at ASC;
        `;

        const { rows } = await executor.query(sql, [userId]);
        return rows.map((r) => r.role);
    }

    /**
     * Checks if a user has a specific platform role.
     * @param {string} userId
     * @param {string} role
     * @param {import('pg').PoolClient|null} [client]
     */
    async hasRole(userId, role, client = null) {
        if (!userId || !role) return false;

        const executor = client || this.pool;
        const sql = `
            SELECT 1
            FROM platform_user_roles
            WHERE user_id = $1 AND role = $2
            LIMIT 1;
        `;

        const { rows } = await executor.query(sql, [userId, role]);
        return rows.length > 0;
    }

    /**
     * Resolves the highest authoritative platform role for a user.
     * Hierarchy: SUPER_ADMIN > PLATFORM_ADMIN > null
     * @param {string} userId
     * @param {import('pg').PoolClient|null} [client]
     */
    async findHighestRole(userId, client = null) {
        const roles = await this.findRolesByUserId(userId, client);
        if (roles.includes('SUPER_ADMIN')) return 'SUPER_ADMIN';
        if (roles.includes('PLATFORM_ADMIN')) return 'PLATFORM_ADMIN';
        return null;
    }

    /**
     * Lists platform users with their roles.
     * @param {object} [params]
     * @param {number} [params.limit=50]
     * @param {number} [params.offset=0]
     */
    async listPlatformUsers({ limit = 50, offset = 0 } = {}) {
        const sql = `
            SELECT u.id AS user_id, u.email, pur.role, pur.assigned_by, pur.created_at
            FROM platform_user_roles pur
            JOIN users u ON u.id = pur.user_id
            ORDER BY pur.created_at DESC
            LIMIT $1 OFFSET $2;
        `;
        const { rows } = await this.pool.query(sql, [limit, offset]);
        return rows;
    }

    /**
     * Lists all registered platform role definitions.
     */
    async listRoles() {
        const sql = `SELECT name, description, created_at FROM platform_roles ORDER BY name ASC;`;
        const { rows } = await this.pool.query(sql);
        return rows;
    }
}

module.exports = PlatformRoleRepository;
