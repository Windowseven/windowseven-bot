/**
 * Windowseven MD Audit Log Repository
 * Records security-sensitive operations and authentication lifecycle events.
 */
class AuditLogRepository {
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Persists an audit log entry. Supports running within an active transaction client.
     */
    async create({
        tenantId = null,
        actorUserId = null,
        action,
        resourceType,
        resourceId = null,
        metadata = {},
        ipAddress = null,
        userAgent = null,
    }, client = null) {
        if (!action || !resourceType) {
            throw new Error('action and resourceType are required for audit log');
        }

        const executor = client || this.pool;
        const sql = `
            INSERT INTO audit_logs (
                tenant_id, actor_user_id, action, resource_type, resource_id,
                metadata, ip_address, user_agent
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, tenant_id, actor_user_id, action, resource_type, resource_id,
                      metadata, ip_address, user_agent, created_at;
        `;
        const { rows } = await executor.query(sql, [
            tenantId,
            actorUserId,
            action,
            resourceType,
            resourceId,
            JSON.stringify(metadata),
            ipAddress,
            userAgent,
        ]);
        return rows[0];
    }

    /**
     * Queries audit logs for a tenant with pagination.
     */
    async listForTenant(tenantId = null, { limit = 50, offset = 0, action = null } = {}) {
        let sql = `
            SELECT id, tenant_id, actor_user_id, action, resource_type, resource_id,
                   metadata, ip_address, user_agent, created_at
            FROM audit_logs
        `;
        const params = [];
        const conditions = [];

        if (tenantId !== undefined && tenantId !== null) {
            params.push(tenantId);
            conditions.push(`tenant_id = $${params.length}`);
        }

        if (action) {
            params.push(action);
            conditions.push(`action = $${params.length}`);
        }

        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        params.push(limit, offset);
        sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length};`;

        const { rows } = await this.pool.query(sql, params);
        return rows;
    }
}

module.exports = AuditLogRepository;
